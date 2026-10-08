# Linear to draft MR/PR, then back to Linear

This workflow combines a project's Linear connection with its GitLab or GitHub forge.
It is an explicit **agent-driven handoff**, not a background synchronizer. Browsing and
ordinary manual runs stay read-only. No vendor mutation occurs just by checking the option
or creating the run: mutations require the agent to execute the workflow.

## Run it

1. In the project's **Settings → Issue tracker**, configure Linear and select the intended
   team. Use a narrowly scoped key that can read the issue/team states, update the issue and
   create its link attachment. Read-only keys still work for browsing, but cannot write back.
2. Set the repository's `origin` to its intended GitLab or GitHub repository. Authenticate the
   corresponding forge CLI (`glab` or `gh`) for that host, including self-hosted installations.
   Linear's key is not a forge credential. Confirm repository, target branch and publication
   permissions before approving a push.
3. Open the Linear issue in the cockpit. Review the description snapshot and any disclosed
   omissions. Select the workflow/backend, then check **Allow Linear workflow writeback for
   this run**. Read the credential-delegation notice before launching.
4. The agent is instructed to fetch the issue again, verify its organization/team, discover
   actual team workflow states, and move to the appropriate in-progress state before work.
   Missing/ambiguous states require your input, not a guessed state ID. Completed/canceled
   issues must not be reopened by this workflow.
5. Review changes and tests. Approve publication separately, using the cockpit's draft MR/PR
   action or an explicit instruction to the agent. This workflow never authorizes a merge.
6. If the agent publishes during its session, it can verify the returned URL and finish
   writeback. **If you use the cockpit's draft button after the agent stops, Continue the same
   run** and send the template below with the actual published URL. The draft button does not
   itself update Linear, and a cezar run marked `done` does not mean the Linear issue is Done.
7. Confirm the agent reports the observed Linear status and verified link. Open Linear to
   check when correctness matters. Leave final completion and merge decisions to your team's
   normal review/release process.

## Continue after publication

```text
The draft MR/PR was published at <actual URL>. Finish this run's opted-in Linear
writeback only. Verify the forge repository, source branch, draft/open state and URL.
Verify the bound Linear issue's organization/team and current state. Attach the actual
URL without duplicates, then move to the team's appropriate non-completed review state.
Ask if the review state is ambiguous. Do not move back to in-progress, mark Done,
merge, enable auto-merge, or claim success without reading back the Linear result.
```

The run's publication URL is also supplied as an **untrusted hint** on Continue, because
run metadata can originate in transcript references. The agent must verify it, not blindly
attach it. A branch push, a guessed URL, a failed publication or agent completion alone is
never sufficient evidence for the review transition.

## Binding, secrets and limits

- Consent is per launch, not a project default. Only connected Linear handoffs expose it.
  Parallel variants are refused to avoid competing writers. Dispatched child tasks do not
  inherit this explicit binding.
- `POST /api/v1/p/:projectId/runs` accepts optional `trackerWorkflow` with `kind: "linear"`,
  `sourceId`, `externalId` (team UUID), `connectionId` (UUID), `itemId` and
  `delegateCredentials: true`. The boot alias remains `POST /api/v1/runs`. No new endpoint.
  Names, URLs and keys cannot be submitted in this object. The server resolves issue identity
  and membership through the current project driver, rejecting stale selections before launch.
- Only non-secret association/issue identity and consent persist in `trackerWorkflow` on the
  run. Queue recovery, each agent step and Continue reuse that binding. Credentials are resolved
  afresh into the child process's `LINEAR_API_KEY`, never into server `process.env`, the prompt
  or run record. Known literal secrets are registered with existing run-event redaction before
  spawn. Do not print keys or send them through chat; redaction cannot cover every encoding.
- The agent receives the key's **full vendor permissions**, not a token restricted by cezar
  to one issue. Scope checks prevent accidental credential retargeting, not a malicious agent.
  Same-user filesystem access is not a tenant sandbox. Use only trusted workflows/backends.
- A changed/deleted connection or disconnected team prevents later sessions from starting.
  Reconnect and launch a newly consented run rather than retargeting an old grant. Local removal
  cannot claw a key back from an already-running process. Stop the run and revoke the key at
  Linear when revocation is required.
- This adds instructions, not server-side mutations, webhook reconciliation, durable mutation
  receipts or guaranteed retries. Each mutation needs a successful response and readback.
  If attaching the link succeeds but status update fails, report that partial result and retry
  explicitly. Inspect existing attachments/state first to avoid duplication or regression.
- Write permissions, network failures, custom team states and the agent's tool access can block
  writeback. Keep the issue unchanged when a target state is unknown. `CEZ_DRY_RUN=1` never
  injects real tracker credentials or performs vendor writes. Verification for this feature
  uses synthetic keys and mocked providers, not live vendor mutation tests.

This explicit per-run exception extends the read-only manual handoff described in the tracker
browsing design. It does not change tracker browsing, tracker automation grants, forge merge
policy or the default task review gate.
