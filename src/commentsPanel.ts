import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ClickUpComment, ClickUpTask, ClickUpUser } from './clickup';
import { imageAttachments, isImage, localImageMap } from './images';
import { formatDate, formatSize, listAttachments, LocalNote, replaceUrls, viewableUrl } from './markdown';
import { escapeHtml, HtmlResolver, markdownToDelta, parseRichText, Person, plainText, toHtml } from './richtext';
import { loadNotes, saveNotes, StoredTask } from './storage';
import { avatar, taskDetailsHtml, taskHeaderHtml } from './taskView';


export type PanelTab = 'desc' | 'comments' | 'notes';

interface Entry {
  panel: vscode.WebviewPanel;
  task: StoredTask;
  people: Person[];
  /** Aba pedida por quem abriu o painel; consumida na próxima renderização. */
  tab?: PanelTab;
  /** URI do webview → arquivo, das imagens baixadas (para abrir no visualizador do VS Code). */
  localFiles: Map<string, string>;
}

const panels = new Map<string, Entry>();

/** URI do webview das imagens baixadas → arquivo e → link original do ClickUp (para o menu de contexto). */
const imageFiles = new Map<string, string>();
const imageLinks = new Map<string, string>();

/**
 * Chave estável para URIs do webview. `asWebviewUri` gera `https://file%2B.vscode-resource…`, mas o
 * navegador do webview normaliza o host para `file+.vscode-resource…` em `img.src`; comparar a
 * string inteira falha. O caminho decodificado é o mesmo nas duas formas.
 */
function imageKey(src: string): string {
  try {
    return decodeURIComponent(new URL(src).pathname);
  } catch {
    return src;
  }
}

/** Resolve o `src` de uma imagem do painel: arquivo local (se baixada) e link do ClickUp para abrir no navegador. */
export function resolveImage(src: string): { file?: string; link: string } {
  const key = imageKey(src);
  return { file: imageFiles.get(key), link: viewableUrl(imageLinks.get(key) ?? src) };
}

export interface CommentActions {
  /** Busca a tarefa de novo no ClickUp (comentários incluídos). */
  refresh(task: StoredTask): Promise<void>;
  /** Publica no ClickUp; `items` é o delta rico, `text` o texto puro como alternativa. */
  post(task: StoredTask, text: string, items: any[] | undefined, notifyAll: boolean, parentId?: string): Promise<void>;
  downloadImages(task: StoredTask): Promise<void>;
  clearImages(task: StoredTask): Promise<void>;
}

interface Message {
  type: string;
  path?: string;
  text?: string;
  notifyAll?: boolean;
  parentId?: string;
  id?: string;
  date?: number;
}

export async function showComments(task: StoredTask, actions: CommentActions, tab: PanelTab = 'comments'): Promise<void> {
  const existing = panels.get(task.dir);
  if (existing) {
    existing.task = task;
    existing.tab = tab;
    existing.panel.reveal();
    await render(existing);
    return;
  }

  const panel = vscode.window.createWebviewPanel('clickupTasks.comments', `📋 ${task.key}`, vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(task.dir)],
  });
  const entry: Entry = { panel, task, people: [], tab, localFiles: new Map() };
  panels.set(task.dir, entry);
  panel.onDidDispose(() => panels.delete(task.dir));

  const refresh = async () => {
    try {
      await actions.refresh(entry.task);
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      await render(entry);
    }
  };

  panel.webview.onDidReceiveMessage(async (msg: Message) => {
    const current = entry.task;
    switch (msg.type) {
      case 'refresh':
        await refresh();
        break;
      case 'post': {
        const text = msg.text?.trim();
        if (!text) break;
        const { items, rich } = markdownToDelta(text, entry.people);
        try {
          await actions.post(current, text, rich ? items : undefined, !!msg.notifyAll, msg.parentId);
        } catch (err) {
          panel.webview.postMessage({ type: 'postFailed', error: err instanceof Error ? err.message : String(err) });
          break;
        }
        panel.webview.postMessage({ type: 'posted' });
        await refresh();
        break;
      }
      case 'saveNote': {
        const text = msg.text?.trim();
        if (!text) break;
        try {
          const notes = await loadNotes(current.dir);
          const note = msg.id ? notes.find((n) => n.id === msg.id) : undefined;
          if (note) {
            note.text = text;
            note.date = msg.date || note.date;
            note.edited = Date.now();
          } else {
            notes.push({ id: `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, text, date: msg.date || Date.now() });
          }
          await saveNotes(current, notes);
        } catch (err) {
          panel.webview.postMessage({ type: 'postFailed', error: err instanceof Error ? err.message : String(err) });
          break;
        }
        panel.webview.postMessage({ type: 'posted' });
        await render(entry);
        break;
      }
      case 'deleteNote': {
        const confirm = await vscode.window.showWarningMessage('Excluir esta nota local?', { modal: true }, 'Excluir');
        if (confirm && msg.id) {
          const notes = await loadNotes(current.dir);
          await saveNotes(current, notes.filter((n) => n.id !== msg.id));
          await render(entry);
        }
        break;
      }
      case 'openTask':
        await vscode.window.showTextDocument(vscode.Uri.file(current.taskFile), { viewColumn: vscode.ViewColumn.One });
        break;
      case 'openUrl':
        if (msg.path?.startsWith('https://')) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.path));
        }
        break;
      case 'openClickUp':
        await vscode.env.openExternal(vscode.Uri.parse(current.url));
        break;
      case 'openImage': {
        const file = msg.path && entry.localFiles.get(imageKey(msg.path));
        if (file) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), vscode.ViewColumn.Active);
        }
        break;
      }
      case 'downloadImages':
        await actions.downloadImages(current);
        break;
      case 'clearImages':
        await actions.clearImages(current);
        break;
      case 'openImagesFolder':
        await vscode.env.openExternal(vscode.Uri.file(path.join(current.dir, 'images')));
        break;
    }
  });

  await render(entry);
}

/** Re-renderiza o painel da tarefa, se estiver aberto (ex.: após reimportar). */
export async function refreshCommentsPanel(task: StoredTask): Promise<void> {
  const entry = panels.get(task.dir);
  if (entry) {
    entry.task = task;
    await render(entry);
  }
}

/** Pessoas que podem ser mencionadas: criador, responsáveis, observadores e quem já comentou. */
function collectPeople(raw: ClickUpTask | undefined, comments: ClickUpComment[]): Person[] {
  const users: (ClickUpUser | undefined)[] = [raw?.creator, ...(raw?.assignees ?? []), ...((raw as any)?.watchers ?? [])];
  const walk = (c: ClickUpComment) => {
    users.push(c.user);
    c.replies?.forEach(walk);
  };
  comments.forEach(walk);
  const people = new Map<number, Person>();
  for (const u of users) {
    // bots do ClickUp têm id negativo
    if (u?.id && u.id > 0 && u.username) {
      people.set(u.id, { id: u.id, username: u.username, picture: u.profilePicture || people.get(u.id)?.picture || undefined });
    }
  }
  return [...people.values()].sort((a, b) => a.username.localeCompare(b.username));
}

async function render(entry: Entry): Promise<void> {
  const { panel, task } = entry;
  const read = async <T>(file: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(path.join(task.dir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  const raw = await read<ClickUpTask | undefined>('task.json', undefined);
  const comments = await read<ClickUpComment[]>('comments.json', []);

  // imagens baixadas viram URIs do webview; as demais são exibidas direto do ClickUp (abrem sem login)
  const local = new Map<string, string>();
  entry.localFiles = new Map();
  for (const [url, rel] of raw ? localImageMap(task.dir, raw) : []) {
    const file = path.join(task.dir, rel);
    const uri = panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    local.set(url, uri);
    entry.localFiles.set(imageKey(uri), file);
    imageFiles.set(imageKey(uri), file);
    imageLinks.set(imageKey(uri), url);
  }
  const resolver: HtmlResolver = {
    image: (url) => local.get(url) ?? (url.startsWith('https://') ? url : undefined),
    link: (url) => local.get(url) ?? viewableUrl(url),
  };

  entry.people = collectPeople(raw, comments);
  const notes = await loadNotes(task.dir);
  const description = raw?.markdown_description || raw?.description || raw?.text_content || '';
  const extra: PageExtra = {
    descriptionHtml: await renderMarkdown(replaceUrls(description, local)),
    attachmentsHtml: raw ? attachmentsHtml(raw, local) : '',
    attachmentCount: raw ? listAttachments(raw).length : 0,
    imageCount: raw ? imageAttachments(raw).length : 0,
    headerHtml: raw ? taskHeaderHtml(raw, task.key) : '',
    detailsHtml: raw ? taskDetailsHtml(raw) : '',
    localImageCount: new Set(entry.localFiles.values()).size,
    tab: entry.tab,
  };
  entry.tab = undefined;
  panel.webview.html = page(panel.webview, task, comments, resolver, entry.people, notes, extra);
}

function relative(ms: string): string {
  const diff = (Number(ms) - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return 'agora';
}

function dayLabel(ms: string): string {
  const label = new Date(Number(ms)).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function commentHtml(comment: ClickUpComment, resolver: HtmlResolver, reply = false): string {
  const lines = parseRichText(comment.comment, comment.comment_text);
  const body = toHtml(lines, resolver) || '<p class="muted">(sem texto)</p>';
  const search = [comment.user?.username, plainText(lines), ...(comment.replies ?? []).map((r) => `${r.user?.username} ${r.comment_text}`)]
    .join(' ')
    .toLowerCase();

  const reactions = new Map<string, number>();
  for (const r of comment.reactions ?? []) reactions.set(r.reaction, (reactions.get(r.reaction) ?? 0) + 1);
  const reactionsHtml = reactions.size
    ? `<div class="reactions">${[...reactions].map(([r, n]) => `<span class="reaction">${escapeHtml(r)} ${n}</span>`).join('')}</div>`
    : '';

  const replies = comment.replies?.length
    ? `<div class="replies">${comment.replies.map((r) => commentHtml(r, resolver, true)).join('')}</div>`
    : '';

  return `
    <article class="comment${reply ? ' reply' : ''}" ${reply ? '' : `data-id="${escapeHtml(comment.id)}" data-date="${escapeHtml(comment.date)}" data-search="${escapeHtml(search)}"`}>
      ${avatar(comment.user)}
      <div class="content">
        <header>
          <span class="author">${escapeHtml(comment.user?.username ?? 'Desconhecido')}</span>
          <span class="date" title="${escapeHtml(formatDate(comment.date))}">${escapeHtml(relative(comment.date))}</span>
          ${reply ? '' : `<button class="link reply-btn" data-id="${escapeHtml(comment.id)}" data-author="${escapeHtml(comment.user?.username ?? '')}">Responder</button>`}
        </header>
        <div class="body">${body}</div>
        ${reactionsHtml}
        ${replies}
      </div>
    </article>`;
}

function noteHtml(note: LocalNote, resolver: HtmlResolver, people: Person[]): string {
  const { items } = markdownToDelta(note.text, people);
  const lines = parseRichText(items, note.text);
  const edited = note.edited
    ? `<span class="edited" title="Editada em ${escapeHtml(formatDate(note.edited))}">· editada</span>`
    : '';
  return `
    <article class="comment note" data-id="note:${escapeHtml(note.id)}" data-date="${note.date}" data-search="${escapeHtml(`nota local ${plainText(lines)}`.toLowerCase())}">
      <div class="avatar note-avatar">🔒</div>
      <div class="content">
        <header>
          <span class="author">Nota local</span>
          <span class="date" title="${escapeHtml(relative(String(note.date)))}">${escapeHtml(formatDate(note.date))}</span>
          ${edited}
          <span class="note-actions">
            <button class="link edit-note" data-id="${escapeHtml(note.id)}">Editar</button>
            <button class="link delete-note" data-id="${escapeHtml(note.id)}">Excluir</button>
          </span>
        </header>
        <div class="body">${toHtml(lines, resolver)}</div>
      </div>
    </article>`;
}

interface PageExtra {
  descriptionHtml: string;
  attachmentsHtml: string;
  attachmentCount: number;
  imageCount: number;
  localImageCount: number;
  headerHtml: string;
  detailsHtml: string;
  tab?: PanelTab;
}

/** Usa o renderizador de Markdown do próprio VS Code (o mesmo do preview). */
async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdown.trim()) {
    return '<p class="muted">(sem descrição)</p>';
  }
  try {
    return await vscode.commands.executeCommand<string>('markdown.api.render', markdown);
  } catch {
    return `<pre class="plain">${escapeHtml(markdown)}</pre>`;
  }
}

function attachmentsHtml(task: ClickUpTask, local: Map<string, string>): string {
  const all = listAttachments(task);
  const images = all.filter(isImage);
  const others = all.filter((a) => !isImage(a));
  const info = (a: (typeof all)[number]) => [formatSize(a.size), formatDate(a.date), a.user?.username].filter(Boolean).join(' · ');
  const gallery = images
    .map(
      (a) =>
        `<figure><img src="${escapeHtml(local.get(a.url) ?? a.url)}" alt="${escapeHtml(a.title)}" loading="lazy"><figcaption title="${escapeHtml(info(a))}">${escapeHtml(a.title)}</figcaption></figure>`,
    )
    .join('');
  const files = others
    .map((a) => `<li><a href="${escapeHtml(viewableUrl(a.url))}">${escapeHtml(a.title)}</a> <span class="muted">${escapeHtml(info(a))}</span></li>`)
    .join('');
  return `${gallery ? `<div class="gallery">${gallery}</div>` : ''}${files ? `<ul class="files">${files}</ul>` : ''}`;
}

function page(
  webview: vscode.Webview,
  task: StoredTask,
  comments: ClickUpComment[],
  resolver: HtmlResolver,
  people: Person[],
  notes: LocalNote[],
  extra: PageExtra,
): string {
  const nonce = randomBytes(16).toString('base64');
  // JSON dentro de <script>: escapa '<' para não fechar a tag
  const peopleJson = JSON.stringify(people).replace(/</g, '\\u003c');
  const replies = comments.reduce((n, c) => n + (c.replies?.length ?? 0), 0);
  const authors = new Set(comments.map((c) => c.user?.username)).size;

  // comentários do ClickUp e notas locais ficam em abas separadas, cada lista agrupada por dia
  const byDay = (items: { date: number; html: () => string }[]) => {
    const days = new Map<string, typeof items>();
    for (const item of [...items].sort((a, b) => a.date - b.date)) {
      const key = new Date(item.date).toDateString();
      days.set(key, [...(days.get(key) ?? []), item]);
    }
    return [...days.values()]
      .map(
        (group) => `
      <section class="day">
        <div class="day-label"><span>${escapeHtml(dayLabel(String(group[0].date)))}</span></div>
        ${group.map((item) => item.html()).join('')}
      </section>`,
      )
      .join('');
  };
  const commentList = byDay(comments.map((c) => ({ date: Number(c.date), html: () => commentHtml(c, resolver) })));
  const noteList = byDay(notes.map((n) => ({ date: n.date, html: () => noteHtml(n, resolver, people) })));
  const notesJson = JSON.stringify(notes.map(({ id, text, date }) => ({ id, text, date }))).replace(/</g, '\\u003c');

  const commentStats = comments.length
    ? `${comments.length} comentário(s) · ${replies} resposta(s) · ${authors} pessoa(s)`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { --gap: 14px; --border: var(--vscode-panel-border, rgba(128,128,128,.25)); --muted: var(--vscode-descriptionForeground); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .top { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); padding: 0 20px 10px; }
  .task-head { padding: 16px 20px 4px; max-width: 980px; }
  .crumbs { color: var(--muted); font-size: .85em; margin-bottom: 6px; }
  .crumbs .sep { opacity: .6; margin: 0 2px; }
  .task-head h1 { margin: 0 0 10px; font-size: 1.35em; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
  .task-head h1 .key, .subtasks .key { color: var(--vscode-textLink-foreground); font-weight: 600; margin-right: 4px; }
  .pills { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
  .status-pill { display: inline-block; padding: 3px 10px; border-radius: 4px; color: #fff; font-size: .8em; font-weight: 700; letter-spacing: .03em; text-shadow: 0 0 2px rgba(0,0,0,.35); }
  .status-pill.sm { padding: 1px 6px; font-size: .72em; }
  .prio { font-weight: 600; font-size: .9em; }
  .tag { padding: 2px 8px; border-radius: 10px; color: #fff; font-size: .78em; font-weight: 600; }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px 18px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-sideBar-background, transparent); }
  .meta-label { color: var(--muted); font-size: .72em; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
  .meta-value { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 22px; }
  .person { display: inline-flex; align-items: center; gap: 6px; }
  .stack { display: inline-flex; }
  .stack .avatar { margin-right: -6px; box-shadow: 0 0 0 2px var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .avatar.sm { width: 22px; height: 22px; font-size: 9px; }
  .bar { flex-basis: 100%; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--vscode-progressBar-background, #0078d4); }
  .overdue { color: var(--vscode-errorForeground, #e44c4c); font-weight: 600; }
  .fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 18px; }
  .field { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; overflow-wrap: anywhere; }
  .checklist, .subtasks { list-style: none; margin: 0; padding: 0; }
  .checklist li, .subtasks li { padding: 4px 0; border-bottom: 1px solid var(--border); }
  .checklist li.done { color: var(--muted); text-decoration: line-through; }
  h3.section .count { color: var(--muted); font-weight: 400; margin-left: 4px; }
  .toolbar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  input[type=search] { flex: 1 1 180px; min-width: 0; padding: 4px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; outline: none; }
  input[type=search]:focus { border-color: var(--vscode-focusBorder); }
  button { padding: 4px 10px; border: none; border-radius: 4px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); white-space: nowrap; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .6; cursor: default; }
  main { padding: 4px 20px; max-width: 900px; }
  .day-label { display: flex; align-items: center; gap: 10px; margin: 18px 0 10px; color: var(--muted); font-size: .85em; }
  .day-label::before, .day-label::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
  .comment { display: flex; gap: 12px; padding: 12px 14px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-sideBar-background, transparent); }
  .comment.reply { border: none; border-left: 2px solid var(--border); border-radius: 0; padding: 6px 0 6px 12px; margin: 8px 0 0; background: transparent; }
  .avatar { position: relative; overflow: hidden; flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 600; }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: var(--vscode-editor-background); }
  .reply .avatar { width: 24px; height: 24px; font-size: 10px; }
  .content { flex: 1; min-width: 0; }
  header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .author { font-weight: 600; }
  .date { color: var(--muted); font-size: .88em; cursor: default; }
  .body { margin-top: 6px; line-height: 1.5; overflow-wrap: anywhere; }
  .body p { margin: 0; }
  .body p.gap { height: .6em; }
  .body h4 { margin: 8px 0 4px; font-size: 1.05em; }
  .body ul, .body ol { margin: 4px 0; padding-left: 22px; }
  .body ul.checklist { list-style: none; padding-left: 4px; }
  .body img { display: block; max-width: 100%; max-height: 360px; margin: 6px 0; border-radius: 6px; border: 1px solid var(--border); }
  .body pre { margin: 6px 0; padding: 8px 10px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); overflow-x: auto; font-family: var(--vscode-editor-font-family); }
  .body code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .body blockquote { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--border)); background: var(--vscode-textBlockQuote-background); }
  .body .banner { margin: 6px 0; padding: 8px 10px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, rgba(249,190,52,.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(249,190,52,.5)); }
  .mention { color: var(--vscode-textLink-foreground); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 0 5px; border-radius: 10px; font-size: .92em; }
  a { color: var(--vscode-textLink-foreground); }
  .reactions { display: flex; gap: 6px; margin-top: 8px; }
  .reaction { padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); font-size: .9em; }
  .empty { text-align: center; color: var(--muted); padding: 48px 0; }
  .hidden { display: none !important; }
  .body img { cursor: zoom-in; }
  .body img.remote { cursor: alias; }
  .images-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-size: .92em; }
  .images-bar .actions { margin-left: auto; display: flex; gap: 6px; }
  .images-bar code.path { font-family: var(--vscode-editor-font-family); font-size: .92em; user-select: all; overflow-wrap: anywhere; }
  .tabs { display: flex; gap: 2px; padding-top: 8px; border-bottom: 1px solid var(--border); }
  .tabs .tab { border-radius: 4px 4px 0 0; background: transparent; color: var(--muted); padding: 5px 12px; border-bottom: 2px solid transparent; }
  .tabs .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  #desc, main.timeline { display: none; }
  body[data-tab="desc"] #desc, body[data-tab="comments"] #list, body[data-tab="notes"] #notes { display: block; }
  body[data-tab="desc"] .composer, body[data-tab="desc"] #search, body[data-tab="desc"] #sort { display: none !important; }
  .composer-title { color: var(--muted); font-size: .85em; }
  #desc { padding: 12px 20px 40px; max-width: 900px; }
  #desc .description { line-height: 1.55; }
  #desc .description img { max-height: 420px; }
  #desc h3.section { margin: 28px 0 10px; font-size: 1em; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .gallery figure { margin: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--vscode-sideBar-background, transparent); }
  .gallery img { display: block; width: 100%; height: 110px; object-fit: cover; margin: 0; border: none; border-radius: 0; max-height: none; }
  .gallery figcaption { padding: 4px 6px; font-size: .82em; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .files { margin: 12px 0 0; padding-left: 18px; }
  .files li { margin: 3px 0; }
  .muted { color: var(--muted); }
  pre.plain { white-space: pre-wrap; }
  .lightbox { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; background: rgba(0,0,0,.88); }
  .lb-bar { display: flex; gap: 6px; align-items: center; justify-content: flex-end; padding: 8px 12px; }
  .lb-bar span { color: #ddd; margin-right: auto; font-size: .9em; }
  .lb-stage { position: relative; flex: 1; overflow: hidden; cursor: grab; }
  .lb-stage.dragging { cursor: grabbing; }
  .lb-stage img { position: absolute; top: 0; left: 0; transform-origin: 0 0; max-width: none; max-height: none; border: none; margin: 0; user-select: none; -webkit-user-drag: none; }
  button.link { padding: 0; background: none; color: var(--muted); font-size: .88em; margin-left: auto; }
  button.link:hover { background: none; color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .comment.target { border-color: var(--vscode-focusBorder); }
  .composer { position: sticky; bottom: 0; z-index: 2; background: var(--vscode-editor-background); border-top: 1px solid var(--border); padding: 10px 20px 12px; margin-top: 12px; }
  .composer .inner { max-width: 860px; }
  .reply-to { display: flex; gap: 6px; align-items: baseline; font-size: .9em; color: var(--vscode-foreground); }
  .actions:has(.reply-to:not(.hidden)) .hint { display: none; }
  .composer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .format { display: inline-flex; gap: 2px; }
  .format button { min-width: 28px; padding: 3px 7px; background: transparent; color: var(--muted); }
  .format button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-button-secondaryBackground)); color: var(--vscode-foreground); }
  .comment.note { border-style: dashed; background: var(--vscode-editorWidget-background, transparent); }
  .note-avatar { background: var(--vscode-badge-background); font-size: 15px; }
  .note-actions { margin-left: auto; display: flex; gap: 10px; }
  .note-actions button.link { margin-left: 0; }
  .edited { color: var(--muted); font-size: .85em; font-style: italic; }
  input[type=datetime-local] { padding: 2px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; color-scheme: dark light; }
  body.mode-note textarea { border-style: dashed; }
  .reply-to button.link { margin-left: 0; }
  .input-wrap { position: relative; }
  textarea { width: 100%; height: 150px; min-height: 80px; max-height: 60vh; resize: vertical; padding: 8px 10px; font-family: inherit; font-size: inherit; line-height: 1.45; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 6px; outline: none; }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .suggest { position: absolute; left: 8px; bottom: calc(100% + 4px); margin: 0; padding: 4px 0; list-style: none; min-width: 220px; background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-editorSuggestWidget-border, var(--border)); border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
  .suggest li { padding: 4px 10px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  .suggest li.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .suggest .avatar { width: 20px; height: 20px; font-size: 9px; }
  .composer .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  .composer .hint { color: var(--muted); font-size: .85em; flex: 1; min-width: 200px; }
  .composer .hint code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .composer label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: .9em; cursor: pointer; }
  .error { margin-bottom: 8px; padding: 6px 10px; border-radius: 4px; background: var(--vscode-inputValidation-errorBackground, rgba(228,76,76,.15)); border: 1px solid var(--vscode-inputValidation-errorBorder, #e44c4c); }
</style>
</head>
<body>
  ${extra.headerHtml || `<div class="task-head"><h1><span class="key">${escapeHtml(task.key)}</span> ${escapeHtml(task.name)}</h1></div>`}
  <div class="top">
    <div class="tabs">
      <button class="tab" data-tab="desc">Descrição${extra.attachmentCount ? ` · ${extra.attachmentCount} anexo(s)` : ''}</button>
      <button class="tab" data-tab="comments" title="${escapeHtml(commentStats)}">Comentários (${comments.length})</button>
      <button class="tab" data-tab="notes" title="Anotações só deste computador, nunca enviadas ao ClickUp">🔒 Notas locais (${notes.length})</button>
    </div>
    <div class="toolbar">
      <input type="search" id="search" placeholder="Buscar nos comentários…">
      <button id="sort" title="Inverter ordem">↓ Mais antigos</button>
      <button id="refresh" class="primary" title="Buscar comentários novos no ClickUp">↻ Atualizar</button>
      <button id="task" title="Abrir task.md">task.md</button>
      <button id="clickup" title="Abrir no ClickUp">ClickUp ↗</button>
    </div>
  </div>
  <main id="desc">
    ${
      extra.imageCount
        ? `<div class="images-bar">${
            extra.localImageCount
              ? `<span>🖼 ${extra.localImageCount} de ${extra.imageCount} imagem(ns) baixada(s): clique para ampliar, botão direito para copiar o caminho. Apagadas sozinhas após o prazo.<br>
                 <code class="path" title="Pasta das imagens">${escapeHtml(path.join(task.dir, 'images'))}</code></span>
                 <span class="actions"><button id="openImagesFolder">Abrir pasta</button><button id="clearImages">Limpar imagens</button></span>`
              : `<span>🌐 ${extra.imageCount} imagem(ns) pelo link: clique abre no navegador.</span>
                 <span class="actions"><button id="downloadImages" class="primary">Baixar imagens</button></span>`
          }</div>`
        : ''
    }
    <div class="body description">${extra.descriptionHtml}</div>
    ${extra.detailsHtml}
    ${extra.attachmentsHtml ? `<h3 class="section">Anexos (${extra.attachmentCount})</h3><div class="body">${extra.attachmentsHtml}</div>` : ''}
  </main>
  <main id="list" class="timeline">
    ${commentList || '<div class="empty">Nenhum comentário nesta tarefa.</div>'}
    <div class="empty hidden nomatch">Nenhum comentário encontrado.</div>
  </main>
  <main id="notes" class="timeline">
    ${noteList || '<div class="empty">Nenhuma nota local ainda. Escreva abaixo: ela fica só neste computador (notes.json e task.md) e nunca vai para o ClickUp.</div>'}
    <div class="empty hidden nomatch">Nenhuma nota encontrada.</div>
  </main>
  <footer class="composer">
    <div class="inner">
      <div class="composer-head">
        <div class="composer-title" id="composerTitle"></div>
        <div class="format" role="toolbar" aria-label="Formatação">
          <button data-format="bold" title="Negrito (Ctrl+B)"><b>B</b></button>
          <button data-format="italic" title="Itálico (Ctrl+I)"><i>I</i></button>
          <button data-format="code" title="Código (Ctrl+E)">&lt;/&gt;</button>
          <button data-format="link" title="Link (Ctrl+K)">🔗</button>
        </div>
      </div>
      <div class="error hidden" id="error"></div>
      <div class="input-wrap">
        <ul class="suggest hidden" id="suggest"></ul>
        <textarea id="text" placeholder="Escreva um comentário… (@ para mencionar)"></textarea>
      </div>
      <div class="actions">
        <div class="reply-to hidden" id="replyTo">↳ Respondendo a <strong id="replyAuthor"></strong> <button class="link" id="cancelReply">cancelar</button></div>
        <div class="reply-to hidden" id="editing">✎ Editando nota local <button class="link" id="cancelEdit">cancelar</button></div>
        <span class="hint">Ctrl+B negrito · Ctrl+I itálico · Ctrl+E código · Ctrl+K link · @ menciona · Ctrl+Enter envia</span>
        <label id="notifyLabel" title="Notifica todos os observadores da tarefa"><input type="checkbox" id="notify"> Notificar todos</label>
        <label id="dateLabel" class="hidden" title="Data da nota (vazio = agora)">📅 <input type="datetime-local" id="noteDate"></label>
        <button class="primary" id="send">Comentar</button>
      </div>
    </div>
  </footer>
  <div id="lightbox" class="lightbox hidden">
    <div class="lb-bar">
      <span id="lbInfo"></span>
      <button id="lbOut" title="Diminuir (-)">−</button>
      <button id="lbIn" title="Aumentar (+)">+</button>
      <button id="lbFit" title="Ajustar à tela (0)">Ajustar</button>
      <button id="lbReal" title="Tamanho real (1)">1:1</button>
      <button id="lbVscode" title="Abre no visualizador de imagens do VS Code">Abrir em aba</button>
      <button id="lbClose" class="primary" title="Fechar (Esc)">✕</button>
    </div>
    <div class="lb-stage" id="lbStage"><img id="lbImg" alt=""></div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { newest: false, query: '' };
  const list = document.getElementById('list');
  const notesList = document.getElementById('notes');
  const lists = [list, notesList];
  const sortBtn = document.getElementById('sort');
  const search = document.getElementById('search');

  function reverse(parent, selector) {
    const items = [...parent.querySelectorAll(':scope > ' + selector)];
    items.reverse().forEach((el) => parent.insertBefore(el, parent.querySelector('.nomatch')));
  }
  function applySort() {
    sortBtn.textContent = state.newest ? '↑ Mais recentes' : '↓ Mais antigos';
  }
  function toggleSort() {
    state.newest = !state.newest;
    lists.forEach((main) => {
      reverse(main, 'section.day');
      main.querySelectorAll('section.day').forEach((day) => {
        const items = [...day.querySelectorAll(':scope > article')].reverse();
        items.forEach((el) => day.appendChild(el));
      });
    });
    applySort();
    vscode.setState(state);
  }
  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    lists.forEach((main) => {
      let visible = 0;
      main.querySelectorAll('section.day').forEach((day) => {
        let any = false;
        day.querySelectorAll(':scope > article').forEach((el) => {
          const show = !q || el.dataset.search.includes(q);
          el.classList.toggle('hidden', !show);
          any = any || show;
          if (show) visible++;
        });
        day.classList.toggle('hidden', !any);
      });
      main.querySelector('.nomatch').classList.toggle('hidden', !q || visible > 0);
    });
    state.query = search.value;
    vscode.setState(state);
  }

  sortBtn.addEventListener('click', toggleSort);
  search.addEventListener('input', applyFilter);
  document.getElementById('refresh').addEventListener('click', (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Atualizando…';
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('task').addEventListener('click', () => vscode.postMessage({ type: 'openTask' }));
  document.getElementById('clickup').addEventListener('click', () => vscode.postMessage({ type: 'openClickUp' }));
  // ---------- abas ----------
  const forcedTab = ${JSON.stringify(extra.tab ?? null)};
  /** A aba define o que o editor faz: Comentários publica no ClickUp, Notas locais grava só aqui. */
  function setTab(tab) {
    state.tab = ['desc', 'comments', 'notes'].includes(tab) ? tab : 'comments';
    document.body.dataset.tab = state.tab;
    document.querySelectorAll('.tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    search.placeholder = state.tab === 'notes' ? 'Buscar nas notas…' : 'Buscar nos comentários…';
    if (state.tab === 'comments') setMode('clickup');
    if (state.tab === 'notes') setMode('note');
    vscode.setState(state);
  }
  document.querySelectorAll('.tabs .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- novo comentário ----------
  const people = ${peopleJson};
  const notes = ${notesJson};
  const noteDate = document.getElementById('noteDate');
  const text = document.getElementById('text');
  const send = document.getElementById('send');
  const notify = document.getElementById('notify');
  const suggest = document.getElementById('suggest');
  const errorBox = document.getElementById('error');
  let matches = [];
  let active = 0;

  function initials(name) {
    return name.split(/\\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }
  function save() {
    state.draft = text.value;
    vscode.setState(state);
    autosize();
  }

  // cresce com o conteúdo, de 150px até 60% da altura do painel; se o usuário puxar o canto, essa altura vira o mínimo
  const BASE_HEIGHT = 150;
  let manualMin = 0;
  let autoHeight = 0;
  function autosize() {
    const max = Math.max(BASE_HEIGHT, window.innerHeight * 0.6);
    text.style.height = 'auto';
    const content = text.scrollHeight + 2;
    autoHeight = Math.round(Math.min(max, Math.max(BASE_HEIGHT, manualMin, content)));
    text.style.height = autoHeight + 'px';
    text.style.overflowY = content > max ? 'auto' : 'hidden';
  }
  text.addEventListener('mouseup', () => {
    // redimensionado pelo canto (a altura mudou sem digitar)
    if (autoHeight && Math.abs(text.offsetHeight - autoHeight) > 2) {
      manualMin = text.offsetHeight;
      autoHeight = text.offsetHeight;
    }
  });
  window.addEventListener('resize', autosize);
  function buttonLabel() {
    if (state.mode === 'note') return state.editNote ? 'Salvar nota' : 'Adicionar nota';
    return state.replyTo ? 'Responder' : 'Comentar';
  }
  function highlight(articleId) {
    document.querySelectorAll('article.target').forEach((el) => el.classList.remove('target'));
    if (articleId) document.querySelector('article[data-id="' + CSS.escape(articleId) + '"]')?.classList.add('target');
  }
  function toLocalInput(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function setMode(mode) {
    state.mode = mode === 'note' ? 'note' : 'clickup';
    document.body.classList.toggle('mode-note', state.mode === 'note');
    document.getElementById('composerTitle').textContent = state.mode === 'note' ? '🔒 Nova nota local' : '💬 Novo comentário no ClickUp';
    document.getElementById('notifyLabel').classList.toggle('hidden', state.mode === 'note');
    document.getElementById('dateLabel').classList.toggle('hidden', state.mode !== 'note');
    text.placeholder = state.mode === 'note'
      ? 'Nota visível só para você… (fica no notes.json e no task.md)'
      : 'Escreva um comentário… (@ para mencionar)';
    if (state.mode === 'note' && state.replyTo) setReply();
    if (state.mode === 'clickup' && state.editNote) setEdit();
    send.textContent = buttonLabel();
    vscode.setState(state);
  }
  function setReply(id, author) {
    state.replyTo = id ? { id, author } : undefined;
    if (id && state.tab !== 'comments') setTab('comments');
    document.getElementById('replyTo').classList.toggle('hidden', !id);
    document.getElementById('replyAuthor').textContent = author || '';
    send.textContent = buttonLabel();
    highlight(id);
    vscode.setState(state);
  }
  function setEdit(id) {
    const note = id && notes.find((n) => n.id === id);
    const wasEditing = !!state.editNote;
    state.editNote = note ? note.id : undefined;
    if (note) {
      if (state.tab !== 'notes') setTab('notes');
      text.value = note.text;
      noteDate.value = toLocalInput(note.date);
      save();
    } else if (wasEditing) {
      text.value = '';
      noteDate.value = '';
      save();
    }
    document.getElementById('editing').classList.toggle('hidden', !note);
    send.textContent = buttonLabel();
    highlight(note ? 'note:' + note.id : undefined);
    vscode.setState(state);
  }
  function mentionQuery() {
    const m = text.value.slice(0, text.selectionStart).match(/(?:^|\\s)@([^@\\n]{0,30})$/);
    return m ? m[1].toLowerCase() : null;
  }
  function hideSuggest() {
    suggest.classList.add('hidden');
    matches = [];
  }
  function renderSuggest() {
    suggest.innerHTML = '';
    matches.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = i === active ? 'active' : '';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = '#7b68ee';
      av.textContent = initials(p.username);
      if (p.picture && p.picture.startsWith('https://')) {
        const img = document.createElement('img');
        img.src = p.picture;
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove());
        av.appendChild(img);
      }
      li.append(av, document.createTextNode(p.username));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(p); });
      suggest.appendChild(li);
    });
    suggest.classList.toggle('hidden', !matches.length);
  }
  function updateSuggest() {
    const q = mentionQuery();
    if (q === null) return hideSuggest();
    matches = people
      .filter((p) => { const n = p.username.toLowerCase(); return n.startsWith(q) || n.split(/\\s+/).some((w) => w.startsWith(q)); })
      .slice(0, 6);
    active = 0;
    renderSuggest();
  }
  function pick(p) {
    const pos = text.selectionStart;
    const before = text.value.slice(0, pos).replace(/@([^@\\n]{0,30})$/, '@' + p.username + ' ');
    text.value = before + text.value.slice(pos);
    text.selectionStart = text.selectionEnd = before.length;
    hideSuggest();
    save();
    text.focus();
  }
  function submit() {
    const value = text.value.trim();
    if (!value || send.disabled) return;
    send.disabled = true;
    send.textContent = 'Enviando…';
    errorBox.classList.add('hidden');
    if (state.mode === 'note') {
      const date = noteDate.value ? new Date(noteDate.value).getTime() : undefined;
      vscode.postMessage({ type: 'saveNote', text: value, id: state.editNote, date });
    } else {
      vscode.postMessage({ type: 'post', text: value, notifyAll: notify.checked, parentId: state.replyTo?.id });
    }
  }

  text.addEventListener('input', () => { save(); updateSuggest(); });
  text.addEventListener('click', updateSuggest);
  text.addEventListener('blur', () => setTimeout(hideSuggest, 100));
  // ---------- formatação (atalhos e botões) ----------
  const MARKERS = { bold: ['**', '**'], italic: ['_', '_'], code: ['\`', '\`'] };
  const SHORTCUTS = { b: 'bold', i: 'italic', e: 'code', k: 'link' };

  /** Substitui um trecho mantendo o Ctrl+Z do textarea (execCommand preserva o histórico). */
  function replaceRange(start, end, value, selStart, selEnd) {
    text.focus();
    text.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, value)) text.setRangeText(value, start, end, 'end');
    text.setSelectionRange(selStart, selEnd);
    save();
  }
  function applyFormat(kind) {
    const v = text.value;
    const s = text.selectionStart;
    const e = text.selectionEnd;
    const sel = v.slice(s, e);
    if (kind === 'link') {
      const label = sel || 'texto';
      const md = '[' + label + '](url)';
      const urlStart = s + label.length + 3;
      return replaceRange(s, e, md, sel ? urlStart : s + 1, sel ? urlStart + 3 : s + 1 + label.length);
    }
    const [open, close] = MARKERS[kind];
    // já formatado em volta da seleção → remove
    if (v.slice(s - open.length, s) === open && v.slice(e, e + close.length) === close) {
      return replaceRange(s - open.length, e + close.length, sel, s - open.length, e - open.length);
    }
    // seleção inclui os marcadores → remove
    if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
      const inner = sel.slice(open.length, sel.length - close.length);
      return replaceRange(s, e, inner, s, s + inner.length);
    }
    replaceRange(s, e, open + sel + close, s + open.length, s + open.length + sel.length);
  }
  document.querySelectorAll('.format button').forEach((b) =>
    b.addEventListener('mousedown', (e) => {
      e.preventDefault(); // não tira o foco/seleção do textarea
      applyFormat(b.dataset.format);
    }),
  );

  text.addEventListener('keydown', (e) => {
    const shortcut = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && SHORTCUTS[e.key.toLowerCase()];
    if (shortcut) {
      // stopPropagation: o webview repassa teclas ao VS Code (Ctrl+B esconderia a barra lateral, Ctrl+E abriria o Quick Open)
      e.preventDefault();
      e.stopPropagation();
      applyFormat(shortcut);
      return;
    }
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
        return renderSuggest();
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(matches[active]); }
      if (e.key === 'Escape') { e.preventDefault(); return hideSuggest(); }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && state.replyTo) setReply();
    if (e.key === 'Escape' && state.editNote) setEdit();
  });
  send.addEventListener('click', submit);
  document.getElementById('cancelReply').addEventListener('click', () => setReply());
  document.getElementById('cancelEdit').addEventListener('click', () => setEdit());
  document.addEventListener('click', (e) => {
    const reply = e.target.closest('.reply-btn');
    if (reply) { setReply(reply.dataset.id, reply.dataset.author); text.focus(); return; }
    const edit = e.target.closest('.edit-note');
    if (edit) { setEdit(edit.dataset.id); text.focus(); return; }
    const del = e.target.closest('.delete-note');
    if (del) vscode.postMessage({ type: 'deleteNote', id: del.dataset.id });
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'posted') {
      state.draft = '';
      text.value = '';
      noteDate.value = '';
      state.editNote = undefined;
      manualMin = 0;
      autosize();
      setReply();
      send.textContent = 'Atualizando…';
    } else if (msg.type === 'postFailed') {
      send.disabled = false;
      send.textContent = buttonLabel();
      errorBox.textContent = (state.mode === 'note' ? 'Não foi possível salvar: ' : 'Não foi possível enviar: ') + msg.error;
      errorBox.classList.remove('hidden');
    }
  });

  setTab(forcedTab || state.tab || 'comments');
  if (state.draft) text.value = state.draft;
  autosize();
  if (state.replyTo) setReply(state.replyTo.id, state.replyTo.author);
  if (state.editNote) {
    const draft = text.value;
    setEdit(state.editNote);
    if (draft) { text.value = draft; save(); }
  }

  // ---------- ampliar imagens ----------
  const lightbox = document.getElementById('lightbox');
  const lbStage = document.getElementById('lbStage');
  const lbImg = document.getElementById('lbImg');
  const view = { s: 1, x: 0, y: 0 };
  let lbHref = '';

  function lbApply() {
    lbImg.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')';
    document.getElementById('lbInfo').textContent = Math.round(view.s * 100) + '% · ' + lbImg.naturalWidth + '×' + lbImg.naturalHeight + ' · roda do mouse: zoom · arrastar: mover · duplo clique: ajustar/1:1';
  }
  function lbZoomAt(factor, cx, cy) {
    const s = Math.min(20, Math.max(0.05, view.s * factor));
    view.x = cx - (cx - view.x) * (s / view.s);
    view.y = cy - (cy - view.y) * (s / view.s);
    view.s = s;
    lbApply();
  }
  function lbCenter(s) {
    const w = lbStage.clientWidth, h = lbStage.clientHeight;
    view.s = s;
    view.x = (w - lbImg.naturalWidth * s) / 2;
    view.y = (h - lbImg.naturalHeight * s) / 2;
    lbApply();
  }
  function lbFitScale() {
    return Math.min(1, lbStage.clientWidth / lbImg.naturalWidth, lbStage.clientHeight / lbImg.naturalHeight);
  }
  /** Menu de contexto nativo do VS Code (webview/context) para imagens. */
  function setImageContext(el, src) {
    el.dataset.vscodeContext = JSON.stringify({ clickupImage: true, clickupImageLocal: isLocal(src), imageSrc: src, preventDefaultContextMenuItems: true });
  }
  function openLightbox(img) {
    lbHref = img.src;
    setImageContext(lbImg, img.src);
    lightbox.classList.remove('hidden');
    lbImg.onload = () => lbCenter(lbFitScale());
    lbImg.src = img.src;
    if (lbImg.complete && lbImg.naturalWidth) lbCenter(lbFitScale());
  }
  function closeLightbox() {
    lightbox.classList.add('hidden');
    lbImg.removeAttribute('src');
  }
  const stageCenter = () => [lbStage.clientWidth / 2, lbStage.clientHeight / 2];

  // imagem baixada (URI do webview) amplia aqui; remota abre no navegador
  const isLocal = (src) => src.includes('vscode-resource') || src.includes('vscode-cdn');
  const viewable = (src) => (src.includes('clickup-attachments.com/') && !src.includes('?') ? src + '?view=open' : src);
  document.querySelectorAll('.body img').forEach((img) => {
    const local = isLocal(img.src);
    img.classList.toggle('remote', !local);
    img.title = local ? 'Clique para ampliar' : 'Clique para abrir no navegador';
    setImageContext(img, img.src);
  });
  document.addEventListener('click', (e) => {
    const img = e.target.closest('.body img');
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    if (isLocal(img.src)) openLightbox(img);
    else vscode.postMessage({ type: 'openUrl', path: viewable(img.src) });
  }, true);
  document.getElementById('downloadImages')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Baixando…';
    vscode.postMessage({ type: 'downloadImages' });
  });
  document.getElementById('clearImages')?.addEventListener('click', () => vscode.postMessage({ type: 'clearImages' }));
  document.getElementById('openImagesFolder')?.addEventListener('click', () => vscode.postMessage({ type: 'openImagesFolder' }));
  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  document.getElementById('lbIn').addEventListener('click', () => lbZoomAt(1.25, ...stageCenter()));
  document.getElementById('lbOut').addEventListener('click', () => lbZoomAt(1 / 1.25, ...stageCenter()));
  document.getElementById('lbFit').addEventListener('click', () => lbCenter(lbFitScale()));
  document.getElementById('lbReal').addEventListener('click', () => lbCenter(1));
  document.getElementById('lbVscode').addEventListener('click', () => vscode.postMessage({ type: 'openImage', path: lbHref }));
  lbStage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = lbStage.getBoundingClientRect();
    lbZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  lbStage.addEventListener('dblclick', (e) => {
    const fit = lbFitScale();
    if (Math.abs(view.s - fit) < 0.01) {
      const r = lbStage.getBoundingClientRect();
      lbZoomAt(1 / view.s, e.clientX - r.left, e.clientY - r.top);
    } else {
      lbCenter(fit);
    }
  });
  let drag;
  lbStage.addEventListener('pointerdown', (e) => {
    drag = { px: e.clientX, py: e.clientY, x: view.x, y: view.y, moved: false };
    lbStage.setPointerCapture(e.pointerId);
    lbStage.classList.add('dragging');
  });
  lbStage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.x = drag.x + e.clientX - drag.px;
    view.y = drag.y + e.clientY - drag.py;
    drag.moved = drag.moved || Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py) > 4;
    lbApply();
  });
  lbStage.addEventListener('pointerup', (e) => {
    // clique sem arrastar fora da imagem fecha
    if (drag && !drag.moved && e.target === lbStage) closeLightbox();
    drag = undefined;
    lbStage.classList.remove('dragging');
  });
  document.addEventListener('keydown', (e) => {
    if (lightbox.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); }
    else if (e.key === '+' || e.key === '=') lbZoomAt(1.25, ...stageCenter());
    else if (e.key === '-') lbZoomAt(1 / 1.25, ...stageCenter());
    else if (e.key === '0') lbCenter(lbFitScale());
    else if (e.key === '1') lbCenter(1);
  }, true);

  // fotos que falharem (link expirado, sem rede) voltam para as iniciais
  document.querySelectorAll('.avatar img').forEach((img) => {
    if (img.complete && !img.naturalWidth) img.remove();
    else img.addEventListener('error', () => img.remove());
  });

  if (state.newest) { state.newest = false; toggleSort(); }
  applySort();
  if (state.query) { search.value = state.query; applyFilter(); }
</script>
</body>
</html>`;
}
