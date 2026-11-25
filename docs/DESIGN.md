# job-radar — Project document

Oct 14, 2026 · @Thiago

## Overview

job-radar collects jobs from multiple sources, opens one GitHub issue per relevant job, and tracks each hiring process to the end. It replaces manual searching and the `controle_vagas.xlsx` spreadsheet.

**Problem.** Today jobs are searched by hand, scattered across LinkedIn, company ATSs and job boards. Tracking lives in a spreadsheet with 3 manually filled columns that could be calculated.

**Goal.** Cover as many sources as possible, domestic and international, without scraping sites that forbid it. Only recent, unseen jobs come through, with the funnel and metrics updating on their own.

**v1 scope**

- Daily scheduled collection on GitHub Actions
- One issue per job, with labels and Project fields
- Manual entry of jobs that come from a recruiter or a referral
- Metrics equivalent to the current spreadsheet's, plus a few new ones

**Out of scope:** automatic applications, scraping LinkedIn, Indeed and Glassdoor, and a dedicated web interface.

**Principles**

- Open source and generic, with everything personal kept in configuration
- Better to miss a job than to flood the board: strict filter first, loosen later
- Each source fails on its own, without taking down the others
- Name, README, code and Action in English, and also everything job-radar generates: issues, labels and comments

## Architecture

The code lives in a public repo, `job-radar`, published as a reusable GitHub Action. Each person has a private repo with the config, the state and the issues, which calls the Action by version tag.

*[embedded content: architecture · public repo and private repo]*

The private repo contains no collector code, so it never diverges from the public one: an improvement to the engine reaches everyone when the `@v1` tag moves. A private fork of a public repo doesn't exist on GitHub, and a repo created from a template would stop receiving updates.

**Why private:** the company list, the filters and the history show that you are looking for a job. Also, scheduled workflows in public repos are disabled after 60 days without commits. Estimated Actions usage is 100 to 150 min/month, well under the 2,000 free minutes.

**Public repo structure**

```text
job-radar/
├─ action.yml              # Action entry point: command = collect | sync-status | intake | metrics | revalidate | setup | import
├─ src/
│  ├─ adapters/            # one file per source
│  ├─ pipeline/            # normalize, filter, dedup
│  ├─ github/              # issues, labels, Project (GraphQL)
│  ├─ metrics/
│  └─ config/              # config schema and loader
├─ test/                   # fixtures per source
├─ examples/               # example config, companies and workflows
└─ docs/DESIGN.md          # this document
```

## Sources and adapters

Each source is an independent adapter, switched on or off by the config. There are three access modes: global search by term, per-company lookup, and discovery of new companies.

**Company health and the hot/cold lists.** `state/companies.json` (separate from `state/seen.json`) keeps, per `<ats>:<slug>`, `lastOk`, `lastRelevant` (a posting passed the title filter), `failures` (weeks in a row with a 404 or a schema error; 5xx and timeouts do not count and a week counts once) and `emptyRuns`, plus the sweep cursor. `companies.yml` is always read. `companies.directory.yml`, the cold list, is only read by `sweep`, which walks it in slices of 200 within `run.budget_minutes`, resumes from the cursor and updates health without creating issues; a directory company whose `lastRelevant` is within `directory.hot_days` joins `collect`. `prune` proposes, by pull request, removing `companies.yml` boards with 4 failing weeks; nothing leaves the file without a merge. Directory companies are fetched lightly: Greenhouse lists titles without `content=true` and fetches `/jobs/{id}?pay_transparency=true` only for postings that could pass the filters, which also yields published pay ranges.

**Harvesting companies from links already collected.** Search sources (freehire, Himalayas, Remote OK, We Work Remotely, Get on Board, Google Jobs) often link straight to a Greenhouse, Lever, Ashby or InHire board. On every real `collect`, the apply link of each fetched job, filtered or not, goes through the same link parser as discovery; boards that are in neither `companies.yml` nor the directory are kept in `state/companies.json` as candidates (first seen, last seen, count) and forgotten after 60 days without a sighting. `discover` checks up to 50 of them per run, most-seen first, with the usual `hasPostings` test, and adds the ones that answer to its pull request, so it works without a SerpAPI key (the search part is skipped). A board that is gone keeps being re-checked while jobs still link to it; that costs one request a week.

**Discovery through public URL archives.** For an ATS with no central search, tenants are found the way `hirehub` finds InHire's: the Wayback Machine CDX API, queried with the ATS's `archive` patterns from the registry (today `*.inhire.app`; each new ATS adds its own, such as `apply.workable.com/*`), `collapse=urlkey`, the last 12 months and a 5,000-row page. The slugs come out of the same link parser as everything else and each new one goes through `hasPostings` before it is proposed. `discovery.max_archive_queries` (default 10, 0 turns it off) caps the CDX requests per run; the HTTP client spaces them one second apart with the identifying User-Agent, and an archive that is slow or down only costs this source of candidates. Gupy company pages are not covered: Gupy is read through its portal-wide source, so it has no per-company entry in the registry. urlscan.io would be a second source but needs a key for useful volume, so it stays out unless the CDX results turn out poor.

**Seeding the directory.** `import-companies` (a local CLI command, like `import`) merges a CSV or a list of career-page URLs into `companies.directory.yml`. A CSV is read with its own RFC 4180 parser so slugs such as `007` stay text; the URL list goes through the same link parser as discovery. The first dataset is the LastRound AI ATS directory, imported whole: the weekly `sweep` decides what reaches the daily run, so the size of the list costs nothing in `collect`.

**Regions.** Checked live: a Lever EU board answers on `api.eu.lever.co` (the `lever` board returns postings there and an empty list on `api.lever.co`), so an entry written as `{ url: https://jobs.eu.lever.co/<slug> }` is read from the EU host. Greenhouse EU (`boards-api.eu.greenhouse.io`) does not resolve, so Greenhouse EU links keep using the standard API.

**ATS registry.** The per-company ATS are listed once, in `src/adapters/ats.ts`: id, the URL patterns that identify a board (including regional hosts such as the EU ones) and whether the slug is case-sensitive. The `companies.yml` schema, the listed-slug check, discovery from links and the empty defaults are all derived from that table, so a new ATS is one table entry plus one adapter. A `companies.yml` entry is a `slug`, `{ slug, name }` or `{ url, name }`; the URL form is for ATS keyed by more than a slug (Workday) and for the generic careers adapter.

| Source | Mode | Access | Priority | Notes |
| --- | --- | --- | --- | --- |
| InHire | Per company | JSON behind `company.inhire.app/vagas` via GET api.inhire.app/job-posts/public/pages, with headers X-Tenant: {company} and X-Inhire-Client: web-inhire, no authentication. Company name from GET api.inhire.app/tenants/public/config/{company}. The response returns all jobs in a `jobsPage` array, without pagination, with displayName, jobId, status, workplaceType (Remote, Hybrid) and location. Details come from GET api.inhire.app/job-posts/public/pages/{jobId}, with the same headers: publishedAt, contractType, salaryCurrency, the description in HTML and the fields the application form requires. It is only called for jobs that pass the title and remote filters, and entries such as "Banco de Talentos" (talent pool) are discarded | v1 | 9 of the 22 applications in the spreadsheet came from here; no aggregator of its own |
| Himalayas | Global search | Official public API, no key, 20 jobs per page | v1 | Reports eligibility by country and timezone; requires a link back |
| Greenhouse | Per company | `boards-api.greenhouse.io/v1/boards/{company}/jobs` | v1 | Documented public API |
| Lever | Per company | `api.lever.co/v0/postings/{company}` | v1 | Documented public API |
| Ashby | Per company | Public per-company job board API | v1 | Common in startups that hire remotely |
| Hacker News "Who is hiring?" | Global search | Algolia HN API: `search_by_date?tags=story,author_whoishiring` finds the thread, `tags=comment,story_<id>` lists its comments | v2 | Optional, off by default. Only top-level comments (`parent_id` is the thread) are postings. The first line follows a loose `Company \| Role \| Place \| Remote` convention, so the title is the second field and the apply link is the comment itself |
| GitHub job repos | Global search | Issues API of `backend-br/vagas`, `frontendbr/vagas`, `qa-brasil/vagas` | v2 | The one QA-specific board, `qa-brasil/vagas`, has been quiet since 2023, so the age filter drops most of it; the other two are general and the title filter does the work. The run's authenticated Octokit client is passed to the adapter (`FetchContext.github`). Issue forms differ between repos, so only the title, labels and company website are read, and the apply link is the issue itself |
| Jobicy | Global search | `jobicy.com/api/v2/remote-jobs?geo=<region>&tag=<term>`, public, no key | v2 | Verified live. `geo` is one of the slugs from `?get=locations`, loaded once; the accepted regions map to `brazil`, `latam` and `anywhere`. Its notice asks for a credit with a direct link and for application buttons to use the feed's job URL, so that URL is the apply link and the source line names Jobicy. Levels map to `senior`, `mid` and `junior`; `Director` and `Any` are left to the title |
| Career pages | Per company | Generic reader for a company's own site: ATS link, `JobPosting` JSON-LD, job sitemap | v2 | See "Career pages on company sites" below |
| Workday | Per company | `POST {origin}/wday/cxs/{tenant}/{site}/jobs`, detail at `.../wday/cxs/{tenant}/{site}{externalPath}` | v2 | Verified live; the site's `robots.txt` allows `/{site}/`. Page size is 20. Searched per include term (5 pages at most) because employers like NVIDIA have thousands of postings. The list gives only `Posted N Days Ago`, so the date is approximate until the detail is read, and `30+` has none. The company name comes from the config entry: `hiringOrganization` is a legal entity. Entries must be URLs, so link discovery skips Workday (`urlOnly` in the registry) |
| Sólides | Per company | `apigw.solides.com.br/jobs/v3/companies/{slug}/vacancies?take=25&page=N` | v2 | Verified live. Per-company only: other projects report the portal-wide search stopped answering after the portal moved to Next.js, and reading the page's embedded data would depend on markup, so neither is used. `take` above 25 is rejected. The `redirectLink` field is broken (`https://solides./...`), so the apply link is built as `https://{slug}.vagas.solides.com.br/vaga/{id}`. The pay range is shown only when the posting makes it public. Seniority is left to the title because the API's names (`Especialista`) do not map to the filter's levels |
| Quickin | Per company | `api.quickin.io/public/{account id}/jobs?sort=-created_at` | v2 | Verified live. The API wants the account id, not the URL slug. The career page (`robots.txt` allows it) carries the id in its Nuxt payload, right after the slug, so it is read once and kept in `state/companies.json` under `resolved`. The salary (`remuneration`, `currency`) is shown when the posting states one |
| Teamtailor | Per company | `/jobs.rss` of the career site, with `/jobs.json` (a JSON Feed) as fallback | v2 | Both verified live. The RSS feed is read first because it carries `remoteStatus`, which the JSON feed lacks; `none` is left as unknown rather than on-site because many companies never fill it in. Custom career domains are listed as `{ url }` |
| Recruitee | Per company | `{slug}.recruitee.com/api/offers/` | v2 | Verified live: public with no token, although one help article suggests the Careers Site API needs one. Apply links use the company's own careers domain when it has one, so the board URL is the only place the slug appears |
| SmartRecruiters | Per company | Documented Posting API, `api.smartrecruiters.com/v1/companies/{id}/postings` | v2 | The id is case sensitive and an unknown id answers 200 with no postings. The list has no description or apply link, so detail is read only for postings that pass `worthDetails`. Searched per include term (5 pages of 100 at most) because large employers have thousands of postings |
| Workable | Per company | `apply.workable.com/api/v1/widget/accounts/{slug}?details=true`, the widget API of the career page | v2 | Whole board in one request; `{slug}.workable.com` and `apply.workable.com/{slug}` are the same board |
| Gupy | Global search | `portal.gupy.io/api/job-search/jobs?jobName=…&workplaceType=remote`, up to 100 per page. The `employability-portal.gupy.io/api/v1/jobs` address this document first listed answers 404; the portal's own search page calls the endpoint above | v2 | Undocumented endpoint, found by reading the portal's code; the daily live contract watches it |
| GitHub job repos | Global search | GitHub issues API (backend-br/vagas, frontendbr/vagas, DevOps-Brazil/Vagas and similar) | v2 | Jobs published as issues; no repo is dedicated to QA, so it filters by term |
| RemoteOK | Global search | Public JSON API by tag | v2 | Lower volume |
| We Work Remotely | Global search | Official RSS feeds | v2 | Lower volume |
| Google Jobs | Global search | SerpAPI, optional | v2 | Covers what only shows up on LinkedIn, Indeed and Glassdoor, without scraping; off without a key |
| Quickin, Sólides, Recrutei, IziRH | Per company | Career page endpoint | v3 | Quickin and IziRH already appear in the spreadsheet |

**Company discovery.** The per-company sources depend on a list. A weekly job runs `site:` searches via SerpAPI and adds new companies to `companies.yml`, for review before they enter collection:

- `site:inhire.app/vagas QA`
- `site:boards.greenhouse.io "QA" remote`
- `site:jobs.lever.co "quality assurance"`
- `site:jobs.ashbyhq.com QA`

**Considered and not added.** Remotive: its public API reportedly ignores the category and search parameters and returns a small feed delayed by 24 hours. Torre: no documented public API. Vagas.com.br and Jobbol: behind Cloudflare. Catho and Indeed: their `robots.txt` forbids it. Programathor, Coodesh, Remotar and 99jobs: other projects found no usable public endpoint.

**Off the table:** direct scraping of LinkedIn, Indeed and Glassdoor. Their terms of use forbid it and blocks are frequent.

**One-time manual signup:** Turing, Toptal and Arc.dev can't be automated, but are worth signing up for, because they bring jobs to the candidate.

An adapter's interface, in TypeScript:

```ts
interface SourceAdapter {
  id: string;                          // 'greenhouse', 'himalayas'...
  mode: 'search' | 'company';
  fetch(ctx: FetchContext): Promise<RawJob[]>;
  normalize(raw: RawJob): Job;         // validates with a schema first
}
```

**Career pages on company sites.** For a company on its own career site (`carreiras.*`, `careers.*`) or on an ATS with no adapter, `companies.yml` has a `careers:` list of `{ url, name }` entries. They are never guessed. The `careers` adapter resolves each one cheapest first:

1. The URL is a board of a supported ATS: that ATS's adapter reads it.
2. The page links to a supported ATS (a link, an iframe or the Greenhouse embed script): same, and the board then shows up as a candidate for the next discovery run, so the entry can move to the ATS list. Harvesting works on the apply links of the jobs it returns.
3. The page carries schema.org `JobPosting` JSON-LD: every `application/ld+json` block is read, looking through arrays, `@graph` and `ItemList`; a posting past its `validThrough` is dropped.
4. `robots.txt` lists a sitemap (or the entry itself is a `.xml` URL): same-host URLs only, capped (`sources.careers.max_urls`, default 100), and the JSON-LD of a posting is read only for URLs whose last path segment could pass the filters, which saves requests on a site with hundreds of postings.
5. Nothing found: the company fails with a warning. There is no headless browser.

Rules that come with it: `robots.txt` is read first for every origin and respected (a missing file allows, an unreadable one forbids, as RFC 9309 asks). **Zero postings on a page that loaded is a failure, not an empty board**, otherwise a site redesign would make `revalidate` close every open "New" issue of that company; a sitemap that lists posting URLs but none that look relevant is the one case that returns an empty list. Each job records how it was found (`ats`, `jsonld`, `sitemap`), shown in the issue's source line, and `revalidate` trusts only results read straight from an ATS or the page's JSON-LD: a sitemap read is capped and filtered, so it cannot prove a job is gone.

**ATS left for later.** Personio, BambooHR, Breezy, Pinpoint, Rippling, HiringRoom, and Recrutei (reports conflict: one project found only an admin-token API). A company on one of them can still be read through `careers:` when its page carries JSON-LD.

## Execution pipeline

Collection runs once a day, on business days. Company discovery and metrics run once a week, in separate workflows.

1. **Collection.** Each active adapter runs in isolation, side by side with the others (they hit different hosts), with retry on HTTP 429. Per-company adapters fetch 4 companies at a time; the HTTP client still spaces requests to the same host. Each source has a deadline, the earlier of `sources.<id>.timeout_minutes` (default 5) and the run's `run.budget_minutes` (default 20): when it passes, no new company starts, the source returns what it has and the log says how many companies were skipped. A source with an error is recorded in the run summary and does not interrupt the others.
2. **Validation.** The raw response goes through a schema (zod). A format change fails only that source, with a warning.
3. **Normalization.** Everything becomes the `Job` type: stable id, source, company, title, location, geographic eligibility, work model, contract, salary when available, publication date, application URL and a description excerpt.
4. **Filter.**
   - Include and exclude terms on the title (e.g. include QA, SDET, Test Automation; exclude Intern, Júnior)
   - Seniority
   - Published at most N days ago (default 15)
   - Eligibility: accept Worldwide, LATAM, Americas, Brazil (timezone does not filter; see Issue model); discard "US only" and "EU only"
5. **Deduplication.** First by source id and canonical URL (without parameters such as `utm_*`, `source`, `gh_src`). Then by normalized company + title, because the same job shows up on Greenhouse, Himalayas and Google Jobs. Ids already seen are kept in `state/seen.json` in the private repo.

   **Reposts.** A job that matches an existing issue only by company and title (new id, new link) and was published after that issue was opened is a repost (the same posting seen through another source keeps its old date and is only a duplicate), and for an application with no answer that is information. When the earlier issue is closed, or at `status:applied` or `no-response`, no issue is created: the earlier one gets one comment (`Reposted on <date>: <link>`) and the label `signal:reposted`, once per issue per run, and each new id is recorded in `state/seen.json` so the next run stays quiet. An issue that `revalidate` closed as `closed-at-source` was never past "New", so it is reopened at `status:new` with the new link in the comment. An issue that is open and not applied to needs nothing, as before.
6. **Writing.** A run writes at most `issues.max_per_run` issues. Jobs that pass every filter but do not fit are kept whole in `state/seen.json` as `backlog` (200 at most), so they are not fetched again to be found again, and the next run writes them first. A queued job is dropped when it gets older than `search.max_age_days` or when an issue for it exists by then. Each group (the backlog, the new jobs) is ordered with the company's own ATS link first, then jobs read from a company's board before aggregators, then newest first. When AI is enabled the whole pool is scored first (scoring creates nothing, and stays inside `ai.max_calls_per_run`) and ordered by fit; the jobs that got no score keep the order above and come last. One issue per new job, with a short interval between creations because of GitHub's rate limit. The issue enters the Project with status New. The posting text is also scanned for signals the source label hides (internal selection, intermediary, scam traits): each raises a `signal:*` label and a quoted line in the body, and never discards the job. In a run over 765 postings from the live sources only the intermediary signal fired (18 postings, all genuine), since public feeds carry no internal selections; a sentence that warns against a scam is ignored, or the Airbnb notice would have flagged 188 of them.
7. **Summary.** The Actions job summary lists new jobs per source, discards by reason and sources with errors. Notification comes from the GitHub app when the issue is created.
8. **Weekly revalidation.** Open jobs with status New whose URL has disappeared from the source get the `closed-at-source` label and are closed.

`seen.json` is committed by the workflow itself. This avoids querying GitHub's search API for each job and also keeps the scheduled workflow active.

**Schedule reliability.** The first examples scheduled `23 5` and `41 8` UTC (02:23 and 05:41 in Brasília). Of 40 runs listed in the private repo in October and November 2026, the scheduled ones started between 12:46 and 19:07 UTC, 7 to 10 hours after the cron time, with no dropped day. That matches GitHub's documented behaviour: scheduled runs queue behind the load in the early UTC hours and can be delayed or dropped. The fix has three parts: an external scheduler calls `workflow_dispatch` at the wanted times; `schedule` stays as a fallback at 10:17 and 16:47 UTC, away from the congested window and round minutes; and one guard applies to every trigger, skipping the run when a collect succeeded in the last `min-interval-hours` (default 4), unless `force` is set. The Metrics issue reports the last successful collect and warns after 30 business hours without one.

## Configuration

Everything personal lives in the private repo, in two files: `job-radar.config.yml` (search and filters) and `companies.yml` (target companies per ATS). The public repo ships an `examples/` folder with both filled in generically, and a JSON Schema to validate and autocomplete in the editor.

```yaml
# job-radar.config.yml
locale: en                   # all generated content is in English

search:
  include: ["QA", "Quality Assurance", "Quality Engineer", "SDET", "Test Automation", "Analista de Testes", "Especialista de Testes", "Analista de Qualidade"]
  ambiguous: ["Analista de Qualidade"]                           # include terms too generic on their own
  ambiguous_requires: ["software", "testes", "QA", "automação"]  # an ambiguous match only passes with one of these
  highlight: ["Playwright", "Cypress", "Selenium", "API testing", "CI/CD"]  # listed in the issue when the description mentions them
  exclude: ["Intern", "Estágio", "Trainee", "Júnior", "Junior", "Pleno", "Mid-level"]
  exclude_companies: []  # companies whose jobs are always dropped
  seniority: [senior, specialist, staff, lead]
  max_age_days: 15

eligibility:
  accept_regions: [worldwide, latam, americas, brazil]
  # no timezone filter: the required hours are converted to Brasília time in the issue
  reject: ["US only", "EU only", "must reside in"]
  reject_languages: [Russian, Spanish]  # drop a job that requires one of these languages

work_model: [remote]         # no salary filter and no technical scope filter

sources:
  himalayas: { enabled: true }
  greenhouse: { enabled: true }
  lever: { enabled: true }
  ashby: { enabled: true }
  inhire: { enabled: true }
  gupy: { enabled: true }
  remoteok: { enabled: false }
  google_jobs: { enabled: false, api_key_secret: SERPAPI_KEY }

discovery:
  enabled: false              # depends on SerpAPI
  queries:
    - 'site:inhire.app/vagas QA'
    - 'site:boards.greenhouse.io "QA" remote'

issues:
  max_per_run: 25             # guard against flooding the board
  project_number: 1
```

```yaml
# companies.yml
inhire: [luby, radix, brq, lyncas, vonbz, zallpy, extractta]
greenhouse: [airbnb]
lever: []
ashby: [{ slug: ramp, name: Ramp }]   # a slug, or a slug with the display name for issue titles
```

The private repo's workflow stays at a few lines:

```yaml
# .github/workflows/collect.yml
on:
  schedule: [{ cron: "17 10 * * 1-5" }]   # fallback only; the README recommends an external scheduler calling workflow_dispatch
  workflow_dispatch:
permissions:
  contents: write
  issues: write
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: thiago8rocha/job-radar@v1
        with:
          command: collect
          github-token: ${{ secrets.JOB_RADAR_TOKEN }}
          serpapi-key: ${{ secrets.SERPAPI_KEY }}
```

The default `GITHUB_TOKEN` creates issues but can't write to user-level Projects, and fine-grained PATs don't support user-owned Projects either. That is why `JOB_RADAR_TOKEN` is a classic PAT with the `repo` and `project` scopes. (If the Project belongs to an organization, a fine-grained PAT with Issues and Projects permission works and can be limited to the private repo.)

## Issue model

Each job is an issue. Fields are split between title, labels, Project fields and body, each where it works best.

**Title:** `[Company] Role`, e.g. `[Luby] Senior QA Automation Engineer`.

**Body generated by the collector**

```markdown
**Apply:** https://luby.inhire.app/vagas/...
**Location / eligibility:** Remote · Brazil
**Posted on:** 2026-10-12
**Stated compensation:** —
**Source:** inhire

> Excerpt of the description with the terms that matched: Playwright, CI/CD, API testing...

<!-- job-radar:id=inhire:luby:9a87c73b -->
```

**Application link.** It is always the first line of the body and is mandatory: a job without a link does not become an issue. The link points straight to the company's application page, without tracking parameters. On InHire, it is built as `https://{company}.inhire.app/vagas/{jobId}/{slug}`.

The hidden marker at the end ties the issue to its source job, for dedup and revalidation.

**Timezone.** Timezone is not a filter. When the job states hours or a timezone, the issue shows the Brasília equivalent, e.g. `9am–5pm ET → 10am–6pm Brasília time`. The conversion uses IANA timezones on the collection date, because the US and Europe have daylight saving time and Brazil does not.

**Mapping from the current spreadsheet**

| Spreadsheet column | Destination | Filled by |
| --- | --- | --- |
| Company, Role (`Empresa`, `Vaga/Cargo`) | Title | Collector |
| Job link (`Link da Vaga`) | Body | Collector |
| Application date (`Data da Candidatura`) | Date field `Applied on` in the Project | You, or the Action when applying `status:applied` |
| Status (`Status`) | `status:*` label, mirrored to the Project's `Status` field | You |
| Furthest stage (`Etapa mais avançada`) | Calculated from the timeline | Automatic |
| Response date (`Data de Retorno`) | Calculated from the timeline | Automatic |
| Days to response (`Dias até Retorno`) | Calculated | Automatic |
| Source (`Fonte`) | `found:*` label (where you saw it) and `ats:*` (where you applied) | Collector; you for manual ones |
| Contract (`Contratação`) | `contract:*` label, accepts more than one (e.g. Cooperado and PJ) | Collector when stated; you |
| Target salary (`Salário Pretendido`) | Numeric field `Target salary` | You |
| Offered salary (`Salário Oferecido`) | Numeric field `Offered salary` | Collector when stated; you |
| — (new) | `Currency` field (BRL, USD, EUR) | Collector; you |
| — (new) | `Contact` field (application, recruiter, referral) | You |
| Notes (`Observações`) | Issue comments | You |

Separating where you saw a job from where you applied fixes a bias in the spreadsheet: almost everything has Source "LinkedIn", but the application was made on the company's ATS.

**Supporting labels:** `scope:brazil` / `scope:international`, `work:remote` / `work:hybrid` / `work:onsite`, and `manual` for jobs entered by hand.

**Jobs outside the collector.** An issue form (`.github/ISSUE_TEMPLATE/job.yml`) covers recruiters, referrals and anything found by hand. It has structured fields for company, role, link, contract, compensation, currency and contact channel. The `intake` command runs on `issues: [opened]` for issues labeled `manual`: it rewrites the title and body to the collector's format and fills in labels and Project fields, just like the collector. Notes become the first comment.

**Closing the issue:** GitHub only offers three close reasons (completed, not planned, duplicate), so the outcome lives in the `status:*` label and the Project `Status` field. The reason says whether a process happened: closed with `status:rejected`, `status:withdrawn` or `status:hired` = history, closed as *completed*; `status:discarded` = dropped without applying, closed as *not planned*. `sync-status` closes the issue when the label becomes a final status and reopens it when it goes back to an active one (`issues.close_on_final_status`, on by default).

**Work model.** The source's own field is cross-checked against the title, the locations and explicit phrases in the description ("hybrid role", "modelo híbrido", "100% presencial"). When they disagree, the more demanding model wins, because a missed job costs less than a misleading one. Mentions that offer a choice ("hybrid or remote") do not count.

## Status and calculated fields

Status lives in a label because the issue timeline records each label added with its date, and the Project doesn't expose the history of its own fields through the API. With that history, three spreadsheet columns become calculated.

**Stages**, the same as the spreadsheet's, with New at the front:

1. `status:new`: came from the collector, not yet evaluated
2. `status:applied`
3. `status:screening`
4. `status:hr-interview`
5. `status:tech-interview`
6. `status:take-home`
7. `status:offer`
8. `status:hired`

Final states from any stage: `status:rejected`, `status:withdrawn` and `status:discarded` (a job looked at and dropped without applying; an optional `discard:*` label, such as `discard:hybrid` or `discard:salary`, says why).

**Sync.** An `on: issues: [labeled]` workflow removes the previous status label (one at a time) and updates the Project's `Status` field, which defines the board column. On receiving `status:applied`, it fills `Applied on` if empty. Dragging the card on the board doesn't trigger an Action on a personal account, so the official path is to change the label; the board only reflects it.

**Fields calculated from the timeline**

| Field | Rule |
| --- | --- |
| Furthest stage | Highest stage (1 to 8) the issue has ever received, ignoring the final states |
| Response date | Date of the first status label after `status:applied`, except `status:withdrawn`, which is your decision and not a response from the company |
| Days to response | Response date minus application date |
| Process duration | Date of the final status minus application date |

The metrics job writes these values to Project fields, so they show up on the board and in the table view.

## Metrics

A weekly workflow reads the issues and their timelines through the API and rewrites a pinned "Metrics" issue, with tables and a Mermaid funnel chart. Project Insights stays as support: on the Free plan, only 2 saved charts on a private project, and no historical charts for a personal account.

**Unique contribution per source.** `dedupe` reports, for each duplicate, the source of the job it matched in the same run, or `known` when it matched an existing issue or seen id. `collect` adds `fetched`, `passedFilters`, `unique` (became an issue) and `duplicateOf` to `state/seen.json` under `stats.<source>.<ISO week>`, keeping 12 weeks, and the Metrics issue turns the last 4 weeks into a "Sources" table. This is what tells whether a direct adapter adds anything over `freehire`, which already aggregates about 50 ATS. `known` is left out of the overlap column: a job stays on its board for weeks and is re-recognized on every run. Dry runs write nothing, so their counts only appear in the log and the report.

**Near misses.** The filters are strict by design, so a job dropped by a single soft rule is the likeliest false negative. `createFilter().checkAll` evaluates every rule (`check` stays first-failure for the hot path). A reason is *soft* when the posting is silent rather than contradicting the search: `seniority: not stated`, `work model: not stated`, and `eligibility: region not accepted` for a job that lists no location. A job that fails exactly one soft rule, and is not already an issue, goes to `nearMiss` in `state/seen.json` (capped at 50, kept 14 days) and never becomes an issue. The Metrics issue shows the last week's in a collapsed block; to follow one up, open the issue by hand with the job form.

**Parity with the spreadsheet's Metrics tab**

| Spreadsheet indicator | In job-radar |
| --- | --- |
| Total applications | Issues with `Applied on` filled |
| In progress | Applied with no final status |
| Count per status (`Inscrito` to `Desisti`) | Count per `status:*` label |
| Applications in 2026 / 2027 | Applications per year, calculated for any year instead of fixed |
| Response rate | Applications with a company response / total. Fixed: `Desisti` (withdrew) does not count as a response |
| Approval rate | Approved / total |

**New metrics**

- Jobs collected, applied to and with a response, by source and by ATS. Shows whether Gupy, for example, actually pays off
- Stage-to-stage funnel conversion
- Mean and median time to first response
- Domestic vs. international, and by contract type
- Salary expectation vs. offer, split by currency
- Stalled applications: applied more than 30 days ago with no response

**Spreadsheet problems that must not be ported**

- The Source validation is applied to `H2:I200` and also catches the Days to response column
- The response rate counts `Desisti` (withdrew) as if it were a response from the company
- The per-year indicators are fixed at 2026 and 2027

**Migration.** A `job-radar import --xlsx controle_vagas.xlsx` command creates the 22 historical issues. Those that already have an outcome are created closed. Old dates don't exist in the timeline, so the import writes `Applied on` and the response date straight into the fields, and the metrics use those fields when the timeline lacks the event.

## Quality

The main risk is a source changing its format without notice and the collector carrying on without bringing anything in. The testing strategy is designed to detect that.

**Stack:** Node 24+, TypeScript, zod for schemas, Vitest for tests, msw to mock HTTP and Octokit for the GitHub API.

| Layer | What it covers | When it runs |
| --- | --- | --- |
| Unit | Filters, title and URL normalization, dedup, stage and response rules | Every PR |
| Contract per adapter | Real recorded fixtures from each source, validated against the schema | Every PR |
| Live contract | One real call per source, validating only the schema | Scheduled, daily, in the public repo |
| GitHub integration | Issue, label and field creation with a mocked Octokit | Every PR |
| Dry-run | Full pipeline without writing, with the result in the job summary | Manual, via `workflow_dispatch` |

**Health signals, in each run's summary**

- Source with a schema or HTTP error
- Source that returned zero jobs for 3 runs in a row, even without an error
- Discard rate by reason, to calibrate filters

When the live contract fails in the public repo, an issue is opened there automatically. That way people using the project find out a source broke through GitHub itself.

**Good practices with sources:** a User-Agent identifying the project, respect for rate limits and retry with backoff, a link back where the source requires it (Himalayas), no collection of recruiters' personal data.

## Optional AI (phase 5)

AI is optional and provider-neutral: any OpenAI-compatible chat completions API, called from inside Actions with an API key kept in a repo secret (`AI_API_KEY`). A free tier is enough for the volume. It runs after the rule-based filters, so it only sees the few new jobs of the day.

**What it does, per new job**

1. Extracts what rules can't catch: contract, salary range, required hours, stack and whether the remote is really remote
2. Gives a fit score for the profile, as a `fit:1` to `fit:5` label, with two or three lines of justification in the issue body. The score sorts and highlights, but doesn't discard anything

**On demand:** an `/evaluate` comment on the issue generates a full analysis: each requirement weighed by importance and evidence (a guess never counts as critical, and a quote must be in the posting to count as stated), what the posting leaves open, with questions for the recruiter, and likely interview questions.

**Rules**

- Off by default in the public repo (`ai.enabled: false`)
- The profile and résumé live in a private repo secret, never in a committed file
- Call limit per run below the provider's quota
- If the quota runs out or the call fails, the issue is created without a score and collection carries on as normal
- The workflow passes the key as the `ai-api-key` input and the secret as the `profile` input; the Action sends the profile only to the model. The posting is sent as data inside tags with instructions in the system message to ignore any instruction found in it, and the reply is validated with a schema and sanitized (no mentions, references or HTML) before it reaches an issue
- Each issue keeps the full posting text (up to 8,000 characters) in a collapsed block, with or without AI, because `/evaluate` and outside scorers run later and the link alone is not enough to rebuild it. When a posting exceeds the model's input limit, the prompt keeps its start and its end, where requirements usually sit. Only the owner, members and collaborators can trigger `/evaluate`, so a comment from a stranger cannot spend the quota

**Risk:** free tiers change without notice. GitHub Models, the first provider, was retired on 2026-07-30, which is why the provider is configurable.

```yaml
ai:
  enabled: true
  base_url: https://generativelanguage.googleapis.com/v1beta/openai
  model: gemini-2.5-flash
  max_calls_per_run: 30
  profile_secret: JOB_RADAR_PROFILE
```

## Reference projects

No similar project uses GitHub Issues and Projects as a tracker, covers Brazilian ATSs such as InHire, or converts timezones. That is job-radar's space. The larger ones solve some parts well, and those are worth copying.

| Project | What it does | What to take | What to avoid |
| --- | --- | --- | --- |
| [career-ops](https://github.com/career-ops-hq/career-ops) | Local search agent, about 74k stars, MIT. Scans companies listed in a `portals.yml` with more than 55 providers (Greenhouse, Lever, Ashby, Wellfound) and scores each job against the résumé | Playwright check for jobs the API still lists but that have already closed; detection of reposted jobs; follow-up reminders; rejection analysis; Wellfound as a source | Depends on running on your machine, inside an AI CLI |
| [JobSpy](https://github.com/speedyapply/JobSpy) | Python library that scrapes LinkedIn, Indeed, Glassdoor, ZipRecruiter and others, MIT | Filter by hours since posting; job schema with minimum and maximum salary | Scraping with proxies and frequent 429s; Google Jobs shows up as unavailable; on Indeed, the date is when Indeed indexed the job, not when the company posted it |
| [anandanair/job-scraper](https://github.com/anandanair/job-scraper) | Collects on GitHub Actions, stores in Supabase and scores jobs with an LLM, MIT | Marks expired jobs and rechecks periodically; LLM scoring as a future idea | LinkedIn scraping with tight limits and ban risk; setup with Supabase, an LLM key and Actions |
| [JobSync](https://github.com/Gsync/jobsync) | Self-hosted tracker in TypeScript, with application analytics, MIT | Ideas for metrics and for per-application task logging | Requires hosting an app |
| [Vagômetro](https://github.com/leo-holanda/vagometro) | Tracker of IT jobs in Brazil, with Gupy, LinkedIn and GitHub job repos | Confirms GitHub job repos as a Brazilian source | LinkedIn via scraping |

**Entering the plan as a result:** Playwright revalidation for sources that keep closed jobs listed (phase 4), repost detection in dedup, a follow-up reminder as an issue comment after N days without a response, and Wellfound and GitHub job repos as sources.

## Phases and open points

Delivery comes in 4 phases, plus an optional AI phase. Each one ends with something usable in your private repo.

1. **Foundation.** Public and private repos, a Project with fields and labels created by script (`job-radar setup`), a manual issue form, status sync by label and spreadsheet import. By this point the spreadsheet can already be retired, even without the collector.
2. **Collector v1.** Full pipeline with InHire, Greenhouse, Lever, Ashby and Himalayas, plus filters, dedup, `seen.json` and the Action published as `@v1`.
3. **Coverage.** Gupy, RemoteOK, We Work Remotely, Google Jobs and company discovery via SerpAPI.
4. **Metrics and opening up.** Weekly metrics job, job revalidation, live contract in the public repo and an onboarding README. The Action won't go to the Marketplace: using it via `uses: thiago8rocha/job-radar@v1` works without publishing.

**Open points**

- [x] Name `job-radar`, no Marketplace publication
- [x] MIT license
- [x] Timezone: no filter; conversion to Brasília time in the issue
- [x] SerpAPI optional, on the free plan; without a key, Google Jobs and automatic discovery stay off
- [x] Filters: Senior and above (no Mid-level), remote only, no salary filter and no technical scope filter
- [ ] InHire: link resolved. The page only uses the jobId and accepts any text in place of the slug; the slug is generated from the title with slugify (lower, strict) just to keep the link readable
- [ ] AI: check the provider's billing settings so only the free tier is used

## Sources consulted

- [Himalayas Remote Jobs API (Apify)](https://apify.com/himalayas/remote-jobs)
- [Gupy Jobs Scraper (Apify)](https://apify.com/national_scrim/gupy-jobs-scraper)
- [About insights for Projects (GitHub Docs)](https://help.github.com/en/issues/planning-and-tracking-with-projects/viewing-insights-from-your-project/about-insights-for-projects)
- [career-ops](https://github.com/career-ops-hq/career-ops)
- [JobSpy](https://github.com/speedyapply/JobSpy)
- [anandanair/job-scraper](https://github.com/anandanair/job-scraper)
- [JobSync on Trendshift](https://trendshift.io/repositories/23173)
- [Vagômetro on TabNews](https://www.tabnews.com.br/leoholanda/linkedin-e-repositorios-no-github-agora-sao-novas-fontes-de-vagas-para-o-vagometro-o-rastreador-de-vagas-pra-ti-no-brasil)
- [Repositories for the vagas topic (ecosyste.ms)](https://repos.ecosyste.ms/topics/vagas)
- [SerpApi Free Plan (Costbench)](https://costbench.com/software/web-scraping/serpapi/free-plan/)
