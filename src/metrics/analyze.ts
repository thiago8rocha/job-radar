import { FIELD } from '../domain/fields.js';
import { STATUSES, STATUS_TITLES, isTerminalStatus, parseStatusLabel, stageNumber, type Status } from '../domain/status.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What is known about one issue: its labels, the dated status changes and the Project fields. */
export interface IssueFacts {
  number: number;
  title: string;
  url?: string;
  state: 'open' | 'closed';
  labels: string[];
  /** `labeled` events for `status:*` labels, oldest first. */
  statusEvents: Array<{ status: Status; at: string }>;
  /**
   * Imported issues got all their labels at import time, so their timeline says nothing about when
   * things really happened; only their Project fields are trusted.
   */
  imported: boolean;
  /** Project field values by name. */
  fields: Record<string, string | number | undefined>;
}

export interface IssueMetrics {
  number: number;
  title: string;
  url?: string;
  /** Current status, from the `status:*` label. */
  status?: Status;
  appliedOn?: string;
  furthestStage?: Status;
  responseDate?: string;
  daysToResponse?: number;
  /** Days from application to the final status, for processes that ended. */
  processDuration?: number;
  found?: string;
  ats?: string;
  scope?: string;
  contracts: string[];
  targetSalary?: number;
  offeredSalary?: number;
  currency?: string;
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${dayOf(to)}T00:00:00Z`) - Date.parse(`${dayOf(from)}T00:00:00Z`)) / DAY_MS);
}

function text(value: string | number | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: string | number | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function statusFromTitle(title: string | undefined): Status | undefined {
  return STATUSES.find((status) => STATUS_TITLES[status] === title);
}

function labelValue(labels: string[], prefix: string): string | undefined {
  return labels.find((name) => name.startsWith(`${prefix}:`))?.slice(prefix.length + 1);
}

/**
 * The calculated fields of "Status and calculated fields": application date, furthest stage,
 * response date, days to response and process duration. An explicit Project field wins over the
 * timeline (the import writes those, and a person can correct them); the furthest stage is the
 * highest of the two, because a process only moves forward.
 */
export function analyzeIssue(facts: IssueFacts): IssueMetrics {
  const events = facts.imported ? [] : facts.statusEvents;
  const status = facts.labels.map(parseStatusLabel).find((value) => value !== undefined);

  const appliedEvent = events.find((event) => event.status === 'applied');
  const appliedOn = text(facts.fields[FIELD.appliedOn]) ?? (appliedEvent ? dayOf(appliedEvent.at) : undefined);

  const stages = [
    ...events.map((event) => event.status),
    ...(status ? [status] : []),
    statusFromTitle(text(facts.fields[FIELD.furthestStage])),
  ]
    .map((value) => (value ? stageNumber(value) : undefined))
    .filter((value): value is number => value !== undefined);
  const furthest = stages.length > 0 ? Math.max(...stages) : undefined;
  const furthestStage = furthest === undefined ? undefined : STATUSES[furthest - 1];

  // The first answer after applying; withdrawing is the candidate's own decision, not a response.
  const response = events.find(
    (event) =>
      event.status !== 'applied' &&
      event.status !== 'new' &&
      event.status !== 'withdrawn' &&
      (!appliedEvent || event.at >= appliedEvent.at),
  );
  const responseDate = text(facts.fields[FIELD.responseDate]) ?? (response ? dayOf(response.at) : undefined);

  const daysToResponse =
    appliedOn && responseDate ? Math.max(0, daysBetween(appliedOn, responseDate)) : num(facts.fields[FIELD.daysToResponse]);

  const finalEvent = status && isTerminalStatus(status) ? [...events].reverse().find((event) => event.status === status) : undefined;
  const processDuration =
    appliedOn && finalEvent ? Math.max(0, daysBetween(appliedOn, finalEvent.at)) : num(facts.fields[FIELD.processDuration]);

  return {
    number: facts.number,
    title: facts.title,
    url: facts.url,
    status,
    appliedOn,
    furthestStage,
    responseDate,
    daysToResponse,
    processDuration,
    found: labelValue(facts.labels, 'found'),
    ats: labelValue(facts.labels, 'ats'),
    scope: labelValue(facts.labels, 'scope'),
    contracts: facts.labels.filter((name) => name.startsWith('contract:')).map((name) => name.slice('contract:'.length)),
    targetSalary: num(facts.fields[FIELD.targetSalary]),
    offeredSalary: num(facts.fields[FIELD.offeredSalary]),
    currency: text(facts.fields[FIELD.currency]),
  };
}

/** The Project fields the metrics job owns, with the value this analysis calls for. */
export function desiredFields(metrics: IssueMetrics): Array<{ field: string; value: { type: 'option'; name: string } | { type: 'date'; value: string } | { type: 'number'; value: number } }> {
  return [
    metrics.furthestStage && metrics.furthestStage !== 'new'
      ? { field: FIELD.furthestStage, value: { type: 'option' as const, name: STATUS_TITLES[metrics.furthestStage] } }
      : undefined,
    metrics.responseDate ? { field: FIELD.responseDate, value: { type: 'date' as const, value: metrics.responseDate } } : undefined,
    metrics.daysToResponse !== undefined
      ? { field: FIELD.daysToResponse, value: { type: 'number' as const, value: metrics.daysToResponse } }
      : undefined,
    metrics.processDuration !== undefined
      ? { field: FIELD.processDuration, value: { type: 'number' as const, value: metrics.processDuration } }
      : undefined,
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}
