# job-radar

Collects job postings, opens one GitHub issue per relevant job, and tracks each hiring process to the end, using GitHub Issues and Projects as the tracker. It runs entirely on GitHub Actions: no server, no database, no cost beyond free Actions minutes.

- **Collector.** Every business day it reads InHire, Greenhouse, Lever, Ashby and Himalayas, filters by title, seniority, remote work and region, removes duplicates, and opens one issue per new job.
- **Tracker.** You move a job along by changing its `status:*` label. The Project board, the open/closed state and the dates follow.
- **Metrics.** A weekly job rewrites a pinned "Metrics" issue (funnel, response rate, time to response, by source and contract) and fills the calculated Project fields.
- **Manual jobs.** An issue form covers recruiters and referrals. A spreadsheet importer brings in history.

Everything personal (your searches, companies and history) lives in your own **private** repo. This repo only holds the engine, which your workflows call as `thiago8rocha/job-radar@v1`.

## Set up your own

1. **Create a private repo** for your data, for example `job-search`.
2. **Create a Project** (Projects → New project, any template) and note its number from the URL.
3. **Create a token**: a [classic personal access token](https://github.com/settings/tokens/new) with the `repo` and `project` scopes, and save it in the private repo as the secret `JOB_RADAR_TOKEN`. The default `GITHUB_TOKEN` cannot write to a user-owned Project, and fine-grained tokens do not support them either.
4. **Copy the files from [`examples/`](examples) into the private repo**, keeping the paths:
   - `job-radar.config.yml` and `companies.yml`: what to search for and which companies to follow.
   - `.github/workflows/`: `setup`, `collect`, `sync-status`, `intake` and `weekly`.
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

Add one `status:*` label and the workflow removes the previous one. Dragging a card on the board does not trigger Actions on a personal account, so change the label. Closing an issue without any status means "discarded without applying".

## Commands

The Action takes `command` plus `github-token`. The same commands run locally with `npm run cli -- <command>` and a `GITHUB_TOKEN`.

| Command | When | What it does |
| --- | --- | --- |
| `setup` | once | Creates labels and Project fields, aligns the `Status` options. |
| `collect` | daily | Fetches the sources, filters, deduplicates and opens issues. Commits `state/seen.json` (your workflow does the commit). |
| `sync-status` | on `labeled` | Keeps one status label and mirrors it to the Project and the issue state. |
| `intake` | on `opened` | Normalizes issues made with the form. |
| `revalidate` | weekly | Closes "New" jobs whose posting left the company's board (`closed-at-source`). |
| `metrics` | weekly | Writes the calculated fields and the Metrics issue. |
| `import` | once, local | Creates issues from a spreadsheet: `npm run cli -- import --xlsx file.xlsx --repo you/job-search`. See `src/import/xlsx.ts` for the expected columns. |

`collect`, `import`, `metrics` and `revalidate` accept `dry-run` and write nothing.

## Configuration

`job-radar.config.yml` (see [`examples/`](examples) for a filled-in file and [`docs/DESIGN.md`](docs/DESIGN.md) for the reasoning):

| Key | Meaning |
| --- | --- |
| `search.include` | A job is a candidate when its title has one of these terms (whole words, accents and case ignored). |
| `search.ambiguous`, `search.ambiguous_requires` | Terms too generic on their own, and the words that confirm them in the title or description. |
| `search.exclude` | Titles with these terms are dropped (`Intern`, `Junior`...). |
| `search.seniority` | `senior`, `specialist`, `staff`, `lead`. A job that states no level is dropped. |
| `search.max_age_days` | Ignore postings older than this. |
| `search.highlight` | Stack terms quoted in the issue when the description mentions them. |
| `eligibility.accept_regions` | `worldwide`, `latam`, `americas`, `brazil`. A job passes when any of its locations is in one of them. |
| `eligibility.reject` | Phrases that discard a job anywhere in its text (`US only`...). "must reside in Brazil" is not rejected when Brazil is accepted. |
| `work_model` | `remote`, `hybrid`, `onsite`. The source's field is checked against the title and description; the more demanding model wins. |
| `sources.<id>.enabled` | Turn a source on or off. |
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
| Himalayas | global search | Public API for remote jobs; the issue links back to the posting. |

Each adapter validates what it receives with a zod schema, so a source that changes its format fails on its own, with a warning, without stopping the others. A source that returns nothing for three runs in a row is flagged in the run summary. LinkedIn, Indeed and Glassdoor are not scraped: their terms forbid it.

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
