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

/**
 * Plain text out of an HTML fragment. `escaped` handles Greenhouse, which returns the HTML
 * entity-encoded (`&lt;div&gt;`), so it is decoded once before the tags are removed.
 */
export function htmlToText(html: string | null | undefined, options: { escaped?: boolean } = {}): string {
  let value = html ?? '';
  if (options.escaped) value = decodeEntities(value);
  return decodeEntities(
    value
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' '),
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
