import { Octokit } from 'octokit';

export type GitHub = Octokit;

export interface RepoRef {
  owner: string;
  repo: string;
}

export function createClient(token: string): GitHub {
  return new Octokit({ auth: token, userAgent: 'job-radar (+https://github.com/thiago8rocha/job-radar)' });
}

export function parseRepo(value: string | undefined): RepoRef {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value ?? '');
  if (!match) throw new Error(`Expected a repository as "owner/name", got "${value ?? ''}"`);
  return { owner: match[1]!, repo: match[2]! };
}
