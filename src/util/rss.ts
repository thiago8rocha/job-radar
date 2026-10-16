import { decodeEntities } from './text.js';

export type RssItem = Record<string, string>;

/**
 * Reads the `<item>` elements of an RSS feed into flat objects (tag name → text). It handles what job
 * boards publish (plain tags, CDATA, entities) without an XML dependency; nested elements are not needed.
 * Returns undefined when the text is not an RSS feed, so a changed format fails loudly.
 */
export function parseRssItems(xml: string): RssItem[] | undefined {
  if (!/<rss[\s>]|<channel[\s>]/i.test(xml)) return undefined;
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item: RssItem = {};
    for (const field of match[1]!.matchAll(/<([a-zA-Z][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
      const raw = field[2]!.trim();
      const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
      item[field[1]!] = cdata ? cdata[1]! : decodeEntities(raw);
    }
    items.push(item);
  }
  return items;
}
