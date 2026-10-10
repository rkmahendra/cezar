import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from './agent-runner.ts';
import type { AcpMessage } from './acp-client.ts';
import { JcodeAcpRunner } from './jcode-acp-runner.ts';
import type { PrivateMcpServer } from './private-mcp.ts';
import type { UiEvent } from './ui-events.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';

// A stand-in `jcode acp` that streams the reply in small chunks, as the real 0.91.0 does
// (live run: "...log was updated.\n\nCE" + "Z:DONE"). Pins the regression where per-delta v1
// `text` events let the engine join them as `CE\nZ:DONE`, so a finished run parked at `waiting`.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('mock-config.json', 'utf8'));
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const chunk = (t) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
let turn = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync('requests.ndjson', line + '\\n');
  if (m.method === 'initialize') {
    if (config.brokenStdin) {
      rl.close();
      process.stdin.destroy();
      try { fs.closeSync(0); } catch {}
      setInterval(() => {}, 1000);
      setTimeout(() => send({ id: m.id, result: { protocolVersion: 1 } }), 100);
    } else send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: config.capabilities ?? {} } });
  }
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
  else if (m.method === 'session/load') {
    if (config.failLoad) send({ id: m.id, error: { code: -32602, message: 'session not found' } });
    else {
      send({ id: m.id, result: {} });
      send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
    }
  }
  else if (m.method === 'session/set_model') setTimeout(() => send(config.failModel
    ? { id: m.id, error: { code: -32602, message: 'unknown model' } }
    : { id: m.id, result: {} }), config.modelDelay ?? 0);
  else if (m.method === 'session/prompt') {
    turn++;
    if (config.exitDuringPrompt) process.exit(0);
    if (config.holdPrompt || (config.holdSecond && turn === 2)) { chunk('Working'); return; }
    for (const t of ['Did it.', '\\n\\nCE', 'Z:DONE']) chunk(t);
    if (!config.closeBeforeResponse) send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } });
  }
});
rl.on('close', () => { if (!config.brokenStdin) process.exit(0); });
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeRunner(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-jcode-fake-'));
  dirs.push(dir);
  const bin = join(dir, 'jcode');
  writeFileSync(join(dir, 'mock-config.json'), JSON.stringify(config));
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    runner: new JcodeAcpRunner({ bin }),
    requests: (): AcpMessage[] => readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
  };
}

it('emits one whole v1 text block per message, so a split CEZ:DONE stays intact', async () => {
  const { dir, runner, requests } = fakeRunner();
  const texts: string[] = [];
  const events: AgentEvent[] = [];
  const result = await runner.run({ userPrompt: 'go', cwd: dir }, (e: AgentEvent) => {
    events.push(e);
    if (e.type === 'text') texts.push(e.text);
  });
  expect(texts).toEqual(['Did it.\n\nCEZ:DONE']);
  expect(result.text).toBe('Did it.\n\nCEZ:DONE');
  expect(result.tokensUsed).toBe(5);
  expect(requests().find((m) => m.method === 'session/new')?.params).toEqual({ cwd: dir, mcpServers: [] });
  expect(events.filter((e) => e.type === 'note')).toEqual([]);
});

it.each(['jcode', 'copilot'] as const)('contains a broken stdin and terminates the %s peer without timing out', async (backend) => {
  const { dir, bin } = fakeRunner({ brokenStdin: true });
  const runner = backend === 'jcode' ? new JcodeAcpRunner({ bin }) : new CopilotAcpRunner({ bin });
  const events: AgentEvent[] = [];
  await runner.run({ cwd: dir, userPrompt: 'go', timeoutMs: 2500 }, (e) => events.push(e));
  expect(events).toContainEqual({ type: 'error', message: expect.stringMatching(/^ACP transport failed:/) });
  expect(events.some((e) => e.type === 'error' && e.message.includes('timed out'))).toBe(false);
});

it('still reports an unsolicited clean exit during a prompt as failure', async () => {
  const { dir, runner } = fakeRunner({ exitDuringPrompt: true });
  const events: AgentEvent[] = [];
  await runner.run({ cwd: dir, userPrompt: 'go' }, (e) => events.push(e));
  expect(events).toContainEqual({ type: 'error', message: 'jcode exited with code 0' });
});

it('emits a timeout terminal event', async () => {
  const { dir, runner } = fakeRunner({ holdPrompt: true });
  const ui: UiEvent[] = [];
  await runner.startSession({ cwd: dir, userPrompt: 'go', timeoutMs: 500 }, undefined, { onUiEvent: (e) => ui.push(e) }).result;
  expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'timeout' });
});

it('keeps cancellation as the terminal reason after an earlier successful turn', async () => {
  const { dir, runner } = fakeRunner({ holdSecond: true });
  const ui: UiEvent[] = [];
  const session = runner.startSession({ cwd: dir, userPrompt: 'first' }, undefined, { onUiEvent: (e) => ui.push(e) });
  try {
    await vi.waitFor(() => expect(ui.some((e) => e.type === 'turn.completed')).toBe(true));
    session.sendMessage([{ type: 'text', text: 'second' }]);
    await vi.waitFor(() => expect(ui.some((e) => e.type === 'item.delta' && e.delta === 'Working')).toBe(true));
    session.interrupt();
    await session.result;
    expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'cancelled' });
  } finally {
    if (session.open) session.interrupt();
    await session.result;
  }
});

it.each([false, true])('never prompts after explicit model rejection (resume=%s)', async (resume) => {
  const { dir, runner, requests } = fakeRunner({ failModel: true, capabilities: { loadSession: true } });
  const events: AgentEvent[] = [];
  await runner.run({ cwd: dir, userPrompt: 'private task', model: 'requested-model', ...(resume ? { resume, sessionId: 's1' } : {}) }, (e) => events.push(e));
  expect(events).toContainEqual({ type: 'error', message: 'jcode could not select requested model: unknown model' });
  expect(requests().some((m) => m.method === 'session/prompt')).toBe(false);
});

it('does not start a prompt after end during bootstrap', async () => {
  const { dir, runner, requests } = fakeRunner();
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  let session: AgentSession;
  session = runner.startSession({ cwd: dir, userPrompt: 'go' }, (e) => {
    events.push(e);
    if (e.type === 'session') session.end();
  }, { onUiEvent: (e) => ui.push(e) });
  await session.result;
  expect(requests().some((m) => m.method === 'session/prompt')).toBe(false);
  expect(ui.some((e) => e.type === 'turn.started')).toBe(false);
  expect(events.some((e) => e.type === 'error')).toBe(false);
  expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
});

it('holds follow-ups until explicit model selection succeeds', async () => {
  const { dir, runner, requests } = fakeRunner({ failModel: true, modelDelay: 200 });
  const session = runner.startSession({ cwd: dir, userPrompt: 'first', model: 'requested-model' });
  try {
    await vi.waitFor(() => expect(requests().some((m) => m.method === 'session/set_model')).toBe(true));
    session.sendMessage([{ type: 'text', text: 'follow-up' }]);
    await session.result;
    expect(requests().some((m) => m.method === 'session/prompt')).toBe(false);
  } finally {
    if (session.open) session.interrupt();
    await session.result;
  }
});

it('settles graceful EOF during a streamed completion without a false failure', async () => {
  const { dir, runner } = fakeRunner({ closeBeforeResponse: true });
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  let session: AgentSession;
  session = runner.startSession({ cwd: dir, userPrompt: 'go' }, (e) => events.push(e), {
    onUiEvent: (e) => {
      ui.push(e);
      if (e.type === 'item.delta' && e.delta.includes('Z:DONE')) session.end();
    },
  });
  await session.result;
  expect(events.some((e) => e.type === 'error')).toBe(false);
  expect(ui.at(-1)).toEqual({ type: 'session.ended', reason: 'end_turn' });
});

it('does not pump queued follow-ups after a turn-end callback closes the session', async () => {
  const { dir, runner, requests } = fakeRunner();
  const events: AgentEvent[] = [];
  let session: AgentSession;
  session = runner.startSession({ cwd: dir, userPrompt: 'first' }, (e) => {
    events.push(e);
    if (e.type === 'turn-end') session.end();
  });
  session.sendMessage([{ type: 'text', text: 'queued' }]);
  await session.result;
  expect(requests().filter((m) => m.method === 'session/prompt')).toHaveLength(1);
  expect(events.some((e) => e.type === 'error')).toBe(false);
});

const SERVERS: PrivateMcpServer[] = [
  { name: 'local', transport: 'stdio', command: 'node', args: ['private-mcp.js'], env: { TOKEN: 'local-secret' }, headers: {} },
  { name: 'http', transport: 'http', url: 'https://example.com/mcp', args: [], env: {}, headers: { Authorization: 'Bearer http-secret' } },
  { name: 'sse', transport: 'sse', url: 'https://example.com/sse', args: [], env: {}, headers: { Authorization: 'Bearer sse-secret' } },
];
const WIRE_SERVERS = [
  { name: 'local', command: 'node', args: ['private-mcp.js'], env: [{ name: 'TOKEN', value: 'local-secret' }] },
  { name: 'http', type: 'http', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer http-secret' }] },
  { name: 'sse', type: 'sse', url: 'https://example.com/sse', headers: [{ name: 'Authorization', value: 'Bearer sse-secret' }] },
];

it.each([
  { mode: 'fresh', mcpCapabilities: {}, accepted: [0], skipped: ['http', 'sse'] },
  { mode: 'fresh', mcpCapabilities: { http: true }, accepted: [0, 1], skipped: ['sse'] },
  { mode: 'resume', mcpCapabilities: { sse: true }, accepted: [0, 2], skipped: ['http'] },
  { mode: 'resume', mcpCapabilities: { http: true, sse: true }, accepted: [0, 1, 2], skipped: [] },
  { mode: 'failed resume', mcpCapabilities: { http: true, sse: true }, accepted: [0, 1, 2], skipped: [] },
])('attaches private MCP on $mode with advertised transports $mcpCapabilities', async ({ mode, mcpCapabilities, accepted, skipped }) => {
  const { dir, runner, requests } = fakeRunner({ capabilities: { loadSession: true, mcpCapabilities }, failLoad: mode === 'failed resume' });
  const events: AgentEvent[] = [];
  const result = await runner.run({
    userPrompt: 'go', cwd: dir, model: 'test-model', mcpServers: SERVERS,
    ...(mode === 'fresh' ? {} : { resume: true, sessionId: 's1' }),
  }, (e) => events.push(e));
  const frames = requests();
  const launches = frames.filter((m) => m.method === 'session/new' || m.method === 'session/load');
  expect(launches.map((m) => m.method)).toEqual(mode === 'fresh' ? ['session/new'] : mode === 'resume' ? ['session/load'] : ['session/load', 'session/new']);
  for (const launch of launches) {
    expect(launch.params).toEqual({
      cwd: dir, mcpServers: accepted.map((index) => WIRE_SERVERS[index]),
      ...(launch.method === 'session/load' ? { sessionId: 's1' } : {}),
    });
  }
  const notes = events.filter((e) => e.type === 'note').map((e) => e.message);
  expect(notes.filter((message) => message.startsWith('private MCP:'))).toEqual(skipped.length
    ? [`private MCP: jcode cannot attach ${skipped.join(', ')} — the CLI did not advertise that MCP transport`]
    : []);
  expect(notes.join('\n')).not.toContain('secret');
  expect(events.filter((e) => e.type === 'error')).toEqual([]);
  expect(frames.find((m) => m.method === 'session/set_model')?.params).toEqual({ sessionId: 's1', modelId: 'test-model' });
  expect(frames.findIndex((m) => m.method === 'session/set_model')).toBeLessThan(frames.findIndex((m) => m.method === 'session/prompt'));
  expect(result.sessionId).toBe('s1');
  expect(result.text).toBe('Did it.\n\nCEZ:DONE');
});
