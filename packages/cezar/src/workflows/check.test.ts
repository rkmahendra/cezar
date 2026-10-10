import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shellQuote } from '../core/shell-env.ts';
import { startCheck, CHECK_OUTPUT_CAP, type CheckExecution } from './check.ts';

let root: string;
const executions: CheckExecution[] = [];
const node = (script: string) => `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
const start = (command: string, timeout = 5000) => {
  const execution = startCheck(command, root, timeout);
  executions.push(execution);
  return execution;
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cez-check-')); });
afterEach(async () => {
  for (const check of executions) check.hardStop();
  await Promise.all(executions.splice(0).map(check => check.result));
  rmSync(root, { recursive: true, force: true });
});

describe('owned workflow checks', () => {
  it('preserves cwd, exit verdict, UTF-8 and empty-output semantics', async () => {
    expect(await start(node("process.stdout.write(process.cwd()+' 日本語'); process.exitCode=7")).result)
      .toEqual({ ok: false, exitCode: 7, output: `${root} 日本語` });
    expect(await start('true').result).toEqual({ ok: true, exitCode: 0, output: '(no output)' });
  });

  it('bounds combined stdout/stderr without changing exit status', async () => {
    const result = await start(node("process.stdout.write('x'.repeat(80000)); process.stderr.write('y'.repeat(80000))")).result;
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(CHECK_OUTPUT_CAP + 30);
    expect(result.output).toContain('output truncated');
  });

  it('reports a deadline as infrastructure failure, not an ordinary repairable exit', async () => {
    const result = await start(node('setInterval(()=>{},1000)'), 100).result;
    expect(result).toMatchObject({ ok: false, exitCode: -1, output: expect.stringContaining('timed out') });
  });

  it('settles failed spawn once and leaves no timeout behind', async () => {
    const execution = startCheck('true', join(root, 'missing'), 100);
    expect(await execution.result).toMatchObject({ ok: false, exitCode: -1, output: expect.stringContaining('failed to spawn') });
    execution.interrupt();
    execution.hardStop();
    expect(await execution.result).toMatchObject({ exitCode: -1 });
  });

  it.skipIf(process.platform === 'win32')('reaps a SIGTERM-resistant descendant before releasing its result', async () => {
    const ready = join(root, 'ready');
    const worker = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(()=>{},1000)`;
    const execution = start(`${node(worker)} & wait`);
    await expect.poll(() => existsSync(ready)).toBe(true);
    const pid = Number(readFileSync(ready, 'utf8'));
    execution.interrupt();
    const result = await execution.result;
    expect(result).toMatchObject({ ok: false, exitCode: -1, output: expect.stringContaining('cancelled') });
    await expect.poll(() => {
      try {
        // Container pid 1 may retain a reaped group's zombie; it is no longer executing.
        return process.platform === 'linux' ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] === 'Z' : (process.kill(pid, 0), false);
      } catch { return true; }
    }).toBe(true);
  });
});
