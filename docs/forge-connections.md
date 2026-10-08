# Forge connections

Cezar uses the repository's `origin` plus existing CLI logins. Linear is a separate
project issue-tracker connection, so a Linear team can drive a GitLab repository.
No repository `.env` or cezar forge configuration file is required.

Open **Project Settings → Code hosting** to see the detected provider, hostname and
repository, with a server-side CLI login command. For an unknown host, choose which
CLI's setup instructions to show. This selection is not saved and does not classify
the host. Log in over SSH as cezar's OS user, then **Reload connection** and **Test
connection**. The test bypasses the driver's completed-result cache, shares any
in-flight probe, and checks repository read access only. It never pushes, mutates
vendor state or proves push permission. Merely opening Settings performs no vendor
request. Demo mode reports **Demo only**, never a real connection success.

This first UI layer guides and tests the existing CLI connection. It does not collect
tokens, execute login commands, change remotes or provide browser-only OAuth onboarding.
Those require a separate credential-management design. Existing CLI-only setups keep working.

| Service | Connection | Cezar support |
| --- | --- | --- |
| GitHub.com | `gh auth login --hostname github.com` | Issues, PRs, draft publication, existing checks/review tools |
| GitHub Enterprise Server | `gh auth login --hostname github.example.com` | GitHub operations routed to that host |
| GitLab.com | `glab auth login --hostname gitlab.com` | Issues, MRs, search, draft MR publication |
| GitLab self-managed CE/EE | `glab auth login --hostname gitlab.example.com` | Same GitLab API, including nested groups |
| Linear | Project Settings → Issue tracker → Configure Linear credentials | Team browsing, issue handoff, opt-in workflow writeback |

Run login commands yourself on the machine hosting cezar, as its OS user. Replace example
hosts with your actual host. Cezar does not ask for forge tokens in repository files.
Use your organization's approved authentication and TLS trust setup. Git push needs
working SSH or HTTPS Git credentials independently of API authentication.

Public forge hosts are recognized directly. A custom host must be present in the
corresponding CLI's local host inventory. Unknown hosts remain plain Git rather than
being guessed from a name such as `git.example.com`. Do not configure the same host in
both CLIs. Credentials from public GitHub are never routed to an enterprise host.

At a task's review gate, **Draft MR** / **Create MR** publishes a GitLab draft and saves
its URL. Existing GitHub tasks retain **Draft PR** / **Create PR**. Publication does not
merge. Errors leave the run available for retry. For GitLab, conversation, detailed
pipeline checks, changed-file review and merging remain in GitLab's own UI.

Commit/push reject task checkouts on a known base/default branch. Publication also verifies
the forge's default/target and push destination before autosave, pushes only the current task
branch without inherited tag/submodule/auto-merge options, and reuses a matching open PR/MR.
For an explicitly opted-in Linear workflow, the cockpit attaches the verified publication
URL to the issue. A linking failure is reported separately and never hides a published request.

The existing `/api/v1/github` API and `/github` page paths are retained for compatibility,
but their list/search/publication operations select the repository's forge. GitLab rows
retain the shared `kind: "pr"` wire value, representing merge requests, with GitLab URLs.
Unsupported GitLab detail endpoints return explicit unavailable responses, never GitHub
fallback data. Numeric-only GitHub reference chips and GitHub event automations are not
GitLab features. Schedule and Linear tracker automations remain independent of forge.

For the complete tracker journey, see [Linear workflow](linear-forge-workflow.md).
See [audit findings](forge-linear-audit.md) for corrected gaps and verification evidence.
This support is covered by offline API/CLI fixtures, not a certification of every
self-managed vendor version or an assertion that your organization's access is configured.
