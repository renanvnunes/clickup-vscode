import type { ClickUpAttachment, ClickUpComment, ClickUpCustomField, ClickUpTask } from './clickup';
import { parseRichText, toMarkdown } from './richtext';

/** Anotação que só existe neste computador (notes.json), nunca enviada ao ClickUp. */
export interface LocalNote {
  id: string;
  text: string;
  /** Data da nota em ms; pode ser escolhida pelo usuário. */
  date: number;
  /** Última edição, em ms. */
  edited?: number;
}

const NOTES_START = '<!-- notas-locais:inicio -->';
const NOTES_END = '<!-- notas-locais:fim -->';

export function renderNotesSection(notes: LocalNote[]): string {
  const sorted = [...notes].sort((a, b) => a.date - b.date);
  const body = sorted.length
    ? sorted.map((n) => `### 🔒 ${formatDate(n.date)}${n.edited ? ` _(editada ${formatDate(n.edited)})_` : ''}\n\n${n.text.trim()}\n`).join('\n')
    : '_(sem notas)_\n';
  return `${NOTES_START}\n## Notas locais (${notes.length})\n\n> Anotações pessoais, não enviadas ao ClickUp.\n\n${body}${NOTES_END}`;
}

/** Troca só a seção de notas do task.md, sem precisar reimportar a tarefa. */
export function replaceNotesSection(markdown: string, notes: LocalNote[]): string {
  const section = renderNotesSection(notes);
  const start = markdown.indexOf(NOTES_START);
  const end = markdown.indexOf(NOTES_END);
  if (start >= 0 && end > start) {
    return markdown.slice(0, start) + section + markdown.slice(end + NOTES_END.length);
  }
  return `${markdown.trimEnd()}\n\n${section}\n`;
}

export function formatDate(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') {
    return '';
  }
  return new Date(Number(ms)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function formatSize(bytes: number | undefined): string {
  if (!bytes) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function formatCustomField(field: ClickUpCustomField): string | undefined {
  const { value, type_config: config } = field;
  if (field.type === 'button' || isEmpty(value)) {
    return undefined;
  }
  const names = (items: any[]) => items.map((i) => i?.name ?? i?.username ?? i?.title ?? i?.label ?? i?.id ?? String(i)).join(', ');
  switch (field.type) {
    case 'drop_down': {
      const option = config?.options?.find((o: any) => o.orderindex === Number(value) || o.id === value);
      return option?.name ?? String(value);
    }
    case 'labels':
      return (value as string[]).map((id) => config?.options?.find((o: any) => o.id === id)?.label ?? id).join(', ');
    case 'checkbox':
      return value === true || value === 'true' ? 'Sim' : undefined;
    case 'date':
      return formatDate(value);
    case 'manual_progress':
    case 'automatic_progress':
      return `${value.percent_completed ?? value.current ?? 0}%`;
    case 'location':
      return value.formatted_address ?? JSON.stringify(value);
    default:
      if (Array.isArray(value)) {
        return names(value);
      }
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/** Troca URLs do ClickUp pelos caminhos locais das imagens baixadas. */
export function replaceUrls(text: string, replacements: Map<string, string>): string {
  // URLs mais longas primeiro, para `url_w_query` não ser cortada por `url`
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
  return keys.reduce((acc, key) => acc.split(key).join(replacements.get(key)!), text);
}

function renderComment(comment: ClickUpComment, local: Map<string, string>, depth = 0): string {
  const heading = depth === 0 ? '###' : '####';
  const prefix = depth === 0 ? '' : '↳ ';
  const rich = toMarkdown(parseRichText(comment.comment, comment.comment_text), (url) => local.get(url) ?? url);
  const body = replaceUrls(rich, local) || '_(sem texto)_';
  const replies = (comment.replies ?? []).map((r) => renderComment(r, local, depth + 1)).join('\n');
  return `${heading} ${prefix}${comment.user?.username ?? 'Desconhecido'} · ${formatDate(comment.date)}\n\n${body}\n${replies ? `\n${replies}` : ''}`;
}

/** Anexos válidos, em ordem cronológica. */
export function listAttachments(task: ClickUpTask): ClickUpAttachment[] {
  return (task.attachments ?? [])
    .filter((a) => !a.deleted && !a.is_folder && a.url)
    .sort((a, b) => Number(a.date) - Number(b.date));
}

/** `local`: URL → caminho relativo das imagens baixadas; as demais ficam como link do ClickUp. */
export function renderTaskMarkdown(
  task: ClickUpTask,
  comments: ClickUpComment[],
  notes: LocalNote[] = [],
  local: Map<string, string> = new Map(),
): string {
  const key = task.custom_id || task.id;
  const meta: [string, string | undefined][] = [
    ['Link', task.url],
    ['Status', task.status?.status],
    ['Prioridade', task.priority?.priority],
    ['Lista', [task.folder?.name, task.list?.name].filter(Boolean).join(' / ')],
    ['Criado por', task.creator?.username],
    ['Responsáveis', task.assignees.map((a) => a.username).join(', ')],
    ['Tags', task.tags.map((t) => t.name).join(', ')],
    ['Criado em', formatDate(task.date_created)],
    ['Atualizado em', formatDate(task.date_updated)],
    ['Prazo', formatDate(task.due_date)],
    ['Tarefa pai', task.parent ?? undefined],
  ];

  const out: string[] = [`# ${key} — ${task.name}`, ''];
  out.push(...meta.filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`), '');

  const description = task.markdown_description || task.description || task.text_content || '';
  out.push('## Descrição', '', replaceUrls(description.trim(), local) || '_(sem descrição)_', '');

  const fields = task.custom_fields
    .map((f) => [f.name.trim(), formatCustomField(f)] as const)
    .filter(([, v]) => v !== undefined);
  if (fields.length) {
    out.push('## Campos personalizados', '', ...fields.map(([k, v]) => `- **${k}:** ${v}`), '');
  }

  for (const checklist of task.checklists) {
    out.push(`## Checklist: ${checklist.name}`, '', ...checklist.items.map((i) => `- [${i.resolved ? 'x' : ' '}] ${i.name}`), '');
  }

  if (task.subtasks?.length) {
    out.push('## Subtarefas', '', ...task.subtasks.map((s) => `- ${s.custom_id || s.id} — ${s.name} (${s.status.status})`), '');
  }

  const attachments = listAttachments(task);
  if (attachments.length) {
    out.push(`## Anexos (${attachments.length})`, '');
    for (const attachment of attachments) {
      const info = [formatSize(attachment.size), formatDate(attachment.date), attachment.user?.username].filter(Boolean).join(' · ');
      const target = local.get(attachment.url) ?? viewableUrl(attachment.url);
      out.push(`- [${attachment.title}](${target}) — ${info}${local.has(attachment.url) ? ' · 🖼 local' : ''}`);
    }
    out.push('');
  }

  out.push(`## Comentários (${comments.length})`, '');
  out.push(comments.length ? comments.map((c) => renderComment(c, local)).join('\n') : '_(sem comentários)_\n');

  if (notes.length) {
    out.push('', renderNotesSection(notes), '');
  }

  return linkImages(out.join('\n'));
}

/**
 * Envolve cada imagem num link para ela mesma. No preview de Markdown, clicar numa imagem
 * baixada abre o visualizador do VS Code (com zoom); numa remota, abre o navegador.
 */
export function linkImages(markdown: string): string {
  return markdown.replace(/(?<!\[)!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `[![${alt}](${src})](${viewableUrl(src)})`);
}

/**
 * Os anexos do ClickUp vêm com `Content-Disposition: attachment` (o navegador baixa em vez de mostrar);
 * com `?view=open` eles são servidos para exibição.
 */
export function viewableUrl(url: string): string {
  return /^https:\/\/[^/]*clickup-attachments\.com\//.test(url) && !url.includes('?') ? `${url}?view=open` : url;
}
