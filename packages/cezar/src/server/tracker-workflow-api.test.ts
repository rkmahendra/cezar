import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trackerWorkflowSchema, type TrackerAssociation } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const mocks = vi.hoisted(() => ({ driver: vi.fn(), startRun: vi.fn() }));
vi.mock('./tracker/index.ts', async importOriginal => {
  const original = await importOriginal<typeof import('./tracker/index.ts')>();
  return { ...original, createTrackerService: (...args: Parameters<typeof original.createTrackerService>) => ({ ...original.createTrackerService(...args), driver: mocks.driver }) };
});
const association: TrackerAssociation = {
  kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' },
  externalId: '11111111-1111-4111-8111-111111111111', externalName: 'Team',
  connectionId: '22222222-2222-4222-8222-222222222222',
};
const consent = { kind: 'linear', sourceId: 'org', externalId: association.externalId, connectionId: association.connectionId, itemId: 'OPS-1', delegateCredentials: true };
const input = { steps: [{ id: 'work', prompt: '{{task}}' }], task: 'Work on selected issue' };
const body = (value: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const getItem = vi.fn();
let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linear-workflow-api-'));
  vi.stubEnv('CEZ_DRY_RUN', '1');
  store = RunStore.open(join(root, '.ai/cezar'));
  mocks.startRun.mockReset().mockImplementation((_workflow, received) => ({ id: 'run', ...received }));
  getItem.mockReset().mockResolvedValue({ available: true, item: { id: 'OPS-1', url: 'https://linear.app/acme/issue/OPS-1' } });
  mocks.driver.mockReset().mockResolvedValue({ association, getItem });
  app = createApp({ repoRoot: root, store, manager: { startRun: mocks.startRun } as never, version: 'test' });
});
afterEach(() => { store.flush(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('ordinary handoff launches without tracker reads or delegation', async () => {
  expect((await apiRequest(app, '/api/v1/runs', body(input))).status).toBe(201);
  expect(mocks.driver).not.toHaveBeenCalled();
  expect(mocks.startRun.mock.calls[0]?.[1]).not.toHaveProperty('trackerWorkflow');
});
it.each(['/api/v1/runs', '/api/v1/p/default/runs'])('captures only server-validated identity at %s', async path => {
  expect((await apiRequest(app, path, body({ ...input, trackerWorkflow: consent }))).status).toBe(201);
  expect(getItem).toHaveBeenCalledWith('OPS-1');
  expect(trackerWorkflowSchema.parse(mocks.startRun.mock.calls[0]?.[1].trackerWorkflow)).toEqual({ association, itemId: 'OPS-1', url: 'https://linear.app/acme/issue/OPS-1', delegateCredentials: true });
});
it.each([
  { delegateCredentials: false }, { delegateCredentials: undefined }, { kind: 'jira' },
  { connectionId: undefined }, { itemId: '../OPS-1' }, { key: 'must-not-be-accepted' },
  { url: 'https://attacker.test/issue' },
])('rejects malformed or implicit consent %j', async override => {
  expect((await apiRequest(app, '/api/v1/runs', body({ ...input, trackerWorkflow: { ...consent, ...override } }))).status).toBe(400);
  expect(mocks.driver).not.toHaveBeenCalled();
  expect(mocks.startRun).not.toHaveBeenCalled();
});
it.each(['sourceId', 'externalId', 'connectionId'] as const)('rejects stale %s before issue lookup', async key => {
  const replacement = key === 'sourceId' ? 'other' : '33333333-3333-4333-8333-333333333333';
  expect((await apiRequest(app, '/api/v1/runs', body({ ...input, trackerWorkflow: { ...consent, [key]: replacement } }))).status).toBe(409);
  expect(getItem).not.toHaveBeenCalled();
  expect(mocks.startRun).not.toHaveBeenCalled();
});
it.each(['credentials_missing', 'source_changed', 'unavailable'])('rejects unavailable connection: %s', async code => {
  mocks.driver.mockResolvedValue({ available: false, code, reason: 'Connection unavailable' });
  expect((await apiRequest(app, '/api/v1/runs', body({ ...input, trackerWorkflow: consent }))).status).toBe(409);
  expect(mocks.startRun).not.toHaveBeenCalled();
});
it.each([['not_found', 404], ['source_changed', 409], ['unauthorized', 409]] as const)('rejects failed issue lookup or a connection changed during lookup: %s', async (code, status) => {
  getItem.mockResolvedValue({ available: false, code, reason: 'Issue unavailable' });
  expect((await apiRequest(app, '/api/v1/runs', body({ ...input, trackerWorkflow: consent }))).status).toBe(status);
  expect(mocks.startRun).not.toHaveBeenCalled();
});
it('refuses competing writeback variants', async () => {
  expect((await apiRequest(app, '/api/v1/runs', body({ ...input, variants: 2, trackerWorkflow: consent }))).status).toBe(400);
  expect(mocks.driver).not.toHaveBeenCalled();
});
