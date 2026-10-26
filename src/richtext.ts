/**
 * Comentários do ClickUp vêm como um delta do Quill: trechos de texto com atributos inline
 * (bold, link...) e quebras de linha cujos atributos descrevem o bloco (lista, título...).
 */

export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
  image?: string;
  mention?: boolean;
}

export interface Line {
  segments: Segment[];
  list?: 'bullet' | 'ordered' | 'checked' | 'unchecked';
  header?: number;
  quote?: boolean;
  codeBlock?: boolean;
  banner?: boolean;
}

function blockAttributes(a: Record<string, any>): Omit<Line, 'segments'> {
  const list = typeof a.list === 'object' ? a.list?.list : a.list;
  return {
    list: ['bullet', 'ordered', 'checked', 'unchecked'].includes(list) ? list : undefined,
    header: a.header ? Number(a.header) : undefined,
    quote: !!a.blockquote,
    codeBlock: !!a['code-block'],
    banner: !!a['advanced-banner'],
  };
}

export function parseRichText(items: any[] | undefined, fallback: string): Line[] {
  if (!items?.length) {
    return (fallback ?? '').split('\n').map((text) => ({ segments: text ? [{ text }] : [] }));
  }
  const lines: Line[] = [];
  let current: Segment[] = [];

  for (const item of items) {
    const a = item.attributes ?? {};
    if (item.type === 'tag' || item.type === 'mention') {
      current.push({ text: item.text || `@${item.user?.username ?? ''}`, mention: true });
      continue;
    }
    if (item.image?.url) {
      current.push({ text: item.image.title || item.image.name || 'imagem', image: item.image.url });
      continue;
    }
    if (item.attachment?.url) {
      current.push({ text: item.attachment.title || item.attachment.name || 'anexo', link: item.attachment.url });
      continue;
    }
    const parts = String(item.text ?? '').split('\n');
    parts.forEach((part, i) => {
      if (part) {
        current.push({ text: part, bold: !!a.bold, italic: !!a.italic, code: !!a.code, strike: !!a.strike, link: a.link });
      }
      if (i < parts.length - 1) {
        lines.push({ segments: current, ...blockAttributes(a) });
        current = [];
      }
    });
  }
  if (current.length) {
    lines.push({ segments: current });
  }
  // remove linhas vazias do fim
  while (lines.length && !lines[lines.length - 1].segments.length) {
    lines.pop();
  }
  return lines;
}

export function plainText(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join('')).join('\n');
}

// ---------- Texto digitado → delta (novo comentário) ----------

export interface Person {
  id: number;
  username: string;
  picture?: string;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Converte um subconjunto de markdown em delta: **negrito**, _itálico_, `código`,
 * [texto](url), URLs soltas e @Nome de pessoas conhecidas (vira menção, que notifica).
 * `rich` é false quando o texto não tem nada disso, e aí basta mandar `comment_text`.
 */
export function markdownToDelta(text: string, people: Person[]): { items: any[]; rich: boolean } {
  const byName = new Map(people.map((p) => [p.username.toLowerCase(), p]));
  const names = [...byName.values()].map((p) => escapeRegex(p.username)).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    [
      '`([^`\\n]+)`',
      '\\*\\*([^*\\n]+)\\*\\*',
      '(?<![\\w*])[*_]([^*_\\n]+)[*_](?![\\w*])',
      '\\[([^\\]\\n]+)\\]\\((https?://[^)\\s]+)\\)',
      '(https?://[^\\s)]+)',
      names.length ? `(?<![\\w@])@(${names.join('|')})(?![\\w])` : '(?!)',
    ].join('|'),
    'gi',
  );

  const items: any[] = [];
  let rich = false;
  const push = (text: string, attributes?: Record<string, unknown>) => {
    const last = items[items.length - 1];
    if (!attributes && last && !last.type && !last.attributes) {
      last.text += text;
    } else {
      items.push(attributes ? { text, attributes } : { text });
    }
  };

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    let index = 0;
    for (const m of line.matchAll(pattern)) {
      if (m.index! > index) push(line.slice(index, m.index));
      const [, code, bold, italic, label, href, url, mention] = m;
      if (code !== undefined) push(code, { code: true });
      else if (bold !== undefined) push(bold, { bold: true });
      else if (italic !== undefined) push(italic, { italic: true });
      else if (label !== undefined) push(label, { link: href });
      else if (url !== undefined) push(url, { link: url });
      else if (mention !== undefined) {
        const person = byName.get(mention.toLowerCase())!;
        items.push({ type: 'tag', text: `@${person.username}`, user: { id: person.id, username: person.username } });
      }
      rich = true;
      index = m.index! + m[0].length;
    }
    if (index < line.length) push(line.slice(index));
    push('\n');
  }
  return { items, rich };
}

// ---------- Markdown (task.md) ----------

function segmentToMarkdown(s: Segment, resolve: (url: string) => string): string {
  if (s.image) {
    return `![${s.text}](${resolve(s.image)})`;
  }
  let text = s.code ? `\`${s.text}\`` : s.text;
  if (s.mention) {
    return `**${text}**`;
  }
  // mantém espaços fora dos marcadores, senão `** texto**` não renderiza
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  text = core;
  if (text) {
    if (s.bold) text = `**${text}**`;
    if (s.italic) text = `_${text}_`;
    if (s.strike) text = `~~${text}~~`;
    if (s.link) text = `[${text}](${resolve(s.link)})`;
  }
  return lead + text + trail;
}

export function toMarkdown(lines: Line[], resolve: (url: string) => string = (u) => u): string {
  const out: string[] = [];
  let ordered = 0;
  let inCode = false;
  for (const line of lines) {
    if (line.codeBlock !== inCode) {
      out.push('```');
      inCode = !!line.codeBlock;
    }
    const text = inCode ? line.segments.map((s) => s.text).join('') : line.segments.map((s) => segmentToMarkdown(s, resolve)).join('');
    ordered = line.list === 'ordered' ? ordered + 1 : 0;
    if (inCode) out.push(text);
    else if (line.list === 'bullet') out.push(`- ${text}`);
    else if (line.list === 'ordered') out.push(`${ordered}. ${text}`);
    else if (line.list === 'checked') out.push(`- [x] ${text}`);
    else if (line.list === 'unchecked') out.push(`- [ ] ${text}`);
    else if (line.header) out.push(text.trim() ? `**${text.trim()}**` : '');
    else if (line.quote || line.banner) out.push(`> ${text}`);
    else out.push(text);
  }
  if (inCode) out.push('```');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- HTML (painel de comentários) ----------

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface HtmlResolver {
  /** URL de imagem exibível no webview, ou undefined se só houver o link remoto. */
  image(url: string): string | undefined;
  link(url: string): string;
}

function segmentToHtml(s: Segment, resolve: HtmlResolver): string {
  if (s.image) {
    const src = resolve.image(s.image);
    return src
      ? `<a href="${escapeHtml(resolve.link(s.image))}"><img src="${escapeHtml(src)}" alt="${escapeHtml(s.text)}"></a>`
      : `<a href="${escapeHtml(resolve.link(s.image))}">🖼 ${escapeHtml(s.text)}</a>`;
  }
  let html = escapeHtml(s.text);
  if (s.mention) return `<span class="mention">${html}</span>`;
  if (s.code) html = `<code>${html}</code>`;
  if (s.bold) html = `<strong>${html}</strong>`;
  if (s.italic) html = `<em>${html}</em>`;
  if (s.strike) html = `<s>${html}</s>`;
  if (s.link) html = `<a href="${escapeHtml(resolve.link(s.link))}">${html}</a>`;
  return html;
}

export function toHtml(lines: Line[], resolve: HtmlResolver): string {
  const out: string[] = [];
  let open: 'ul' | 'ol' | 'pre' | undefined;
  const close = () => {
    if (open) out.push(`</${open}>`);
    open = undefined;
  };
  const ensure = (tag: 'ul' | 'ol' | 'pre', attrs = '') => {
    if (open !== tag) {
      close();
      out.push(`<${tag}${attrs}>`);
      open = tag;
    }
  };

  for (const line of lines) {
    if (line.codeBlock) {
      ensure('pre');
      out.push(escapeHtml(line.segments.map((s) => s.text).join('')) + '\n');
      continue;
    }
    const html = line.segments.map((s) => segmentToHtml(s, resolve)).join('');
    if (line.list === 'bullet' || line.list === 'checked' || line.list === 'unchecked') {
      ensure('ul', line.list === 'bullet' ? '' : ' class="checklist"');
      const box = line.list === 'bullet' ? '' : `<span class="box">${line.list === 'checked' ? '☑' : '☐'}</span> `;
      out.push(`<li>${box}${html}</li>`);
    } else if (line.list === 'ordered') {
      ensure('ol');
      out.push(`<li>${html}</li>`);
    } else {
      close();
      if (line.header) out.push(`<h4>${html}</h4>`);
      else if (line.banner) out.push(`<div class="banner">${html}</div>`);
      else if (line.quote) out.push(`<blockquote>${html}</blockquote>`);
      else out.push(html ? `<p>${html}</p>` : '<p class="gap"></p>');
    }
  }
  close();
  return out.join('');
}
