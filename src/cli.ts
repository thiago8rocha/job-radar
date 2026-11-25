import { parseArgs } from 'node:util';
import { importCompaniesFiles } from './import/companies.js';
import { COMMANDS, run, type Command } from './run.js';

const USAGE = `Usage: job-radar <command> [options]

Commands: ${COMMANDS.join(', ')}, import-companies

Options:
  --repo <owner/name>   Private repo with the issues (default: $GITHUB_REPOSITORY)
  --config <path>       Config file (default: job-radar.config.yml)
  --xlsx <path>         Spreadsheet to import (import only)
  --companies <path>    Companies file (default: companies.yml; collect and revalidate)
  --state <path>        State file (default: state/seen.json; collect only)
  --directory <path>    Cold company list (default: companies.directory.yml; collect and sweep)
  --companies-state <path>  Company health file (default: state/companies.json; collect, sweep and prune)
  --event <path>        GitHub event payload (event-driven commands)
  --dry-run             Report what would happen without writing (import, collect, metrics, revalidate and discover)
  --csv <path>          import-companies: CSV of boards (default columns follow the LastRound AI ATS directory)
  --urls <path>         import-companies: text file with one career-page URL per line
  --ats-column <name>   import-companies: CSV column with the ATS (default: ats_vendor)
  --slug-column <name>  import-companies: CSV column with the board slug (default: board_slug)
  --name-column <name>  import-companies: CSV column with the company name (default: company_name)
  -h, --help            Show this help

The token is read from $GITHUB_TOKEN (or $GH_TOKEN); the SerpAPI key, if any, from $SERPAPI_KEY.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      config: { type: 'string' },
      xlsx: { type: 'string' },
      companies: { type: 'string' },
      state: { type: 'string' },
      directory: { type: 'string' },
      csv: { type: 'string' },
      urls: { type: 'string' },
      'ats-column': { type: 'string' },
      'slug-column': { type: 'string' },
      'name-column': { type: 'string' },
      'companies-state': { type: 'string' },
      event: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (command === 'import-companies') {
    await importCompaniesFiles({
      csv: values.csv,
      urls: values.urls,
      columns: { ats: values['ats-column'], slug: values['slug-column'], name: values['name-column'] },
      directoryPath: values.directory,
      companiesPath: values.companies,
    });
    return;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (or GH_TOKEN) to a token with Issues and Projects access');

  await run({
    command: command as Command,
    token,
    repository: values.repo ?? process.env.GITHUB_REPOSITORY ?? '',
    configPath: values.config ?? 'job-radar.config.yml',
    eventPath: values.event,
    xlsxPath: values.xlsx,
    companiesPath: values.companies,
    statePath: values.state,
    directoryPath: values.directory,
    companiesStatePath: values['companies-state'],
    serpapiKey: process.env.SERPAPI_KEY,
    aiApiKey: process.env.AI_API_KEY,
    profile: process.env.JOB_RADAR_PROFILE,
    dryRun: values['dry-run'],
  });
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
