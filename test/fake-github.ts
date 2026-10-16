import { vi } from 'vitest';
import type { Context } from '../src/commands/context.js';
import { parseConfig } from '../src/config/load.js';

export interface GraphqlCall {
  query: string;
  variables: Record<string, any>;
}

export const BASE_FIELDS = [
  { id: 'F_status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'O_todo', name: 'Todo' }] },
];

/** Project fields as `job-radar setup` leaves them, with option ids derived from the names. */
export function readyFields() {
  const option = (name: string) => ({ id: `O_${name}`, name });
  return [
    {
      id: 'F_status',
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: ['New', 'Applied', 'Screening', 'HR interview', 'Tech interview', 'Take-home', 'Offer', 'Hired', 'Rejected', 'Withdrawn', 'Discarded'].map(option),
    },
    { id: 'F_applied', name: 'Applied on', dataType: 'DATE' },
    { id: 'F_target', name: 'Target salary', dataType: 'NUMBER' },
    { id: 'F_offered', name: 'Offered salary', dataType: 'NUMBER' },
    { id: 'F_currency', name: 'Currency', dataType: 'SINGLE_SELECT', options: ['BRL', 'USD', 'EUR'].map(option) },
    { id: 'F_contact', name: 'Contact', dataType: 'SINGLE_SELECT', options: ['Application', 'Recruiter', 'Referral'].map(option) },
    {
      id: 'F_furthest',
      name: 'Furthest stage',
      dataType: 'SINGLE_SELECT',
      options: ['New', 'Applied', 'Screening', 'HR interview', 'Tech interview', 'Take-home', 'Offer', 'Hired'].map(option),
    },
    { id: 'F_response', name: 'Response date', dataType: 'DATE' },
    { id: 'F_days', name: 'Days to response', dataType: 'NUMBER' },
    { id: 'F_duration', name: 'Process duration', dataType: 'NUMBER' },
  ];
}

interface Overrides {
  fields?: unknown[];
  /** Value returned for the `Applied on` field of an item. */
  appliedOn?: string;
  labelsOnIssue?: string[];
  existingIssues?: Array<{ title?: string; body: string | null; pull_request?: unknown; [key: string]: unknown }>;
  /** Status events by issue number, as `issues.listEvents` returns them. */
  events?: Record<number, Array<{ event: string; created_at: string; label?: { name: string } }>>;
  /** Project items as the GraphQL `items` query returns them. */
  projectItems?: unknown[];
  existingLabels?: string[];
  /** Current state of the issue `issues.get` returns. */
  issueState?: 'open' | 'closed';
}

/** Minimal in-memory stand-in for the parts of Octokit job-radar uses. */
export function fakeContext(overrides: Overrides = {}) {
  const graphqlCalls: GraphqlCall[] = [];
  let nextIssue = 100;

  const issues = {
    createLabel: vi.fn(async (_params: unknown) => ({})),
    updateLabel: vi.fn(async (_params: unknown) => ({})),
    addLabels: vi.fn(async (_params: unknown) => ({})),
    removeLabel: vi.fn(async (_params: unknown) => ({})),
    createComment: vi.fn(async (_params: unknown) => ({})),
    update: vi.fn(async (_params: unknown) => ({})),
    create: vi.fn(async (_params: unknown) => ({ data: { number: ++nextIssue, node_id: `I_${nextIssue}` } })),
    listLabelsOnIssue: vi.fn(async (_params: unknown) => ({
      data: (overrides.labelsOnIssue ?? []).map((name) => ({ name })),
    })),
    get: vi.fn(async (_params: unknown) => ({ data: { state: overrides.issueState ?? 'open' } })),
    listForRepo: vi.fn(),
    listEvents: vi.fn(),
    listLabelsForRepo: vi.fn(),
  };

  const graphql = vi.fn(async (query: string, variables: Record<string, any> = {}) => {
    graphqlCalls.push({ query, variables });
    if (query.includes('repositoryOwner')) {
      return {
        repositoryOwner: {
          projectV2: { id: 'P_1', title: 'Job search', fields: { nodes: overrides.fields ?? readyFields() } },
        },
      };
    }
    if (query.includes('items(first')) {
      return { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: overrides.projectItems ?? [] } } };
    }
    if (query.includes('pinIssue')) return { pinIssue: { issue: { id: 'x' } } };
    if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'ITEM_1' } } };
    if (query.includes('fieldValueByName')) {
      return { node: { fieldValueByName: overrides.appliedOn ? { date: overrides.appliedOn } : null } };
    }
    return {};
  });

  const octokit = {
    rest: { issues },
    graphql,
    paginate: vi.fn(async (method: unknown, params: any) => {
      if (method === issues.listLabelsForRepo) return (overrides.existingLabels ?? []).map((name) => ({ name }));
      if (method === issues.listEvents) return overrides.events?.[params.issue_number] ?? [];
      return (overrides.existingIssues ?? []).map((issue) => ({ title: '', ...issue }));
    }),
  };

  const log = { info: vi.fn(), warn: vi.fn() };
  const ctx: Context = {
    octokit: octokit as unknown as Context['octokit'],
    repo: { owner: 'me', repo: 'jobs' },
    config: parseConfig(''),
    log,
  };

  /** Every field-value mutation, as `[fieldId, value]`. */
  const fieldWrites = () =>
    graphqlCalls
      .filter((call) => call.query.includes('updateProjectV2ItemFieldValue'))
      .map((call) => [call.variables.input.fieldId, call.variables.input.value] as const);

  return { ctx, issues, graphql, graphqlCalls, log, fieldWrites };
}
