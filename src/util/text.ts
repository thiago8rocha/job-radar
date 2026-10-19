const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  atilde: 'ã',
  acirc: 'â',
  ccedil: 'ç',
  iacute: 'í',
  oacute: 'ó',
  otilde: 'õ',
  ocirc: 'ô',
  uacute: 'ú',
  ecirc: 'ê',
  Eacute: 'É',
  Aacute: 'Á',
  Ccedil: 'Ç',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

const BLOCK_TAGS = /<\/?(p|div|br|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote)\b[^>]*>/gi;

const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![\d.])|opacity\s*:\s*0(?![.\d]*[1-9])|color\s*:\s*transparent/i;
const HIDDEN_ATTRIBUTE = /\shidden(?=[\s=/>]|$)/i;
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'wbr']);

/** Zero-width, bidirectional-control and soft-hyphen characters, which read as nothing but can hide words or reorder them. */
export function stripInvisible(value: string): string {
  return value.replace(INVISIBLE, '');
}

/**
 * Removes elements a browser would not show (`display:none`, `font-size:0`, the `hidden` attribute...) together
 * with everything inside them, so text planted for a parser or a model never reaches the description.
 */
function dropHiddenElements(html: string): string {
  const open = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let value = html;
  for (let guard = 0; guard < 1000; guard++) {
    open.lastIndex = 0;
    let found: RegExpExecArray | null;
    do {
      found = open.exec(value);
    } while (found && !HIDDEN_STYLE.test(found[2]!) && !HIDDEN_ATTRIBUTE.test(found[2]!));
    if (!found) return value;

    const start = found.index;
    let end = start + found[0].length;
    if (!VOID_TAGS.has(found[1]!.toLowerCase())) {
      const tag = new RegExp(`<(/?)${found[1]}\\b[^>]*>`, 'gi');
      tag.lastIndex = end;
      let depth = 1;
      end = value.length;
      for (let next = tag.exec(value); next; next = tag.exec(value)) {
        depth += next[1] ? -1 : 1;
        if (depth === 0) {
          end = next.index + next[0].length;
          break;
        }
      }
    }
    value = `${value.slice(0, start)} ${value.slice(end)}`;
  }
  return value;
}

/**
 * Plain text out of an HTML fragment. `escaped` handles Greenhouse, which returns the HTML
 * entity-encoded (`&lt;div&gt;`), so it is decoded once before the tags are removed.
 */
export function htmlToText(html: string | null | undefined, options: { escaped?: boolean } = {}): string {
  let value = html ?? '';
  if (options.escaped) value = decodeEntities(value);
  return stripInvisible(
    decodeEntities(
      dropHiddenElements(value)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(BLOCK_TAGS, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lower case, no accents, single spaces: the form used to compare titles and company names. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
}

/** Escapes a literal string for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `term` appears in `text` as a whole word or phrase, ignoring case and accents.
 * `QA` matches "Senior QA Engineer" but not "aquatic".
 */
export function containsTerm(text: string, term: string): boolean {
  const haystack = ` ${normalizeText(text)} `;
  const needle = normalizeText(term);
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

/** First `max` characters, cut at a sentence or word boundary, with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
  const cut = sentence > max * 0.5 ? sentence + 1 : slice.lastIndexOf(' ');
  return `${slice.slice(0, cut > 0 ? cut : max).trim()}…`;
}
