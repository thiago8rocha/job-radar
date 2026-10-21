import { readFile } from 'node:fs/promises';
import { createModelsClient } from './ai/models.js';
import { loadCompanies, loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { evaluate, type CommentEvent } from './commands/evaluate.js';
import { createHttpClient } from './util/http.js';
import { collect } from './commands/collect.js';
import { discover } from './commands/discover.js';
import { metrics } from './commands/metrics.js';
import { revalidate } from './commands/revalidate.js';
import { consoleLogger, type Context, type Logger } from './commands/context.js';
import { intake, type OpenedEvent } from './commands/intake.js';
import { setup } from './commands/setup.js';
import { syncStatus, type LabeledEvent } from './commands/sync-status.js';
import { createClient, parseRepo } from './github/client.js';
import { runImport } from './import/run.js';
import { parseXlsx } from './import/xlsx.js';

export const COMMANDS = ['setup', 'sync-status', 'intake', 'import', 'collect', 'metrics', 'revalidate', 'discover', 'evaluate'] as const;
export type Command = (typeof COMMANDS)[number];

export interface RunOptions {
  command: Command;
  token: string;
  /** `owner/name` of the private repo that holds the issues. */
  repository: string;
  configPath: string;
  /** Path to the GitHub event payload (`GITHUB_EVENT_PATH`), for event-driven commands. */
  eventPath?: string;
  /** Spreadsheet for `import`. */
  xlsxPath?: string;
  /** `companies.yml` for `collect`. */
  companiesPath?: string;
  /** `state/seen.json` for `collect`. */
  statePath?: string;
  /** SerpAPI key (Google Jobs, discovery). */
  serpapiKey?: string;
  /** API key of the AI provider named by `ai.base_url`, from a secret. */
  aiApiKey?: string;
  /** The candidate profile or résumé, from a secret; it is only ever sent to the model. */
  profile?: string;
  dryRun?: boolean;
  log?: Logger;
}

/** The optional AI step, when it is switched on and the workflow supplied what it needs. */
function aiOf(options: RunOptions, config: Config, log: Logger): { client: ReturnType<typeof createModelsClient>; profile: string } | undefined {
  if (!config.ai.enabled) return undefined;
  if (!config.ai.base_url || !config.ai.model || !options.aiApiKey || !options.profile) {
    log.warn('AI is on (ai.enabled) but ai.base_url, ai.model, the ai-api-key input or the profile input is missing; continuing without it');
    return undefined;
  }
  return {
    client: createModelsClient({
      baseUrl: config.ai.base_url,
      apiKey: options.aiApiKey,
      model: config.ai.model,
      http: createHttpClient({ retries: 0, timeoutMs: 60_000 }),
    }),
    profile: options.profile,
  };
}

async function readEvent<T>(path: string | undefined, command: Command): Promise<T> {
  if (!path) throw new Error(`"${command}" runs on a GitHub event, but no event payload was provided`);
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function run(options: RunOptions): Promise<void> {
  const log = options.log ?? consoleLogger;
  const ctx: Context = {
    octokit: createClient(options.token),
    repo: parseRepo(options.repository),
    config: await loadConfig(options.configPath),
    log,
  };

  switch (options.command) {
    case 'setup':
      return setup(ctx);
    case 'sync-status':
      return syncStatus(ctx, await readEvent<LabeledEvent>(options.eventPath, options.command));
    case 'intake':
      return intake(ctx, await readEvent<OpenedEvent>(options.eventPath, options.command));
    case 'collect': {
      const companies = await loadCompanies(options.companiesPath ?? 'companies.yml');
      await collect(ctx, {
        dryRun: options.dryRun,
        companies,
        statePath: options.statePath,
        serpapiKey: options.serpapiKey,
        ai: options.dryRun ? undefined : aiOf(options, ctx.config, log),
      });
      return;
    }
    case 'evaluate':
      return evaluate(ctx, await readEvent<CommentEvent>(options.eventPath, options.command), { ai: aiOf(options, ctx.config, log) });
    case 'metrics':
      await metrics(ctx, { dryRun: options.dryRun });
      return;
    case 'discover':
      await discover(ctx, { dryRun: options.dryRun, companiesPath: options.companiesPath, serpapiKey: options.serpapiKey });
      return;
    case 'revalidate': {
      const companies = await loadCompanies(options.companiesPath ?? 'companies.yml');
      await revalidate(ctx, { dryRun: options.dryRun, companies });
      return;
    }
    case 'import': {
      if (!options.xlsxPath) throw new Error('"import" needs the spreadsheet path (--xlsx)');
      const { rows, warnings } = await parseXlsx(options.xlsxPath);
      for (const warning of warnings) log.warn(warning);
      const result = await runImport(ctx, rows, { dryRun: options.dryRun });
      log.info(`Import ${options.dryRun ? '(dry-run) ' : ''}finished: ${result.created} created, ${result.skipped} skipped`);
      return;
    }
  }
}
