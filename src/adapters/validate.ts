import type { z } from 'zod';
import { SchemaError, type FetchContext } from './types.js';

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown';
}

/** Validates the response envelope. A mismatch is a format change: it fails the whole source. */
export function parseEnvelope<S extends z.ZodType>(source: string, schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new SchemaError(source, describe(result.error));
  return result.data;
}

/**
 * Validates each posting on its own. One malformed posting is skipped with a warning; when
 * none of them is valid the format has changed, which fails the source.
 */
export function parseItems<S extends z.ZodType>(
  source: string,
  schema: S,
  items: unknown[],
  ctx: Pick<FetchContext, 'warn'>,
): Array<z.output<S>> {
  const valid: Array<z.output<S>> = [];
  let firstError: string | undefined;
  let invalid = 0;
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid++;
      firstError ??= describe(result.error);
    }
  }
  if (items.length > 0 && valid.length === 0) throw new SchemaError(source, firstError ?? 'no valid postings');
  if (invalid > 0) ctx.warn(`${source}: ${invalid} of ${items.length} postings skipped (${firstError})`);
  return valid;
}
