/**
 * Jcode's ACP dialect, over the shared `acp-ui-mapper.ts` (fork-local runner, see FORK.md).
 *
 * Read off a live `jcode acp` capture (jcode 0.91.0, 2026-10-06; `__fixtures__/jcode/`):
 *  - a tool is announced `pending`, then a burst of bare `tool_call_update`s while the model
 *    streams arguments, then `in_progress` with `rawInput`, then `completed`/`failed`;
 *  - `title` is jcode's tool NAME for its own tools (`todo`, `swarm`, `subagent`) and prose for
 *    the built-ins (`Writing file`, `Running shell command`);
 *  - the plan is the `todo` tool's `rawInput.todos`, never an ACP `plan` update;
 *  - diffs are a ```diff block inside the file tools' text output, not ACP `diff` parts;
 *  - per-turn token counts arrive on the `session/prompt` result in standard ACP shape, so no
 *    usage hook; `usage_update` is a context gauge `{used,size}` and stays unmapped;
 *  - no `agent_thought_chunk` exists in the 0.91.0 binary, and no parent attribution: a spawned
 *    subagent/swarm worker runs in its own daemon session, invisible on this wire.
 */
import { createAcpUiState, mapAcpFrame, type AcpDialect, type AcpUiMapperState, type AcpUiMapping } from './acp-ui-mapper.ts';
import type { FileDiff, PlanEntry, PlanStatus } from './ui-events.ts';

const DELEGATION_TOOLS = new Set(['subagent', 'swarm', 'task']);
const PLAN_STATUSES = new Set<PlanStatus>(['pending', 'in_progress', 'completed', 'cancelled']);

export function jcodeToolName(update: Record<string, unknown>): string {
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  // A single lowercase word is jcode's own tool name; prose titles fall back to the ACP kind.
  if (/^[a-z_][a-z0-9_]*$/.test(title)) return title;
  return typeof update.kind === 'string' && update.kind ? update.kind : 'tool';
}

function jcodePlan(name: string, update: Record<string, unknown>): PlanEntry[] | undefined {
  if (name !== 'todo' || !isRecord(update.rawInput) || !Array.isArray(update.rawInput.todos)) return undefined;
  const entries: PlanEntry[] = [];
  for (const todo of update.rawInput.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string' || !todo.content.trim()) continue;
    const status = PLAN_STATUSES.has(todo.status as PlanStatus) ? (todo.status as PlanStatus) : 'pending';
    const priority = todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low' ? todo.priority : undefined;
    entries.push({ content: todo.content, status, ...(priority ? { priority } : {}) });
  }
  return entries;
}

/**
 * jcode's file tools end their output with "File diff:\n```diff\n--- a/x\n+++ b/x\n...```" (live,
 * 0.91.0). Lift each fenced block into a unified `FileDiff`; the path is the `+++` side (or `---`
 * for a deletion). No fence, no diff.
 */
export function jcodeDiffs(update: Record<string, unknown>): FileDiff[] | undefined {
  if (update.status !== 'completed' || !isRecord(update.rawOutput) || typeof update.rawOutput.output !== 'string') return undefined;
  const diffs: FileDiff[] = [];
  for (const [, unified] of update.rawOutput.output.matchAll(/```diff\n([\s\S]*?)```/g)) {
    const path = /^\+\+\+ (?:b\/)?(.+)$/m.exec(unified!)?.[1] ?? /^--- (?:a\/)?(.+)$/m.exec(unified!)?.[1];
    if (path && path !== '/dev/null') diffs.push({ path, oldText: null, unified: unified! });
  }
  return diffs.length > 0 ? diffs : undefined;
}

export const jcodeDialect: AcpDialect = {
  backend: 'jcode',
  toolNameOf: jcodeToolName,
  toolKindOf: (name) => (DELEGATION_TOOLS.has(name) ? 'task' : undefined),
  // `pending` is jcode's "model started emitting this call" — it is already running.
  toolStatusOf: (update, previous) => (update.status === 'pending' ? previous ?? 'running' : undefined),
  planFromToolCall: jcodePlan,
  diffsOf: jcodeDiffs,
};

export function createJcodeUiState(): AcpUiMapperState {
  return createAcpUiState();
}

export function mapJcodeFrame(frame: unknown, state: AcpUiMapperState): AcpUiMapping {
  return mapAcpFrame(frame, state, jcodeDialect);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
