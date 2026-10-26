import { existsSync, mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { listStoredTasks, StoredTask } from './storage';

/**
 * ThemeColor só aceita cores registradas, então cada cor de status do ClickUp
 * vira um SVG gerado uma vez na pasta de armazenamento da extensão.
 */
function statusIcon(iconDir: string, color: string | undefined, shape: 'dot' | 'ring'): vscode.Uri | vscode.ThemeIcon {
  if (!color || !/^#[0-9a-f]{3,8}$/i.test(color)) {
    return new vscode.ThemeIcon(shape === 'dot' ? 'circle-filled' : 'circle-large-outline');
  }
  const file = path.join(iconDir, `status-${shape}-${color.slice(1).toLowerCase()}.svg`);
  if (!existsSync(file)) {
    mkdirSync(iconDir, { recursive: true });
    const svg =
      shape === 'dot'
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4.5" fill="${color}"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
    writeFileSync(file, svg);
  }
  return vscode.Uri.file(file);
}

export class TaskItem extends vscode.TreeItem {
  constructor(readonly task: StoredTask, iconDir: string, grouped: boolean, running: boolean) {
    super(task.key, vscode.TreeItemCollapsibleState.None);
    this.id = `task:${task.dir}`;
    this.description = task.name;
    this.tooltip = new vscode.MarkdownString(
      `**${task.key}** — ${task.name}\n\nStatus: **${task.status.toUpperCase()}**${running ? '\n\n⏱ **Timer rodando**' : ''}\n\n\`${task.dir}\``,
    );
    // agrupado, o status já está no grupo; solto, a cor do status fica no ícone da tarefa
    this.iconPath = running
      ? new vscode.ThemeIcon('record', new vscode.ThemeColor('charts.red'))
      : grouped
        ? new vscode.ThemeIcon('tasklist')
        : statusIcon(iconDir, task.statusColor, 'ring');
    // o sufixo escolhe o botão ▶ ou ■ nos menus
    this.contextValue = running ? 'clickupTasks.task.running' : 'clickupTasks.task';
    this.command = { command: 'clickupTasks.openDescription', title: 'Abrir tarefa', arguments: [this] };
  }
}

export class StatusGroup extends vscode.TreeItem {
  constructor(readonly status: string, readonly tasks: TaskItem[], color: string | undefined, done: boolean, iconDir: string) {
    super(status.toUpperCase(), done ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
    this.id = `status:${status}`;
    this.description = String(tasks.length);
    this.iconPath = statusIcon(iconDir, color, 'dot');
    this.contextValue = 'clickupTasks.status';
  }
}

type Node = StatusGroup | TaskItem;

export interface TaskFilter {
  /** Status (em minúsculas) a mostrar; vazio mostra todos. */
  statuses: string[];
  query: string;
}

const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Todos os termos precisam aparecer no título ou no ID. */
function matchesQuery(task: StoredTask, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const haystack = normalize(`${task.name} ${task.key}`);
  return terms.every((term) => haystack.includes(term));
}

export class TaskTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly counted = new vscode.EventEmitter<{ shown: number; total: number }>();
  /** Disparado a cada renderização, com quantas tarefas passaram no filtro. */
  readonly onDidCount = this.counted.event;
  filter: TaskFilter = { statuses: [], query: '' };
  /** ID nativo da tarefa com timer rodando no ClickUp. */
  runningTaskId?: string;

  constructor(
    private readonly baseFolder: () => string | undefined,
    private readonly iconDir: string,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  setFilter(filter: TaskFilter): void {
    this.filter = filter;
    this.refresh();
  }

  get isFiltered(): boolean {
    return this.filter.statuses.length > 0 || !!this.filter.query.trim();
  }

  getTreeItem(item: Node): Node {
    return item;
  }

  async getChildren(item?: Node): Promise<Node[]> {
    if (item instanceof StatusGroup) {
      return item.tasks;
    }
    const base = this.baseFolder();
    if (item || !base) {
      return [];
    }
    const all = await listStoredTasks(base);
    const { statuses, query } = this.filter;
    const tasks = all.filter((t) => (!statuses.length || statuses.includes(t.status.toLowerCase())) && matchesQuery(t, query));
    this.counted.fire({ shown: tasks.length, total: all.length });
    const grouped = vscode.workspace.getConfiguration('clickupTasks').get<boolean>('groupByStatus', true);
    if (!grouped) {
      return tasks.map((task) => new TaskItem(task, this.iconDir, false, task.id === this.runningTaskId));
    }

    const groups = new Map<string, StoredTask[]>();
    for (const task of tasks) {
      const key = task.status.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    // ordem do ClickUp; tarefas concluídas/fechadas por último e recolhidas
    const isDone = (t: StoredTask) => t.statusType === 'done' || t.statusType === 'closed';
    return [...groups.values()]
      .sort((a, b) => Number(isDone(a[0])) - Number(isDone(b[0])) || a[0].statusOrder - b[0].statusOrder)
      .map(
        (list) =>
          new StatusGroup(
            list[0].status,
            list.map((task) => new TaskItem(task, this.iconDir, true, task.id === this.runningTaskId)),
            list[0].statusColor,
            isDone(list[0]),
            this.iconDir,
          ),
      );
  }
}
