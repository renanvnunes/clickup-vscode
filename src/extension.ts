import { existsSync, mkdirSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClickUpClient, ClickUpError, parseTaskRefs, TaskRef } from './clickup';
import { listStoredTasks, loadRawTask, loadStoredTask, regenerateTaskMarkdown, saveTask, StoredTask } from './storage';
import { CommentActions, refreshCommentsPanel, resolveImage, showComments } from './commentsPanel';
import { clearImages, downloadImages, expireImages, imageAttachments } from './images';
import { formatSize } from './markdown';
import { TimerConnection, TimerController } from './timer';
import { TaskFilter, TaskItem, TaskTreeProvider } from './tree';

const TOKEN_KEY = 'clickupTasks.token';
const TEAM_KEY = 'clickupTasks.teamId';

function config() {
  return vscode.workspace.getConfiguration('clickupTasks');
}

function tasksFolder(): string | undefined {
  let folder = config().get<string>('tasksFolder', '').trim() || '.clickup/tasks';
  if (folder === '~' || folder.startsWith('~/')) {
    folder = path.join(os.homedir(), folder.slice(1));
  }
  if (path.isAbsolute(folder)) {
    return folder;
  }
  const workspace = vscode.workspace.workspaceFolders?.[0];
  return workspace && path.join(workspace.uri.fsPath, folder);
}

function requireTasksFolder(): string {
  const folder = tasksFolder();
  if (!folder) {
    throw new Error('Abra uma pasta no VS Code ou configure "clickupTasks.tasksFolder" com um caminho absoluto.');
  }
  return folder;
}

/** Quando a pasta das tarefas fica dentro de um projeto, evita que ela entre no git por acidente. */
async function ensureGitignore(baseDir: string): Promise<void> {
  if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(baseDir))) {
    return;
  }
  const file = path.join(baseDir, '.gitignore');
  if (!existsSync(file)) {
    await mkdir(baseDir, { recursive: true });
    await writeFile(file, '*\n');
  }
}

/** Tenta cada referência em ordem (ex.: 49228 → ID-49228, 49228) até achar a tarefa. */
async function fetchFirstFound(client: ClickUpClient, refs: TaskRef[], teamId: string | undefined, signal: AbortSignal) {
  for (const [i, ref] of refs.entries()) {
    try {
      return await client.task(ref, teamId, signal);
    } catch (err) {
      const last = i === refs.length - 1;
      if (!(err instanceof ClickUpError && err.isNotFound) || last) {
        if (last && refs.length > 1 && err instanceof ClickUpError && err.isNotFound) {
          throw new Error(`Tarefa não encontrada. Tentei: ${refs.map((r) => r.id).join(', ')}.`);
        }
        throw err;
      }
    }
  }
  throw new Error('Nenhuma referência de tarefa para buscar.');
}

export function activate(context: vscode.ExtensionContext) {
  const tree = new TaskTreeProvider(tasksFolder, path.join(context.globalStorageUri.fsPath, 'icons'));
  const timer = new TimerController(timerConnection);
  context.subscriptions.push(timer);
  timer.onDidChange((taskId) => {
    tree.runningTaskId = taskId;
    tree.refresh();
  });
  const view = vscode.window.createTreeView('clickupTasks.tasks', { treeDataProvider: tree });
  const FILTER_KEY = 'clickupTasks.filter';

  // a pasta pode ser compartilhada entre janelas: qualquer importação/remoção atualiza todas
  let watcher: vscode.FileSystemWatcher | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => tree.refresh(), 300);
  };
  function watchTasksFolder(): void {
    watcher?.dispose();
    watcher = undefined;
    const folder = tasksFolder();
    if (!folder) {
      return;
    }
    mkdirSync(folder, { recursive: true });
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '{*,*/task.json}'));
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
  }
  watchTasksFolder();
  context.subscriptions.push({ dispose: () => watcher?.dispose() });
  tree.filter = context.workspaceState.get<TaskFilter>(FILTER_KEY) ?? { statuses: [], query: '' };

  function applyFilter(filter: TaskFilter): void {
    void context.workspaceState.update(FILTER_KEY, filter);
    tree.setFilter(filter);
  }

  // topo do painel: timer rodando (se houver) + resumo dos filtros (se houver)
  let timerLine: string | undefined;
  let filterLine: string | undefined;
  const updateMessage = () => {
    view.message = [timerLine, filterLine].filter(Boolean).join('   |   ') || undefined;
  };

  tree.onDidCount(({ shown, total }) => {
    void vscode.commands.executeCommand('setContext', 'clickupTasks.filtered', tree.isFiltered);
    const { statuses, query } = tree.filter;
    const parts = [
      statuses.length ? `status: ${statuses.map((s) => s.toUpperCase()).join(', ')}` : '',
      query.trim() ? `busca: "${query.trim()}"` : '',
    ].filter(Boolean);
    filterLine = tree.isFiltered ? `${shown} de ${total} tarefa(s) · ${parts.join(' · ')}` : undefined;
    updateMessage();
  });

  timer.onDidTick((tick) => {
    timerLine = tick ? `⏱ ${tick.elapsed} em ${tick.label}` : undefined;
    // badge no ícone da Activity Bar, visível mesmo com o painel fechado
    view.badge = tick ? { value: 1, tooltip: `Timer rodando: ${tick.label} (${tick.elapsed})` } : undefined;
    updateMessage();
  });

  async function searchTasks(): Promise<void> {
    const previous = tree.filter.query;
    const input = vscode.window.createInputBox();
    input.title = 'Pesquisar tarefas';
    input.placeholder = 'Termos do título ou ID (ex.: 49228, ID-47102, agendamento)';
    input.value = previous;
    let accepted = false;
    // filtra enquanto digita
    input.onDidChangeValue((query) => tree.setFilter({ ...tree.filter, query }));
    input.onDidAccept(() => {
      accepted = true;
      input.hide();
    });
    input.onDidHide(() => {
      applyFilter({ ...tree.filter, query: accepted ? input.value : previous });
      input.dispose();
    });
    input.show();
  }

  async function filterByStatus(): Promise<void> {
    const base = requireTasksFolder();
    const counts = new Map<string, { label: string; order: number; count: number }>();
    for (const t of await listStoredTasks(base)) {
      const key = t.status.toLowerCase();
      const entry = counts.get(key) ?? { label: t.status.toUpperCase(), order: t.statusOrder, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    if (!counts.size) {
      vscode.window.showInformationMessage('Nenhuma tarefa importada ainda.');
      return;
    }
    const selected = new Set(tree.filter.statuses);
    const picked = await vscode.window.showQuickPick(
      [...counts]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([key, { label, count }]) => ({ label, description: `${count}`, key, picked: selected.has(key) })),
      { title: 'Filtrar por status', placeHolder: 'Marque os status a mostrar (nenhum = todos)', canPickMany: true },
    );
    if (picked) {
      applyFilter({ ...tree.filter, statuses: picked.length === counts.size ? [] : picked.map((p) => p.key) });
    }
  }

  async function getToken(forcePrompt = false): Promise<string | undefined> {
    const saved = forcePrompt ? undefined : await context.secrets.get(TOKEN_KEY);
    if (saved) {
      return saved;
    }
    const token = await vscode.window.showInputBox({
      title: 'Token da API do ClickUp',
      prompt: 'ClickUp → Settings → Apps → API Token (começa com pk_)',
      placeHolder: 'pk_...',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token?.trim()) {
      return undefined;
    }
    const user = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Validando token do ClickUp…' },
      () => new ClickUpClient(token.trim()).user(),
    );
    await context.secrets.store(TOKEN_KEY, token.trim());
    // outro token pode ser de outra conta, com outros workspaces
    await context.globalState.update(TEAM_KEY, undefined);
    vscode.window.showInformationMessage(`Token do ClickUp salvo. Conectado como ${user.username}.`);
    return token.trim();
  }

  async function removeToken(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage('Remover o token do ClickUp?', { modal: true }, 'Remover');
    if (confirm) {
      await context.secrets.delete(TOKEN_KEY);
      await context.globalState.update(TEAM_KEY, undefined);
      vscode.window.showInformationMessage('Token do ClickUp removido.');
    }
  }

  /** Alimenta os `when` do painel de boas-vindas e mostra a conta no cabeçalho da view. */
  async function updateTokenStatus(): Promise<void> {
    const token = await context.secrets.get(TOKEN_KEY);
    await vscode.commands.executeCommand('setContext', 'clickupTasks.hasToken', !!token);
    if (!token) {
      view.description = 'sem token';
      return;
    }
    try {
      view.description = (await new ClickUpClient(token).user()).username;
    } catch {
      view.description = 'token inválido';
    }
  }

  async function manageToken(): Promise<void> {
    const token = await context.secrets.get(TOKEN_KEY);
    if (!token) {
      await getToken(true);
      return;
    }
    const masked = `${token.slice(0, 6)}…${token.slice(-4)}`;
    let account = 'não foi possível validar';
    try {
      const user = await new ClickUpClient(token).user();
      account = `${user.username}${user.email ? ` <${user.email}>` : ''}`;
    } catch (err) {
      account = err instanceof Error ? err.message : String(err);
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-swap) Trocar token', action: 'replace' },
        { label: '$(trash) Remover token', action: 'remove' },
      ],
      { title: `Token do ClickUp: ${masked}`, placeHolder: `Conta: ${account}` },
    );
    if (choice?.action === 'replace') {
      await getToken(true);
    } else if (choice?.action === 'remove') {
      await removeToken();
    }
  }

  async function resolveTeamId(client: ClickUpClient, signal: AbortSignal): Promise<string> {
    const configured = config().get<string>('teamId', '').trim() || context.globalState.get<string>(TEAM_KEY);
    if (configured) {
      return configured;
    }
    const teams = await client.teams(signal);
    const teamId =
      teams.length === 1
        ? teams[0].id
        : (
            await vscode.window.showQuickPick(
              teams.map((t) => ({ label: t.name, description: t.id, id: t.id })),
              { title: 'Workspace do ClickUp', ignoreFocusOut: true },
            )
          )?.id;
    if (!teamId) {
      throw new Error('Nenhum workspace do ClickUp selecionado.');
    }
    await context.globalState.update(TEAM_KEY, teamId);
    return teamId;
  }

  /** Sem `interactive`, não pede nada ao usuário: usa só o que já está salvo (sincronização em segundo plano). */
  async function timerConnection(interactive: boolean): Promise<TimerConnection | undefined> {
    const token = interactive ? await getToken() : await context.secrets.get(TOKEN_KEY);
    if (!token) {
      return undefined;
    }
    const client = new ClickUpClient(token);
    if (interactive) {
      return { client, teamId: await resolveTeamId(client, new AbortController().signal) };
    }
    let teamId = config().get<string>('teamId', '').trim() || context.globalState.get<string>(TEAM_KEY);
    if (!teamId) {
      const teams = await client.teams();
      if (teams.length !== 1) {
        return undefined;
      }
      teamId = teams[0].id;
      await context.globalState.update(TEAM_KEY, teamId);
    }
    return { client, teamId };
  }

  async function pickTask(arg: unknown): Promise<StoredTask | undefined> {
    if (arg instanceof TaskItem) {
      return arg.task;
    }
    const tasks = await listStoredTasks(requireTasksFolder());
    if (!tasks.length) {
      const choice = await vscode.window.showInformationMessage('Nenhuma tarefa importada ainda.', 'Importar tarefa');
      if (choice) {
        await vscode.commands.executeCommand('clickupTasks.importTask');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      tasks.map((task) => ({ label: task.key, description: task.name, detail: task.status, task })),
      { title: 'Tarefa do ClickUp', matchOnDescription: true },
    );
    return picked?.task;
  }

  async function importTask(input?: string, openAfter = true): Promise<void> {
    input ??= await vscode.window.showInputBox({
      title: 'Nova tarefa do ClickUp',
      prompt: 'Link, hash (ID nativo), ID customizado (ex.: ID-1234) ou só o número',
      placeHolder: '49228, ID-49228, 86abc123x ou https://app.clickup.com/t/...',
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim() || parseTaskRefs(value).length ? undefined : 'Informe um link, hash, ID customizado (ex.: ID-1234) ou número.',
    });
    if (!input) {
      return;
    }
    const refs = parseTaskRefs(input, config().get<string[]>('numericIdPrefixes', ['ID']));
    if (!refs.length) {
      throw new Error(`"${input}" não parece um ID ou link de tarefa do ClickUp.`);
    }
    const baseDir = requireTasksFolder();
    const token = await getToken();
    if (!token) {
      return;
    }
    const client = new ClickUpClient(token);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ClickUp ${input.trim()}`, cancellable: true },
      async (progress, cancellation) => {
        const abort = new AbortController();
        cancellation.onCancellationRequested(() => abort.abort());
        try {
          progress.report({ message: 'buscando tarefa…' });
          const teamId = refs.some((r) => r.custom) ? await resolveTeamId(client, abort.signal) : undefined;
          const task = await fetchFirstFound(client, refs, teamId, abort.signal);

          progress.report({ message: 'buscando comentários…' });
          const comments = await client.comments(task.id, abort.signal);

          await ensureGitignore(baseDir);
          return await saveTask(baseDir, task, comments);
        } catch (err) {
          if (err instanceof ClickUpError && err.isAuth) {
            await context.secrets.delete(TOKEN_KEY);
          }
          if (abort.signal.aborted) {
            return undefined;
          }
          throw err;
        }
      },
    );
    if (!result) {
      return;
    }

    tree.refresh();
    const stored = result;
    await refreshCommentsPanel(stored);
    if (openAfter) {
      await showComments(stored, panelActions, 'desc');
    }
    vscode.window.showInformationMessage(`${stored.key} atualizada.`);
  }

  function command(id: string, handler: (...args: any[]) => Promise<unknown> | unknown) {
    return vscode.commands.registerCommand(id, async (...args: any[]) => {
      try {
        await handler(...args);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function taskCommand(id: string, handler: (task: StoredTask) => Promise<unknown> | unknown) {
    return command(id, async (arg?: unknown) => {
      const task = await pickTask(arg);
      if (task) {
        await handler(task);
      }
    });
  }

  context.subscriptions.push(
    view,
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration('clickupTasks.tasksFolder')) {
          watchTasksFolder();
        }
        if (['tasksFolder', 'groupByStatus'].some((k) => e.affectsConfiguration(`clickupTasks.${k}`))) {
          tree.refresh();
        }
      },
    ),
    context.secrets.onDidChange((e) => {
      if (e.key === TOKEN_KEY) {
        void updateTokenStatus();
        void timer.refresh();
      }
    }),

    command('clickupTasks.importTask', (input?: unknown) => importTask(typeof input === 'string' ? input : undefined)),
    command('clickupTasks.refreshView', () => tree.refresh()),
    command('clickupTasks.searchTasks', searchTasks),
    command('clickupTasks.filterByStatus', filterByStatus),
    command('clickupTasks.clearFilters', () => applyFilter({ statuses: [], query: '' })),
    command('clickupTasks.setToken', manageToken),
    command('clickupTasks.replaceToken', () => getToken(true)),
    command('clickupTasks.removeToken', removeToken),

    taskCommand('clickupTasks.reimportTask', (task) => importTask(task.key)),
    taskCommand('clickupTasks.openTaskFolder', (task) =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(task.taskFile)),
    ),
    taskCommand('clickupTasks.openInBrowser', (task) => vscode.env.openExternal(vscode.Uri.parse(task.url))),
    taskCommand('clickupTasks.removeTask', removeLocalTask),
    taskCommand('clickupTasks.changeStatus', changeStatus),
    taskCommand('clickupTasks.startTimer', (task) => timer.start(task)),
    command('clickupTasks.stopTimer', () => timer.stop()),
    command('clickupTasks.groupByStatus', () => config().update('groupByStatus', true, vscode.ConfigurationTarget.Global)),
    command('clickupTasks.ungroupByStatus', () => config().update('groupByStatus', false, vscode.ConfigurationTarget.Global)),
    taskCommand('clickupTasks.openComments', (task) => showComments(task, panelActions, 'comments')),
    taskCommand('clickupTasks.openDescription', (task) => showComments(task, panelActions, 'desc')),
    taskCommand('clickupTasks.openNotes', (task) => showComments(task, panelActions, 'notes')),
    // menu de contexto das imagens no painel: o VS Code passa o data-vscode-context da imagem
    command('clickupTasks.copyImagePath', async (ctx: { imageSrc?: string }) => {
      const file = ctx?.imageSrc && resolveImage(ctx.imageSrc).file;
      if (file) {
        await vscode.env.clipboard.writeText(file);
        vscode.window.setStatusBarMessage(`$(copy) Caminho copiado: ${file}`, 4000);
      }
    }),
    command('clickupTasks.openImageTab', async (ctx: { imageSrc?: string }) => {
      const file = ctx?.imageSrc && resolveImage(ctx.imageSrc).file;
      if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    }),
    command('clickupTasks.copyImageLink', async (ctx: { imageSrc?: string }) => {
      if (!ctx?.imageSrc) return;
      const link = resolveImage(ctx.imageSrc).link;
      await vscode.env.clipboard.writeText(link);
      vscode.window.setStatusBarMessage('$(copy) Link da imagem copiado', 4000);
    }),
    command('clickupTasks.openImageBrowser', async (ctx: { imageSrc?: string }) => {
      if (ctx?.imageSrc) await vscode.env.openExternal(vscode.Uri.parse(resolveImage(ctx.imageSrc).link));
    }),
    taskCommand('clickupTasks.openTaskFile', (task) => vscode.window.showTextDocument(vscode.Uri.file(task.taskFile))),
    taskCommand('clickupTasks.downloadImages', downloadTaskImages),
    taskCommand('clickupTasks.clearImages', clearTaskImages),
  );

  async function changeStatus(task: StoredTask): Promise<void> {
    if (!task.listId) {
      throw new Error('Tarefa importada por uma versão antiga. Atualize-a do ClickUp e tente de novo.');
    }
    const token = await getToken();
    if (!token) {
      return;
    }
    const client = new ClickUpClient(token);
    const statuses = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Buscando status do ClickUp…' },
      () => client.listStatuses(task.listId!),
    );
    const current = task.status.toLowerCase();
    const picked = await vscode.window.showQuickPick(
      statuses.map((s) => ({
        label: `${s.status.toLowerCase() === current ? '$(pass-filled)' : '$(circle-large-outline)'} ${s.status.toUpperCase()}`,
        description: s.status.toLowerCase() === current ? 'atual' : undefined,
        status: s.status,
      })),
      { title: `Status de ${task.key} — ${task.name}`, placeHolder: 'Novo status' },
    );
    if (!picked || picked.status.toLowerCase() === current) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${task.key} → ${picked.status.toUpperCase()}` },
      () => client.setStatus(task.id, picked.status),
    );
    // reimporta para o task.md, a lista e o painel de comentários refletirem o novo status
    await importTask(task.key, false);
  }

  const panelActions: CommentActions = {
    refresh: (t) => importTask(t.key, false),
    post: (...args) => postComment(...args),
    downloadImages: (t) => downloadTaskImages(t),
    clearImages: (t) => clearTaskImages(t),
  };

  /** Só imagens; vídeos e outros arquivos nunca são baixados. */
  async function downloadTaskImages(task: StoredTask): Promise<void> {
    const raw = await loadRawTask(task.dir);
    const total = imageAttachments(raw).length;
    if (!total) {
      vscode.window.showInformationMessage(`${task.key} não tem imagens anexadas.`);
      return;
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Baixando imagens de ${task.key}`, cancellable: true },
      async (progress, cancellation) => {
        const abort = new AbortController();
        cancellation.onCancellationRequested(() => abort.abort());
        try {
          return await downloadImages(task.dir, raw, (done, all) => progress.report({ message: `${done}/${all}`, increment: 100 / all }), abort.signal);
        } catch (err) {
          if (abort.signal.aborted) return undefined;
          throw err;
        }
      },
    );
    await regenerateTaskMarkdown(task);
    await refreshCommentsPanel(task);
    if (result) {
      const hours = Math.max(1, config().get<number>('imageRetentionHours', 3));
      const parts = [
        `${result.downloaded} baixada(s)${result.bytes ? ` (${formatSize(result.bytes)})` : ''}`,
        result.existing ? `${result.existing} já estava(m) no disco` : '',
        result.failed ? `${result.failed} com erro` : '',
      ].filter(Boolean);
      vscode.window.showInformationMessage(`${task.key}: ${parts.join(', ')}. As imagens são apagadas sozinhas em ${hours} h.`);
    }
  }

  async function clearTaskImages(task: StoredTask): Promise<void> {
    const removed = await clearImages(task.dir);
    await regenerateTaskMarkdown(task);
    await refreshCommentsPanel(task);
    vscode.window.showInformationMessage(
      removed ? `${task.key}: ${removed} imagem(ns) apagada(s). A descrição voltou a usar os links.` : `${task.key} não tinha imagens baixadas.`,
    );
  }

  async function postComment(task: StoredTask, text: string, items: any[] | undefined, notifyAll: boolean, parentId?: string) {
    const token = await getToken();
    if (!token) {
      throw new Error('Defina o token da API do ClickUp.');
    }
    const client = new ClickUpClient(token);
    if (items) {
      try {
        await client.postComment(task.id, { comment: items, notify_all: notifyAll }, parentId);
        return;
      } catch (err) {
        // formato rico recusado (4xx): o comentário não foi criado, então reenvia como texto puro
        if (!(err instanceof ClickUpError) || err.status >= 500 || err.isAuth) {
          throw err;
        }
      }
    }
    await client.postComment(task.id, { comment_text: text, notify_all: notifyAll }, parentId);
  }

  /** Apaga só a cópia local (task.md e anexos); a tarefa no ClickUp não é tocada. */
  async function removeLocalTask(task: StoredTask): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Remover ${task.key} deste computador?`,
      { modal: true, detail: `A pasta ${task.dir} vai para a lixeira. A tarefa no ClickUp não é alterada.` },
      'Remover',
    );
    if (!confirm) {
      return;
    }
    const uri = vscode.Uri.file(task.dir);
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    } catch {
      const permanent = await vscode.window.showWarningMessage(
        'Não foi possível mover para a lixeira. Apagar permanentemente?',
        { modal: true },
        'Apagar',
      );
      if (!permanent) {
        return;
      }
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
    }
    tree.refresh();
    vscode.window.showInformationMessage(`${task.key} removida localmente.`);
  }

  void updateTokenStatus();
  void timer.refresh();

  // imagens baixadas vivem `imageRetentionHours` (padrão 3 h) em qualquer tarefa; verificado a cada 15 min
  const expire = async () => {
    const base = tasksFolder();
    if (!base) return;
    const hours = Math.max(1, config().get<number>('imageRetentionHours', 3));
    for (const dir of await expireImages(base, hours * 3_600_000)) {
      const stored = await loadStoredTask(dir);
      if (stored) {
        await regenerateTaskMarkdown(stored);
        await refreshCommentsPanel(stored);
      }
    }
  };
  void expire().catch(() => undefined);
  const expireTimer = setInterval(() => void expire().catch(() => undefined), 15 * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(expireTimer) });
  // cache em /tmp das versões anteriores
  void rm(path.join(os.tmpdir(), 'clickup-tasks-images'), { recursive: true, force: true }).catch(() => undefined);
}

export function deactivate() {}
