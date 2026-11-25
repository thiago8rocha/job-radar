import { STAGES, STATUSES, STATUS_TITLES, isTerminalStatus, stageNumber, type Status } from '../domain/status.js';
import type { SeenState } from '../state/seen.js';
import { isoWeek } from '../state/seen.js';
import { daysBetween, isDiscarded, isUnanswered, type IssueMetrics } from './analyze.js';

export const METRICS_MARKER = '<!-- job-radar:metrics -->';
export const IGNORE_MARKER = '<!-- job-radar:ignore -->';

const STALLED_AFTER_DAYS = 30;
const STALE_COLLECT_AFTER_HOURS = 30;
const BRASILIA_OFFSET_MS = -3 * 3_600_000;
export const DEFAULT_NO_RESPONSE_AFTER_DAYS = 60;

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;
}

function avg(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

function fixed(value: number | undefined, digits = 1): string {
  return value === undefined ? '—' : value.toFixed(digits).replace(/\.0+$/, '');
}

function money(value: number | undefined): string {
  return value === undefined ? '—' : Math.round(value).toLocaleString('en-US');
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '_No data yet._';
  const line = (cells: Array<string | number>) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

export interface Totals {
  collected: number;
  /** Open and still at "New": waiting for you to apply or drop them. */
  waiting: number;
  /** Closed without applying, with how many of those left the company's board by themselves. */
  discarded: number;
  goneFromSource: number;
  applications: number;
  inProgress: number;
  /** Applications with no answer yet, still inside the no-response window. */
  awaitingReply: number;
  /** Applications nobody answered: marked by hand or past the no-response window. */
  noResponse: number;
  responded: number;
  hired: number;
}

export function totals(all: IssueMetrics[], todayIso: string, noResponseAfterDays: number): Totals {
  const applications = all.filter((issue) => issue.appliedOn);
  const unanswered = applications.filter((issue) => isUnanswered(issue, todayIso, noResponseAfterDays));
  const open = applications.filter((issue) => !issue.status || !isTerminalStatus(issue.status));
  return {
    collected: all.length,
    waiting: all.filter((issue) => issue.state === 'open' && !issue.appliedOn && (!issue.status || issue.status === 'new')).length,
    discarded: all.filter(isDiscarded).length,
    goneFromSource: all.filter((issue) => isDiscarded(issue) && issue.closedAtSource).length,
    applications: applications.length,
    inProgress: open.length - unanswered.length,
    awaitingReply: open.filter((issue) => !issue.responseDate && !unanswered.includes(issue)).length,
    noResponse: unanswered.length,
    responded: applications.filter((issue) => issue.responseDate).length,
    hired: applications.filter((issue) => issue.status === 'hired').length,
  };
}

/** Collected / applied / responded, for each value of a grouping such as the source or the contract. */
function breakdown(all: IssueMetrics[], keys: (issue: IssueMetrics) => string[]): Array<Array<string | number>> {
  const groups = new Map<string, IssueMetrics[]>();
  for (const issue of all) {
    for (const key of keys(issue)) groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([key, issues]) => {
      const applied = issues.filter((issue) => issue.appliedOn);
      const responded = applied.filter((issue) => issue.responseDate);
      return [key, issues.length, issues.filter(isDiscarded).length, applied.length, responded.length, pct(responded.length, applied.length)];
    });
}

const SOURCE_WINDOW_WEEKS = 4;

/**
 * What each source contributed over the last weeks: issues it created, its share of all unique jobs,
 * the other source it most often duplicates, and the applications and responses on its issues.
 * Duplicates of `known` are left out of the overlap, since a job stays on its board for weeks and
 * is re-fetched, and re-recognized, on every run.
 */
function sourceContribution(all: IssueMetrics[], stats: SeenState['stats'], today: Date): Array<Array<string | number>> {
  const weeks = new Set(Array.from({ length: SOURCE_WINDOW_WEEKS }, (_, index) => isoWeek(new Date(today.getTime() - index * 7 * 86_400_000))));
  const rows = Object.entries(stats).map(([source, byWeek]) => {
    const recent = Object.entries(byWeek).filter(([week]) => weeks.has(week)).map(([, counts]) => counts);
    const overlap = new Map<string, number>();
    for (const counts of recent) {
      for (const [other, count] of Object.entries(counts.duplicateOf)) if (other !== 'known') overlap.set(other, (overlap.get(other) ?? 0) + count);
    }
    const top = [...overlap.entries()].sort(([, a], [, b]) => b - a)[0];
    const applied = all.filter((issue) => issue.found === source && issue.appliedOn);
    return {
      source,
      unique: recent.reduce((sum, counts) => sum + counts.unique, 0),
      overlap: top ? `${top[0]} (${top[1]})` : '—',
      applied: applied.length,
      responded: applied.filter((issue) => issue.responseDate).length,
    };
  });
  const total = rows.reduce((sum, row) => sum + row.unique, 0);
  return rows
    .sort((a, b) => b.unique - a.unique || a.source.localeCompare(b.source))
    .map((row) => [row.source, row.unique, pct(row.unique, total), row.overlap, row.applied, row.responded]);
}

const MIN_CASES_FOR_RATE = 5;

/**
 * Outcome by AI fit score. An application with no answer yet stays out of the rate and is listed on its
 * own, since counting it as a failure punishes recent ones and counting it as a success inflates the rest.
 * A band with fewer than `MIN_CASES_FOR_RATE` decided applications shows the count, never a percentage.
 */
function byFit(all: IssueMetrics[], todayIso: string, noResponseAfterDays: number): Array<Array<string | number>> {
  return [1, 2, 3, 4, 5, undefined].flatMap((fit) => {
    const jobs = all.filter((issue) => issue.fit === fit);
    if (jobs.length === 0) return [];
    const applied = jobs.filter((issue) => issue.appliedOn);
    return [[fit ?? 'no score', jobs.length, jobs.filter(isDiscarded).length, applied.length, ...outcome(applied, todayIso, noResponseAfterDays)]];
  });
}

/** Responded, no response, still waiting and the response rate of a group of applications. */
function outcome(applied: IssueMetrics[], todayIso: string, noResponseAfterDays: number): Array<string | number> {
  const responded = applied.filter((issue) => issue.responseDate).length;
  const noResponse = applied.filter((issue) => isUnanswered(issue, todayIso, noResponseAfterDays)).length;
  const inProgress = applied.filter(
    (issue) => !issue.responseDate && !(issue.status && isTerminalStatus(issue.status)) && !isUnanswered(issue, todayIso, noResponseAfterDays),
  ).length;
  const decided = responded + noResponse;
  const rate = decided === 0 ? '—' : decided < MIN_CASES_FOR_RATE ? `${responded} of ${decided}` : pct(responded, decided);
  return [responded, noResponse, inProgress, rate];
}

/** Applications with and without a tailored CV, so the effect of tailoring can be seen once there are enough of them. */
function byTailoring(applications: IssueMetrics[], todayIso: string, noResponseAfterDays: number): Array<Array<string | number>> {
  return [
    ['Tailored CV', applications.filter((issue) => issue.tailored)],
    ['Generic CV', applications.filter((issue) => !issue.tailored)],
  ].map(([label, group]) => [label as string, (group as IssueMetrics[]).length, ...outcome(group as IssueMetrics[], todayIso, noResponseAfterDays)]);
}

/** Reasons given on discarded jobs (`discard:*` labels), most common first; jobs without one are "not given". */
function discardReasons(all: IssueMetrics[]): Array<Array<string | number>> {
  const counts = new Map<string, number>();
  for (const issue of all.filter(isDiscarded)) {
    for (const reason of issue.discardReasons.length > 0 ? issue.discardReasons : ['not given']) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([, a], [, b]) => b - a).map(([reason, count]) => [reason, count]);
}

function funnel(applications: IssueMetrics[]): { stage: Status; reached: number }[] {
  const reachedAtLeast = (stage: Status) =>
    applications.filter((issue) => (stageNumber(issue.furthestStage ?? 'applied') ?? 0) >= stageNumber(stage)!).length;
  return STAGES.filter((stage) => stage !== 'new').map((stage) => ({ stage, reached: reachedAtLeast(stage) }));
}

function funnelChart(steps: { stage: Status; reached: number }[]): string {
  const max = Math.max(...steps.map((step) => step.reached));
  if (max === 0) return '';
  return [
    '```mermaid',
    'xychart-beta',
    '    title "Applications that reached each stage"',
    `    x-axis [${steps.map((step) => `"${STATUS_TITLES[step.stage]}"`).join(', ')}]`,
    `    y-axis "Applications" 0 --> ${max}`,
    `    bar [${steps.map((step) => step.reached).join(', ')}]`,
    '```',
  ].join('\n');
}

function isWeekendInBrasilia(at: Date): boolean {
  const day = new Date(at.getTime() + BRASILIA_OFFSET_MS).getUTCDay();
  return day === 0 || day === 6;
}

/** Hours between two instants, skipping Saturdays and Sundays in Brasília time. */
export function businessHoursBetween(from: Date, to: Date): number {
  let hours = 0;
  for (let at = from.getTime(); at < to.getTime(); at += 3_600_000) {
    if (!isWeekendInBrasilia(new Date(at))) hours++;
  }
  return hours;
}

function lastCollectLine(lastCollect: Date, now: Date): string {
  const stamp = new Date(lastCollect.getTime() + BRASILIA_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
  const line = `_Last successful collect: ${stamp} (Brasília)._`;
  const stale = !isWeekendInBrasilia(now) && businessHoursBetween(lastCollect, now) > STALE_COLLECT_AFTER_HOURS;
  return stale ? `${line}

> [!WARNING]
> The last successful collect is older than ${STALE_COLLECT_AFTER_HOURS} hours. Check the schedule of the collect workflow.` : line;
}

/** The body of the pinned "Metrics" issue. `lastCollect` is left out when the Actions API could not be read. */
export function renderReport(
  all: IssueMetrics[],
  today: Date,
  noResponseAfterDays = DEFAULT_NO_RESPONSE_AFTER_DAYS,
  lastCollect?: Date,
  sourceStats: SeenState['stats'] = {},
): string {
  const todayIso = today.toISOString().slice(0, 10);
  const total = totals(all, todayIso, noResponseAfterDays);
  const applications = all.filter((issue) => issue.appliedOn);

  // Discarded jobs keep their `status:new` label, so they are counted on their own row.
  const active = all.filter((issue) => !isDiscarded(issue));
  const byStatus = [
    ...STATUSES.map((status) => [STATUS_TITLES[status], active.filter((issue) => issue.status === status).length] as const),
    ['Discarded', total.discarded] as const,
  ].filter(([, count]) => count > 0);
  const years = new Map<string, number>();
  for (const issue of applications) years.set(issue.appliedOn!.slice(0, 4), (years.get(issue.appliedOn!.slice(0, 4)) ?? 0) + 1);

  const steps = funnel(applications);
  const conversions = steps.slice(1).map((step, index) => [
    `${STATUS_TITLES[steps[index]!.stage]} → ${STATUS_TITLES[step.stage]}`,
    steps[index]!.reached,
    step.reached,
    pct(step.reached, steps[index]!.reached),
  ]);

  const responseDays = applications.map((issue) => issue.daysToResponse).filter((value): value is number => value !== undefined);

  const currencies = [...new Set(all.map((issue) => issue.currency).filter((value): value is string => Boolean(value)))].sort();
  const salaries = currencies
    .map((currency) => {
      const group = all.filter((issue) => issue.currency === currency);
      const targets = group.map((issue) => issue.targetSalary).filter((value): value is number => value !== undefined);
      const offers = group.map((issue) => issue.offeredSalary).filter((value): value is number => value !== undefined);
      return [currency, money(avg(targets)), targets.length, money(avg(offers)), offers.length];
    })
    .filter((row) => Number(row[2]) > 0 || Number(row[4]) > 0);

  const stalled = applications
    .filter((issue) => !issue.responseDate && (!issue.status || !isTerminalStatus(issue.status)) && !isUnanswered(issue, todayIso, noResponseAfterDays))
    .map((issue) => ({ issue, days: daysBetween(issue.appliedOn!, todayIso) }))
    .filter(({ days }) => days > STALLED_AFTER_DAYS)
    .sort((a, b) => b.days - a.days);

  const sections = [
    METRICS_MARKER,
    `_Updated ${todayIso} by job-radar. Edits to this issue are overwritten._`,
    ...(lastCollect ? [lastCollectLine(lastCollect, today)] : []),
    '## Overview',
    table(
      ['Indicator', 'Value'],
      [
        ['Jobs tracked', total.collected],
        ['Waiting for a decision', total.waiting],
        ['Discarded without applying', total.discarded === 0 ? 0 : `${total.discarded} (${total.goneFromSource} gone from the source)`],
        ['Applications', total.applications],
        ['In progress', total.inProgress],
        ['Awaiting a reply', total.awaitingReply],
        [`No response (marked or over ${noResponseAfterDays} days)`, total.noResponse],
        ['Response rate', `${pct(total.responded, total.applications)} (${total.responded} of ${total.applications})`],
        ['Hired', `${pct(total.hired, total.applications)} (${total.hired} of ${total.applications})`],
        ['Time to first response', `mean ${fixed(avg(responseDays))} days · median ${fixed(median(responseDays))} days`],
      ],
    ),
    '_A response is the first status after applying, except withdrawing, which is your own decision._',
    '## Jobs by status',
    table(['Status', 'Jobs'], byStatus.map(([status, count]) => [status, count])),
    '## Applications per year',
    table(['Year', 'Applications'], [...years.entries()].sort().map(([year, count]) => [year, count])),
    '## Funnel',
    funnelChart(steps),
    table(['Step', 'From', 'To', 'Conversion'], conversions),
    ...(Object.keys(sourceStats).length > 0
      ? [
          `## Sources (last ${SOURCE_WINDOW_WEEKS} weeks)`,
          table(['Source', 'Issues created', 'Share of unique jobs', 'Overlaps most with', 'Applied', 'Responded'], sourceContribution(all, sourceStats, today)),
          '_Overlap counts the jobs a source returned that another source already had in the same run._',
        ]
      : []),
    '## Where jobs come from',
    table(['Found on', 'Jobs', 'Discarded', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.found ? [issue.found] : []))),
    '### By ATS',
    table(['ATS', 'Jobs', 'Discarded', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.ats ? [issue.ats] : []))),
    '## Why jobs were discarded',
    table(['Reason', 'Jobs'], discardReasons(all)),
    '## Domestic vs international',
    table(['Scope', 'Jobs', 'Discarded', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.scope ? [issue.scope] : []))),
    '## By contract',
    table(['Contract', 'Jobs', 'Discarded', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => issue.contracts)),
    '## By fit score',
    table(
      ['Fit', 'Jobs', 'Discarded', 'Applied', 'Responded', 'No response', 'In progress', 'Response rate'],
      byFit(all, todayIso, noResponseAfterDays),
    ),
    '_The rate leaves out applications still waiting and shows a count when fewer than 5 are decided. It only observes: the score is never changed._',
    ...(applications.some((issue) => issue.tailored)
      ? [
          '## By CV',
          table(['CV', 'Applied', 'Responded', 'No response', 'In progress', 'Response rate'], byTailoring(applications, todayIso, noResponseAfterDays)),
          '_The rate leaves out applications still waiting and shows a count when fewer than 5 are decided._',
        ]
      : []),
    '## Salary',
    table(['Currency', 'Mean target', 'Targets', 'Mean offered', 'Offers'], salaries),
    `## Stalled applications (${STALLED_AFTER_DAYS} to ${noResponseAfterDays} days without a response)`,
    stalled.length === 0
      ? '_None._'
      : stalled.map(({ issue, days }) => `- #${issue.number} ${issue.title} (${days} days)`).join('\n'),
  ];
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}
