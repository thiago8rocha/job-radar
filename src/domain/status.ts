/** Hiring stages in order, with `new` in front. Stage number = index + 1. */
export const STAGES = [
  'new',
  'applied',
  'screening',
  'hr-interview',
  'tech-interview',
  'take-home',
  'offer',
  'hired',
] as const;

/** Final states reachable from any stage. */
export const FINAL_STATUSES = ['rejected', 'withdrawn'] as const;

export const STATUSES = [...STAGES, ...FINAL_STATUSES] as const;

export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL_PREFIX = 'status:';

/** Human-readable names, used as options of the Project `Status` field. */
export const STATUS_TITLES: Record<Status, string> = {
  new: 'New',
  applied: 'Applied',
  screening: 'Screening',
  'hr-interview': 'HR interview',
  'tech-interview': 'Tech interview',
  'take-home': 'Take-home',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function statusLabel(status: Status): string {
  return `${STATUS_LABEL_PREFIX}${status}`;
}

export function parseStatusLabel(label: string): Status | undefined {
  if (!label.startsWith(STATUS_LABEL_PREFIX)) return undefined;
  const value = label.slice(STATUS_LABEL_PREFIX.length);
  return (STATUSES as readonly string[]).includes(value) ? (value as Status) : undefined;
}

export function isFinalStatus(status: Status): boolean {
  return (FINAL_STATUSES as readonly string[]).includes(status);
}

/** Closing with one of these keeps the issue as history; any other closure means "discarded". */
export function isTerminalStatus(status: Status): boolean {
  return isFinalStatus(status) || status === 'hired';
}

/** Stage number (1 to 8), or undefined for the final states `rejected` and `withdrawn`. */
export function stageNumber(status: Status): number | undefined {
  const index = (STAGES as readonly string[]).indexOf(status);
  return index === -1 ? undefined : index + 1;
}
