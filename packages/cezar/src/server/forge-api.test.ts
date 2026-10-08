import { beforeEach, describe, expect, it, vi } from 'vitest';
import { githubDataSchema, githubRefStatusDataSchema } from '@open-mercato/cezar-contract';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn(), comments: vi.fn(), checks: vi.fn(), refs: vi.fn() }));
vi.mock('./git.ts', () => ({ getRepoInfo: async () => ({ root: '/repo', branch: 'main' }) }));
vi.mock('./forge/index.ts', () => ({ resolveForge: mocks.resolve }));
vi.mock('./github.ts', () => ({ fetchGithub: mocks.list, fetchGithubComments: mocks.comments, fetchGithubChecks: mocks.checks, fetchGithubRefStatus: mocks.refs }));
import { fetchForge, fetchForgeChecks, fetchForgeComments, fetchForgePrDiff, fetchForgeRefStatus, searchForge } from './forge-api.ts';

beforeEach(() => vi.resetAllMocks());

describe('forge API routing', () => {
  it('keeps GitHub list behavior and never makes unknown remotes into GitHub', async () => {
    const expected = { available: true, issues: [], prs: [], repo: 'acme/demo' };
    mocks.resolve.mockReturnValue({ kind: 'github' });
    mocks.list.mockResolvedValue(expected);
    expect(await fetchForge('/repo', true, 15)).toEqual(expected);
    expect(mocks.list).toHaveBeenCalledWith('/repo', true, 15);
    mocks.resolve.mockReturnValue(null);
    expect(await fetchForge('/repo')).toMatchObject({ available: false });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('lists GitLab via its driver and distinguishes an outage from an empty list', async () => {
    const issues = vi.fn().mockResolvedValue([]);
    const prs = vi.fn().mockResolvedValue([]);
    mocks.resolve.mockReturnValue({ kind: 'gitlab', detect: async () => ({ available: true }), listIssues: issues, listPRs: prs });
    expect(githubDataSchema.parse(await fetchForge('/repo', true, 20))).toMatchObject({ available: true, issues: [], prs: [] });
    expect(prs).toHaveBeenCalledWith({ refresh: true, limit: 20 });
    prs.mockRejectedValue(new Error('vendor body secret must not escape'));
    const failed = await fetchForge('/repo');
    expect(failed.available).toBe(false);
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('unsupported GitLab operations degrade without invoking gh or renewing polls', async () => {
    mocks.resolve.mockReturnValue({ kind: 'gitlab' });
    expect(await fetchForgeComments('/repo', 'pr', 1)).toMatchObject({ available: false, comments: [] });
    expect(await fetchForgeChecks('/repo', [1])).toMatchObject({ available: false });
    expect(await fetchForgePrDiff('/repo', 1)).toMatchObject({ available: false });
    expect(await searchForge('/repo', 'pr', 'hello')).toMatchObject({ available: false, items: [] });
    expect(githubRefStatusDataSchema.parse(await fetchForgeRefStatus('/repo', { prs: [1], issues: [] }))).toMatchObject({ available: false, recheckAfterMs: null });
    expect(mocks.comments).not.toHaveBeenCalled();
    expect(mocks.checks).not.toHaveBeenCalled();
    expect(mocks.refs).not.toHaveBeenCalled();
  });
});
