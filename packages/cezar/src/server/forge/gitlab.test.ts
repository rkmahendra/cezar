import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPrInput } from './types.ts';

const { execMock, autosave } = vi.hoisted(() => ({ execMock: vi.fn(), autosave: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execMock }));
vi.mock('../../git-worktree.ts', () => ({ autosaveCommit: autosave }));
import { createGitlabDriver } from './gitlab.ts';

const ref = { host: 'gitlab.corp.example', owner: 'platform/payments', repo: 'service' };
const rootUrl = `https://${ref.host}/${ref.owner}/${ref.repo}`;
const endpoint = 'projects/platform%2Fpayments%2Fservice';
const project = { id: 123, path_with_namespace: 'platform/payments/service', default_branch: 'main', web_url: rootUrl };
const issue = {
  id: 4567, iid: 12, project_id: 123, title: 'Accept Linear task', description: 'Task **body**', state: 'opened',
  author: { id: 77, username: 'sam', name: 'Sam Developer', avatar_url: null },
  created_at: '2026-10-07T19:01:02.123Z', updated_at: '2026-10-08T01:02:03.123Z',
  labels: ['backend', 'linear'], user_notes_count: 3, web_url: `${rootUrl}/-/issues/12`,
};
const mr = {
  ...issue, iid: 24, title: 'Draft: Implement Linear task', source_branch: 'feat/linear-42', target_branch: 'develop',
  source_project_id: 123, target_project_id: 123, draft: true, work_in_progress: true,
  web_url: `${rootUrl}/-/merge_requests/24`, head_pipeline: { id: 88, status: 'success' },
};
let sequence = 0;
let root: string;
let respond: (bin: string, args: string[]) => unknown;
const calls = (bin: string) => execMock.mock.calls.filter((call) => call[0] === bin);
const apiCalls = () => calls('glab');
const postCalls = () => apiCalls().filter((call) => (call[1] as string[]).includes('POST'));
const pushCalls = () => calls('git').filter((call) => call[1][0] === 'push');
const input = (): DraftPrInput => ({
  repoRoot: root,
  run: { worktreePath: `${root}/worktree`, branch: 'cez/stale', baseBranch: 'origin/develop', title: 'Implement Linear task', task: 'Ship Linear task' } as DraftPrInput['run'],
  handoffText: '## Goal\n\nShip Linear task\n\n## Progress log\n\n- Tests pass\n',
});
const standard = (bin: string, args: string[]): unknown => {
  if (bin === 'git') {
    if (args[0] === 'symbolic-ref') return 'feat/linear-42\n';
    if (args[0] === 'check-ref-format' || args[0] === 'push' || args[0] === 'status') return '';
    if (args[0] === 'remote') return `git@${ref.host}:${ref.owner}/${ref.repo}.git\n`;
  }
  if (bin === 'glab') {
    if (args[5] === endpoint) return project;
    if (args.includes('POST')) return mr;
    if (args[5]?.startsWith(`${endpoint}/issues?`)) return [issue];
    if (args[5]?.startsWith(`${endpoint}/merge_requests?`)) return args[5].includes('source_branch=') ? [] : [mr];
    if (args[5] === `${endpoint}/merge_requests/24`) return mr;
  }
  throw new Error(`Unexpected test command ${bin} ${args.join(' ')}`);
};

beforeEach(() => {
  root = `/offline/gitlab-${sequence++}`;
  vi.stubEnv('CEZ_DRY_RUN', '0');
  execMock.mockReset();
  autosave.mockReset().mockResolvedValue('nothing-to-do');
  respond = standard;
  // Match promisify(execFile)'s output without spawning any process or contacting a vendor.
  execMock.mockImplementation((bin: string, args: string[], _opts: unknown, callback: (error: unknown, output?: unknown) => void) => {
    try {
      const value = respond(bin, args);
      callback(null, { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    } catch (error) { callback(error); }
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('GitLab forge read operations', () => {
  it('construction and repeated health probes never spawn, including expired cached state', async () => {
    const driver = createGitlabDriver(root, ref);
    expect(driver.kind).toBe('gitlab');
    expect(driver.detectCached()).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
    expect(await driver.detect()).toEqual({ available: true });
    expect(apiCalls()).toHaveLength(1);
    const again = createGitlabDriver(root, ref);
    expect(await again.detect()).toEqual({ available: true });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    expect(again.detectCached()).toEqual({ available: true });
    expect(apiCalls()).toHaveLength(1);
  });

  it('deduplicates explicit detection and scopes all commands to host and encoded nested project', async () => {
    for (const key of ['GITLAB_TOKEN', 'GLAB_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN', 'GITLAB_HOST', 'GL_HOST']) vi.stubEnv(key, 'do-not-leak');
    vi.stubEnv('GLAB_CONFIG_DIR', '/configured/glab');
    const driver = createGitlabDriver(root, ref);
    await Promise.all([driver.detect(), driver.detect()]);
    expect(apiCalls()).toHaveLength(1);
    const [bin, args, opts] = apiCalls()[0]!;
    expect(bin).toBe('glab');
    expect(args).toEqual(['api', '--hostname', ref.host, '--method', 'GET', endpoint]);
    expect(opts).toMatchObject({ cwd: root, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0', GLAB_CONFIG_DIR: '/configured/glab' } });
    expect(Object.values(opts.env)).not.toContain('do-not-leak');
    expect(process.env.GITLAB_TOKEN).toBe('do-not-leak');
  });

  it.each([
    ['GITLAB_HOST', 'https://gitlab.corp.example', ref.host, true],
    ['GL_HOST', 'gitlab.corp.example', ref.host, true],
    ['GITLAB_HOST', 'gitlab.corp.example:8443', 'gitlab.corp.example:8443', true],
    ['GITLAB_HOST', 'gitlab.corp.example:8443', ref.host, false],
    ['GITLAB_HOST', 'https://secret@gitlab.corp.example', ref.host, false],
    ['GITLAB_HOST', 'https://gitlab.corp.example/path', ref.host, false],
    ['GITLAB_HOST', '', 'gitlab.com', true],
    ['GITLAB_HOST', '', ref.host, false],
  ])('binds env auth %s=%s only to %s', async (name, value, host, allowed) => {
    vi.stubEnv('GITLAB_HOST', '');
    vi.stubEnv('GL_HOST', '');
    vi.stubEnv(name, value);
    vi.stubEnv('GITLAB_TOKEN', 'scoped-gitlab-token');
    vi.stubEnv('OAUTH_TOKEN', 'scoped-oauth-token');
    vi.stubEnv('GITHUB_TOKEN', 'never-forward-github-token');
    vi.stubEnv('GH_TOKEN', 'never-forward-gh-token');
    await createGitlabDriver(root, { ...ref, host }).detect();
    const env = apiCalls()[0]![2].env;
    expect(env.GITLAB_TOKEN).toBe(allowed ? 'scoped-gitlab-token' : undefined);
    expect(env.OAUTH_TOKEN).toBe(allowed ? 'scoped-oauth-token' : undefined);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(apiCalls()[0]![1][2]).toBe(host);
  });

  it('keeps caches host/project scoped even when one root is reused', async () => {
    const first = createGitlabDriver(root, ref);
    await first.detect();
    const other = createGitlabDriver(root, { ...ref, host: 'gitlab.com' });
    expect(other.detectCached()).toBeNull();
    await other.detect();
    expect(apiCalls()).toHaveLength(2);
    expect(apiCalls()[1]![1][2]).toBe('gitlab.com');
  });

  it('normalizes realistic issue/MR payloads without altering GitHub item shape', async () => {
    const driver = createGitlabDriver(root, ref);
    expect(await driver.listIssues()).toEqual([{
      kind: 'issue', number: 12, title: issue.title, author: 'sam', createdAt: issue.created_at,
      labels: issue.labels, body: issue.description, url: issue.web_url, comments: 3,
    }]);
    expect(await driver.listPRs()).toEqual([{
      kind: 'pr', number: 24, title: mr.title, author: 'sam', createdAt: mr.created_at,
      labels: mr.labels, body: mr.description, url: mr.web_url, comments: 3, isDraft: true, checks: null,
    }]);
    expect(apiCalls()).toHaveLength(2);
    for (const call of apiCalls()) expect(call[1][5]).toContain('state=opened&scope=all');
  });

  it('caps list pages and bodies, supports refresh, and tolerates deleted authors', async () => {
    respond = (bin, args) => bin === 'glab' ? [{ ...issue, author: null, description: 'x'.repeat(9000) }] : standard(bin, args);
    const driver = createGitlabDriver(root, ref);
    const result = await driver.listIssues({ limit: 1000 });
    expect(result[0]).toMatchObject({ author: '?', body: 'x'.repeat(8000) });
    await driver.listIssues({ limit: 1000 });
    expect(apiCalls()).toHaveLength(1);
    expect(apiCalls()[0]![1][5]).toContain('per_page=100&page=1');
    expect(apiCalls()[0]![1]).not.toContain('--paginate');
    await driver.listIssues({ limit: 1000, refresh: true });
    expect(apiCalls()).toHaveLength(2);
  });

  it.each(['garbled secret=glpat-secret', JSON.stringify([{ ...issue, iid: '12' }]), JSON.stringify([{ ...issue, web_url: 'https://user:secret@gitlab.corp.example/x' }])])('rejects malformed vendor output with controlled errors', async (body) => {
    respond = () => body;
    const driver = createGitlabDriver(root, ref);
    await expect(driver.listIssues()).rejects.toThrow('GitLab returned an invalid response.');
    expect(driver.detectCached()).toEqual({ available: false, reason: 'GitLab returned an invalid response.' });
  });

  it.each(['ENOENT', 'ETIMEDOUT', 1])('degrades missing CLI, timeout and auth failures without echoing secrets', async (code) => {
    respond = () => { throw Object.assign(new Error('https://token:glpat-secret@host/ stderr secret'), { code }); };
    const driver = createGitlabDriver(root, ref);
    const availability = await driver.detect();
    expect(availability.available).toBe(false);
    expect(availability.reason).not.toMatch(/secret|token:/);
    expect(availability.reason).toContain(code === 'ENOENT' ? 'glab CLI not found' : `glab auth login --hostname ${ref.host}`);
    await expect(driver.listPRs()).rejects.toThrow();
    expect(await driver.prStatus('feature')).toBeNull();
  });

  it.each(['--hostname=evil', 'host/path', 'user:token@host', 'host\nother'])('rejects invalid host %s before spawning', async (host) => {
    const driver = createGitlabDriver(root, { ...ref, host });
    expect(await driver.detect()).toMatchObject({ available: false });
    expect(driver.viewUrl('repo', '')).toBeNull();
    await expect(driver.listIssues()).rejects.toThrow('GitLab repository reference is invalid.');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('searches closed/merged items with literal encoded text and explicit truncation', async () => {
    const driver = createGitlabDriver(root, ref);
    const result = await driver.searchItems!('pr', '@private&state=all', { limit: 1 });
    expect(result).toMatchObject({ available: true, truncated: true, items: [{ number: 24 }] });
    const query = new URLSearchParams(apiCalls()[0]![1][5].split('?')[1]);
    expect(query.get('state')).toBe('all');
    expect(query.get('search')).toBe('@private&state=all');
    expect(query.get('per_page')).toBe('1');
    expect(await driver.searchItems!('issue', '\nsecret')).toMatchObject({ available: false, items: [] });
    expect(apiCalls()).toHaveLength(1);
  });

  it.each([
    ['opened', 'success', 'open', 'passing'], ['merged', 'failed', 'merged', 'failing'],
    ['closed', 'running', 'closed', 'pending'], ['locked', 'manual', 'open', 'pending'],
    ['opened', 'skipped', 'open', null], ['opened', 'future-status', 'open', 'pending'],
  ])('maps MR state %s and pipeline %s', async (state, status, expectedState, expectedChecks) => {
    const row = { ...mr, state, head_pipeline: { status } };
    respond = (bin, args) => args[5]?.includes('?') ? [row] : row;
    expect(await createGitlabDriver(root, ref).prStatus(mr.source_branch)).toEqual({
      number: 24, url: mr.web_url, state: expectedState, isDraft: true, checks: expectedChecks,
    });
    expect(apiCalls()).toHaveLength(2);
  });

  it('prefers open MR and excludes same-name branches from forks', async () => {
    respond = (bin, args) => args[5]?.includes('?')
      ? [{ ...mr, iid: 99, source_project_id: 999 }, { ...mr, iid: 23, state: 'merged' }, mr]
      : standard(bin, args);
    expect(await createGitlabDriver(root, ref).prStatus(mr.source_branch)).toMatchObject({ number: 24, state: 'open' });
  });

  it('builds nested namespace URLs and encodes ref characters', () => {
    const driver = createGitlabDriver(root, ref);
    expect(driver.viewUrl('repo', '')).toBe(rootUrl);
    expect(driver.viewUrl('pr', 24)).toBe(mr.web_url);
    expect(driver.viewUrl('issue', 12)).toBe(issue.web_url);
    expect(driver.viewUrl('branch', 'feat/a#b?c')).toBe(`${rootUrl}/-/tree/feat/a%23b%3Fc`);
    expect(driver.viewUrl('commit', 'deadbeef')).toBe(`${rootUrl}/-/commit/deadbeef`);
    expect(driver.viewUrl('branch', '../bad')).toBeNull();
    expect(driver.viewUrl('pr', '12?token=secret')).toBeNull();
    expect(driver.mergePR).toBeUndefined();
    expect(driver.prMergeState).toBeUndefined();
    expect(driver.prDiff).toBeUndefined();
    expect(driver.recentCreated).toBeUndefined();
  });

  it('dry-run performs no CLI read calls', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const driver = createGitlabDriver(root, ref);
    expect(await driver.detect()).toEqual({ available: true });
    expect(driver.detectCached()).toEqual({ available: true });
    expect(await driver.listIssues()).toEqual([]);
    expect(await driver.listPRs()).toEqual([]);
    expect(await driver.searchItems!('pr', 'test')).toEqual({ available: true, items: [], truncated: false });
    expect(await driver.prStatus('feature')).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('GitLab draft MR publication', () => {
  it('autosaves and publishes actual checked-out branch with configured base and bounded literal text', async () => {
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    const result = await createGitlabDriver(root, ref).createPR(input());
    expect(result).toEqual({ ok: true, url: mr.web_url, dryRun: false });
    expect(autosave).toHaveBeenCalledWith(`${root}/worktree`, 'pre-PR');
    expect(pushCalls()).toHaveLength(1);
    expect(pushCalls()[0]![1]).toEqual(['push', '-u', '--', 'origin', 'refs/heads/feat/linear-42:refs/heads/feat/linear-42']);
    expect(pushCalls()[0]![2]).toMatchObject({ cwd: `${root}/worktree`, timeout: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]![1]).toEqual([
      'api', '--hostname', ref.host, '--method', 'POST', `${endpoint}/merge_requests`,
      '--raw-field', 'source_branch=feat/linear-42', '--raw-field', 'target_branch=develop',
      '--raw-field', 'title=Draft: Implement Linear task', '--raw-field', expect.stringContaining('description=## Goal'),
    ]);
    expect(postCalls()[0]![1].join(' ')).not.toContain('cez/stale');
    expect(execMock.mock.calls.some((call) => call[1].includes('merge'))).toBe(false);
  });

  it.each([undefined, 'deadbee', 'origin/0123456789abcdef0123456789abcdef01234567'])('uses project default for missing or SHA base %s', async (baseBranch) => {
    const request = input();
    request.run.baseBranch = baseBranch;
    respond = (bin, args) => args.includes('POST') ? { ...mr, target_branch: 'main' } : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(request)).toMatchObject({ ok: true });
    expect(postCalls()[0]![1]).toContain('target_branch=main');
  });

  it.each(['refused', 'failed'])('autosave %s blocks every vendor call and push, even dry-run', async (saved) => {
    autosave.mockResolvedValue(saved);
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const result = await createGitlabDriver(root, ref).createPR(input());
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(saved === 'refused' ? /unresolved merge conflicts/ : /Could not commit/) });
    expect(apiCalls()).toHaveLength(0);
    expect(pushCalls()).toHaveLength(0);
  });

  it('dry-run preserves autosave but never pushes or contacts GitLab', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    expect(await createGitlabDriver(root, ref).createPR(input())).toEqual({ ok: true, url: `${rootUrl}/-/merge_requests/777`, dryRun: true });
    expect(autosave).toHaveBeenCalledOnce();
    expect(apiCalls()).toHaveLength(0);
    expect(pushCalls()).toHaveLength(0);
  });

  it.each(['', '--all', 'feat:main', '@{-1}', 'bad\nbranch'])('invalid branch %s cannot reach push', async (branch) => {
    respond = (bin, args) => {
      if (args[0] === 'symbolic-ref') return branch;
      if (args[0] === 'check-ref-format') throw new Error('invalid ref');
      return standard(bin, args);
    };
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false });
    expect(autosave).not.toHaveBeenCalled();
    expect(pushCalls()).toHaveLength(0);
  });

  it('detached HEAD cannot autosave or publish', async () => {
    respond = () => { throw new Error('not a symbolic ref'); };
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false });
    expect(autosave).not.toHaveBeenCalled();
    expect(pushCalls()).toHaveLength(0);
  });

  it('reuses existing branch MR after pushing updates without changing ready state', async () => {
    respond = (bin, args) => args[5]?.includes('source_branch=') ? [{ ...mr, draft: false, work_in_progress: false, title: 'Ready for review' }] : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(input())).toEqual({ ok: true, url: mr.web_url, dryRun: false });
    expect(pushCalls()).toHaveLength(1);
    expect(postCalls()).toHaveLength(0);
  });

  it('recovers a lost POST response through one bounded MR lookup', async () => {
    let lookups = 0;
    respond = (bin, args) => {
      if (args.includes('POST')) throw new Error('timeout token=secret');
      if (args[5]?.includes('source_branch=')) return ++lookups === 1 ? [] : [mr];
      return standard(bin, args);
    };
    expect(await createGitlabDriver(root, ref).createPR(input())).toEqual({ ok: true, url: mr.web_url, dryRun: false });
    expect(postCalls()).toHaveLength(1);
    expect(lookups).toBe(2);
  });

  it('does not call a non-draft POST result a success', async () => {
    respond = (bin, args) => args.includes('POST') ? { ...mr, draft: false, work_in_progress: false, title: 'Not draft' } : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false, error: expect.stringContaining('unexpected merge request') });
  });

  it.each([
    'git@elsewhere.example:platform/payments/service.git',
    `https://${ref.host}/wrong/service.git`,
    `git@${ref.host}:platform/payments/service.git\ngit@evil.example:stolen/repo.git`,
  ])('refuses mismatched or multiple origin push URLs before vendor calls: %s', async (remote) => {
    respond = (bin, args) => args[0] === 'remote' ? remote : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false, error: expect.stringContaining('push URL does not match') });
    expect(pushCalls()).toHaveLength(0);
    expect(apiCalls()).toHaveLength(0);
  });

  it.each([`https://user:secret@${ref.host}/platform/payments/service.git`, `ssh://git@${ref.host}:2222/platform/payments/service.git`])('accepts supported git remote syntax without exposing credentials', async (remote) => {
    respond = (bin, args) => args[0] === 'remote' ? remote : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(input())).toEqual({ ok: true, url: mr.web_url, dryRun: false });
  });

  it.each(['wrong-base', 'same-branch', 'default-branch', 'changed-branch', 'push-failed'])('blocks unsafe publication: %s', async (mode) => {
    let heads = 0;
    respond = (bin, args) => {
      if (mode === 'wrong-base' && args[5]?.includes('source_branch=')) return [{ ...mr, target_branch: 'main' }];
      if (mode === 'same-branch' && args[0] === 'symbolic-ref') return 'develop';
      if (mode === 'default-branch' && args[0] === 'symbolic-ref') return 'main';
      if (mode === 'changed-branch' && args[0] === 'symbolic-ref' && ++heads > 1) return 'other-branch';
      if (mode === 'push-failed' && args[0] === 'push') throw new Error('https://token:secret@host rejected');
      return standard(bin, args);
    };
    const result = await createGitlabDriver(root, ref).createPR(input());
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(postCalls()).toHaveLength(0);
    expect(pushCalls()).toHaveLength(mode === 'push-failed' ? 1 : 0);
  });

  it.each(['dirty', 'unreadable'])('refuses a %s worktree after final autosave', async (mode) => {
    respond = (bin, args) => {
      if (args[0] === 'status') {
        if (mode === 'unreadable') throw new Error('cannot read status');
        return ' M still-dirty.txt';
      }
      return standard(bin, args);
    };
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false });
    expect(pushCalls()).toHaveLength(0);
    expect(apiCalls()).toHaveLength(0);
  });

  it('refuses to create a duplicate when branch lookup truncates before this project', async () => {
    respond = (bin, args) => args[5]?.includes('source_branch=')
      ? Array.from({ length: 100 }, (_, n) => ({ ...mr, iid: n + 1, source_project_id: 999 }))
      : standard(bin, args);
    expect(await createGitlabDriver(root, ref).createPR(input())).toMatchObject({ ok: false, error: expect.stringContaining('truncated') });
    expect(pushCalls()).toHaveLength(0);
    expect(postCalls()).toHaveLength(0);
  });

  it('caps title and body argv without interpreting file or flag text', async () => {
    const request = input();
    request.run.title = '@secret --yes ' + 'x'.repeat(500);
    request.run.task = '日'.repeat(100_000);
    request.handoffText = '';
    expect(await createGitlabDriver(root, ref).createPR(request)).toMatchObject({ ok: true });
    const args = postCalls()[0]![1] as string[];
    expect(args.find((value) => value.startsWith('title='))!.length).toBeLessThanOrEqual(261);
    expect(Buffer.byteLength(args.find((value) => value.startsWith('description='))!)).toBeLessThanOrEqual(60_015);
    expect(args).not.toContain('--field');
    expect(args).not.toContain('--yes');
  });
});
