import { readFile } from 'node:fs/promises';
import { loadCompanies, loadConfig } from './config/load.js';
import { collect } from './commands/collect.js';
import { consoleLogger, type Context, type Logger } from './commands/context.js';
import { intake, type OpenedEvent } from './commands/intake.js';
import { setup } from './commands/setup.js';
import { syncStatus, type LabeledEvent } from './commands/sync-status.js';
import { createClient, parseRepo } from './github/client.js';
import { runImport } from './import/run.js';
import { parseXlsx } from './import/xlsx.js';

export const COMMANDS = ['setup', 'sync-status', 'intake', 'import', 'collect', 'metrics'] as const;
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
  dryRun?: boolean;
  log?: Logger;
}

async function readEvent<T>(path: string | undefined, command: Command): Promise<T> {
  if (!path) throw new Error(`"${command}" runs on a GitHub event, but no event payload was provided`);
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function run(options: RunOptions): Promise<void> {
  const log = options.log ?? consoleLogger;
  if (options.command === 'metrics') {
    throw new Error(`"${options.command}" is not available yet (planned for a later phase)`);
  }

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
      await collect(ctx, { dryRun: options.dryRun, companies, statePath: options.statePath });
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
