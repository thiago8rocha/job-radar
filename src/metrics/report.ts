import { STAGES, STATUSES, STATUS_TITLES, isTerminalStatus, stageNumber, type Status } from '../domain/status.js';
import { daysBetween, type IssueMetrics } from './analyze.js';

export const METRICS_MARKER = '<!-- job-radar:metrics -->';

const STALLED_AFTER_DAYS = 30;

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
  applications: number;
  inProgress: number;
  responded: number;
  hired: number;
}

export function totals(all: IssueMetrics[]): Totals {
  const applications = all.filter((issue) => issue.appliedOn);
  return {
    collected: all.length,
    applications: applications.length,
    inProgress: applications.filter((issue) => !issue.status || !isTerminalStatus(issue.status)).length,
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
      return [key, issues.length, applied.length, responded.length, pct(responded.length, applied.length)];
    });
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

/** The body of the pinned "Metrics" issue. */
export function renderReport(all: IssueMetrics[], today: Date): string {
  const total = totals(all);
  const applications = all.filter((issue) => issue.appliedOn);
  const todayIso = today.toISOString().slice(0, 10);

  const byStatus = STATUSES.map((status) => [STATUS_TITLES[status], all.filter((issue) => issue.status === status).length] as const).filter(
    ([, count]) => count > 0,
  );
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
    .filter((issue) => !issue.responseDate && (!issue.status || !isTerminalStatus(issue.status)))
    .map((issue) => ({ issue, days: daysBetween(issue.appliedOn!, todayIso) }))
    .filter(({ days }) => days > STALLED_AFTER_DAYS)
    .sort((a, b) => b.days - a.days);

  const sections = [
    METRICS_MARKER,
    `_Updated ${todayIso} by job-radar. Edits to this issue are overwritten._`,
    '## Overview',
    table(
      ['Indicator', 'Value'],
      [
        ['Jobs tracked', total.collected],
        ['Applications', total.applications],
        ['In progress', total.inProgress],
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
    '## Where jobs come from',
    table(['Found on', 'Jobs', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.found ? [issue.found] : []))),
    '### By ATS',
    table(['ATS', 'Jobs', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.ats ? [issue.ats] : []))),
    '## Domestic vs international',
    table(['Scope', 'Jobs', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => (issue.scope ? [issue.scope] : []))),
    '## By contract',
    table(['Contract', 'Jobs', 'Applied', 'Responded', 'Response rate'], breakdown(all, (issue) => issue.contracts)),
    '## Salary',
    table(['Currency', 'Mean target', 'Targets', 'Mean offered', 'Offers'], salaries),
    `## Stalled applications (over ${STALLED_AFTER_DAYS} days without a response)`,
    stalled.length === 0
      ? '_None._'
      : stalled.map(({ issue, days }) => `- #${issue.number} ${issue.title} (${days} days)`).join('\n'),
  ];
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`;
}
