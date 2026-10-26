const API = 'https://api.clickup.com/api/v2';
const COMMENTS_PAGE_SIZE = 25;

export interface ClickUpUser {
  id: number;
  username: string;
  email?: string;
  initials?: string;
  color?: string;
  profilePicture?: string | null;
}

export interface ClickUpAttachment {
  id: string;
  date: string;
  title: string;
  extension?: string;
  mimetype?: string;
  size?: number;
  url: string;
  url_w_query?: string;
  url_w_host?: string;
  is_folder?: boolean | null;
  deleted?: boolean;
  user?: ClickUpUser;
}

export interface ClickUpTimeEntry {
  id: string;
  /** Início em ms (string). */
  start: string;
  task?: { id: string; custom_id?: string | null; name: string };
}

export interface ClickUpStatus {
  status: string;
  color?: string;
  orderindex?: number | string;
  /** open, custom, done ou closed */
  type?: string;
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  type_config?: any;
  value?: any;
}

export interface ClickUpChecklist {
  id: string;
  name: string;
  items: { id: string; name: string; resolved: boolean }[];
}

export interface ClickUpTask {
  id: string;
  custom_id?: string | null;
  name: string;
  text_content?: string | null;
  description?: string | null;
  markdown_description?: string | null;
  status: ClickUpStatus;
  date_created: string;
  date_updated?: string | null;
  due_date?: string | null;
  creator?: ClickUpUser;
  assignees: ClickUpUser[];
  tags: { name: string }[];
  priority?: { priority: string } | null;
  checklists: ClickUpChecklist[];
  custom_fields: ClickUpCustomField[];
  list?: { id: string; name: string };
  folder?: { name: string };
  parent?: string | null;
  url: string;
  team_id: string;
  attachments: ClickUpAttachment[];
  subtasks?: { id: string; custom_id?: string | null; name: string; status: { status: string } }[];
}

export interface ClickUpComment {
  id: string;
  comment_text: string;
  /** Texto rico no formato delta do Quill. */
  comment?: any[];
  reactions?: { reaction: string; user?: ClickUpUser }[];
  user: ClickUpUser;
  date: string;
  reply_count?: number;
  replies?: ClickUpComment[];
}

/** `comment` (delta rico) ou `comment_text` (texto puro). */
export interface NewComment {
  comment?: any[];
  comment_text?: string;
  notify_all: boolean;
}

export interface TaskRef {
  id: string;
  /** IDs customizados (ex.: ID-49228) exigem custom_task_ids + team_id. */
  custom: boolean;
}

/**
 * Interpreta o que o usuário digitou e devolve as referências a tentar, em ordem.
 * Aceita link, hash (ID nativo), ID customizado (ex.: ID-49228, DEV-1234) ou só o número,
 * que é tentado com cada prefixo de `numericPrefixes` e por fim como ID nativo.
 */
export function parseTaskRefs(input: string, numericPrefixes: string[] = []): TaskRef[] {
  const text = input.trim();
  const link = text.match(/app\.clickup\.com\/t\/(?:\d+\/)?([^/?#\s]+)/i);
  const id = (link ? decodeURIComponent(link[1]) : text).replace(/^#/, '');

  const custom = id.match(/^([a-z][a-z0-9]*)[-\s]+(\d+)$/i);
  if (custom) {
    return [{ id: `${custom[1].toUpperCase()}-${custom[2]}`, custom: true }];
  }
  if (/^\d+$/.test(id)) {
    return [...numericPrefixes.map((prefix) => ({ id: `${prefix.toUpperCase()}-${id}`, custom: true })), { id, custom: false }];
  }
  return /^[a-z0-9]+$/i.test(id) ? [{ id, custom: false }] : [];
}

export class ClickUpError extends Error {
  readonly code?: string;

  constructor(readonly status: number, body: string) {
    let detail = body;
    let code: string | undefined;
    try {
      const json = JSON.parse(body);
      detail = json.err ?? body;
      code = json.ECODE;
    } catch {
      // corpo não é JSON
    }
    super(ClickUpError.describe(status, detail, code));
    this.code = code;
  }

  /** Token inválido, expirado ou revogado (o ClickUp também usa 401 para tarefa de outro workspace). */
  get isAuth(): boolean {
    return this.status === 401 && (!this.code || this.code.startsWith('OAUTH_'));
  }

  get isNotFound(): boolean {
    return this.status === 404 || (!!this.code && this.code.startsWith('ITEM_'));
  }

  private static describe(status: number, detail: string, code: string | undefined): string {
    if (status === 401 && (!code || code.startsWith('OAUTH_'))) {
      return `Token do ClickUp inválido ou sem acesso (${detail}).`;
    }
    if (status === 404 || code?.startsWith('ITEM_')) {
      return `Tarefa não encontrada (${detail}).`;
    }
    return `ClickUp respondeu HTTP ${status}: ${detail}`;
  }
}

export class ClickUpClient {
  constructor(private readonly token: string) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    params: Record<string, string | undefined> = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      throw new ClickUpError(res.status, await res.text());
    }
    return (await res.json()) as T;
  }

  private get<T>(path: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, params, undefined, signal);
  }

  /** Status disponíveis na lista da tarefa (cada lista pode ter os seus). */
  async listStatuses(listId: string): Promise<ClickUpStatus[]> {
    const { statuses } = await this.get<{ statuses: ClickUpStatus[] }>(`/list/${listId}`);
    return [...statuses].sort((a, b) => Number(a.orderindex) - Number(b.orderindex));
  }

  async setStatus(taskId: string, status: string): Promise<void> {
    await this.request('PUT', `/task/${taskId}`, {}, { status });
  }

  /** Timer rodando para o usuário do token (em qualquer tarefa), ou undefined. */
  async currentTimer(teamId: string): Promise<ClickUpTimeEntry | undefined> {
    const { data } = await this.get<{ data: ClickUpTimeEntry | null }>(`/team/${teamId}/time_entries/current`);
    return data?.id ? data : undefined;
  }

  async startTimer(teamId: string, taskId: string): Promise<void> {
    await this.request('POST', `/team/${teamId}/time_entries/start`, {}, { tid: taskId });
  }

  async stopTimer(teamId: string): Promise<void> {
    await this.request('POST', `/team/${teamId}/time_entries/stop`, {}, {});
  }

  /** Comenta na tarefa, ou responde a um comentário quando `parentId` é informado. */
  async postComment(taskId: string, body: NewComment, parentId?: string): Promise<void> {
    await this.request('POST', parentId ? `/comment/${parentId}/reply` : `/task/${taskId}/comment`, {}, body);
  }

  async user(signal?: AbortSignal): Promise<ClickUpUser> {
    const { user } = await this.get<{ user: ClickUpUser }>('/user', {}, signal);
    return user;
  }

  async teams(signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
    const { teams } = await this.get<{ teams: { id: string; name: string }[] }>('/team', {}, signal);
    return teams;
  }

  task(ref: TaskRef, teamId: string | undefined, signal?: AbortSignal): Promise<ClickUpTask> {
    return this.get<ClickUpTask>(
      `/task/${encodeURIComponent(ref.id)}`,
      {
        custom_task_ids: ref.custom ? 'true' : undefined,
        team_id: ref.custom ? teamId : undefined,
        include_subtasks: 'true',
        include_markdown_description: 'true',
      },
      signal,
    );
  }

  /** Todos os comentários (com respostas), do mais antigo para o mais recente. */
  async comments(taskId: string, signal?: AbortSignal): Promise<ClickUpComment[]> {
    const all: ClickUpComment[] = [];
    const seen = new Set<string>();
    let params: Record<string, string> = {};
    for (;;) {
      const { comments } = await this.get<{ comments: ClickUpComment[] }>(`/task/${taskId}/comment`, params, signal);
      const fresh = comments.filter((c) => !seen.has(c.id));
      fresh.forEach((c) => seen.add(c.id));
      all.push(...fresh);
      if (comments.length < COMMENTS_PAGE_SIZE || fresh.length === 0) {
        break;
      }
      const oldest = comments[comments.length - 1];
      params = { start: oldest.date, start_id: oldest.id };
    }
    for (const comment of all) {
      if (comment.reply_count) {
        try {
          const { comments } = await this.get<{ comments: ClickUpComment[] }>(`/comment/${comment.id}/reply`, {}, signal);
          comment.replies = comments;
        } catch (err) {
          if (signal?.aborted) {
            throw err;
          }
          // respostas são opcionais; não derrubam a importação
        }
      }
    }
    return all.reverse();
  }
}
