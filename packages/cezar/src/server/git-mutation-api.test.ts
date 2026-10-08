import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const mocks = vi.hoisted(() => ({ branch: vi.fn(), commit: vi.fn(), push: vi.fn(), publish: vi.fn(), active: vi.fn() }));
vi.mock('./git-changes.ts', async original => ({ ...await original<typeof import('./git-changes.ts')>(), checkTaskBranch: mocks.branch, commitAll: mocks.commit, pushCurrentBranch: mocks.push }));
vi.mock('./git.ts', async original => ({ ...await original<typeof import('./git.ts')>(), getRepoInfo: vi.fn().mockResolvedValue({ root: '/repo', branch: 'main', remote: 'https://gitlab.com/team/repo.git' }) }));
vi.mock('./forge/index.ts', async original => ({ ...await original<typeof import('./forge/index.ts')>(), resolveForge: () => ({ kind: 'gitlab', createPR: mocks.publish }) }));
import { createApp } from './server.ts';

let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-git-mutation-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  id = store.createRun({ title: 'Review task', task: 'Fix it', workflow: 'quick-task', steps: [] }).id;
  store.updateRun(id, { status: 'review', worktreePath: root, branch: 'cez/test' });
  mocks.active.mockReset().mockReturnValue(false);
  mocks.branch.mockReset().mockResolvedValue({ ok: true, branch: 'cez/test' });
  mocks.commit.mockReset().mockResolvedValue({ ok: true, sha: 'a'.repeat(40) });
  mocks.push.mockReset().mockResolvedValue({ ok: true, branch: 'cez/test', remote: 'origin', upstreamSet: true });
  mocks.publish.mockReset().mockResolvedValue({ ok: true, url: 'https://gitlab.com/team/repo/-/merge_requests/1', dryRun: false });
  app = createApp({ repoRoot: root, store, manager: { isActive: mocks.active } as unknown as RunManager, version: 'test' });
});
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });
const post = (action: string, prefix = '/api/v1') => apiRequest(app, `${prefix}/runs/${id}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(action === 'git/commit' ? { message: 'fix' } : action === 'messages' ? { text: 'Fix one more thing' } : {}),
});

it.each(['git/commit', 'git/push'])('refuses %s while agent is writing, through both mounts', async action => {
  store.updateRun(id, { status: 'running' });
  mocks.active.mockReturnValue(true);
  for (const prefix of ['/api/v1', '/api/v1/p/default']) {
    expect((await post(action, prefix)).status).toBe(409);
  }
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('excludes concurrent publication, commit, push, Continue and cleanup across route aliases', async () => {
  let release!: (value: unknown) => void;
  mocks.publish.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = post('pr');
  await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
  try {
    for (const action of ['pr', 'git/commit', 'git/push', 'continue', 'messages', 'remove-worktree']) {
      const response = await post(action, '/api/v1/p/default');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'another task mutation is in progress; wait and retry' });
    }
    expect((await apiRequest(app, `/api/v1/runs/${id}`, { method: 'DELETE' })).status).toBe(409);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  } finally {
    release({ ok: true, url: 'https://gitlab.com/team/repo/-/merge_requests/1', dryRun: false });
    expect((await first).status).toBe(201);
  }
  expect((await post('git/commit')).status).toBe(200);
});

it('releases mutation exclusion after failure and keeps review work retryable', async () => {
  mocks.publish.mockResolvedValueOnce({ ok: false, error: 'offline' });
  const failure = await post('pr');
  expect(failure.status).toBe(409);
  expect(await failure.json()).toEqual({ error: 'offline', manual: 'git status --short' });
  expect(store.getRun(id)).toMatchObject({ status: 'review' });
  expect(store.getRun(id)?.pullRequestUrl).toBeUndefined();
  expect((await post('pr')).status).toBe(201);
});

it('releases checkout lock even when a helper throws', async () => {
  mocks.commit.mockRejectedValueOnce(new Error('unexpected failure'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { expect((await post('git/commit')).status).toBe(500); } finally { log.mockRestore(); }
  expect((await post('git/commit')).status).toBe(200);
});

it('keeps idle waiting-session commit and push reachable', async () => {
  store.updateRun(id, { status: 'waiting' });
  mocks.active.mockReturnValue(true);
  expect((await post('git/commit')).status).toBe(200);
  expect((await post('git/push')).status).toBe(200);
  expect((await post('pr')).status).toBe(409);
});

it.each(['git/commit', 'git/push'])('checks task base branch before %s mutates git', async action => {
  store.updateRun(id, { baseBranch: 'origin/develop' });
  mocks.branch.mockResolvedValue({ ok: false, error: 'Task checkout is on a base branch' });
  expect((await post(action)).status).toBe(409);
  expect(mocks.branch).toHaveBeenCalledWith(root, 'origin/develop');
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
});
