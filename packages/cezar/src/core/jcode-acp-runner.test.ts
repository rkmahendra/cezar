import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { JcodeAcpRunner } from './jcode-acp-runner.ts';

// A stand-in `jcode acp` that streams the reply in small chunks, as the real 0.91.0 does
// (live run: "...log was updated.\n\nCE" + "Z:DONE"). Pins the regression where per-delta v1
// `text` events let the engine join them as `CE\nZ:DONE`, so a finished run parked at `waiting`.
const FAKE = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const chunk = (t) => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's1' } });
  else if (m.method === 'session/prompt') {
    for (const t of ['Did it.', '\\n\\nCE', 'Z:DONE']) chunk(t);
    send({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } });
  }
});
rl.on('close', () => process.exit(0));
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

it('emits one whole v1 text block per message, so a split CEZ:DONE stays intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-jcode-fake-'));
  dirs.push(dir);
  const bin = join(dir, 'jcode');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const texts: string[] = [];
  const result = await new JcodeAcpRunner({ bin }).run({ userPrompt: 'go', cwd: dir }, (e: AgentEvent) => {
    if (e.type === 'text') texts.push(e.text);
  });
  expect(texts).toEqual(['Did it.\n\nCEZ:DONE']);
  expect(result.text).toBe('Did it.\n\nCEZ:DONE');
  expect(result.tokensUsed).toBe(5);
});
