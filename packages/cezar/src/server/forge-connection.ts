import type { ForgeConnection } from '@open-mercato/cezar-contract';
import { getRepoInfo } from './git.ts';
import { parseRemote, resolveForge } from './forge/index.ts';

/** Settings reads only local identity. Testing is explicit, read-only and uses host-scoped CLI auth. */
export async function readForgeConnection(root: string, test = false): Promise<ForgeConnection> {
  const repo = await getRepoInfo(root, { requireRemoteRead: true, allowUnborn: true });
  const parsed = repo?.remote ? parseRemote(repo.remote) : null;
  const driver = resolveForge(repo);
  const result: ForgeConnection = {
    kind: driver?.kind ?? null,
    host: parsed?.host ?? null,
    repository: parsed ? `${parsed.owner}/${parsed.repo}` : null,
    url: driver?.viewUrl('repo', '') ?? null,
    status: driver ? 'untested' : 'unconfigured',
    reason: driver ? null : parsed
      ? 'Unknown forge host. Log in with gh or glab on the server, then reload this connection.'
      : 'No supported repository remote is configured.',
  };
  if (!driver || !test) return result;
  if (process.env.CEZ_DRY_RUN === '1') return { ...result, status: 'demo', reason: 'Demo mode: no real connection was tested.' };
  try {
    const availability = await driver.detect({ refresh: true });
    const current = await getRepoInfo(root, { requireRemoteRead: true, allowUnborn: true });
    if (repo?.remote !== current?.remote) return { ...result, status: 'unavailable', reason: 'Repository remote changed during the test. Reload and test again.' };
    return { ...result, status: availability.available ? 'available' : 'unavailable', reason: availability.available ? null : 'Could not read this repository. Check the server CLI login, repository access and connectivity.' };
  } catch {
    // CLI errors can echo credential-bearing remotes or upstream bodies. Never expose them here.
    return { ...result, status: 'unavailable', reason: 'Connection test failed. Check the server CLI installation, login and connectivity.' };
  }
}
