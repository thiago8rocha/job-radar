import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { configSchema, companiesSchema, type Config, type Companies } from './schema.js';

export class ConfigError extends Error {}

function parseWith<S extends z.ZodType>(schema: S, source: string, text: string): z.output<S> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: invalid YAML (${(error as Error).message})`);
  }
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`${source}: invalid configuration\n${issues}`);
  }
  return result.data;
}

export function parseConfig(text: string, source = 'job-radar.config.yml'): Config {
  return parseWith(configSchema, source, text);
}

export function parseCompanies(text: string, source = 'companies.yml'): Companies {
  return parseWith(companiesSchema, source, text);
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read the config file at ${path}`);
  }
  return parseConfig(text, path);
}
