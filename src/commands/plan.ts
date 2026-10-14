import { parseStatusLabel, type Status } from '../domain/status.js';

export interface StatusSyncPlan {
  status: Status;
  /** Other `status:*` labels to remove, so only one stays on the issue. */
  remove: string[];
  /** `Applied on` should be filled (when still empty). */
  fillAppliedOn: boolean;
}

/**
 * Decides what to do when `eventLabel` was added to an issue that currently has `currentLabels`.
 * Returns undefined when the event is not a status change, or was already superseded
 * (the label is no longer on the issue because a concurrent run removed it).
 */
export function planStatusSync(eventLabel: string, currentLabels: string[]): StatusSyncPlan | undefined {
  const status = parseStatusLabel(eventLabel);
  if (!status) return undefined;
  if (!currentLabels.includes(eventLabel)) return undefined;

  const remove = currentLabels.filter((name) => name !== eventLabel && parseStatusLabel(name) !== undefined);
  return { status, remove, fillAppliedOn: status === 'applied' };
}
