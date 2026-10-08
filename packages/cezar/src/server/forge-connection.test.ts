import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { forgeConnectionSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const mocks = vi.hoisted(() => ({ info: vi.fn(), resolve: vi.fn(), detect: vi.fn(), cached: vi.fn() }));
vi.mock('./git.ts', async original => ({ ...await original<typeof import('./git.ts')>(), getRepoInfo: mocks.info }));
vi.mock('./forge/index.ts', async original => ({ ...await original<typeof import('./forge/index.ts')>(), resolveForge: mocks.resolve }));
import { createApp } from './server.ts';
import { readForgeConnection } from './forge-connection.ts';
let root: string;
let store: RunStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-forge-connection-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  vi.stubEnv('CEZ_DRY_RUN', '0');
  mocks.info.mockReset().mockResolvedValue({ root, branch: 'main', remote: 'https://user:secret@gitlab.com/team/sub/repo.git' });
  mocks.resolve.mockReset().mockReturnValue({ kind: 'gitlab', detect: mocks.detect, detectCached: mocks.cached, viewUrl: () => 'https://gitlab.com/team/sub/repo' });
  mocks.detect.mockReset().mockResolvedValue({ available: true });
  mocks.cached.mockReset();
});
afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const app = () => createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });

it('reads local identity through both route mounts without probing or leaking credentials', async () => {
  const instance = app();
  for (const prefix of ['/api/v1', '/api/v1/p/default']) {
    const response = await apiRequest(instance, `${prefix}/forge/connection`);
    expect(response.status).toBe(200);
    const data = forgeConnectionSchema.parse(await response.json());
    expect(data).toEqual({ kind: 'gitlab', host: 'gitlab.com', repository: 'team/sub/repo', url: 'https://gitlab.com/team/sub/repo', status: 'untested', reason: null });
    expect(JSON.stringify(data)).not.toContain('secret');
  }
  expect(mocks.detect).not.toHaveBeenCalled();
  expect(mocks.cached).not.toHaveBeenCalled();
});

it('tests explicitly with a fresh probe, including hosted mode, without caching the HTTP response', async () => {
  vi.stubEnv('CEZ_REMOTE', '1');
  const instance = app();
  const response = await apiRequest(instance, '/api/v1/forge/connection?test=1');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(forgeConnectionSchema.parse(await response.json()).status).toBe('available');
  expect(mocks.detect).toHaveBeenCalledWith({ refresh: true });
  expect((await readForgeConnection(root)).status).toBe('untested');
});

it.each(['test=0', 'test=true', 'host=evil.example', 'token=secret'])('validates query in middleware: %s', async query => {
  expect((await apiRequest(app(), `/api/v1/forge/connection?${query}`)).status).toBe(400);
  expect(mocks.detect).not.toHaveBeenCalled();
});

it('does not confuse missing or unknown hosts with authenticated access', async () => {
  mocks.resolve.mockReturnValue(null);
  expect(await readForgeConnection(root, true)).toMatchObject({ kind: null, status: 'unconfigured', host: 'gitlab.com', url: null });
  mocks.info.mockResolvedValue(null);
  expect(await readForgeConnection(root, true)).toMatchObject({ kind: null, host: null, repository: null, status: 'unconfigured' });
  expect(mocks.detect).not.toHaveBeenCalled();
});

it('does not expose driver error bodies or report demo mode as real access', async () => {
  mocks.detect.mockResolvedValue({ available: false, reason: 'sensitive token in upstream error' });
  const result = await readForgeConnection(root, true);
  expect(result.status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('sensitive');
  mocks.detect.mockRejectedValue(new Error('secret upstream body'));
  expect(JSON.stringify(await readForgeConnection(root, true))).not.toContain('secret');
  mocks.detect.mockClear();
  vi.stubEnv('CEZ_DRY_RUN', '1');
  expect((await readForgeConnection(root, true)).status).toBe('demo');
  expect(mocks.detect).not.toHaveBeenCalled();
});

it('refuses success if the remote changes while checking', async () => {
  mocks.info.mockResolvedValueOnce({ root, branch: 'main', remote: 'https://gitlab.com/a/b.git' });
  expect(await readForgeConnection(root, true)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('changed') });
});
