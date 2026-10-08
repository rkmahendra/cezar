import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { execFile, execFileSync, autosaveCommit } = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn(), autosaveCommit: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile, execFileSync }));
vi.mock('../../git-worktree.ts', () => ({ autosaveCommit }));
import { createGithubDriver, createDraftPr, fetchGithub, fetchGithubComments, fetchGithubPrDiff, fetchGithubChecks, fetchGithubRefStatus, readCachedRefStatuses, __seedRefStatusCacheForTests } from './github.ts';
import type { DraftPrInput } from './types.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-routing-'));
  vi.stubEnv('GH_CONFIG_DIR', dir);
  vi.stubEnv('GLAB_CONFIG_DIR', dir);
  vi.stubEnv('CEZ_DRY_RUN', '');
  vi.stubEnv('GH_TOKEN', 'public-token'); vi.stubEnv('GITHUB_TOKEN', 'other-public-token');
  vi.stubEnv('GH_HOST', 'wrong.example'); vi.stubEnv('GH_REPO', 'wrong.example/wrong/repo');
  vi.stubEnv('GH_ENTERPRISE_TOKEN', 'wrong-enterprise-token');
  writeFileSync(join(dir, 'hosts.yml'), 'code.example: { user: alice }\n"code.example:8443": { user: alice }\n');
  execFile.mockReset(); execFileSync.mockReset(); autosaveCommit.mockReset();
  execFileSync.mockReturnValue('https://code.example/acme/demo.git');
  autosaveCommit.mockResolvedValue('clean');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function readMock() {
  execFile.mockImplementation((_bin, args: string[], opts, cb) => {
    let stdout = '{}';
    if (args[0] === 'repo') stdout = 'acme/demo';
    if (args[0] === 'issue') stdout = JSON.stringify([{ number: 1, title: opts.env.GH_HOST, createdAt: '2026-01-01T00:00:00Z', url: `https://${opts.env.GH_HOST}/acme/demo/issues/1` }]);
    if (args[0] === 'pr') stdout = args.includes('headRefOid') ? JSON.stringify({ headRefOid: 'a'.repeat(40) }) : '[]';
    if (args[0] === 'api' && args[1] !== 'graphql') stdout = '[]';
    cb(null, { stdout, stderr: '' });
  });
}

describe('GitHub host routing', () => {
  it('scopes legacy helpers including REST, GraphQL, checks and statuses to local origin', async () => {
    readMock();
    expect((await fetchGithub('/legacy-routing', true)).issues[0]?.title).toBe('code.example');
    await fetchGithubComments('/legacy-routing', 'pr', 1, true);
    await fetchGithubPrDiff('/legacy-routing', 1, true);
    await fetchGithubChecks('/legacy-routing', [1]);
    await fetchGithubRefStatus('/legacy-routing', { prs: [1] });
    for (const [bin, args, opts] of execFile.mock.calls) {
      expect(bin).toBe('gh');
      expect(opts.env.GH_HOST).toBe('code.example');
      expect(opts.env.GH_REPO).toBe('code.example/acme/demo');
      expect(opts.env.GH_TOKEN).toBeUndefined(); expect(opts.env.GITHUB_TOKEN).toBeUndefined();
      expect(opts.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      if (args[0] === 'api') expect(args).toEqual(expect.arrayContaining(['--hostname', 'code.example']));
      expect(args.join(' ')).not.toContain('{owner}');
    }
  });
  it('does not leak cached public results when origin changes host or repository', async () => {
    readMock();
    execFileSync.mockReturnValue('https://github.com/acme/demo.git');
    expect((await fetchGithub('/changed-origin')).issues[0]?.title).toBe('github.com');
    execFileSync.mockReturnValue('https://code.example/acme/demo.git');
    expect((await fetchGithub('/changed-origin')).issues[0]?.title).toBe('code.example');
    const count = execFile.mock.calls.length;
    execFileSync.mockReturnValue('https://code.example/other/demo.git');
    await fetchGithub('/changed-origin');
    expect(execFile.mock.calls.length).toBeGreaterThan(count);
  });
  it('never contacts unknown, GitLab, or absent origins even with ambient GH_REPO', async () => {
    for (const remote of ['https://github.evil.test/acme/demo.git', 'https://gitlab.com/acme/demo.git', '']) {
      execFileSync.mockReturnValue(remote);
      expect((await fetchGithub('/untrusted', true)).available).toBe(false);
    }
    expect(execFile).not.toHaveBeenCalled();
  });
  it('isolates bound driver caches and links at same cwd across public and enterprise ports', async () => {
    readMock();
    const pub = createGithubDriver('/same-cwd', { host: 'github.com', owner: 'acme', repo: 'demo' });
    const ent = createGithubDriver('/same-cwd', { host: 'code.example:8443', owner: 'acme', repo: 'demo' });
    expect((await pub.listIssues())[0]?.title).toBe('github.com');
    expect((await ent.listIssues())[0]?.title).toBe('code.example:8443');
    expect(ent.viewUrl('pr', 7)).toBe('https://code.example:8443/acme/demo/pull/7');
    expect(execFileSync).not.toHaveBeenCalled();
    const pubCall = execFile.mock.calls.find((call) => call[2].env.GH_HOST === 'github.com');
    expect(pubCall?.[2].env.GH_TOKEN).toBe('public-token');
  });
  it('does not serve warm status data under a new remote', () => {
    execFileSync.mockReturnValue('https://github.com/acme/demo.git');
    __seedRefStatusCacheForTests('/status-origin', [[7, { kind: 'pr', status: 'merged' }]]);
    expect(readCachedRefStatuses('/status-origin', [7]).prs[7]).toBe('merged');
    execFileSync.mockReturnValue('https://code.example/acme/demo.git');
    expect(readCachedRefStatuses('/status-origin', [7]).prs).toEqual({});
  });
  it('does not let PR URL selectors override the intended host', async () => {
    const driver = createGithubDriver('/selector', { host: 'github.com', owner: 'acme', repo: 'demo' });
    expect(await driver.prStatus('https://code.example/acme/demo/pull/1')).toBeNull();
    expect(await driver.prStatus('--web')).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('enterprise draft PR publication (mock only)', () => {
  const input = { run: { worktreePath: '/worktree', branch: 'cez/test', baseBranch: 'origin/develop', title: 'Test', task: 'Test' }, handoffText: '' } as DraftPrInput;
  function publishMock(url: string, remote = 'https://code.example/acme/demo.git') {
    execFile.mockImplementation((bin, args, _opts, cb) => cb(null, bin === 'gh' ? url : args[0] === 'remote' ? remote : '', ''));
  }
  it('returns only matching enterprise PR URLs and scopes gh creation auth', async () => {
    publishMock('https://code.example/acme/demo/pull/42');
    expect(await createDraftPr(input)).toEqual({ ok: true, url: 'https://code.example/acme/demo/pull/42', dryRun: false });
    const ghCall = execFile.mock.calls.find((call) => call[0] === 'gh')!;
    expect(ghCall[1]).toEqual(expect.arrayContaining(['--draft', '--base', 'develop']));
    expect(ghCall[2].env.GH_REPO).toBe('code.example/acme/demo');
    expect(ghCall[2].env.GH_TOKEN).toBeUndefined();
    expect(ghCall[2].env.GITHUB_TOKEN).toBeUndefined();
    const pushCall = execFile.mock.calls.find((call) => call[1][0] === 'push')!;
    expect(pushCall[2].env.GH_TOKEN).toBeUndefined();
    expect(pushCall[2].env.GITHUB_TOKEN).toBeUndefined();
    expect(pushCall[2].env.GIT_TERMINAL_PROMPT).toBe('0');
  });
  it('rejects cross-host PR URLs and refuses changed origin before push', async () => {
    publishMock('https://github.com/acme/demo/pull/42');
    expect((await createDraftPr(input)).ok).toBe(false);
    execFile.mockClear();
    expect((await createDraftPr(input, { host: 'code.example', owner: 'other', repo: 'demo' })).ok).toBe(false);
    expect(execFile.mock.calls.some((call) => call[1][0] === 'push')).toBe(false);
  });
  it('refuses unknown and GitLab origins before push', async () => {
    publishMock('', 'https://gitlab.com/acme/demo.git');
    expect((await createDraftPr(input)).ok).toBe(false);
    expect(execFile.mock.calls.some((call) => call[1][0] === 'push')).toBe(false);
  });
  it('refuses a separate push URL for another host before push', async () => {
    execFile.mockImplementation((_bin, args, _opts, cb) => cb(null,
      args.includes('--push') ? 'https://other.example/acme/demo.git' : 'https://code.example/acme/demo.git', ''));
    expect((await createDraftPr(input)).ok).toBe(false);
    expect(execFile.mock.calls.some((call) => call[1][0] === 'push')).toBe(false);
  });
});
