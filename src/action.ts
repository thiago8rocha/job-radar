import { appendFileSync } from 'node:fs';
import { COMMANDS, run, type Command } from './run.js';

function input(name: string): string | undefined {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<void> {
  const command = input('command');
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Input "command" must be one of: ${COMMANDS.join(', ')}`);
  }
  const token = input('github-token');
  if (!token) throw new Error('Input "github-token" is required');

  const lines: string[] = [];
  const record = (prefix: string) => (message: string) => {
    lines.push(`- ${message}`);
    console.log(prefix ? `${prefix}${message}` : message);
  };

  try {
    await run({
      command: command as Command,
      token,
      repository: process.env.GITHUB_REPOSITORY ?? '',
      configPath: input('config-path') ?? 'job-radar.config.yml',
      eventPath: process.env.GITHUB_EVENT_PATH,
      xlsxPath: input('xlsx-path'),
      dryRun: input('dry-run') === 'true',
      log: { info: record(''), warn: record('::warning::') },
    });
  } finally {
    if (process.env.GITHUB_STEP_SUMMARY && lines.length > 0) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### job-radar ${command}\n\n${lines.join('\n')}\n`);
    }
  }
}

main().catch((error: Error) => {
  console.log(`::error::${error.message.replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
});
