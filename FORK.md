# FORK.md: rkmh integration branch

`rkmh` consolidates the former `jcode-runner` and `cez/b71d26c5` branches. It adds
`jcode` as a cezar agent backend, driven through `jcode acp` (Agent Client Protocol
over stdio), plus GitLab/enterprise forge connections and opt-in Linear forge
writeback. See [forge connections](docs/forge-connections.md) and
[Linear forge workflow](docs/linear-forge-workflow.md).

`origin` is the fork (`rkmahendra/cezar`); `upstream` is the original repository
(`open-mercato/cezar`). `main` stays a clean upstream mirror.
Updates flow from upstream into `rkmh`; fork work is pushed only to `origin`, not
submitted as pull requests to the original repository.

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

Jcode also receives private project MCP servers through ACP `session/new` and
`session/load`, including Continue and resume fallback. HTTP/SSE transports follow
the CLI's advertised capabilities. Wire behavior is mock-tested, not live-verified.

The [2026-10-10 integration audit](docs/audits/2026-10-10-jcode-integration.md)
records remaining defects and workflow opportunities. Its first follow-up contains
ACP stream errors instead of crashing the host, stops on rejected explicit model
selection, and preserves successful caller-requested session closure. These paths
have fake-peer regression coverage, not a live-provider verification claim.

## Reinstall the running cezar from this checkout

```bash
scripts/reinstall-fork.sh          # build, npm i -g, sudo systemctl restart cezar, health check
scripts/reinstall-fork.sh --force  # skip the "no active runs" guard
```

Undo: `npm i -g cezar-run && sudo systemctl restart cezar`.

### Service setup on this host (systemd drop-in, not in git)

`/etc/systemd/system/cezar.service.d/default-project.conf` does three things:

- sets the default project to `~/projects/dev0`;
- sources `~/.config/crab9.env`, which holds jcode's provider key;
- forwards `CRAB9_*` to agents with `CEZ_ENV_PASSTHROUGH`.

Remove the drop-in and run `sudo systemctl daemon-reload && sudo systemctl restart cezar` to revert.

## Staying up to date

```bash
git fetch upstream main
git switch main && git merge --ff-only upstream/main
git switch rkmh && git merge --no-ff --no-commit main
npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package
git commit -m "Merge upstream main into rkmh"
git push -u origin rkmh
```

If the shell exports `ANTHROPIC_MODEL`, run validation commands with
`env -u ANTHROPIC_MODEL` so host model choices do not override test fixtures.

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
