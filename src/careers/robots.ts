import { HttpError, type HttpClient } from '../util/http.js';

export interface Robots {
  allows(url: string): boolean;
  /** `Sitemap:` lines, which apply whatever the user agent. */
  sitemaps: string[];
}

const ALLOW_ALL: Robots = { allows: () => true, sitemaps: [] };
const DISALLOW_ALL: Robots = { allows: () => false, sitemaps: [] };

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

function compile(path: string): RegExp {
  const escaped = path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}`);
}

/** Rules of the group that names this user agent, else of `*` (RFC 9309: the most specific path wins, `allow` on a tie). */
export function parseRobots(text: string, agent = 'job-radar'): Robots {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap' && value) sitemaps.push(value);
    if ((field === 'allow' || field === 'disallow') && current && value) {
      current.rules.push({ allow: field === 'allow', pattern: compile(value), length: value.length });
    }
  }

  const token = agent.toLowerCase();
  const group = groups.find((entry) => entry.agents.some((name) => name !== '*' && token.includes(name))) ?? groups.find((entry) => entry.agents.includes('*'));
  const rules = group?.rules ?? [];
  return {
    sitemaps,
    allows(url) {
      const { pathname, search } = new URL(url);
      const target = `${pathname}${search}`;
      const match = rules
        .filter((rule) => rule.pattern.test(target))
        .sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow))[0];
      return match ? match.allow : true;
    },
  };
}

/**
 * `robots.txt` of each origin, read once. A missing file (4xx) allows everything; one that cannot be
 * read (5xx, network) allows nothing, as RFC 9309 asks.
 */
export function createRobotsReader(http: HttpClient): (url: string) => Promise<Robots> {
  const cache = new Map<string, Promise<Robots>>();
  return (url) => {
    const origin = new URL(url).origin;
    let robots = cache.get(origin);
    if (!robots) {
      robots = http.getText(`${origin}/robots.txt`).then(
        (text) => parseRobots(text),
        (error) => (error instanceof HttpError && error.status >= 400 && error.status < 500 ? ALLOW_ALL : DISALLOW_ALL),
      );
      cache.set(origin, robots);
    }
    return robots;
  };
}
