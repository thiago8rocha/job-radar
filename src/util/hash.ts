import { createHash } from 'node:crypto';

/** Short stable hash used in the hidden issue marker. */
export function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 8);
}
