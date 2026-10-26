import * as vscode from 'vscode';
import type { ClickUpClient, ClickUpTimeEntry } from './clickup';
import type { StoredTask } from './storage';

/** Intervalo para notar timers iniciados/parados fora do VS Code (ClickUp web, outra janela). */
const SYNC_INTERVAL = 60_000;

export interface TimerConnection {
  client: ClickUpClient;
  teamId: string;
}

export interface TimerTick {
  label: string;
  name?: string;
  elapsed: string;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Espelha o timer do ClickUp. O ClickUp só permite um timer rodando por usuário,
 * então iniciar numa tarefa para o que estiver rodando em outra.
 */
export class TimerController implements vscode.Disposable {
  private entry?: ClickUpTimeEntry;
  private readonly item = vscode.window.createStatusBarItem('clickupTasks.timer', vscode.StatusBarAlignment.Left, 100);
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  /** Disparado quando muda a tarefa com timer rodando (ID nativo, ou undefined). */
  readonly onDidChange = this.changed.event;
  private readonly ticked = new vscode.EventEmitter<TimerTick | undefined>();
  /** Disparado a cada segundo com o timer rodando, e com undefined quando ele para. */
  readonly onDidTick = this.ticked.event;
  private tick?: NodeJS.Timeout;
  private readonly poll: NodeJS.Timeout;
  private readonly focus: vscode.Disposable;

  /** `interactive` permite pedir token/workspace ao usuário. */
  constructor(private readonly connect: (interactive: boolean) => Promise<TimerConnection | undefined>) {
    this.item.name = 'Timer do ClickUp';
    this.item.command = 'clickupTasks.stopTimer';
    this.poll = setInterval(() => void this.refresh(), SYNC_INTERVAL);
    this.focus = vscode.window.onDidChangeWindowState((state) => state.focused && void this.refresh());
  }

  get runningTaskId(): string | undefined {
    return this.entry?.task?.id;
  }

  async refresh(): Promise<void> {
    const connection = await this.connect(false).catch(() => undefined);
    if (!connection) {
      this.set(undefined);
      return;
    }
    try {
      this.set(await connection.client.currentTimer(connection.teamId));
    } catch {
      // sem rede ou API fora: mantém o último estado conhecido
    }
  }

  async start(task: StoredTask): Promise<void> {
    const connection = await this.connect(true);
    if (!connection) {
      return;
    }
    const { client, teamId } = connection;
    const current = await client.currentTimer(teamId);
    if (current?.task?.id === task.id) {
      this.set(current);
      return;
    }
    if (current) {
      await client.stopTimer(teamId);
    }
    await client.startTimer(teamId, task.id);
    this.set(await client.currentTimer(teamId));

    const stopped = current ? ` (parado em ${label(current)}, ${formatElapsed(Date.now() - Number(current.start))})` : '';
    vscode.window.showInformationMessage(`⏱ Timer iniciado em ${task.key}${stopped}.`);
  }

  async stop(): Promise<void> {
    const connection = await this.connect(true);
    if (!connection) {
      return;
    }
    const current = await connection.client.currentTimer(connection.teamId);
    if (!current) {
      this.set(undefined);
      vscode.window.showInformationMessage('Nenhum timer rodando no ClickUp.');
      return;
    }
    await connection.client.stopTimer(connection.teamId);
    this.set(undefined);
    vscode.window.showInformationMessage(`⏹ Timer parado em ${label(current)}: ${formatElapsed(Date.now() - Number(current.start))}.`);
  }

  private set(entry: ClickUpTimeEntry | undefined): void {
    const before = this.entry?.task?.id;
    this.entry = entry;
    clearInterval(this.tick);
    if (entry) {
      this.render();
      this.tick = setInterval(() => this.render(), 1000);
      this.item.show();
    } else {
      this.item.hide();
      this.ticked.fire(undefined);
    }
    void vscode.commands.executeCommand('setContext', 'clickupTasks.timerRunning', !!entry);
    if (before !== entry?.task?.id) {
      this.changed.fire(entry?.task?.id);
    }
  }

  private render(): void {
    const entry = this.entry!;
    const tick: TimerTick = { label: label(entry), name: entry.task?.name, elapsed: formatElapsed(Date.now() - Number(entry.start)) };
    this.item.text = `$(clock) ${tick.label} ${tick.elapsed}`;
    this.item.tooltip = `Timer do ClickUp rodando em ${tick.label}${tick.name ? ` — ${tick.name}` : ''}\nClique para parar.`;
    // só as cores de aviso/erro são permitidas como fundo de item da barra de status
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.ticked.fire(tick);
  }

  dispose(): void {
    clearInterval(this.tick);
    clearInterval(this.poll);
    this.focus.dispose();
    this.item.dispose();
    this.changed.dispose();
    this.ticked.dispose();
  }
}

function label(entry: ClickUpTimeEntry): string {
  return entry.task?.custom_id || entry.task?.id || 'tarefa';
}
