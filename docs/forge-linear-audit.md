# GitHub, GitLab and Linear workflow audit

Audited 2026-10-08 against fork base `39e428c8`. Verification uses mocked vendor APIs and temporary local Git repositories. No live vendor mutation, remote push, deployment or credential change is part of this audit.

## Findings and corrections

| Area | Finding | Correction |
| --- | --- | --- |
| GitHub publication | Stored task branch could differ from actual checkout; autosave happened before destination/base checks. | Validate actual symbolic HEAD, origin/push destination and vendor default/target before autosave. Refuse detached/default/base checkouts. |
| GitHub retry | Failed or timed-out creation could leave a published PR unrecorded. | Look up matching open PR first and read back after creation. Reuse existing PR without changing human-selected draft state. |
| GitLab publication | Default/base/destination rejection could occur after autosave. | Read-only preflight before autosave, shared strict remote parsing and verified MR identity. |
| Git push | Ambient push defaults could publish another branch, tags, submodules or GitLab auto-merge options. | Explicit current-branch refspec, chosen remote, no tags/submodule recursion, cleared `push.pushOption`. No force push. |
| Commit | `git add -A` could clear unresolved index conflicts. | Refuse unmerged paths before staging. |
| Review API | Concurrent publication, commit, push, Continue or cleanup could race. | Checkout-scoped request exclusion, running-agent guard and task base/default branch preflight. Idle waiting-session commit/push remain supported. |
| Error guidance | Failed draft publication suggested `git merge`. | Offer read-only `git status --short`, never merge guidance from publication consent. |
| GitLab refresh | Explicit refresh reused stale availability result. | Refresh both availability and list, contain probe errors. |
| Code hosting UI | Connection reload left navigation/provider caches stale. | Reconcile project/health identity and invalidate scoped forge/repository data without background vendor listing from Settings. |
| Multi-project UI | Palette could use boot project's forge for another project. | Resolve active project's forge. |
| GitLab references | MR chips said PR, queried GitHub numeric status or synthesized invalid GitHub links. | MR labeling and GitLab `!number`, suppress GitHub-only lookup/link synthesis. |
| GitLab details | Unsupported conversation/change actions appeared available. | Keep supported list/search/handoff, link to GitLab for unsupported hosted review features. |
| Review controls | UI mutations could overlap within one view. | Disable competing actions and prevent closing commit dialog during mutation. |
| Linear start | Agent-only instructions did not ensure In Progress before implementation. | Explicitly authorized runs now revalidate identity, discover actual state, update/read back before spawn and persist a start receipt. Continue does not regress state. |
| Linear automation | Existing credential delegation did not authorize deterministic server writes. | Separate optional `task.linearWorkflow` consent, limited to single-variant Linear automations, exposed in UI and CLI JSON. Existing definitions remain unchanged. |
| Publication link | Cockpit draft button never updated the Linear issue. | Attach only verified forge outcome URL with bounded identity checks and duplicate detection. Linking failure leaves publication intact and emits a controlled retry note. |

## Supported review and publication flow

1. Connect repository `origin` and authenticate matching CLI on cezar's server: `gh` for GitHub/Enterprise, `glab` for GitLab/self-managed. Git transport credentials remain separate from API login.
2. Use Project Settings, Code hosting to inspect identity and explicitly test repository read access. A passing test does not prove push permission.
3. Connect Linear team separately in Issue tracker. Launch a manually reviewed issue or configure existing tracker automation for `issue.opened`, with optional label filters. Automations start paused unless explicitly enabled and never launch the pre-enable backlog.
4. Keep task isolated in its worktree. Review changes/tests, request another fix through Send back or Continue, then commit/push or explicitly publish a draft PR/MR.
5. Publication reuses an existing matching open request rather than duplicating it. It never merges. A cezar task marked Done is not a Linear issue marked Done.

## Deliberate limits

- GitLab conversation, detailed pipelines, hosted changed-file review and merge remain in GitLab's own UI. Local task changes/review/fix/commit/push/draft MR are supported. GitHub event automations are not GitLab event automations. Linear intake works independently of forge.
- Custom forge hosts must be identified by matching CLI's local host inventory. Unknown hosts remain plain Git, not guessed from hostname.
- Local branch guard sees configured base, native `origin/HEAD`, `main` and `master`. An unknown custom default absent local metadata is checked by vendor API during publication.
- Request exclusion covers one cockpit process. Another terminal or process can still change a repository concurrently. Native Git locks apply, but this is not a cross-process repository sandbox.
- No certification of live account scopes, private installations or push permission. Those require explicit tests with target account and repository.

## Validation

Final integrated validation, 2026-10-10:

- `npm run typecheck`: all workspaces passed.
- `npm test`: all 543 test files accounted for across workspace and remainder runs, with 542 passing files and one existing opt-in smoke suite skipped. Deduplicated results: server 4,683 passed, cockpit 4,474 passed, API client 45 passed (9,202 total), plus three skipped smoke tests.
- Full commands hit the environment's 600-second process cap. Unfinished files were enumerated from completed-suite output and run separately, with no source edits between runs. One unrelated diff-render assertion failed under concurrent load and passed on its isolated rerun. This is complete partitioned coverage, not a claim that the timed-out commands passed.
- `npm run test:unit`: 42 passed. `npm run build`: passed, including the 777-file tarball gate. `npm run test:package`: 17 passed.
- Real Chromium smoke verified GitHub and nested-group GitLab Code hosting settings using an isolated repository/home with `CEZ_DRY_RUN=1`. This checks rendered provider, repository and connection controls, not live vendor permissions or the entire browser E2E suite.

Root and child regressions were run against original source to establish failures before fixes. Independently verified child suites: backend 444, UI 440, Linear 292 tests. Validation used Node 26's `--no-experimental-webstorage` for jsdom compatibility and a validation-only login-shell PATH for the installed Node executable. Live task environment identifiers were removed so fixture agents could not alter the real task's handoff.
