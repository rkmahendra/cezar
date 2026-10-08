import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

let root: string | undefined;
let store: RunStore | undefined;
afterEach(() => { store?.flush(); if (root) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('publishes a GitLab draft through both route mounts and never merges', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  root = mkdtempSync(join(tmpdir(), 'cez-gitlab-route-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '-b', 'cez/test']);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'test']);
  git(['remote', 'add', 'origin', 'https://gitlab.com/group/sub/app.git']);
  store = RunStore.open(join(root, '.ai/cezar'));
  let active = true;
  const app = createApp({ repoRoot: root, store, manager: { isActive: () => active } as unknown as RunManager, version: 'test' });
  const run = store.createRun({ title: 'Linear task', task: 'Implement it', workflow: 'quick-task', steps: [] });
  store.updateRun(run.id, { status: 'review', worktreePath: root, branch: 'cez/test' });
  const post = (prefix: string) => apiRequest(app, `${prefix}/runs/${run.id}/pr`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } });
  expect((await post('/api/v1')).status).toBe(409);
  expect(store.getRun(run.id)?.pullRequestUrl).toBeUndefined();
  active = false;
  for (const prefix of ['/api/v1', '/api/v1/p/default']) {
    const response = await post(prefix);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ url: 'https://gitlab.com/group/sub/app/-/merge_requests/777', dryRun: true });
  }
  expect(store.getRun(run.id)).toMatchObject({ status: 'done', pullRequestUrl: 'https://gitlab.com/group/sub/app/-/merge_requests/777' });
  const merge = await apiRequest(app, '/api/v1/github/prs/777/merge', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
    body: JSON.stringify({ method: 'merge', expectedHeadSha: 'a'.repeat(40) }),
  });
  expect(merge.status).toBe(409);
});
