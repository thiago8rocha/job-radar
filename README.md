# job-radar

Collects job postings, opens one GitHub issue per relevant job, and tracks each hiring process to the end, using GitHub Issues and Projects as the tracker. It runs entirely on GitHub Actions: no server, no database, no cost beyond free Actions minutes.

- **Collector.** Every business day it reads InHire, Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Teamtailor, Quickin, Sólides, Workday, career pages, Gupy, Himalayas, freehire, Get on Board, LinkedIn, Remote OK, Jobicy, GitHub job repos, Hacker News and We Work Remotely (and Google Jobs, optionally), filters by title, seniority, remote work and region, removes duplicates, and opens one issue per new job.
- **Tracker.** You move a job along by changing its `status:*` label. The Project board, the open/closed state and the dates follow.
- **Metrics.** After every collect and every week, a job rewrites a pinned "Metrics" issue (funnel, response rate, time to response, by source and contract) and fills the calculated Project fields.
- **Manual jobs.** An issue form covers recruiters and referrals. A spreadsheet importer brings in history.
- **Optional extras.** A weekly search for new companies to follow (SerpAPI), and a fit score and `/evaluate` analysis from an AI provider of your choice. Both are off until you turn them on, and neither is needed for the rest.

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

### Reliable schedule (recommended)

GitHub delays scheduled workflows under load and can drop them, most of all between 00:00 and 08:00 UTC. The `schedule` in the example `collect` workflow is only a fallback (07:17 and 13:47 in Brasília). For runs at the time you pick, call the workflow from a free external scheduler such as [cron-job.org](https://cron-job.org):

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to your private repo, with only the permission *Actions: read and write*.
2. Schedule `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/collect.yml/dispatches` with the headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json` and the body `{"ref":"main"}`. Suggested times: 07:00 and 14:00 Brasília, Monday to Friday.

A guard job skips any run when a collect succeeded in the last `min-interval-hours` (default 4), so the external trigger and the fallback never both run. Tick `force` on a manual run to bypass it. The Metrics issue shows when the last collect succeeded and warns if it is stale.

## How a job moves

| Stage | Label | What happens |
| --- | --- | --- |
| New | `status:new` | The collector opened it. Open it, decide, apply or close it. |
| Applied | `status:applied` | Fills `Applied on` with today if empty. |
| Screening, HR interview, Tech interview, Take-home, Offer | `status:*` | The board column follows the label. |
| Hired, Rejected, Withdrawn | `status:hired`, `status:rejected`, `status:withdrawn` | The issue closes as "completed". Going back to an active status reopens it. |
| Discarded | `status:discarded` | A job you looked at and will not apply to. The issue closes as "not planned". |

Add one `status:*` label and the workflow removes the previous one. Dragging a card on the board does not trigger Actions on a personal account, so change the label. To drop a job you will not apply to, add `status:discarded`, plus a reason such as `discard:hybrid`, `discard:salary` or `discard:stack` (`setup` creates a set; any `discard:*` label counts). The issue closes as "not planned", leaves the "New" column, and the Metrics issue counts it as *Discarded* and breaks the reasons down. Jobs that leave the company's board by themselves get `status:discarded` and `closed-at-source` from `revalidate`; if the same job is posted again, `collect` reopens the issue at `status:new` with the new link in a comment. When a job you applied to (or discarded) is reposted, the earlier issue gets a comment with the new link and the `signal:reposted` label instead of a second issue: a repost after no answer is worth knowing about.

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
| `metrics` | weekly, and after each `collect` | Writes the calculated fields, repairs `Status` cards that no longer match their label, and rewrites the Metrics issue. |
| `sweep` | weekly, optional | Walks `companies.directory.yml` (a large cold list of boards) in slices and records which companies have postings that match your search. Creates no issues. Commits `state/companies.json`. |
| `prune` | weekly | Opens (or updates) one pull request removing from `companies.yml` the boards that were missing or unreadable for 4 weeks in a row. |
| `discover` | weekly, optional | Searches Google through SerpAPI for career pages on the supported ATS and opens a pull request that adds the new companies to `companies.yml`. It also checks the boards that collected jobs link to and the tenants the Wayback Machine has seen for ATS with no search of their own (`discovery.max_archive_queries`), so it is useful without a SerpAPI key. |
| `evaluate` | on `/evaluate` comment, optional | Posts a full AI analysis of the job (each requirement weighed by importance and evidence, what the posting leaves open with questions for the recruiter, likely interview questions) and refreshes its `fit:*` label. |
| `import` | once, local | Creates issues from a spreadsheet: `npm run cli -- import --xlsx file.xlsx --repo you/job-search`. See `src/import/xlsx.ts` for the expected columns. |

`collect`, `import`, `metrics`, `revalidate`, `discover`, `sweep` and `prune` accept `dry-run` and write nothing.

### Hot and cold company lists

`companies.yml` is read on every `collect`. For a long list of boards (a public directory of Greenhouse, Lever and Ashby companies, say), put them in `companies.directory.yml` instead, with the same shape. The weekly `sweep` checks them in slices and `collect` then reads only the directory companies that had a posting matching your search in the last `directory.hot_days` (default 45). Entries in `companies.yml` can also be a board URL, `{ url: https://jobs.eu.lever.co/acme }`, which is how an EU-region Lever board is listed.

## Configuration

`job-radar.config.yml` (see [`examples/`](examples) for a filled-in file and [`docs/DESIGN.md`](docs/DESIGN.md) for the reasoning):

| Key | Meaning |
| --- | --- |
| `search.include` | A job is a candidate when its title has one of these terms (whole words, accents and case ignored). |
| `search.ambiguous`, `search.ambiguous_requires` | Terms too generic on their own, and the words that confirm them in the title or description. |
| `search.exclude` | Titles with these terms are dropped (`Intern`, `Junior`...). |
| `search.exclude_companies` | Companies whose jobs are always dropped (`Jobgether`...). Matched on the company name, case, accents and spacing ignored: `Jobgether` also catches `Job Gether`. |
| `search.seniority` | `senior`, `specialist`, `staff`, `lead`. A title with a numbered level of 3 or higher ("III", "IV", "Nível 3", "Level 3") also reads as `senior`. A job that states no level is dropped, unless its description asks for 5 or more years of experience (ranges like "3-5 years" do not count), which reads as `senior`. |
| `search.max_age_days` | Ignore postings older than this. |
| `search.highlight` | Stack terms quoted in the issue when the description mentions them. |
| `eligibility.accept_regions` | `worldwide`, `latam`, `americas`, `brazil`. A job passes when any of its locations is in one of them. |
| `eligibility.reject` | Phrases that discard a job anywhere in its text (`US only`...). "must reside in Brazil" is not rejected when Brazil is accepted. A role the text places in another country ("Our partner is looking for a QA Engineer based in Canada") is also dropped, whatever countries the source lists. |
| `eligibility.reject_languages` | Languages a job may not require (`Russian`, `Spanish`...). "Fluent Russian", "Espanhol avançado" or "Bilingual (English/Spanish)" discard the job; "Spanish is a plus", "English or Spanish" and a bare mention do not. |
| `work_model` | `remote`, `hybrid`, `onsite`. The source's field is checked against the title and description; the more demanding model wins. |
| `sources.<id>.enabled` | Turn a source on or off. A source with no adapter in your version is skipped with a note in the run summary. |
| `sources.linkedin.*` | `queries` (default: the first 6 `search.include` terms), `locations` (default `Brazil` and `Worldwide`), `max_searches` (default 12), `window_days` (default 2) and `delay_ms` (default 3000). |
| `sources.google_jobs.*` | `api_key_secret`, `max_searches` (default 3 a run), `queries` and `location`. See "Optional: SerpAPI". |
| `discovery.*` | `enabled`, `queries` (Google searches such as `site:boards.greenhouse.io "QA" remote`) and `max_searches`. |
| `ai.*` | `enabled`, `base_url`, `model` and `max_calls_per_run`. See "Optional: AI". |
| `metrics.no_response_after_days` | Days after which an unanswered application counts as "no response" (default 60). |
| `metrics.follow_up_after_days` | Days after which an application still at `status:applied` gets one reminder comment on its issue (default 30, 0 turns it off). |
| `run.budget_minutes` | Minutes the whole collection may take (default 20). A source that is still working stops with what it has and logs how many companies it skipped. `sources.<id>.timeout_minutes` (default 5) sets a tighter limit for one source. |
| `issues.max_per_run` | At most this many new issues per run. What does not fit waits in a backlog kept in `state/seen.json` (up to 200 jobs, dropped once older than `search.max_age_days` or when an issue exists) and is written first on the next run, so busy days do not push the oldest jobs out. Each group is ordered with the company's own ATS link first, then jobs read from a company's board before aggregators, then newest first; with AI on, by fit score. |
| `issues.project_number`, `issues.project_owner` | Which Project to use. |
| `issues.close_on_final_status` | Close issues on `rejected`, `withdrawn` and `hired` (default `true`). |

`companies.yml` lists the companies to follow on each ATS, by the slug in their career page URL (`https://boards.greenhouse.io/<slug>`). An entry can be `{ slug: ramp, name: Ramp }` to pick the name used in issue titles.

A job counts as a duplicate when its source id, its application link, its company and title, or its company and posting code match one that already has an issue, open or closed. Company names are compared without legal suffixes, so "Plata" and "Banco Plata, S.A." are the same company, and a bracketed code, a `[Exclusiva PCD]` tag or a region tag such as `- Brazil` or `(LATAM based)` in the title does not make a job new.

When a posting states working hours with a time zone (`9am–5pm ET`), the issue shows them in Brasília time, using the zone's rules on the collection date.

## Sources

| Source | Mode | Notes |
| --- | --- | --- |
| InHire | per company | Brazilian ATS; public career page API. |
| Greenhouse | per company | Documented public API. |
| Lever | per company | Documented public API. |
| Ashby | per company | Public job board API. |
| Career pages | per company | A company's own career site, listed under `careers:` as `{ url, name }`. Cheapest first: a link to a supported ATS (also inside an embedded iframe or script) goes to that ATS's adapter; else the page's schema.org `JobPosting` JSON-LD; else the job sitemap listed in `robots.txt`, reading only postings whose URL could pass your filters. It reads `robots.txt` first and never uses a headless browser. A page with no job data fails with a warning instead of counting as an empty board. |
| Workday | per company | Large employers, including banks hiring in Brazil. Entries are the career site URL, `{ url: https://<tenant>.wd5.myworkdayjobs.com/<site>, name: Acme }`, because a slug cannot address a Workday site. One search per `search.include` term, then the detail of each posting that could pass the filters. The list only says "Posted 6 Days Ago", so older postings have no date until the detail is read. |
| Sólides | per company | Brazilian ATS. The vacancies API its company career pages call (`apigw.solides.com.br/jobs/v3/companies/{slug}/vacancies`), 25 per page. Not a documented API, so the live test watches it. The portal-wide search is not used. |
| Quickin | per company | Brazilian ATS. Public jobs API keyed by account id; job-radar reads the id once from the career page (`jobs.quickin.io/<slug>`) and keeps it in `state/companies.json`. You can also write the 24-character id as the slug. |
| Teamtailor | per company | Public RSS feed of the career site (`/jobs.rss`, which states remote and hybrid jobs), with `/jobs.json` as a fallback. Works on `{slug}.teamtailor.com` and, as `{ url: https://careers.acme.com }`, on the company's own domain. |
| Recruitee | per company | Public career site API, `{company}.recruitee.com/api/offers/`: no token needed (checked against a live board), the whole board in one request, with the salary when the offer publishes one. |
| SmartRecruiters | per company | Documented Posting API. The company id is case sensitive (`BoschGroup`), and a wrong one looks like an empty board. One search per `search.include` term, then the detail of each posting that could pass the filters. |
| Workable | per company | Public widget API of the career page, the whole board in one request. |
| Gupy | global search | The job portal most large Brazilian employers use. Not a documented API: it calls the portal's own search endpoint, so the live test watches it. |
| Himalayas | global search | Public API for remote jobs; the issue links back to the posting. |
| freehire | global search | Public API of freehire.me, which aggregates about 50 ATS. Searches titles with the region and country facets; when a posting comes without a link, the redirect freehire gives is followed to the real one; a personal project with no SLA, so an outage only costs this source. |
| Get on Board | global search | Public API, no key, of a tech job board with many LatAm jobs. It has no text search, so it reads the SysAdmin / DevOps / QA category newest first and the title filter does the rest; postings that are remote only for residents of an unnamed country are skipped. |
| LinkedIn | global search | LinkedIn's public guest search, no login and no key; off by default. One search per term and place for remote, Mid-Senior jobs of the last 2 days, then one detail page for each card that passes the cheap filters. Requests are spaced out and a 429 ends the source with what it had read. Based on the endpoints documented by [JobSpy](https://github.com/speedyapply/JobSpy) (MIT). |
| Hacker News "Who is hiring?" | global search | The latest monthly thread, through the Algolia HN API (no key): its top-level comments are the postings, read from the usual `Company \| Role \| Place \| Remote` first line. Few QA roles appear, so it is off by default. |
| GitHub job repos | global search | Open issues of Brazilian job boards that run as GitHub repositories, one issue per job: `backend-br/vagas`, `frontendbr/vagas` and `qa-brasil/vagas` by default, or the `repos` you list under `sources.github_repos`. Read with the run's own GitHub token. Titles and labels are free-form, so the company comes from the title (`Role na Company`, `Role - Company`) and the filters do the rest. Off by default. |
| Jobicy | global search | Public API of remote jobs, no key. One request per accepted region (`brazil`, `latam`, `anywhere`, taken from `eligibility.accept_regions`) and `search.include` term. Its terms ask for a credit with a direct link, which the issue's source line and apply link provide. |
| Remote OK | global search | Public JSON feed of the latest remote jobs. Its terms ask for a link back and a mention as the source, which the issue provides. |
| We Work Remotely | global search | Official RSS feed of the latest remote jobs. |
| Google Jobs | global search | Through SerpAPI, so it also covers postings that only exist on LinkedIn, Indeed or Glassdoor. Optional, needs a key. |

**About LinkedIn.** It has no public API: the source reads the HTML of its guest pages, and LinkedIn's terms forbid automated access, so turn it on knowing that and keep the volume low. It can also stop working without a change on your side: GitHub's runners use datacenter IPs that LinkedIn often answers with HTTP 429, and a change in its HTML makes the schema check fail. Either way the collect log carries a warning (`linkedin: rate limited` or `linkedin: failed`) and the other sources carry on.

Each adapter validates what it receives with a zod schema, so a source that changes its format fails on its own, with a warning, without stopping the others. A source that returns nothing for three runs in a row is flagged in the run summary. LinkedIn, Indeed and Glassdoor are not scraped: their terms forbid it.

## Optional: SerpAPI

Google Jobs and company discovery use [SerpAPI](https://serpapi.com), whose free plan allows 100 searches a month. Everything else works without it.

1. Create a SerpAPI account and save the key as the secret `SERPAPI_KEY` in your private repo.
2. **Google Jobs:** set `sources.google_jobs.enabled: true`. Every request is one search (each page, and the extra call of `remote_filter`; cached repeats within an hour are free). A run spends up to `max_searches` of them (default 3), takes the `queries` in turn from run to run, and stops for the month at `monthly_cap` (default 100, counted across runs; discovery has its own count against the same plan). Write the queries as plain text with the remote intent in them (`QA Engineer remote`, `Analista de QA remoto`); quotes and `OR` are not documented by SerpAPI and long queries tend to come back empty. Without `queries`, one `<include term> remote` search is built from each of your first five include terms.
   `location` must be a name from [SerpAPI's Locations API](https://serpapi.com/locations.json?q=Brazil) (`Brazil`, or `Sao Paulo,State of Sao Paulo,Brazil` for a city). `gl` defaults to `br` when `brazil` is an accepted region and `hl` to `pt-br` (with the page in English Google Jobs returns almost nothing for Brazil), or `en` when Brazil is not accepted. `max_pages` (default 1) reads more than the first 10 jobs of a query. The run log names the location Google used for each search.
3. **Discovery:** set `discovery.enabled: true`, list the `queries`, and add the `discover` workflow. Every week it opens a pull request that adds the career pages it found, after checking that each answers with at least one posting. Merge it to start collecting from them, or close it to discard.

Without the key both stay off and the run summary says so.

## Posting signals

The text of a posting can say what its source label hides. When a new job's text shows one of these, the issue gets a `signal:*` label and a `**Signal (...)**` line quoting the sentence. Nothing is discarded: it is a warning for you to weigh.

| Label | Raised by |
| --- | --- |
| `signal:internal` | Internal selection: "internal candidates only", "seleção interna", "exclusivo para colaboradores". |
| `signal:intermediary` | A recruiter or aggregator posting for someone else: "on behalf of a partner company", "our client is...", "nosso cliente atua...". |
| `signal:scam` | Money or contact traits: a registration or training fee, a request for bank details, contact only by WhatsApp or Telegram. A sentence that warns against these ("we will never ask you to pay a fee") does not count. |

## Optional: AI

When `ai.enabled` is true, each new job gets a fit score for your profile (a `fit:1` to `fit:5` label and two or three lines of reasoning in the issue), plus what rules cannot read: contract, salary range, required hours, stack, and whether it really is fully remote. The score sorts and highlights; it never discards a job. Commenting `/evaluate` on an issue posts the full analysis.

- **Your provider:** it calls any OpenAI-compatible chat completions API. Set `ai.base_url` and `ai.model` in the config and save the provider's API key as the secret `AI_API_KEY`. Several providers have a free tier that is enough for a few calls a day (Google Gemini, Groq); their limits change, so check the provider's page and its billing settings before relying on them. GitHub Models is no longer an option: it was retired on 2026-07-30.
- **Your profile stays private:** save your profile or résumé as text in the secret `JOB_RADAR_PROFILE`. The workflow passes it to the Action, which sends it only to the model and never writes it anywhere. `examples/profile.template.md` is a template for a fuller master profile: deal-breakers first, then preferences, skills with honest levels, known gaps and your experience.
- **Safe by default:** off unless you enable it, at most `ai.max_calls_per_run` calls a run, and an issue is created without a score when the quota runs out or a call fails. Posting text is sent to the model as data and its reply is validated and sanitized before it reaches an issue, but treat the score as a hint.
- **Setup:** `ai.enabled: true` with `ai.base_url` and `ai.model`, the `collect` workflow's `ai-api-key` and `profile` inputs (already in the example), and the `evaluate` workflow for `/evaluate`. Only the repository owner, members and collaborators can trigger it. Every new issue keeps the full posting text in a collapsed block, which `/evaluate` and external scorers read.

## Seeding the company directory

`import-companies` fills `companies.directory.yml` from a list of boards, skipping any slug already in `companies.yml` or the directory; running it twice gives the same file. Rows for an ATS job-radar has no adapter for are counted and reported, not imported.

```sh
# a CSV; the defaults follow the LastRound AI ATS directory (ats_vendor, board_slug, company_name)
npm run cli -- import-companies --csv ats-directory.csv
# any CSV, naming its columns
npm run cli -- import-companies --csv boards.csv --ats-column vendor --slug-column slug --name-column name
# a text file with one career-page URL per line
npm run cli -- import-companies --urls career-pages.txt
```

The [LastRound AI ATS directory](https://datahub.io/lastroundai-hiring-data/lastroundai-hiring-data/ats-directory) (about 9.9k Greenhouse, Lever and Ashby boards) is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): credit it if you share what you build from it. Keep the dataset and the resulting directory in your own private repo, not in this one.

## Development

```bash
npm ci
npm test              # unit, contract (recorded fixtures) and GitHub integration tests
npm run test:live     # one real request per source; run by hand from the live-contract workflow
npm run typecheck
npm run build         # bundles dist/index.cjs, which the Action runs; commit it with your change
```

To add a source, write an adapter in `src/adapters/` that implements `SourceAdapter` (`fetch` returns validated raw postings, `normalize` returns a `Job`), register it in `src/adapters/index.ts`, record a fixture under `test/fixtures/` and cover it in `test/adapters.test.ts`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/); see [`AGENTS.md`](AGENTS.md).

## License

MIT
