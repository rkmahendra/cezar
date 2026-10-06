import { spawn } from 'node:child_process';
import { AcpClient } from './acp-client.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;

/**
 * jcode's model catalog, read the way the cockpit's picker needs it: `jcode acp` answers
 * `session/new` with `configOptions[{id:'model', currentValue, options:[{name,value}]}]` (live,
 * 0.91.0), which is the list jcode's own `/model` offers. No prompt is sent, so nothing is billed.
 * The current default is listed first and marked, so "auto" and the explicit id agree.
 */
export async function discoverJcodeModels(options: { cwd: string; bin?: string } = { cwd: process.cwd() }): Promise<ModelOption[]> {
  const bin = options.bin ?? process.env.CEZ_JCODE_BIN ?? 'jcode';
  const child = spawn(bin, ['acp', '--no-update'], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const client = new AcpClient(child.stdin, child.stdout, {});
  const reading = client.run();
  const failed = new Promise<never>((_, reject) => child.once('error', reject));
  try {
    const session = await Promise.race([
      client.initialize(TIMEOUT_MS).then(() => client.newSession(options.cwd, TIMEOUT_MS)),
      failed,
    ]);
    return jcodeModelOptions(session);
  } finally {
    child.stdin.end();
    child.kill();
    void reading.catch(() => undefined);
  }
}

export function jcodeModelOptions(session: Record<string, unknown>): ModelOption[] {
  const configs = Array.isArray(session.configOptions) ? session.configOptions : [];
  const model = configs.find((c): c is Record<string, unknown> => !!c && typeof c === 'object' && (c as { id?: unknown }).id === 'model');
  if (!model || !Array.isArray(model.options)) throw new Error('jcode did not report a model list');
  const current = typeof model.currentValue === 'string' ? model.currentValue : undefined;
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const o of model.options.slice(0, MAX_MODELS)) {
    if (!o || typeof o !== 'object') continue;
    const id = typeof (o as { value?: unknown }).value === 'string' ? (o as { value: string }).value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = (o as { name?: unknown }).name;
    out.push({ id, label: typeof name === 'string' && name.trim() ? name.trim() : id, description: id === current ? 'jcode default' : '' });
  }
  // The default first, so it is the obvious pick after "auto".
  out.sort((a, b) => Number(b.id === current) - Number(a.id === current));
  return out;
}
