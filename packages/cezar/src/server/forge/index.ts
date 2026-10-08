import type { RepoInfo } from '../git.ts';
import { createGithubDriver } from './github.ts';
import { createGitlabDriver } from './gitlab.ts';
import { forgeKindOfHost, parseRemote } from './host-discovery.ts';
import type { ForgeDriver, ForgeKind } from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver using public hosts and native CLI inventories.
 * Unknown hosts, no remote, or not a repo → null. The health route
 * serializes the result as `forge: {kind, available, reason?} | null`; a null
 * forge means plain-git features only (diffs, commit, push, branches).
 */

export { parseRemote } from './host-discovery.ts';
export type { ParsedRemote } from './host-discovery.ts';

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the
 * registry's per-project probe classifies each root from its remote alone —
 * string parsing plus native local inventories, no CLI/network — so the sidebar can gate each
 * project's GitHub tab on the project's own remote.
 */
export function forgeKindOfRemote(remote: string | undefined): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  return parsed ? forgeKindOfHost(parsed.host) : null;
}

/**
 * A remote's web root — `https://github.com/owner/repo` — or null for anything not on a known
 * forge host.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, owner, repo}` leaves nothing to leak.
 */
export function forgeWebRoot(remote: string | undefined): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed || !forgeKindOfHost(parsed.host)) return null;
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}`;
}

/** Remote host → driver | null. Construction does not contact either provider. */
export function resolveForge(repoInfo: RepoInfo | null): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  switch (forgeKindOfHost(parsed.host)) {
    case 'github':
      return parsed.owner.includes('/') ? null : createGithubDriver(repoInfo.root, parsed);
    case 'gitlab':
      return createGitlabDriver(repoInfo.root, parsed);
    default:
      return null;
  }
}

export type { ForgeDriver, ForgeAvailability, ForgeItem, ForgeKind, ForgePrStatus, ForgeRefKind } from './types.ts';
