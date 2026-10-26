import type { ClickUpTask, ClickUpUser } from './clickup';
import { formatCustomField, formatDate } from './markdown';
import { escapeHtml } from './richtext';

const AVATAR_COLORS = ['#7b68ee', '#0091ff', '#00b884', '#f9be34', '#e44c4c', '#d64ab5', '#5f55ee', '#1090e0'];
const PRIORITY_LABELS: Record<string, string> = { urgent: 'Urgente', high: 'Alta', normal: 'Normal', low: 'Baixa' };

/** Só aceita cores hex vindas do ClickUp, para não injetar CSS. */
function safeColor(color: string | undefined | null, fallback: string): string {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : fallback;
}

export function avatar(user: ClickUpUser | undefined, size?: 'sm'): string {
  const name = user?.username ?? '?';
  const initials = user?.initials || name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const color = safeColor(user?.color, AVATAR_COLORS[Math.abs(user?.id ?? 0) % AVATAR_COLORS.length]);
  // a foto fica por cima das iniciais; se não carregar, o script a remove e as iniciais aparecem
  const photo = user?.profilePicture?.startsWith('https://')
    ? `<img src="${escapeHtml(user.profilePicture)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return `<div class="avatar${size ? ` ${size}` : ''}" style="background:${color}" title="${escapeHtml(name)}">${escapeHtml(initials)}${photo}</div>`;
}

/** ms → "2h 05m", "45m" ou "—". */
export function formatDuration(ms: number | string | null | undefined): string {
  const total = Math.round(Number(ms ?? 0) / 60_000);
  if (!total) return '—';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function dateOnly(ms: string | null | undefined): string {
  return ms ? new Date(Number(ms)).toLocaleDateString('pt-BR') : '';
}

function cell(label: string, value: string, extraClass = ''): string {
  return `<div class="meta${extraClass ? ` ${extraClass}` : ''}"><div class="meta-label">${label}</div><div class="meta-value">${value}</div></div>`;
}

function people(users: ClickUpUser[]): string {
  if (!users.length) return '<span class="muted">—</span>';
  if (users.length === 1) return `<span class="person">${avatar(users[0], 'sm')}${escapeHtml(users[0].username)}</span>`;
  return `<span class="stack">${users.map((u) => avatar(u, 'sm')).join('')}</span>`;
}

/** Cabeçalho no estilo do topo da tarefa no ClickUp. */
export function taskHeaderHtml(task: ClickUpTask, key: string): string {
  const raw = task as ClickUpTask & Record<string, any>;
  const done = task.status?.type === 'done' || task.status?.type === 'closed';
  const statusColor = safeColor(task.status?.color, '#87909e');
  const priority = task.priority;
  const prioColor = safeColor((priority as any)?.color, '#87909e');

  const pills = [
    `<span class="status-pill" style="background:${statusColor}">${escapeHtml((task.status?.status ?? '').toUpperCase())}</span>`,
    priority
      ? `<span class="prio" style="color:${prioColor}" title="Prioridade">⚑ ${escapeHtml(PRIORITY_LABELS[priority.priority] ?? priority.priority)}</span>`
      : '<span class="prio muted" title="Prioridade">⚐ Sem prioridade</span>',
    ...(raw.tags ?? []).map(
      (t: any) => `<span class="tag" style="background:${safeColor(t.tag_bg, '#5f55ee')}">${escapeHtml(t.name)}</span>`,
    ),
  ].join('');

  const spent = Number(raw.time_spent ?? 0);
  const estimate = Number(raw.time_estimate ?? 0);
  const ratio = estimate ? Math.min(100, Math.round((spent / estimate) * 100)) : 0;
  const estimateHtml = estimate
    ? `${formatDuration(estimate)}<div class="bar" title="${Math.round((spent / estimate) * 100)}% do estimado"><span style="width:${ratio}%;${spent > estimate ? 'background:#e44c4c' : ''}"></span></div>`
    : '<span class="muted">—</span>';

  const due = raw.due_date ? Number(raw.due_date) : 0;
  const overdue = due && !done && due < Date.now();
  const watchers: ClickUpUser[] = raw.watchers ?? [];

  const cells = [
    cell('Responsáveis', people(task.assignees ?? [])),
    cell('Criado por', people(task.creator ? [task.creator] : [])),
    cell('Tempo rastreado', formatDuration(spent)),
    cell('Estimativa', estimateHtml),
    cell('Início', dateOnly(raw.start_date) || '<span class="muted">—</span>'),
    cell('Prazo', due ? `<span class="${overdue ? 'overdue' : ''}">${dateOnly(raw.due_date)}${overdue ? ' · atrasada' : ''}</span>` : '<span class="muted">—</span>'),
    cell('Criada', escapeHtml(formatDate(task.date_created))),
    cell('Atualizada', escapeHtml(formatDate(task.date_updated))),
    raw.date_closed ? cell('Concluída', escapeHtml(formatDate(raw.date_closed))) : '',
    raw.points != null ? cell('Pontos', escapeHtml(String(raw.points))) : '',
    watchers.length ? cell(`Observadores (${watchers.length})`, `<span class="stack">${watchers.map((u) => avatar(u, 'sm')).join('')}</span>`) : '',
    task.parent ? cell('Tarefa pai', escapeHtml(task.parent)) : '',
  ].join('');

  const crumbs = [task.folder?.name, task.list?.name].filter(Boolean).map((s) => escapeHtml(s!)).join(' <span class="sep">›</span> ');

  return `
  <div class="task-head">
    ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
    <h1><span class="key">${escapeHtml(key)}</span> ${escapeHtml(task.name)}</h1>
    <div class="pills">${pills}</div>
    <div class="meta-grid">${cells}</div>
  </div>`;
}

/** Campos personalizados, checklists e subtarefas (vão na aba Descrição, depois do texto). */
export function taskDetailsHtml(task: ClickUpTask): string {
  const sections: string[] = [];

  const fields = (task.custom_fields ?? [])
    .map((f) => [f.name.trim(), formatCustomField(f)] as const)
    .filter(([, v]) => v !== undefined);
  if (fields.length) {
    sections.push(
      `<h3 class="section">Campos personalizados</h3><div class="fields">${fields
        .map(([k, v]) => `<div class="field"><div class="meta-label">${escapeHtml(k)}</div><div>${escapeHtml(v!)}</div></div>`)
        .join('')}</div>`,
    );
  }

  for (const checklist of task.checklists ?? []) {
    const resolved = checklist.items.filter((i) => i.resolved).length;
    sections.push(
      `<h3 class="section">${escapeHtml(checklist.name)} <span class="count">${resolved}/${checklist.items.length}</span></h3><ul class="checklist">${checklist.items
        .map((i) => `<li class="${i.resolved ? 'done' : ''}"><span class="box">${i.resolved ? '☑' : '☐'}</span> ${escapeHtml(i.name)}</li>`)
        .join('')}</ul>`,
    );
  }

  if (task.subtasks?.length) {
    sections.push(
      `<h3 class="section">Subtarefas <span class="count">${task.subtasks.length}</span></h3><ul class="subtasks">${task.subtasks
        .map(
          (s: any) =>
            `<li><span class="status-pill sm" style="background:${safeColor(s.status?.color, '#87909e')}">${escapeHtml((s.status?.status ?? '').toUpperCase())}</span> <span class="key">${escapeHtml(s.custom_id || s.id)}</span> ${escapeHtml(s.name)}</li>`,
        )
        .join('')}</ul>`,
    );
  }

  return sections.join('');
}
