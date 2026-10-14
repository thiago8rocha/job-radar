import type { Config } from '../config/schema.js';
import type { GitHub, RepoRef } from '../github/client.js';
import { getProject, type Project } from '../github/project.js';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export interface Context {
  octokit: GitHub;
  repo: RepoRef;
  config: Config;
  log: Logger;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

export function loadProject(ctx: Context): Promise<Project> {
  return getProject(ctx.octokit, ctx.config.issues.project_owner ?? ctx.repo.owner, ctx.config.issues.project_number);
}
