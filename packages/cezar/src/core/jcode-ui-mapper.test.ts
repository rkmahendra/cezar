import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UiEvent } from './ui-events.ts';
import { createJcodeUiState, jcodeDiffs, jcodeToolName, mapJcodeFrame } from './jcode-ui-mapper.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'jcode');

function replay(name: string): UiEvent[] {
  let state = createJcodeUiState();
  const events: UiEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8').trim().split('\n')) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if ('fixture' in value) continue;
    const mapped = mapJcodeFrame(value, state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

const NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -'.ndjson'.length)).sort();
const tools = (events: UiEvent[]) =>
  events.flatMap((e) => (e.type === 'item.completed' && e.item.kind === 'tool' ? [e.item] : []));

describe('jcode acp → v2 golden fixtures', () => {
  for (const name of NAMES) {
    it(`maps ${name} exactly`, () => {
      const path = join(FIXTURES, `${name}.expected.json`);
      // Regenerate after a deliberate mapper change: CEZ_UPDATE_FIXTURES=1 npm test -- jcode-ui-mapper
      if (process.env.CEZ_UPDATE_FIXTURES === '1') writeFileSync(path, `${JSON.stringify(replay(name), null, 2)}\n`);
      expect(replay(name)).toStrictEqual(JSON.parse(readFileSync(path, 'utf8')));
    });
  }

  it('reads the todo tool as the plan, in order, ending all completed', () => {
    const plans = replay('tool-lifecycle').filter((e) => e.type === 'plan.updated');
    expect(plans.length).toBeGreaterThanOrEqual(2);
    const last = plans.at(-1)!;
    expect(last.type === 'plan.updated' && last.entries.map((e) => e.status)).toEqual(['completed', 'completed']);
  });

  it('classifies tools: shell is execute, swarm is a task, a missing file read fails', () => {
    expect(tools(replay('tool-lifecycle')).some((t) => t.toolKind === 'execute' && t.status === 'completed')).toBe(true);
    expect(tools(replay('subagent')).some((t) => t.name === 'swarm' && t.toolKind === 'task')).toBe(true);
    expect(tools(replay('tool-failed')).some((t) => t.status === 'failed')).toBe(true);
  });

  it('lifts the ```diff block of a file tool into a unified diff', () => {
    const edits = tools(replay('tool-lifecycle')).filter((t) => t.toolKind === 'edit');
    expect(edits.map((t) => t.diffs?.[0]?.path)).toEqual(['hello.txt', 'hello.txt']);
    expect(edits[1]!.diffs![0]!.unified).toContain('+hello');
    expect(jcodeDiffs({ status: 'completed', rawOutput: { output: 'no fence' } })).toBeUndefined();
  });

  it('names tools from a bare-word title, else the ACP kind', () => {
    expect(jcodeToolName({ title: 'todo', kind: 'other' })).toBe('todo');
    expect(jcodeToolName({ title: 'Running shell command', kind: 'execute' })).toBe('execute');
    expect(jcodeToolName({})).toBe('tool');
  });

  it('never throws on malformed frames', () => {
    let state = createJcodeUiState();
    for (const frame of [null, 1, 'x', {}, { dir: 'in' }, { dir: 'in', frame: { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', title: 'todo', rawInput: { todos: 'nope' } } } } }]) {
      state = mapJcodeFrame(frame, state).state;
    }
  });
});
