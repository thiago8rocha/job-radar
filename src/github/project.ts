import type { ProjectFieldDef } from '../domain/fields.js';
import type { GitHub } from './client.js';

export interface ProjectOption {
  id: string;
  name: string;
}

export interface ProjectField {
  id: string;
  name: string;
  dataType: string;
  options: ProjectOption[];
}

export interface Project {
  id: string;
  title: string;
  fields: Map<string, ProjectField>;
}

export type FieldValue =
  | { type: 'option'; name: string }
  | { type: 'date'; value: string }
  | { type: 'number'; value: number }
  | { type: 'text'; value: string };

export class ProjectError extends Error {}

const OPTION_COLORS = ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'] as const;

const FIELDS_FRAGMENT = `
  id
  title
  fields(first: 50) {
    nodes {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType options { id name } }
      ... on ProjectV2IterationField { id name dataType }
    }
  }`;

interface RawField {
  id: string;
  name: string;
  dataType: string;
  options?: ProjectOption[];
}

interface RawProject {
  id: string;
  title: string;
  fields: { nodes: RawField[] };
}

function toProject(raw: RawProject): Project {
  const fields = new Map<string, ProjectField>();
  for (const node of raw.fields.nodes) {
    if (!node?.id) continue;
    fields.set(node.name, { id: node.id, name: node.name, dataType: node.dataType, options: node.options ?? [] });
  }
  return { id: raw.id, title: raw.title, fields };
}

/** Loads a user or organization Project by number, with its fields. */
export async function getProject(octokit: GitHub, owner: string, number: number): Promise<Project> {
  const data = await octokit.graphql<{ repositoryOwner: { projectV2: RawProject | null } | null }>(
    `query($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        ... on User { projectV2(number: $number) { ${FIELDS_FRAGMENT} } }
        ... on Organization { projectV2(number: $number) { ${FIELDS_FRAGMENT} } }
      }
    }`,
    { owner, number },
  );
  const raw = data.repositoryOwner?.projectV2;
  if (!raw) {
    throw new ProjectError(
      `Project #${number} not found for "${owner}". Create an empty Project first and check the token has the Projects permission.`,
    );
  }
  return toProject(raw);
}

function optionInputs(names: string[]) {
  return names.map((name, index) => ({
    name,
    color: OPTION_COLORS[index % OPTION_COLORS.length]!,
    description: '',
  }));
}

export interface EnsureFieldsResult {
  created: string[];
  optionsUpdated: string[];
}

/**
 * Creates the missing fields and aligns the options of existing single-select fields.
 * Updating options regenerates their ids, so it only happens when the names differ.
 */
export async function ensureProjectFields(
  octokit: GitHub,
  project: Project,
  defs: ProjectFieldDef[],
): Promise<EnsureFieldsResult> {
  const result: EnsureFieldsResult = { created: [], optionsUpdated: [] };
  for (const def of defs) {
    const existing = project.fields.get(def.name);
    if (!existing) {
      await octokit.graphql(
        `mutation($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id } } }
        }`,
        {
          input: {
            projectId: project.id,
            name: def.name,
            dataType: def.type,
            ...(def.type === 'SINGLE_SELECT' ? { singleSelectOptions: optionInputs(def.options ?? []) } : {}),
          },
        },
      );
      result.created.push(def.name);
      continue;
    }
    if (existing.dataType !== def.type) {
      throw new ProjectError(
        `Field "${def.name}" exists with type ${existing.dataType}, expected ${def.type}. Rename or delete it and run setup again.`,
      );
    }
    if (def.type === 'SINGLE_SELECT') {
      const wanted = def.options ?? [];
      const current = existing.options.map((option) => option.name);
      if (wanted.join('\n') !== current.join('\n')) {
        await octokit.graphql(
          `mutation($input: UpdateProjectV2FieldInput!) {
            updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id } } }
          }`,
          { input: { fieldId: existing.id, singleSelectOptions: optionInputs(wanted) } },
        );
        result.optionsUpdated.push(def.name);
      }
    }
  }
  return result;
}

/** Adds an issue to the Project. GitHub returns the existing item if it is already there. */
export async function addIssueToProject(octokit: GitHub, project: Project, issueNodeId: string): Promise<string> {
  const data = await octokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
    }`,
    { projectId: project.id, contentId: issueNodeId },
  );
  return data.addProjectV2ItemById.item.id;
}

export async function setFieldValue(
  octokit: GitHub,
  project: Project,
  itemId: string,
  fieldName: string,
  value: FieldValue,
): Promise<void> {
  const field = project.fields.get(fieldName);
  if (!field) throw new ProjectError(`Field "${fieldName}" not found on the Project. Run "job-radar setup" first.`);

  let graphqlValue: Record<string, unknown>;
  switch (value.type) {
    case 'option': {
      const option = field.options.find((candidate) => candidate.name === value.name);
      if (!option) throw new ProjectError(`Option "${value.name}" not found on field "${fieldName}". Run "job-radar setup" again.`);
      graphqlValue = { singleSelectOptionId: option.id };
      break;
    }
    case 'date':
      graphqlValue = { date: value.value };
      break;
    case 'number':
      graphqlValue = { number: value.value };
      break;
    case 'text':
      graphqlValue = { text: value.value };
      break;
  }

  await octokit.graphql(
    `mutation($input: UpdateProjectV2ItemFieldValueInput!) {
      updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
    }`,
    { input: { projectId: project.id, itemId, fieldId: field.id, value: graphqlValue } },
  );
}

/** Current date value of an item, or undefined when the field is empty. */
export async function getDateValue(octokit: GitHub, itemId: string, fieldName: string): Promise<string | undefined> {
  const data = await octokit.graphql<{ node: { fieldValueByName: { date?: string } | null } | null }>(
    `query($itemId: ID!, $name: String!) {
      node(id: $itemId) {
        ... on ProjectV2Item { fieldValueByName(name: $name) { ... on ProjectV2ItemFieldDateValue { date } } }
      }
    }`,
    { itemId, name: fieldName },
  );
  return data.node?.fieldValueByName?.date ?? undefined;
}
