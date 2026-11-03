import { readFileSync, writeFileSync } from 'node:fs';
import { analyzeJob } from '../src/ai/insight.js';
import { MIN_AGREEMENT, scoreGolden, type GoldenCase } from '../src/ai/golden.js';
import { createModelsClient } from '../src/ai/models.js';
import { createHttpClient } from '../src/util/http.js';

/**
 * Scores the golden cases with a real model and compares them with what the candidate decided.
 *   AI_BASE_URL, AI_MODEL and AI_API_KEY pick the provider; --profile <file> is the candidate profile (never recorded).
 *   --record saves the raw replies to evals/replies.json so the replay test can run them for free.
 */
const args = process.argv.slice(2);
const profilePath = args[args.indexOf('--profile') + 1];
const { AI_BASE_URL, AI_MODEL, AI_API_KEY } = process.env;
if (!profilePath || !AI_BASE_URL || !AI_MODEL || !AI_API_KEY) {
  console.error('Usage: AI_BASE_URL=... AI_MODEL=... AI_API_KEY=... tsx scripts/eval-golden.ts --profile <file> [--record]');
  process.exit(2);
}

const cases = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as GoldenCase[];
const profile = readFileSync(profilePath, 'utf8');
const http = createHttpClient({ retries: 0, hostDelayMs: 1000 });
const client = createModelsClient({ baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL, http });

const replies: Record<string, string> = {};
const fits: Record<string, number> = {};
for (const item of cases) {
  const recording = { complete: async (messages: Parameters<typeof client.complete>[0]) => (replies[item.id] = await client.complete(messages)) };
  const insight = await analyzeJob(recording, profile, { title: item.title, company: item.company, locations: [], description: item.description });
  fits[item.id] = insight.fit;
  console.log(`${item.id} ${item.label}: fit ${insight.fit} (allowed ${item.expect.min}-${item.expect.max})`);
}

if (args.includes('--record')) writeFileSync('evals/replies.json', `${JSON.stringify(replies, null, 2)}\n`);

const result = scoreGolden(cases, fits);
console.log(`Agreement: ${result.agreed} of ${result.total} (${Math.round(result.rate * 100)}%), minimum ${Math.round(MIN_AGREEMENT * 100)}%`);
process.exit(result.rate >= MIN_AGREEMENT ? 0 : 1);
