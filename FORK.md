# FORK.md: jcode runner fork

This fork adds `jcode` as a cezar agent backend, driven through `jcode acp` (Agent Client
Protocol over stdio). Everything else tracks upstream `open-mercato/cezar`.

## What the fork adds

New files (upstream never touches them, so they never conflict):

- `packages/cezar/src/core/jcode-acp-runner.ts`: the runner, a structural copy of `copilot-acp-runner.ts`
- `packages/cezar/src/core/jcode-ui-mapper.ts`: the jcode ACP dialect (tool names, `todo` as the plan, ```diff blocks as diffs)
- `packages/cezar/src/core/jcode-ui-mapper.test.ts` + `__fixtures__/jcode/`: live-captured golden fixtures (jcode 0.91.0)

One-line additions in shared files (where a merge conflict can happen): every place that lists
the runners, next to `copilot`. Find them all with:

```bash
git grep -n "jcode" -- packages ':!packages/cezar/src/core/jcode-*' ':!**/__fixtures__/jcode/*'
```

The one non-list change in a shared file is the optional `diffsOf` hook in `core/acp-ui-mapper.ts`.

## Staying up to date

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main   # main stays a clean mirror
git checkout jcode-runner && git merge main              # or: git rebase main
npm run typecheck && npm test -- packages/cezar/src/core/jcode-ui-mapper packages/cezar/src/core/ui-parity
```

Conflict rule: when upstream adds runner X where `jcode` sits, keep both (`'copilot', 'X', 'jcode'`).
If upstream adds a new `Record<RunnerId, …>` map, typecheck fails until it gets a `jcode` entry. That
is the checklist.

## Known limits (jcode 0.91.0)

- `jcode acp` ignores `-m`, so the runner sets the model with `session/set_model`.
- No reasoning stream (`agent_thought_chunk`) and no sub-agent nesting on the wire. Spawned
  workers run in their own daemon session.
- `allowedTools` is not honored: jcode runs its tools unrestricted, like Codex and OpenCode in cezar.
- Dry-run (`CEZ_DRY_RUN=1`) reuses the Copilot ACP mock. A turn maps through the jcode dialect
  (detection, text, tool, plan and usage all verified). Headless `cezar run` in dry-run parks at
  `waiting`, because the mock never says `CEZ:DONE`. Upstream `copilot` does exactly the same, so
  this is mock behavior, not a jcode bug. Use the cockpit for dry-run.
- Guard tests: `jcode-ui-mapper.test.ts` (wire), `jcode-acp-runner.test.ts` (whole-block v1
  text, so a streamed `CEZ:DONE` closes the run) and `server/jcode-runner-api.test.ts`
  (`POST /runs` accepts `runner: jcode`).
- Verified live on jcode 0.91.0: `cezar run` with `defaultRunner: "jcode"` writes the file in the
  task worktree and the run ends `done` (exit 0). Continue/resume keeps context. Cancel settles
  in under 10 ms as `cancelled`.
- Some models' raw `<think>` text reaches the transcript as plain text, because jcode sends it
  inside `agent_message_chunk`. This is a jcode-side behavior; cezar does not strip it.
- Recapture fixtures after a jcode upgrade changes the wire:
  `CEZ_UPDATE_FIXTURES=1 npm test -- jcode-ui-mapper`, then review the diff.
