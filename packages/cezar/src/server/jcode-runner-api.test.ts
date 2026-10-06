import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

// Fork-local (FORK.md): `runner: 'jcode'` must pass the HTTP contract and reach the engine.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

it('POST /api/v1/runs accepts runner jcode and hands it to the engine', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cez-jcode-'));
  roots.push(repoRoot);
  const store = RunStore.open(join(repoRoot, '.ai/cezar'));
  let captured: StartRunInput | undefined;
  const manager = {
    startRun: (_w: unknown, input: StartRunInput) => {
      captured = input;
      return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
    },
  } as unknown as RunManager;
  const app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  const res = await apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'x', runner: 'jcode', steps: [{ id: 'work', prompt: '{{task}}' }] }),
  });
  expect(res.status).toBe(201);
  expect(captured?.runner).toBe('jcode');
  store.flush();
});
