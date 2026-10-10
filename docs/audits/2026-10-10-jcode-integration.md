# Jcode integration audit, 2026-10-10

## Verdict

**Changes recommended before treating Jcode as fully reliable for unattended, mixed-backend workflows.** Core integration works, but an ACP pipe failure can crash its host, explicit model rejection falls back to an unchosen model, and several cross-layer lifecycle paths are incorrect.

Audit target: `39e428c837ea1ffa26079c08c0359bd32fb8bfd1`, cezar 0.14.0 fork. Installed CLI: Jcode `v0.93.0 (9948f0e8c)`. Checked-in wire captures: Jcode 0.91.0. Linux, Node 26.10.0. This is an audit, not a fixes release. No production source changed, no provider prompt sent by the reproductions, no real credential files read, no service changed or branch pushed.

Three independent read-only reviews covered runner/protocol, discovery/accounts/security, and cockpit/workflows. Parent verified their empty branch diffs and independently reran every reported reproduction. Shared ACP and workflow defects below are not necessarily introduced by Jcode commits. Parent also checked cost enforcement and process attribution. Findings distinguish reproducible behavior from unverified deployment consequences.

Paths and line numbers refer to the audited revision. Severity follows `CODE_REVIEW.md`; conditional cases and known limitations are labelled separately.

## Fix first

| Priority | Finding | Why it matters |
| --- | --- | --- |
| 1 | **F01: unhandled ACP stdin error** | One broken agent pipe can terminate the cezar host, affecting unrelated runs. |
| 2 | **F02: explicit model rejection still launches work** | Work can reach an unchosen provider/model with different privacy and billing properties. |
| 3 | **F03-F06: retry, takeover, dispatch and automation identity** | Displayed task history or selected engine can disagree with actual execution. |
| 4 | **F07-F10: auth, discovery isolation and spend guarantees** | Unattended work can retry broken auth, touch real tools in dry-run, expose extra environment, or exceed an unenforceable USD cap. |
| 5 | **F11-F23: protocol accuracy, edge cases and telemetry** | Close remaining correctness gaps, then improve capability visibility and regression coverage. |

## Confirmed high-impact findings

### F01. Blocker: broken ACP stdin crashes the runner host

**Location:** `packages/cezar/src/core/acp-client.ts:224-231`, `packages/cezar/src/core/jcode-acp-runner.ts:146-161`. Shared ACP transport.

A fake ACP peer reads `initialize`, closes stdin while retaining stdout, then answers initialization. The next `session/new` write raises asynchronous `EPIPE`. `try/catch` around `write()` does not catch stream error events, and neither transport nor Jcode session attaches a stdin error listener. An isolated subprocess exits **1** with `Unhandled 'error' event`, stack at `acp-client.ts:228`, before `session.result` settles. No service-level recovery handler was found. This reproduced against a fake peer, not by crashing the running cockpit.

**Fix:** transport owns writable errors, rejects pending requests and triggers bounded session cleanup. Test stdout errors as well. Preserve process-exit-aware SIGTERM/SIGKILL escalation.

### F02. Major: rejected explicit model still sends the task to the default

**Location:** `packages/cezar/src/core/jcode-acp-runner.ts:317-333`.

A `session/set_model` rejection produces only a note, then bootstrap sends `session/prompt`. Fake `-32602: unknown model` response reproduced successful task completion with no v1 error despite failed model selection. This is not merely stale UI metadata.

**Fix:** fail before sending a prompt when an explicitly requested model cannot be selected. Keep daemon-default behavior when no model was requested. Do not silently substitute providers.

### F03. Major: retries corrupt transcript turn attribution

**Location:** `packages/web/src/routes/task-thread/thread-state.ts:383-385,494-496`, `packages/web/src/api/run-events.ts:46-58`; producer `packages/cezar/src/core/acp-ui-mapper.ts:98-105,152-156,265`; retry `packages/cezar/src/workflows/run.ts:4269-4283,4360-4375`.

A workflow retry launches a fresh Jcode session under the same workflow `stepId`. Mapper IDs restart at `turn_1_msg_1`; client keys only `stepId:itemId`. Actual mapper/reducer replay of two attempts yielded:

```text
Expected:       [["first attempt"], ["second attempt"]]
v2 only:        [["second attempt"], []]
With v1 twins:  [["second attempt", "first attempt"], ["second attempt"]]
```

This is **rendering corruption, not proven on-disk history loss**. Continue using `continue-1` is a passing control because its step ID differs.

**Fix:** scope turn/item identity to session invocation across persistence, live coalescing and replay. Handle old repeated-step recordings without attributing a new `item.started` to a previous turn. Test retry plus v1 twins and reload.

### F04. Major: mixed-backend takeover pairs a session with the wrong CLI

**Location:** `packages/cezar/src/server/server.ts:4473-4483,4581-4595`; `packages/web/src/routes/task-thread/run-actions.ts:69-75,87-91`.

A task with `run.runner='claude'` and final step `{backend:'jcode', sessionId:'jcode-session'}` produces `claude --resume jcode-session`. UI marks Claude as resuming and Jcode as fresh. Server repeats the run-level runner selection with the step-owned session ID, including account lookup.

**Fix:** resolve session owner once and use `sessionStep.backend ?? run.runner ?? 'claude'` for resume CLI, provider gate, account and label. Retain intentional fresh sessions for a different target backend.

### F05. Major: dispatch runner-only override inherits an incompatible model

**Location:** `packages/cezar/src/workflows/run.ts:2193-2200,4815-4837`.

Parent Jcode model `cc/claude-opus-5-5`, child `--runner codex` without `--model`: actual dispatch method passes the parent model into the Codex child. Actual model normalization then throws `ModelIdentityError` before agent spawn. Child allocation precedes this failure. Explicit Codex model is a passing control. Dispatch-intent backend overrides share the problem.

**Fix:** inherit runner/model together. On backend change, use its default unless a compatible model was explicitly supplied. Validate explicit pairs before allocating a child/worktree.

### F06. Major: automation editor can display Jcode but save another engine

**Location:** `packages/web/src/routes/automations/editor.tsx:121-145,278-279`, `editor-draft.ts:265-276`, `editor-run-as.tsx:53-54`; `packages/web/src/components/engine-pills.tsx:78-108`; `packages/cezar/src/automations/task-template.ts:140-146`.

Project default Claude is disconnected, Jcode connected, runner untouched. Picker resolves Jcode, but `toBody(draft)` omits null runner. Occurrence resolves omitted runner back to Claude. Actual helper replay: `displayed=jcode, saved=undefined, launch=claude`. The sole usable-runner pill can be hidden. Explicit Jcode automation JSON/picker selections work.

**Fix:** serialize the engine the UI claims will run, or explicitly display dynamic project-default semantics and unavailable pinned runners. Do not freeze all dynamic defaults without preserving that user intent.

### F07. Major: daemon liveness clears a real authentication incident

**Location:** `packages/cezar/src/core/provider-auth.ts:384-392,650-654`; `packages/cezar/src/server/provider-auth-runtime.ts:55-61`.

Jcode's descriptor admits `session/new` success means daemon usability, not per-model auth. Nevertheless, runtime auth verification treats this as credential recovery. An injected command returning only a session ID changed a recorded auth failure from disconnected to connected, cleared its incident and reopened the provider action gate.

**Fix:** distinguish usable/unknown from verified auth. Do not auto-clear an authoritative runtime incident on daemon liveness alone. Keep normal unknown-auth Jcode use available. No live invalid key was tested.

### F08. Major: dry-run model discovery invokes the external Jcode binary

**Location:** `packages/cezar/src/core/jcode-model-catalog.ts:14-16`; registration `packages/cezar/src/server/server.ts:1166,1818-1820`.

With `CEZ_DRY_RUN=1`, discovery still executes `CEZ_JCODE_BIN` or `jcode acp --no-update`; unlike task launch, it has no mock branch. A recording fake executable confirmed the invocation. Missing real CLI can therefore leave an unavailable model catalog despite mocked runner availability. An installed CLI can touch daemon/session state.

**Fix:** use deterministic mock discovery in dry-run and prove the external binary is never invoked. **No prompt is sent by discovery; billed work was not demonstrated.** This differs from the documented headless mock `waiting` limitation.

### F09. Major: model discovery inherits the entire host environment

**Location:** `packages/cezar/src/core/jcode-model-catalog.ts:16`; compare `packages/cezar/src/core/jcode-acp-runner.ts:90-95` and `packages/cezar/src/core/agent-env.ts`.

Discovery omits `spawn.env`. A mock captured synthetic unrelated service and provider secrets that `buildChildEnv({backend:'jcode'})` excludes from ordinary task execution. Discovery therefore crosses a broader environment boundary and may initialize a daemon differently from the task path.

**Fix:** reuse the runner's sanitized environment. First verify cold-daemon credential needs rather than widening the allowlist indiscriminately. This proves extra child-process exposure, **not exfiltration**. The generic auth command helper also inherits host env by current policy and deserves a separate consistency review.

### F10. Major guarantee gap: USD budget cannot stop Jcode's own unreported spend

**Location:** `packages/cezar/src/core/jcode-acp-runner.ts:421-424`, `packages/cezar/src/core/acp-ui-mapper.ts:381-389,492-508`; `packages/cezar/src/workflows/run.ts:2111-2117`; `packages/cezar/src/runs/store.ts:1147-1149`.

Jcode emits token usage but no cost event. Dispatch's turn-end brake reads `run.costUsd ?? 0`; an isolated call with ten million tokens and absent cost never brakes, while reported cost above the cap does. This is inability to enforce USD spend, not proof of actual overspend in a live account. The ordinary turn-end cap is not a within-turn hard cap even on metered runners.

**Important control:** `packages/cezar/src/dispatch/engine.ts:62-80` retains the full reservation for an unknown-cost settled child. It does **not** incorrectly refund that child as free.

**Fix:** expose cost support and unknown spend honestly. Do not promise a USD ceiling without authoritative metering. Use provider-native budget support where available, or explicit conservative behavior for capped runs with unknown spend. Never invent costs or silently block uncapped zero-config use.

## Remaining reproduced defects and compatibility risks

| ID | Severity / scope | Location | Reproduction and smallest fix |
| --- | --- | --- | --- |
| F11 | Major, Jcode v1 parity | `packages/cezar/src/core/jcode-acp-runner.ts:399-430` | All six tool calls in the captured tool-lifecycle fixture retain `{title}` in v1/`AgentRunResult` while v2 receives real arguments later. Track updates and emit one meaningful v1 call per ID with correct ordering, not duplicate calls per delta. |
| F12 | Major, shared ACP validation | `packages/cezar/src/core/acp-client.ts:203-209`; `acp-ui-mapper.ts:172-187,394-404` | `{id, result:null}` for prompt becomes successful `end_turn` with no error. Validate envelopes and method response shapes before mapping success. |
| F13 | Major, runner close race | `packages/cezar/src/core/jcode-acp-runner.ts:326-338,488-497` | Calling `end()` in initial session callback still starts a phantom turn and reports `jcode exited with code 0` as failure. Gate bootstrap/pump on open and record caller-requested EOF before signal escalation. Direct-session proof, not a claim every cockpit Cancel fails. |
| F14 | Major, shared ACP robustness | `packages/cezar/src/core/acp-ui-mapper.ts:173` | Active prompt plus JSON-parsed `error:[{"toString":null}]` throws TypeError via `String(error)`. Use safe error normalization and active-state malformed tests. Mapper exception proven, separate host crash not claimed. |
| F15 | Major, discovery cleanup | `packages/cezar/src/core/jcode-model-catalog.ts:26-29` | Valid catalog returns while fake child ignores EOF/SIGTERM and remains alive. No escalation or exit wait exists. Reuse bounded exit-aware TERM/KILL cleanup, test success and failure. Repro kills only its own fake peer. |
| F16 | Minor, terminal protocol | `packages/cezar/src/core/jcode-acp-runner.ts:242-246,271` | Timeout lacks `session.ended`; second-turn interrupt ends session as `end_turn`. Derive every terminal event from actual stop reason. RunManager compensates for parts of this, so no incorrect final cockpit status asserted. |
| F17 | Minor, model metadata | `packages/cezar/src/core/acp-ui-mapper.ts:175-211`; Jcode runner `317-324` | Successful model override leaves `session.started.model` at daemon default. Publish confirmed model after selection or via update. Header does not directly consume this field. |
| F18 | Minor, deletion diff | `packages/cezar/src/core/jcode-ui-mapper.ts:51-52` | `+++ /dev/null` prevents fallback to `--- a/gone.txt`, discarding deletion preview. Treat null new-side path as deletion. Supported-format parser proof, no live deletion capture. |
| F19 | Minor, image capability edge | `packages/cezar/src/core/jcode-acp-runner.ts:178-185,459-465` | Image queued before init bypasses later `image:false`. Filter at send time after capabilities resolve. Captured Jcode 0.91 advertises image support, limiting current impact. |
| F20 | Minor, misleading permission note | `packages/cezar/src/core/jcode-acp-runner.ts:439-454` | Reject-only permission correctly selects rejection but logs `auto-approved (reject_once)`. Report actual decision or cancel when no known allow exists. No unauthorized approval demonstrated. |
| F21 | Minor, malformed catalog fallback | `packages/cezar/src/core/jcode-model-catalog.ts:33-46`; `runner-model-catalog.ts:83-86` | Nonempty malformed/grouped choices become `[]`, overwriting last-good cache as `source:'live', stale:false`. Reject incompatible nonempty lists, support groups when needed, preserve stale cache on error. No claim installed CLI emits grouped choices. |
| F22 | Conditional model-ID bug | `packages/cezar/src/core/model-identity.ts:122-147,217-243` | Opaque `Qwen/Qwen3-Coder` becomes `qwen/Qwen3-Coder`; literal `jcode/` prefix is stripped. Preserve Jcode backend ID separately from canonical namespace. String rewrite reproduced, live provider rejection not verified; lowercase fixtures still work. |
| F23 | Telemetry limitation | `packages/cezar/src/core/jcode-acp-runner.ts:146-147`; `packages/cezar/src/core/process-usage.ts:68-95`; `packages/cezar/src/workflows/run.ts:3979,4926` | Run sampling starts at adapter PID and excludes a pre-existing sibling daemon and its workers. Synthetic process-tree check proves exclusion. Label adapter-only metrics or obtain session attribution from Jcode. Do not charge all shared daemon memory to every run, or claim system memory admission is bypassed. |

## Workflow improvements, in recommended order

1. **Make engine selection exact.** Fix F02/F04/F05/F06, then show current/latest step backend and requested versus confirmed model. Current header mostly uses run-level runner/model (`packages/web/src/routes/task-thread/run-header.tsx:1002-1024`). Mixed workflows need step ownership, not another global setting.
2. **Show capabilities where users make decisions.** Jcode currently ignores `allowedTools`. A read-only review scope is prompt guidance, not an enforced sandbox. Mark unavailable spend enforcement, adapter-only metrics and invisible native subagents. Keep extra Jcode accounts disabled until home, daemon, credential and session isolation are proven.
3. **Use native prompt-free diagnostics where verified.** Jcode 0.93 help advertises `auth status --json`, `model list --json`, `provider current --json`, tool-profile/allowlist controls and provider profiles. Verify output, ACP propagation, network behavior and 0.91 compatibility before replacing session-based probes or claiming tool enforcement. No new dependency needed.
4. **One realistic offline lifecycle check.** Exercise create, split markers, delayed tool arguments, repeated-step retry, Continue, runner-only dispatch, model/auth rejection, cancel and reload through actual mapper/reducer plus fake ACP. Keep test proof red without each fix. Existing happy-path fixtures alone missed these boundaries.
5. **Expose existing per-step controls.** YAML/import/export already preserve runner/model, but workflow builder lacks corresponding controls (`packages/web/src/routes/workflows/workflows.tsx`, `packages/web/src/lib/workflow-builder.ts:29,116-117,183-187`). Small optional selectors improve mixed-engine workflows without adding configuration requirements.
6. **Explain native settings and MCP.** Provider/account rows exist; native Jcode config panel is absent. Document native config location and private project MCP path before adding raw editing. Preserve local-only write guards, secret redaction and `0600` storage.
7. **Improve worktree validation defaults.** Local package links, task-env isolation, and login-shell Node discovery must agree. Otherwise a child can typecheck the base checkout or contaminate a real task handoff while running mocks. This audit encountered both setup problems; no production fix was made.

## Working guarantees retained

- Jcode registered through runner factory, contract/schema, API, provider and model picker paths. No missing chained Jcode route found.
- Split `CEZ:DONE` remains intact through v1 text coalescing. System prompt delivery, supported images and follow-up ordering work in covered cases.
- Private MCP stdio mapping and capability-gated HTTP/SSE attach on fresh, load and failed-load fallback. Five scenario tests pass, with synthetic secrets absent from skip notes.
- Missing Jcode binary degrades to unavailable catalog, not failed boot. Shared catalog deduplicates requests and keeps stale data on thrown failures.
- Extra Jcode accounts correctly rejected. No invented account isolation promised.
- Continue uses unique step IDs and reconstructs relevant context/MCP. Do not conflate retry attribution with ordinary Continue.
- Existing handshake timeout, replay bound and exit-aware process escalation remain load-bearing. No removal recommended.
- Same-backend dispatch and explicit Jcode automation definitions are passing controls.

## Validation and evidence

### Repository gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **Pass**, all four workspaces after local package-link isolation. Initial web errors were stale base-checkout declarations, not source defects. |
| `npm test -- --maxWorkers=4` | Completed: **9,109 passed, 12 failed, 3 skipped**, 539 files. Not a clean one-shot pass. |
| Targeted rerun of all five failed files | **154 passed, 5 files**, no failures. Restored NVM Node in login shells, supplied worktree `.bin` link and allowed 30s per test. |
| `npm run test:unit` | **42 passed**. |
| `npm run build` | **Pass**, including `check:pack`: 774 files, 116 web assets. |
| `npm run test:package` | **17 passed**. |
| Real browser / live provider QA | **Not run**. No claim of live Jcode 0.93 ACP compatibility. |

The first full validation chain hit a 600-second tool limit. A later isolated full Vitest run completed. Its five failed files were `workflows/run-isolation.test.ts`, `workflows/run-lease.test.ts`, `workflows/workspace-semaphore.test.ts`, `workspace/home-safety.test.ts`, and web `routes/github/github.test.tsx`. Ten failures were login-shell `node` absence, one nested runner could not find worktree `node_modules/.bin/vitest`, and one UI test exceeded 5s. An asynchronous fixture-cleanup error accompanied the failed isolation suite. All five files passed together after environment fixes. These are not counted as new Jcode product findings.

Validation removed inherited `CEZ_API_URL`, `CEZ_BIN`, `CEZ_ENV_PASSTHROUGH`, `CEZ_HANDOFF_FILE`, `CEZ_PROJECT_ID`, `CEZ_REMOTE`, `CEZ_TASK_ID`, `CEZ_TODOS_FILE`, `CEZ_TREE_DIR`, and `ANTHROPIC_MODEL` where relevant. `NODE_OPTIONS=--no-experimental-webstorage` avoided Node 26's global `localStorage` conflict with browser tests. An ignored local `@open-mercato` link set resolved this worktree's packages, without modifying base checkout links. A scratch `BASH_ENV` supplied NVM Node to `bash -lc`.

Full local logs: `/home/rkmh/.jcode/scratch/jcode-audit-7b566b27/{typecheck-local,test-isolated,test-recheck,test-unit,build,test-package}.log`. Review notes: task-tree units `489d6c82`, `341fb230`, `bcb7c246` under root task `7b566b27-b6ef-4187-af55-0830ef86fcd7`. Read-only child branches contained no changes to merge.

### Reproduction inventory

All assertions below confirm defects exist, not that fixes have landed. Parent reran them against the audited revision. Fake peers only produce scripted ACP frames, never execute captured tool commands. Their files are retained locally under `/home/rkmh/.jcode/scratch/`:

| Script | Coverage |
| --- | --- |
| `489d6c82-epipe-check.mts` plus `epipe-repro.mts` / `broken-stdin.cjs` with the same prefix | F01, host crash isolated in subprocess. |
| `489d6c82-runner-audit.mts`, `489d6c82-fake-jcode.cjs` | F02, F11-F13, F16-F20, permission controls, actual captured tool notifications. |
| `489d6c82-malformed-mapper.mts` | F14, active-state malformed JSON error. |
| `jcode-audit-341fb230.KQ49mk/reproduce.mjs`, `mock-jcode.mjs` | F08/F09/F15/F22, grouped choices, missing binary control. |
| `jcode-audit-341fb230.KQ49mk/auth-cache-reproduce.mjs` | F07/F21, unsupported-account control. |
| `bcb7c246-workflow-repros.mjs` | F03-F06, passing Continue and explicit-selection controls. |
| `jcode-audit-7b566b27/parent-repros.mjs` | F10/F23, unknown-child reservation control. |

Local scratch artifacts are not shipped and are not permanent repository fixtures. The following small check remains runnable directly from this report with installed `tsx`, exercising three boundary defects without child processes, files, credentials or provider calls:

```bash
node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { jcodeDiffs, createJcodeUiState, mapJcodeFrame } from './packages/cezar/src/core/jcode-ui-mapper.ts';
import { normalizeModelForBackend } from './packages/cezar/src/core/model-identity.ts';
assert.equal(normalizeModelForBackend('jcode', 'Qwen/Qwen3-Coder').backendModel, 'qwen/Qwen3-Coder');
assert.equal(jcodeDiffs({ status: 'completed', rawOutput: {
  output: '```diff\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n```',
} }), undefined);
let { state } = mapJcodeFrame({ dir: 'out', frame: {
  id: 1, method: 'session/prompt', params: {},
} }, createJcodeUiState());
const reply = mapJcodeFrame({ dir: 'in', frame: { id: 1, result: null } }, state);
assert(reply.events.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn'));
console.log('Confirmed F12, F18, F22 on audited source. These assertions should change after fixes.');
JS
```

## Coverage limits and next decision

No live daemon cancellation acknowledgment, child-process ownership, cold-start provider-env propagation, slow resume replay, MCP server execution, actual provider costs, or upgraded 0.93 wire capture was tested. Parent-session failures during the audit are not attributed to F01 without matching crash evidence. Native subagent invisibility, unrestricted tools, raw think text, and headless dry-run parking were already documented in `FORK.md` and are not new discoveries.

Recommended next work: fix F01 and F02 first, then identity/lifecycle cases F03-F07 with their reproductions converted to durable regression tests. Keep these as focused changes rather than replacing the whole runner. Audit complete, defects remain unfixed by design.
