import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** ponytail: fixed 30-minute check ceiling, matching agent steps; add per-step override if needed. */
export const CHECK_TIMEOUT_MS = 30 * 60_000;
export const CHECK_OUTPUT_CAP = 20_000;
const KILL_GRACE_MS = 1_000;

export interface CheckResult { ok: boolean; output: string; exitCode: number }
export interface CheckExecution {
  readonly pid: number | undefined;
  result: Promise<CheckResult>;
  interrupt(): void;
  hardStop(): void;
}

/** A bounded local command. No agent credentials, login or network setup is performed here. */
export function startCheck(command: string, cwd: string, timeoutMs = CHECK_TIMEOUT_MS): CheckExecution {
  const child = spawn('bash', ['-lc', command], {
    cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let finished = false;
  let stopped: string | undefined;
  let output = '';
  let truncated = false;
  let timeout: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  const signal = (value: NodeJS.Signals) => {
    if (finished) return;
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, value);
      else child.kill(value);
    } catch { /* Already reaped or spawn failed. */ }
  };
  const stop = (reason: string) => {
    if (finished || stopped) return;
    stopped = reason;
    signal('SIGTERM');
    // A killed shell can leave descendants holding stdout open. Escalate the group until
    // close, not ChildProcess.killed or just the root's exit event.
    escalation = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    escalation.unref();
  };
  const append = (text: string) => {
    const room = CHECK_OUTPUT_CAP - output.length;
    if (text.length > room) truncated = true;
    output += text.slice(0, Math.max(0, room));
  };
  const result = new Promise<CheckResult>(resolve => {
    const settle = (exitCode: number, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      const text = output.trim() || '(no output)';
      resolve({ ok: !stopped && !error && exitCode === 0,
        output: error ?? `${text}${truncated ? '\n… (output truncated)' : ''}${stopped ? `\n${stopped}` : ''}`,
        exitCode: stopped || error ? -1 : exitCode });
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
      stream.on('end', () => append(decoder.end()));
    }
    child.once('error', error => settle(-1, `failed to spawn: ${error.message}`));
    child.once('close', code => {
      // A background child may have closed its pipes while remaining alive in our group.
      if (process.platform !== 'win32') signal('SIGKILL');
      settle(code ?? -1);
    });
    timeout = setTimeout(() => stop(`check timed out after ${timeoutMs}ms`), timeoutMs);
    timeout.unref();
  });
  return { pid: child.pid, result, interrupt: () => stop('check cancelled'), hardStop: () => {
    stopped ??= 'check cancelled';
    signal('SIGKILL');
  } };
}
