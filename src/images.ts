import { createWriteStream, existsSync } from 'fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream } from 'stream/web';
import type { ClickUpAttachment, ClickUpTask } from './clickup';
import { listAttachments } from './markdown';

/**
 * Só imagens podem ser baixadas, e só quando o usuário pede ("Baixar imagens").
 * Ficam em <tarefa>/images e são apagadas sozinhas depois do prazo de retenção.
 * Vídeos e outros arquivos são sempre usados pelo link do ClickUp.
 */
export const IMAGES_DIR = 'images';
const DOWNLOAD_CONCURRENCY = 4;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

export function isImage(attachment: ClickUpAttachment): boolean {
  return !!attachment.mimetype?.startsWith('image/') || IMAGE_EXTENSIONS.has((attachment.extension ?? '').toLowerCase());
}

export function imageAttachments(task: ClickUpTask): ClickUpAttachment[] {
  return listAttachments(task).filter(isImage);
}

/** Nome estável (prefixo do id do anexo), para não colidir entre os vários "image.png". */
function imageFileName(attachment: ClickUpAttachment): string {
  const id = attachment.id.replace(/\.[^.]+$/, '').slice(0, 8);
  let title = (attachment.title || 'imagem').replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '_');
  if (attachment.extension && !title.toLowerCase().endsWith(`.${attachment.extension.toLowerCase()}`)) {
    title += `.${attachment.extension}`;
  }
  return `${id}_${title}`;
}

/** URL do ClickUp → caminho relativo à pasta da tarefa (images/…), só das imagens já baixadas. */
export function localImageMap(dir: string, task: ClickUpTask): Map<string, string> {
  const map = new Map<string, string>();
  for (const attachment of imageAttachments(task)) {
    const rel = `${IMAGES_DIR}/${imageFileName(attachment)}`;
    if (existsSync(path.join(dir, rel))) {
      for (const url of [attachment.url, attachment.url_w_query, attachment.url_w_host]) {
        if (url) map.set(url, rel);
      }
    }
  }
  return map;
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(tmp), { signal });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return (await stat(dest)).size;
}

export interface DownloadResult {
  downloaded: number;
  existing: number;
  failed: number;
  bytes: number;
}

export async function downloadImages(
  dir: string,
  task: ClickUpTask,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const images = imageAttachments(task);
  const result: DownloadResult = { downloaded: 0, existing: 0, failed: 0, bytes: 0 };
  await mkdir(path.join(dir, IMAGES_DIR), { recursive: true });

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < images.length) {
      const attachment = images[next++];
      const dest = path.join(dir, IMAGES_DIR, imageFileName(attachment));
      try {
        if (existsSync(dest)) {
          result.existing++;
        } else {
          // aguarda antes de somar: `bytes += await` leria o total antigo e perderia somas dos outros workers
          const size = await downloadFile(attachment.url, dest, signal);
          result.bytes += size;
          result.downloaded++;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        result.failed++;
      }
      onProgress?.(++done, images.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, images.length) }, worker));
  return result;
}

/** Apaga as imagens baixadas da tarefa. Devolve quantas eram. */
export async function clearImages(dir: string): Promise<number> {
  const imagesDir = path.join(dir, IMAGES_DIR);
  if (!existsSync(imagesDir)) {
    return 0;
  }
  const count = (await readdir(imagesDir)).length;
  await rm(imagesDir, { recursive: true, force: true });
  return count;
}

/**
 * Apaga, em todas as tarefas, imagens baixadas há mais de `maxAgeMs`.
 * Devolve as pastas de tarefa que perderam imagens (o task.md delas precisa voltar aos links).
 */
export async function expireImages(baseDir: string, maxAgeMs: number): Promise<string[]> {
  if (!existsSync(baseDir)) {
    return [];
  }
  const limit = Date.now() - maxAgeMs;
  const changed: string[] = [];
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    const imagesDir = path.join(baseDir, entry.name, IMAGES_DIR);
    if (!entry.isDirectory() || !existsSync(imagesDir)) {
      continue;
    }
    let removed = 0;
    for (const name of await readdir(imagesDir)) {
      const file = path.join(imagesDir, name);
      try {
        if ((await stat(file)).mtimeMs < limit) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        // apagado por outra janela ao mesmo tempo
      }
    }
    await rmdir(imagesDir).catch(() => undefined); // só sai se ficou vazia
    if (removed) {
      changed.push(path.join(baseDir, entry.name));
    }
  }
  return changed;
}
