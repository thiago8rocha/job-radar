# job-radar

Collects job postings, opens one GitHub issue per relevant job, and tracks each hiring process to the end, using GitHub Issues and Projects as the tracker. It runs entirely on GitHub Actions: no server, no database, no cost beyond free Actions minutes.

- **Collector.** Every business day it reads InHire, Greenhouse, Lever, Ashby, Gupy, Himalayas, freehire, Remote OK and We Work Remotely (and Google Jobs, optionally), filters by title, seniority, remote work and region, removes duplicates, and opens one issue per new job.
- **Tracker.** You move a job along by changing its `status:*` label. The Project board, the open/closed state and the dates follow.
- **Metrics.** A weekly job rewrites a pinned "Metrics" issue (funnel, response rate, time to response, by source and contract) and fills the calculated Project fields.
- **Manual jobs.** An issue form covers recruiters and referrals. A spreadsheet importer brings in history.
- **Optional extras.** A weekly search for new companies to follow (SerpAPI), and a fit score and `/evaluate` analysis from GitHub Models (AI). Both are off until you turn them on, and neither is needed for the rest.

Everything personal (your searches, companies and history) lives in your own **private** repo. This repo only holds the engine, which your workflows call as `thiago8rocha/job-radar@v1`.

## Set up your own

1. **Create a private repo** for your data, for example `job-search`.
2. **Create a Project** (Projects → New project, any template) and note its number from the URL.
3. **Create a token**: a [classic personal access token](https://github.com/settings/tokens/new) with the `repo` and `project` scopes, and save it in the private repo as the secret `JOB_RADAR_TOKEN`. The default `GITHUB_TOKEN` cannot write to a user-owned Project, and fine-grained tokens do not support them either.
4. **Copy the files from [`examples/`](examples) into the private repo**, keeping the paths:
   - `job-radar.config.yml` and `companies.yml`: what to search for and which companies to follow.
   - `.github/workflows/`: `setup`, `collect`, `sync-status`, `intake` and `weekly`; plus `discover` and `evaluate` if you use the optional extras.
   - `.github/ISSUE_TEMPLATE/job.yml`: the form for jobs you find by hand.
5. **Edit the config**, at least `issues.project_number` and `search.include`.
6. **Run the `setup` workflow** once (Actions → setup → Run workflow). It creates the labels and the Project fields.
7. **Run `collect` with `dry-run` ticked** to see what it would open, then run it for real. From then on it runs on its own.

## How a job moves

| Stage | Label | What happens |
| --- | --- | --- |
| New | `status:new` | The collector opened it. Open it, decide, apply or close it. |
| Applied | `status:applied` | Fills `Applied on` with today if empty. |
| Screening, HR interview, Tech interview, Take-home, Offer | `status:*` | The board column follows the label. |
| Hired, Rejected, Withdrawn | `status:hired`, `status:rejected`, `status:withdrawn` | The issue closes as "completed". Going back to an active status reopens it. |
| Discarded | `status:discarded` | A job you looked at and will not apply to. The issue closes as "not planned". |

Add one `status:*` label and the workflow removes the previous one. Dragging a card on the board does not trigger Actions on a personal account, so change the label. To drop a job you will not apply to, add `status:discarded`, plus a reason such as `discard:hybrid`, `discard:salary` or `discard:stack` (`setup` creates a set; any `discard:*` label counts). The issue closes as "not planned", leaves the "New" column, and the Metrics issue counts it as *Discarded* and breaks the reasons down. Jobs that leave the company's board by themselves get `status:discarded` and `closed-at-source` from `revalidate`.

An application nobody answers is not a rejection, so it keeps its status. The Metrics issue lists it as *No response* once it is older than `metrics.no_response_after_days` (60 by default), or at once when you add the `no-response` label, for example after seeing the posting taken down.

## Commands

The Action takes `command` plus `github-token`. The same commands run locally with `npm run cli -- <command>` and a `GITHUB_TOKEN`.

| Command | When | What it does |
| --- | --- | --- |
| `setup` | once | Creates labels and Project fields, aligns the `Status` options. |
| `collect` | daily | Fetches the sources, filters, deduplicates and opens issues. Commits `state/seen.json` (your workflow does the commit). |
| `sync-status` | on `labeled` | Keeps one status label and mirrors it to the Project and the issue state. |
| `intake` | on `opened` | Normalizes issues made with the form. |
| `revalidate` | weekly | Closes "New" jobs whose posting left the company's board (`closed-at-source`). |
| `metrics` | weekly | Writes the calculated fields, repairs `Status` cards that no longer match their label, and rewrites the Metrics issue. |
| `discover` | weekly, optional | Searches Google through SerpAPI for career pages on the supported ATS and opens a pull request that adds the new companies to `companies.yml`. |
| `evaluate` | on `/evaluate` comment, optional | Posts a full AI analysis of the job (strengths, gaps, likely interview questions) and refreshes its `fit:*` label. |
| `import` | once, local | Creates issues from a spreadsheet: `npm run cli -- import --xlsx file.xlsx --repo you/job-search`. See `src/import/xlsx.ts` for the expected columns. |

`collect`, `import`, `metrics`, `revalidate` and `discover` accept `dry-run` and write nothing.

## Configuration

`job-radar.config.yml` (see [`examples/`](examples) for a filled-in file and [`docs/DESIGN.md`](docs/DESIGN.md) for the reasoning):

| Key | Meaning |
| --- | --- |
| `search.include` | A job is a candidate when its title has one of these terms (whole words, accents and case ignored). |
| `search.ambiguous`, `search.ambiguous_requires` | Terms too generic on their own, and the words that confirm them in the title or description. |
| `search.exclude` | Titles with these terms are dropped (`Intern`, `Junior`...). |
| `search.seniority` | `senior`, `specialist`, `staff`, `lead`. A job that states no level is dropped, unless its description asks for 5 or more years of experience (ranges like "3-5 years" do not count), which reads as `senior`. |
| `search.max_age_days` | Ignore postings older than this. |
| `search.highlight` | Stack terms quoted in the issue when the description mentions them. |
| `eligibility.accept_regions` | `worldwide`, `latam`, `americas`, `brazil`. A job passes when any of its locations is in one of them. |
| `eligibility.reject` | Phrases that discard a job anywhere in its text (`US only`...). "must reside in Brazil" is not rejected when Brazil is accepted. |
| `work_model` | `remote`, `hybrid`, `onsite`. The source's field is checked against the title and description; the more demanding model wins. |
| `sources.<id>.enabled` | Turn a source on or off. A source with no adapter in your version is skipped with a note in the run summary. |
| `sources.google_jobs.*` | `api_key_secret`, `max_searches` (default 3 a run), `queries` and `location`. See "Optional: SerpAPI". |
| `discovery.*` | `enabled`, `queries` (Google searches such as `site:boards.greenhouse.io "QA" remote`) and `max_searches`. |
| `ai.*` | `enabled`, `model` and `max_calls_per_run`. See "Optional: AI". |
| `issues.max_per_run` | At most this many new issues per run, newest first. The rest wait for the next run. |
| `issues.project_number`, `issues.project_owner` | Which Project to use. |
| `issues.close_on_final_status` | Close issues on `rejected`, `withdrawn` and `hired` (default `true`). |

`companies.yml` lists the companies to follow on each ATS, by the slug in their career page URL (`https://boards.greenhouse.io/<slug>`). An entry can be `{ slug: ramp, name: Ramp }` to pick the name used in issue titles.

When a posting states working hours with a time zone (`9am–5pm ET`), the issue shows them in Brasília time, using the zone's rules on the collection date.

## Sources

| Source | Mode | Notes |
| --- | --- | --- |
| InHire | per company | Brazilian ATS; public career page API. |
| Greenhouse | per company | Documented public API. |
| Lever | per company | Documented public API. |
| Ashby | per company | Public job board API. |
| Gupy | global search | The job portal most large Brazilian employers use. Not a documented API: it calls the portal's own search endpoint, so the daily live test watches it. |
| Himalayas | global search | Public API for remote jobs; the issue links back to the posting. |
| freehire | global search | Public API of freehire.me, which aggregates about 50 ATS. Searches titles with the region and country facets; a personal project with no SLA, so an outage only costs this source. |
| Remote OK | global search | Public JSON feed of the latest remote jobs. Its terms ask for a link back and a mention as the source, which the issue provides. |
| We Work Remotely | global search | Official RSS feed of the latest remote jobs. |
| Google Jobs | global search | Through SerpAPI, so it also covers postings that only exist on LinkedIn, Indeed or Glassdoor. Optional, needs a key. |

Each adapter validates what it receives with a zod schema, so a source that changes its format fails on its own, with a warning, without stopping the others. A source that returns nothing for three runs in a row is flagged in the run summary. LinkedIn, Indeed and Glassdoor are not scraped: their terms forbid it.

## Optional: SerpAPI

Google Jobs and company discovery use [SerpAPI](https://serpapi.com), whose free plan allows 100 searches a month. Everything else works without it.

1. Create a SerpAPI account and save the key as the secret `SERPAPI_KEY` in your private repo.
2. **Google Jobs:** set `sources.google_jobs.enabled: true`. Each daily run spends up to `max_searches` searches (default 3, about 66 a month on business days). Without `queries`, one search is built from your first include terms.
3. **Discovery:** set `discovery.enabled: true`, list the `queries`, and add the `discover` workflow. Every week it opens a pull request that adds the career pages it found, after checking that each answers with at least one posting. Merge it to start collecting from them, or close it to discard.

Without the key both stay off and the run summary says so.

## Optional: AI

When `ai.enabled` is true, each new job gets a fit score for your profile (a `fit:1` to `fit:5` label and two or three lines of reasoning in the issue), plus what rules cannot read: contract, salary range, required hours, stack, and whether it really is fully remote. The score sorts and highlights; it never discards a job. Commenting `/evaluate` on an issue posts the full analysis.

- **Free:** it calls [GitHub Models](https://docs.github.com/en/github-models) with the workflow's own `GITHUB_TOKEN` (`permissions: models: read`), so there is no API key. Before turning it on, check in GitHub Billing that paid usage of GitHub Models is off; then the free limits are the only limits. They are not well documented and GitHub may reduce them.
- **Your profile stays private:** save your profile or résumé as text in the secret `JOB_RADAR_PROFILE`. The workflow passes it to the Action, which sends it only to the model and never writes it anywhere.
- **Safe by default:** off unless you enable it, at most `ai.max_calls_per_run` calls a run, and an issue is created without a score when the quota runs out or a call fails. Posting text is sent to the model as data and its reply is validated and sanitized before it reaches an issue, but treat the score as a hint.
- **Setup:** `ai.enabled: true`, the `collect` workflow's `models-token` and `profile` inputs (already in the example), and the `evaluate` workflow for `/evaluate`. Only the repository owner, members and collaborators can trigger it. With AI on, each new issue also keeps the full posting text in a collapsed block, which `/evaluate` reads.

## Development

```bash
npm ci
npm test              # unit, contract (recorded fixtures) and GitHub integration tests
npm run test:live     # one real request per source; runs daily in CI
npm run typecheck
npm run build         # bundles dist/index.cjs, which the Action runs; commit it with your change
```

To add a source, write an adapter in `src/adapters/` that implements `SourceAdapter` (`fetch` returns validated raw postings, `normalize` returns a `Job`), register it in `src/adapters/index.ts`, record a fixture under `test/fixtures/` and cover it in `test/adapters.test.ts`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/); see [`AGENTS.md`](AGENTS.md).

## License

MIT
