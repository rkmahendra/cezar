import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { shellQuote } from '../core/shell-env.ts';
import { retryableExit, type WorkflowDef, type WorkflowStepDef } from './types.ts';

const runner = vi.hoisted(() => ({ prompts: [] as string[], persistent: false }));
vi.mock('../core/runner-factory.ts', () => ({ createRunner: () => ({
  run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
  startSession: (spec: { userPrompt: string }, emit: (event: unknown) => void) => {
    runner.prompts.push(spec.userPrompt);
    let finish: (result: unknown) => void;
    let open = runner.persistent;
    return {
      get open() { return open; }, sendMessage: () => false,
      end: () => { open = false; finish({ text: 'done', toolCalls: [], tokensUsed: 0 }); },
      interrupt: () => { open = false; finish({ text: 'cancelled', toolCalls: [], tokensUsed: 0 }); },
      result: new Promise(resolve => setTimeout(() => {
        finish = resolve;
        emit({ type: 'session', sessionId: `session-${runner.prompts.length}` });
        if (runner.persistent) emit({ type: 'turn-end' });
        else resolve({ text: 'done', toolCalls: [], tokensUsed: 0 });
      }, 0)),
    };
  },
}) }));

let root: string;
let store: RunStore;
let manager: RunManager;
const node = (script: string) => `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
const terminal = async (id: string) => {
  await expect.poll(() => manager.isActive(id), { timeout: 10000 }).toBe(false);
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-workflow-recovery-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  manager = new RunManager(store, root);
  runner.prompts.length = 0;
  runner.persistent = false;
});
afterEach(async () => {
  for (const run of store.listRuns()) if (manager.isActive(run.id)) manager.cancel(run.id);
  await expect.poll(() => store.listRuns().some(run => manager.isActive(run.id))).toBe(false);
  manager.dispose(); store.flush(); rmSync(root, { recursive: true, force: true });
});

function interrupted(steps: WorkflowStepDef[], owner = 'implement') {
  const workflow: WorkflowDef = { name: 'factory', source: 'file', steps };
  const run = store.createRun({ title: 'Task', task: 'Build requested feature', workflow: workflow.name,
    steps: steps.map(step => ({ id: step.id, name: step.id, kind: step.command ? 'check' : 'agent' })) });
  store.updateRun(run.id, { status: 'failed', workflowDef: workflow, runner: 'claude', worktree: false });
  store.updateStep(run.id, owner, { status: 'failed', sessionId: 'original-session', backend: 'claude' });
  return run.id;
}

describe('factory workflow guarantees', () => {
  it('does not buy code-repair attempts for spawn, signal or timeout failures', () => {
    expect(retryableExit(undefined, -1)).toBe(false);
    expect(retryableExit([], -1)).toBe(false);
    expect(retryableExit(undefined, 0)).toBe(false);
    expect(retryableExit(undefined, 1)).toBe(true);
  });

  it('continues unfinished review and verification stages before reporting success', async () => {
    const check = join(root, 'checked');
    const id = interrupted([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'review', prompt: 'Review implemented change: {{task}}' },
      { id: 'verify', command: node(`require('node:fs').writeFileSync(${JSON.stringify(check)}, 'passed')`) },
    ]);
    expect(manager.continueRun(id, { text: 'Finish implementation' })).toEqual({ ok: true });
    await terminal(id);
    expect(runner.prompts).toHaveLength(2);
    expect(runner.prompts[0]).toBe('Finish implementation');
    expect(runner.prompts[1]).toContain('Review implemented change: Build requested feature');
    expect(runner.prompts[1]).toContain('step 2 of 2');
    expect(readFileSync(check, 'utf8')).toBe('passed');
    expect(store.getRun(id)?.steps.filter(step => ['implement', 'review', 'verify'].includes(step.id)).every(step => step.status === 'done')).toBe(true);
    expect(store.getRun(id)?.status).toBe('done');
  });

  it('reruns declared checks after every revision and never promotes failed verification to done', async () => {
    const gate = join(root, 'gate');
    writeFileSync(gate, 'fail');
    const id = interrupted([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: node(`process.exit(require('node:fs').readFileSync(${JSON.stringify(gate)}, 'utf8') === 'pass' ? 0 : 1)`) },
    ]);
    expect(manager.continueRun(id, { text: 'First revision' }).ok).toBe(true);
    await terminal(id);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.status).toBe('failed');
    writeFileSync(gate, 'pass');
    expect(manager.continueRun(id, { text: 'Second revision' }).ok).toBe(true);
    await terminal(id);
    expect(store.getRun(id)?.status).toBe('done');
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.iterations).toBe(2);
  });

  it('recovers a running workflow without skipping its pending checks', async () => {
    const marker = join(root, 'recovered-check');
    const id = interrupted([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: node(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'checked')`) },
    ]);
    store.updateRun(id, { status: 'running' });
    store.updateStep(id, 'implement', { status: 'running' });
    await manager.recover();
    await terminal(id);
    expect(readFileSync(marker, 'utf8')).toBe('checked');
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.status).toBe('done');
  });

  it('uses the existing bounded repair loop after a resumed stage fails validation', async () => {
    const id = interrupted([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'verify', command: 'printf failing-check; exit 1', onFail: { retry: 'implement', max: 1 } },
    ]);
    expect(manager.continueRun(id, { text: 'Fix it' }).ok).toBe(true);
    await terminal(id);
    expect(runner.prompts).toHaveLength(2);
    expect(runner.prompts[1]).toContain('failing-check');
    expect(store.getRun(id)?.status).toBe('failed');
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.iterations).toBe(2);
  });

  it('closes a resumed intermediate session at turn-end so the next check can run', async () => {
    runner.persistent = true;
    const id = interrupted([{ id: 'implement', prompt: '{{task}}' }, { id: 'verify', command: 'true' }]);
    expect(manager.continueRun(id, { text: 'Finish implementation' }).ok).toBe(true);
    await terminal(id);
    expect(store.getRun(id)?.status).toBe('done');
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.status).toBe('done');
  });

  it('selects the latest executed workflow stage after the synthetic continuation', async () => {
    const id = interrupted([
      { id: 'implement', prompt: '{{task}}' },
      { id: 'review', prompt: 'Review requested change' },
      { id: 'verify', command: 'true' },
    ]);
    expect(manager.continueRun(id, { text: 'Finish work' }).ok).toBe(true);
    await terminal(id);
    expect(manager.continueRun(id, { text: 'Revise review' }).ok).toBe(true);
    await terminal(id);
    expect(store.getRun(id)?.steps.find(step => step.id === 'continue-2')?.workflowStepId).toBe('review');
    expect(runner.prompts).toHaveLength(3);
    expect(store.getRun(id)?.steps.find(step => step.id === 'verify')?.iterations).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('holds the cancelled check slot until its process tree is reaped', async () => {
    const ready = join(root, 'check-ready');
    const run = manager.startRun({ name: 'verify', source: 'file', steps: [{ id: 'verify', command: node(`process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(()=>{},1000)`) }] }, { task: 'verify', worktree: false });
    await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
    expect(manager.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)?.status).toBe('cancelled');
    expect(manager.isActive(run.id)).toBe(true);
    await terminal(run.id);
    expect(store.getRun(run.id)?.status).toBe('cancelled');
  });

  it('caps collected check output even when one write exceeds the entire limit', async () => {
    const state = { cwd: root, cancelled: false, interrupt: () => {} };
    const events: unknown[] = [];
    const result = await (manager as unknown as { runCheckStep(state: unknown, step: WorkflowStepDef, emit: (event: unknown) => void): Promise<{ output: string }> })
      .runCheckStep(state, { id: 'verify', command: node("process.stdout.write('x'.repeat(100000))") }, event => events.push(event));
    expect(result.output.length).toBeLessThanOrEqual(20030);
    expect(result.output).toContain('output truncated');
  });
});
