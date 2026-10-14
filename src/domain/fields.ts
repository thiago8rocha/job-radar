import { STAGES, STATUSES, STATUS_TITLES } from './status.js';

export type ProjectFieldType = 'SINGLE_SELECT' | 'DATE' | 'NUMBER' | 'TEXT';

export interface ProjectFieldDef {
  name: string;
  type: ProjectFieldType;
  options?: string[];
}

export const FIELD = {
  status: 'Status',
  appliedOn: 'Applied on',
  targetSalary: 'Target salary',
  offeredSalary: 'Offered salary',
  currency: 'Currency',
  contact: 'Contact',
  furthestStage: 'Furthest stage',
  responseDate: 'Response date',
  daysToResponse: 'Days to response',
  processDuration: 'Process duration',
} as const;

export const CURRENCIES = ['BRL', 'USD', 'EUR'] as const;
export const CONTACTS = ['Application', 'Recruiter', 'Referral'] as const;

/**
 * Fields `job-radar setup` ensures on the Project. `Status` already exists on every
 * Project, so setup only aligns its options. The last four are calculated from the issue
 * timeline by the metrics job (or written directly by the spreadsheet import).
 */
export const PROJECT_FIELDS: ProjectFieldDef[] = [
  { name: FIELD.status, type: 'SINGLE_SELECT', options: STATUSES.map((s) => STATUS_TITLES[s]) },
  { name: FIELD.appliedOn, type: 'DATE' },
  { name: FIELD.targetSalary, type: 'NUMBER' },
  { name: FIELD.offeredSalary, type: 'NUMBER' },
  { name: FIELD.currency, type: 'SINGLE_SELECT', options: [...CURRENCIES] },
  { name: FIELD.contact, type: 'SINGLE_SELECT', options: [...CONTACTS] },
  {
    name: FIELD.furthestStage,
    type: 'SINGLE_SELECT',
    options: STAGES.map((s) => STATUS_TITLES[s]),
  },
  { name: FIELD.responseDate, type: 'DATE' },
  { name: FIELD.daysToResponse, type: 'NUMBER' },
  { name: FIELD.processDuration, type: 'NUMBER' },
];
