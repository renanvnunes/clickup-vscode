import { existsSync } from 'fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import type { ClickUpComment, ClickUpTask } from './clickup';
import { localImageMap } from './images';
import { LocalNote, renderTaskMarkdown, replaceNotesSection } from './markdown';

export interface StoredTask {
  /** ID nativo do ClickUp, usado nas chamadas à API. */
  id: string;
  key: string;
  name: string;
  status: string;
  statusColor?: string;
  statusOrder: number;
  statusType?: string;
  listId?: string;
  url: string;
  dir: string;
  taskFile: string;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').replace(/^\.+/, '_') || 'arquivo';
}

export function taskKey(task: Pick<ClickUpTask, 'id' | 'custom_id'>): string {
  return sanitizeFileName(task.custom_id || task.id);
}

function toStoredTask(dir: string, task: ClickUpTask): StoredTask {
  return {
    id: task.id,
    key: path.basename(dir),
    name: task.name,
    status: task.status?.status ?? '',
    statusColor: task.status?.color,
    statusOrder: Number(task.status?.orderindex ?? 0),
    statusType: task.status?.type,
    listId: task.list?.id,
    url: task.url,
    dir,
    taskFile: path.join(dir, 'task.md'),
  };
}

export async function saveTask(baseDir: string, task: ClickUpTask, comments: ClickUpComment[]): Promise<StoredTask> {
  const dir = path.join(baseDir, taskKey(task));
  const stored = toStoredTask(dir, task);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
  await writeFile(path.join(dir, 'comments.json'), JSON.stringify(comments, null, 2));
  await writeFile(stored.taskFile, renderTaskMarkdown(task, comments, await loadNotes(dir), localImageMap(dir, task)));
  return stored;
}

export async function loadRawTask(dir: string): Promise<ClickUpTask> {
  return JSON.parse(await readFile(path.join(dir, 'task.json'), 'utf8')) as ClickUpTask;
}

/** Regera o task.md a partir dos dados salvos (ex.: após baixar ou limpar imagens), sem chamar a API. */
export async function regenerateTaskMarkdown(task: StoredTask): Promise<void> {
  const raw = await loadRawTask(task.dir);
  const comments = JSON.parse(await readFile(path.join(task.dir, 'comments.json'), 'utf8').catch(() => '[]')) as ClickUpComment[];
  await writeFile(task.taskFile, renderTaskMarkdown(raw, comments, await loadNotes(task.dir), localImageMap(task.dir, raw)));
}

export async function loadNotes(dir: string): Promise<LocalNote[]> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'notes.json'), 'utf8')) as LocalNote[];
  } catch {
    return [];
  }
}

/** Grava as notas e atualiza a seção correspondente do task.md. */
export async function saveNotes(task: StoredTask, notes: LocalNote[]): Promise<void> {
  await writeFile(path.join(task.dir, 'notes.json'), JSON.stringify(notes, null, 2));
  const markdown = await readFile(task.taskFile, 'utf8').catch(() => '');
  await writeFile(task.taskFile, replaceNotesSection(markdown, notes));
}

export async function loadStoredTask(dir: string): Promise<StoredTask | undefined> {
  try {
    const task = JSON.parse(await readFile(path.join(dir, 'task.json'), 'utf8')) as ClickUpTask;
    return toStoredTask(dir, task);
  } catch {
    return undefined;
  }
}

/** Tarefas já importadas, das mais recentes para as mais antigas. */
export async function listStoredTasks(baseDir: string): Promise<StoredTask[]> {
  if (!existsSync(baseDir)) {
    return [];
  }
  const entries = await readdir(baseDir, { withFileTypes: true });
  const tasks = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = path.join(baseDir, e.name);
        const stored = await loadStoredTask(dir);
        const mtime = stored ? (await stat(path.join(dir, 'task.json'))).mtimeMs : 0;
        return { stored, mtime };
      }),
  );
  return tasks
    .filter((t): t is { stored: StoredTask; mtime: number } => !!t.stored)
    .sort((a, b) => b.mtime - a.mtime)
    .map((t) => t.stored);
}
