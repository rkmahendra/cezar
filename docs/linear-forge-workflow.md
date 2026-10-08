# Linear issue to reviewed GitHub PR or GitLab MR

Linear is independent of code hosting: one project's Linear team can drive a GitHub, GitHub Enterprise, GitLab.com or self-managed GitLab repository. Cezar keeps human review and publication separate from tracker updates. It never auto-merges or marks a Linear issue Done because an agent finished.

## Connect once

1. In **Project Settings → Code hosting**, check provider, host and repository. Authenticate `gh` or `glab` as the server's OS user, then reload and explicitly test read access. Configure Git SSH/HTTPS push credentials separately. See [forge connections](forge-connections.md).
2. In **Project Settings → Issue tracker**, configure Linear and select the team. A key needs issue/team-state read access, issue update access and attachment creation access for the complete workflow. Read-only keys still support browsing.

## Manual issue handoff

1. Open the issue, inspect its full description snapshot and acknowledge any disclosed omissions.
2. Choose workflow/backend and check **Allow Linear workflow writeback for this run**. This is explicit per-run consent, not a project default.
3. When work actually starts, cezar revalidates captured connection, organization, team and issue. It chooses the team's unique started state named **In Progress** (case-insensitive, surrounding whitespace ignored), otherwise its only started state. It uses the vendor's actual state ID. Ambiguous or incomplete state discovery blocks work instead of guessing.
4. Issues already in a started state stay there, including In Review. Completed/canceled issues are not reopened. A successful readback is recorded before the agent starts. Later steps and Continue revalidate identity without restarting the status transition.
5. Review task changes and tests. Use **Send back** or **Continue** for another fix. Commit and push explicitly, or use **Draft PR/MR**, which performs final autosave, safe branch push and draft publication. Publication is never a merge.
6. After the cockpit verifies the published PR/MR, cezar attaches its actual URL to the bound Linear issue without duplicate links. This does not change Linear status to Review or Done. Use your team's normal review/release process for those decisions.

## Automatic intake of new Linear issues

1. Open **Automations → New**, choose the project's tracker, select `issue.opened` and optional required labels. Only advertised provider events are available.
2. Use a prompt such as:

   ```text
   Read the full current Linear issue {{tracker.key}}. Implement its acceptance criteria
   in this task's worktree, run relevant tests, then stop at review. Do not push, publish,
   merge, enable auto-merge or mark the issue Done. Leave changes ready for human review.
   ```

3. Select **Allow Linear workflow updates**. This authorizes deterministic In Progress handling and publication linking for each matched issue, plus the existing agent credential delegation. Without this option, the scheduler does not perform tracker writes. Existing automations remain unchanged.
4. Save paused, preview the filter, then enable when intended. Enabling establishes a current-time baseline, so old backlog is not launched. Review each resulting task and publish only when ready.

The JSON equivalent is optional `task.linearWorkflow: true`, valid only for a Linear tracker automation with one variant. Use `cez automation schema` for the current contract, fetch the exact tracker association from `/api/v1/p/:projectId/tracker/automation-options`, and create through the CLI/API. Do not edit automation state files.

## Failure and retry

- A missing/replaced connection, unreadable issue, ambiguous state or denied write prevents the initial agent spawn. Inspect the issue and fix the blocker, then launch a newly consented run. Continue requires an existing agent session.
- A timed-out mutation may have reached Linear. Re-read the issue before retrying. Already-started states and existing identical attachments prevent duplicate changes on the next attempt.
- A failed attachment does **not** undo a successful push or PR/MR. The published URL remains on the task and a controlled note records that Linear linking failed. Continue the same run with the verified published URL for an explicit retry, or attach it in Linear yourself. Never republish merely to repair a tracker status.
- If an agent publishes outside the cockpit action, it must verify the actual forge URL, repository and branch before linking it. A transcript reference or guessed URL is not proof of publication.

## Consent, credentials and limits

- Only explicitly bound runs get server-managed writeback. Parallel variants are refused; dispatched children do not inherit the binding.
- The request contains only issue/connection/scope identity and consent. Names, keys, URLs and server-owned `startedAt` receipts cannot be authored in `trackerWorkflow` input.
- Credentials are freshly resolved from the captured project connection for each session and request. They never enter the prompt, run record or server `process.env`. Known secrets are registered with transcript redaction before spawn.
- The agent still receives the key's **full vendor permissions**, not a token restricted to one issue. Use narrowly scoped keys and trusted workflows. Same-user filesystem access is not a tenant sandbox.
- Removing/replacing a connection blocks future sessions and server requests but cannot revoke a key already held by an agent. Stop the run and revoke the key at Linear when required.
- Same-process issue updates serialize. Linear offers no compare-and-set in this path, so a human or another process can still race the final read/update window. This is not webhook reconciliation or a background synchronizer.
- At most 100 team states/attachments are inspected; incomplete responses block instead of guessing or duplicating. Network operations use existing transport deadlines and controlled errors.
- `CEZ_DRY_RUN=1` never injects real tracker credentials or performs vendor requests. Tests use synthetic keys and mocked APIs. Live account permissions and self-managed forge installations require separate explicit verification.

See [audit findings](forge-linear-audit.md) for implementation coverage and remaining GitLab-specific limits.
