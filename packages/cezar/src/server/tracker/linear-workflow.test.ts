import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerWorkflow } from '@open-mercato/cezar-contract';
import { trackerWorkflowInputSchema, trackerWorkflowSchema } from '@open-mercato/cezar-contract';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { attachTrackerWorkflowPublication, startTrackerWorkflow } from './linear-workflow.ts';

const team = '11111111-1111-4111-8111-111111111111';
const issueId = '22222222-2222-4222-8222-222222222222';
const todo = { id: '33333333-3333-4333-8333-333333333333', name: 'Ready', type: 'unstarted' };
const started = { id: '44444444-4444-4444-8444-444444444444', name: 'Building', type: 'started' };
const publication = 'https://gitlab.example.com/group/repo/-/merge_requests/8';

describe('consented Linear workflow lifecycle', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let connections: TrackerConnections;
  let binding: TrackerWorkflow;
  let state: typeof todo;
  let states: typeof todo[];
  let links: Array<{ url: string }>;
  let truncated: boolean;
  let source: string;
  let mutations: string[];
  let beforeResponse: (query: string) => Promise<void>;
  let fetcher: typeof fetch;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cez-linear-workflow-'));
    env = { CEZ_HOME: join(root, 'home') };
    connections = new TrackerConnections(env);
    const record = await connections.write(root, { kind: 'linear', key: 'synthetic-secret' });
    binding = { association: { kind: 'linear', source: { id: 'org', webUrl: 'https://linear.app/acme' }, externalId: team, externalName: 'Team', connectionId: record!.id }, itemId: 'OPS-1', url: 'https://linear.app/acme/issue/OPS-1', delegateCredentials: true };
    await writeTrackerAssociation(join(root, '.ai/cezar'), binding.association);
    state = { ...todo }; states = [{ ...started }]; links = []; truncated = false; source = 'org'; mutations = [];
    beforeResponse = async () => {};
    fetcher = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.linear.app/graphql');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe('synthetic-secret');
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      await beforeResponse(query);
      let data: unknown;
      if (query.includes('CezWorkflowIssue')) data = { organization: { id: source, urlKey: 'acme' }, issue: { id: issueId, identifier: 'OPS-1', url: binding.url, team: { id: team }, state } };
      else if (query.includes('CezWorkflowStates')) data = { team: { id: team, states: { nodes: states, pageInfo: { hasNextPage: truncated } } } };
      else if (query.includes('CezWorkflowLinks')) data = { issue: { id: issueId, attachments: { nodes: links, pageInfo: { hasNextPage: truncated } } } };
      else if (query.includes('CezWorkflowStart')) {
        expect(variables).toEqual({ id: issueId, stateId: started.id });
        mutations.push('start'); state = { ...started }; data = { issueUpdate: { success: true } };
      } else if (query.includes('CezWorkflowAttach')) {
        expect(variables).toEqual({ issueId, url: publication });
        mutations.push('attach'); links.push({ url: publication }); data = { attachmentCreate: { success: true } };
      } else throw new Error('unexpected GraphQL query');
      return Response.json({ data });
    });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const start = () => startTrackerWorkflow(root, binding, { env, fetcher });
  const attach = () => attachTrackerWorkflowPublication(root, binding, publication, { env, fetcher });

  it('discovers actual team state, reads back, and serializes repeated starts', async () => {
    await expect(Promise.all([start(), start()])).resolves.toEqual([
      'Linear workflow: started state confirmed.', 'Linear workflow: already started, status unchanged.',
    ]);
    expect(mutations).toEqual(['start']);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it.each(['completed', 'canceled', 'triage'])('does not reopen %s', async type => {
    state.type = type;
    await expect(start()).rejects.toThrow(/not be reopened|not eligible/);
    expect(mutations).toEqual([]);
  });

  it.each(['missing', 'ambiguous', 'truncated'])('refuses %s started state catalog', async mode => {
    if (mode === 'missing') states = [];
    if (mode === 'ambiguous') states.push({ ...started, id: todo.id, name: 'Review' });
    if (mode === 'truncated') truncated = true;
    await expect(start()).rejects.toThrow('no unique started state');
    expect(mutations).toEqual([]);
  });

  it('preserves review and validates old continued runs without moving reset status back', async () => {
    state = { ...started, name: 'Review' };
    await start();
    state = { ...todo };
    await startTrackerWorkflow(root, binding, { env, fetcher, checkOnly: true });
    binding.startedAt = new Date().toISOString();
    await start();
    expect(mutations).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('selects unique actual In Progress among started states including In Review', async () => {
    states = [{ ...started, name: ' In Progress ' }, { ...started, id: todo.id, name: 'In Review' }];
    await expect(start()).resolves.toContain('started state confirmed');
    expect(mutations).toEqual(['start']);
  });

  it('rejects duplicate In Progress names rather than guessing their IDs', async () => {
    states = [{ ...started, name: 'In Progress' }, { ...started, id: todo.id, name: 'in progress' }];
    await expect(start()).rejects.toThrow('no unique started state');
    expect(mutations).toEqual([]);
  });

  it('does not write if issue became terminal during discovery', async () => {
    beforeResponse = async query => { if (query.includes('CezWorkflowStates')) state.type = 'completed'; };
    await expect(start()).rejects.toThrow('not be reopened');
    expect(mutations).toEqual([]);
  });

  it.each(['connection', 'scope', 'organization', 'item'])('revalidates %s before writes', async mode => {
    if (mode === 'connection') await connections.write(root, { kind: 'linear', key: 'replacement' });
    if (mode === 'scope') await writeTrackerAssociation(join(root, '.ai/cezar'), { ...binding.association, externalId: issueId });
    if (mode === 'organization') source = 'other';
    if (mode === 'item') binding.itemId = 'OPS-2';
    await expect(start()).rejects.toThrow(/changed/);
    expect(mutations).toEqual([]);
    if (mode === 'connection' || mode === 'scope') expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks removal during state discovery', async () => {
    beforeResponse = async query => { if (query.includes('CezWorkflowStates')) await connections.remove(root); };
    await expect(start()).rejects.toThrow('connection or scope changed');
    expect(mutations).toEqual([]);
  });

  it('checks task cancellation before sending a mutation', async () => {
    let cancelled = false;
    beforeResponse = async query => { if (query.includes('CezWorkflowStates')) cancelled = true; };
    await expect(startTrackerWorkflow(root, binding, { env, fetcher, assertActive: () => {
      if (cancelled) throw new Error('cancelled');
    } })).rejects.toThrow('Linear workflow');
    expect(mutations).toEqual([]);
  });

  it('maps vendor write denial without exposing the upstream body', async () => {
    const real = fetcher;
    fetcher = vi.fn(async (url, init) => String(init?.body).includes('CezWorkflowStart')
      ? Response.json({ errors: [{ message: 'synthetic-secret', extensions: { code: 'FORBIDDEN' } }] })
      : real(url, init));
    await expect(start()).rejects.toThrow('Linear denied access');
    expect(mutations).toEqual([]);
  });

  it('dry-run does not resolve credentials or make requests', async () => {
    await connections.remove(root);
    env.CEZ_DRY_RUN = '1';
    await expect(start()).resolves.toContain('dry run');
    await expect(attach()).resolves.toContain('dry run');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a client cannot supply the server start receipt', () => {
    expect(trackerWorkflowSchema.safeParse({ ...binding, startedAt: new Date().toISOString() }).success).toBe(true);
    expect(trackerWorkflowInputSchema.safeParse({ kind: 'linear', sourceId: 'org', externalId: team,
      connectionId: binding.association.connectionId, itemId: binding.itemId, delegateCredentials: true,
      startedAt: new Date().toISOString() }).success).toBe(false);
  });

  it('blocks replacement issue identity and allows harmless title URL slugs', async () => {
    binding.url += '/old-title';
    await expect(start()).resolves.toContain('confirmed');
    state = { ...todo };
    const real = fetcher;
    let reads = 0;
    fetcher = vi.fn(async (url, init) => {
      const response = await real(url, init);
      if (String(init?.body).includes('CezWorkflowIssue') && ++reads === 2) {
        const body = await response.json() as { data: { issue: { id: string } } };
        body.data.issue.id = team;
        return Response.json(body);
      }
      return response;
    });
    await expect(start()).rejects.toThrow('identity or scope changed');
    expect(mutations).toEqual(['start']);
  });

  it('does not accept final readback after credentials are revoked in flight', async () => {
    let reads = 0;
    beforeResponse = async query => {
      if (query.includes('CezWorkflowIssue') && ++reads === 3) await connections.remove(root);
    };
    await expect(start()).rejects.toThrow('connection or scope changed');
    expect(mutations).toEqual(['start']); // Side effect happened, but no successful receipt is claimed.
  });

  it('reports controlled upstream failure, then safely retries a lost successful response', async () => {
    const real = fetcher;
    let lost = true;
    fetcher = vi.fn(async (url, init) => {
      const response = await real(url, init);
      if (lost && String(init?.body).includes('CezWorkflowStart')) { lost = false; throw new Error('synthetic-secret response lost'); }
      return response;
    });
    await expect(start()).rejects.toThrow('Tracker is unavailable');
    await expect(start()).resolves.toContain('already started');
    expect(mutations).toEqual(['start']);
  });

  it('attaches verified publication once, retries lost response, and never changes status', async () => {
    const real = fetcher;
    let lost = true;
    fetcher = vi.fn(async (url, init) => {
      const response = await real(url, init);
      if (lost && String(init?.body).includes('CezWorkflowAttach')) { lost = false; throw new Error('lost response'); }
      return response;
    });
    await expect(attach()).rejects.toThrow('Tracker is unavailable');
    await expect(attach()).resolves.toContain('already attached');
    expect(mutations).toEqual(['attach']);
    expect(state).toEqual(todo);
  });

  it('requires successful readback, including actual attachment presence', async () => {
    const real = fetcher;
    fetcher = vi.fn(async (url, init) => {
      const response = await real(url, init);
      if (String(init?.body).includes('CezWorkflowStart')) state = { ...todo };
      if (String(init?.body).includes('CezWorkflowAttach')) links = [];
      return response;
    });
    await expect(start()).rejects.toThrow('not confirmed');
    await expect(attach()).rejects.toThrow('not confirmed');
  });

  it('rejects incomplete attachments, unconsented binding, and unsafe URLs', async () => {
    truncated = true;
    await expect(attach()).rejects.toThrow('attachments are incomplete');
    await expect(attachTrackerWorkflowPublication(root, binding, 'https://key@host/mr/1', { env, fetcher })).rejects.toThrow('verified HTTPS');
    binding.delegateCredentials = false as unknown as true;
    await expect(start()).rejects.toThrow('Linear workflow');
    expect(mutations).toEqual([]);
  });
});
