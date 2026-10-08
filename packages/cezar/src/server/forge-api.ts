import type {
  GithubData, GithubSearchData, GithubChecksData, GithubRefStatusData,
} from '@open-mercato/cezar-contract';
import { getRepoInfo } from './git.ts';
import { resolveForge } from './forge/index.ts';
import type { ForgeCommentsData, ForgePrDiffResult } from './forge/types.ts';
import * as github from './github.ts';

/** Keep the existing /github wire shapes, but never send GitLab requests through gh. */
export async function fetchForge(root: string, refresh = false, limit = 30): Promise<GithubData> {
  const forge = resolveForge(await getRepoInfo(root));
  if (forge?.kind === 'github' || (!forge && process.env.CEZ_DRY_RUN === '1')) return github.fetchGithub(root, refresh, limit);
  if (!forge) return { available: false, reason: 'No supported forge remote detected', issues: [], prs: [] };
  const availability = await forge.detect();
  if (!availability.available) return { ...availability, issues: [], prs: [] };
  try {
    const [issues, prs] = await Promise.all([forge.listIssues({ refresh, limit }), forge.listPRs({ refresh, limit })]);
    return { available: true, issues, prs, syncedAt: new Date().toISOString() };
  } catch {
    return { available: false, reason: 'Could not load GitLab issues and merge requests. Check glab authentication and connectivity.', issues: [], prs: [] };
  }
}

export async function searchForge(root: string, kind: 'issue' | 'pr', query: string, limit?: number): Promise<GithubSearchData> {
  const forge = resolveForge(await getRepoInfo(root));
  if (!forge && process.env.CEZ_DRY_RUN === '1') return github.searchGithubItems(root, kind, query, limit);
  return forge?.searchItems
    ? forge.searchItems(kind, query, { limit })
    : { available: false, reason: 'Search is unavailable for this forge', items: [] };
}

// ponytail: GitLab thread/check/merge details remain on GitLab, add driver methods when needed.
export async function fetchForgeComments(root: string, kind: 'issue' | 'pr', number: number, refresh = false): Promise<ForgeCommentsData> {
  const forge = resolveForge(await getRepoInfo(root));
  return forge?.kind === 'github' || (!forge && process.env.CEZ_DRY_RUN === '1')
    ? github.fetchGithubComments(root, kind, number, refresh)
    : { available: false, reason: 'Open this item on its forge to read the conversation.', comments: [] };
}

export async function fetchForgeChecks(root: string, numbers: number[]): Promise<GithubChecksData> {
  const forge = resolveForge(await getRepoInfo(root));
  return forge?.kind === 'github' || (!forge && process.env.CEZ_DRY_RUN === '1')
    ? github.fetchGithubChecks(root, numbers)
    : { available: false, reason: 'Open the merge request on GitLab to inspect pipeline checks.' };
}

export async function fetchForgeRefStatus(root: string, refs: { prs: number[]; issues: number[] }): Promise<GithubRefStatusData> {
  const forge = resolveForge(await getRepoInfo(root));
  return forge?.kind === 'github' || (!forge && process.env.CEZ_DRY_RUN === '1')
    ? github.fetchGithubRefStatus(root, refs)
    : { available: false, reason: 'Reference status is unavailable for this forge.', recheckAfterMs: null };
}

export async function fetchForgePrDiff(root: string, number: number, refresh = false): Promise<ForgePrDiffResult> {
  const forge = resolveForge(await getRepoInfo(root));
  if (!forge && process.env.CEZ_DRY_RUN === '1') return github.fetchGithubPrDiff(root, number, refresh);
  return forge?.prDiff
    ? forge.prDiff(number, { refresh })
    : { available: false, reason: 'Open the merge request on GitLab to inspect changed files.' };
}
