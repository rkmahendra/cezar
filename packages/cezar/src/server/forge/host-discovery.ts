import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ForgeKind } from './types.ts';

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Parse URL and scp-like remotes without retaining credentials. SSH ports are transport-only. */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string | undefined;
  let path: string | undefined;
  if (/^[a-z+]+:\/\//i.test(r)) {
    try {
      const url = new URL(r);
      if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol) || url.search || url.hash) return null;
      host = url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.hostname;
      // URL normalizes /../ and backslashes. Validate the literal path rather than reassigning
      // a malformed remote to a different repository after that normalization.
      if (r.includes('\\')) return null;
      path = r.slice(r.indexOf('/', r.indexOf('://') + 3) + 1);
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (!host || !path) return null;
  const authority = normalizeForgeHost(host);
  const parts = path.replace(/\.git$/i, '').split('/');
  if (!authority || parts.length < 2 || parts.some((part) => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) return null;
  const repo = parts.pop()!;
  return { host: authority, owner: parts.join('/'), repo };
}

/** Exact web authority, not a URL, suffix match, or SSH transport port. */
export function normalizeForgeHost(value: string): string | null {
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(value)) return null;
  try {
    const url = new URL(`https://${value}`);
    if (url.port === '0') return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

const hostEntries = z.record(z.string(), z.unknown());
const configCache = new Map<string, { stamp: string; hosts: string[] }>();

/** Read only native CLI inventories. No token extraction, keychain access, CLI spawn, or network.
 * An entry suffices: gh/glab can keep its credential in the OS keychain, outside this YAML.
 * ponytail: native config inventories only. Add provider discovery when another CLI needs it. */
function configuredHosts(file: string, nested: boolean): string[] {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return [];
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = configCache.get(file);
    if (cached?.stamp === stamp) return cached.hosts;
    const raw: unknown = parse(readFileSync(file, 'utf8'), { maxAliasCount: 0 });
    const root = hostEntries.parse(raw);
    const hosts = Object.entries(hostEntries.parse(nested ? root.hosts : root))
      .filter(([, entry]) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      .map(([host]) => normalizeForgeHost(host))
      .filter((host): host is string => host !== null);
    configCache.set(file, { stamp, hosts });
    while (configCache.size > 8) configCache.delete(configCache.keys().next().value!);
    return hosts;
  } catch {
    return [];
  }
}

/** Synchronous registry classification. Unknown or conflicting self-hosted inventory stays unknown.
 * Public hosts cannot be reclassified by local config. No secrets survive config parsing. */
export function forgeKindOfHost(host: string): ForgeKind | null {
  const authority = normalizeForgeHost(host);
  if (!authority) return null;
  if (authority === 'github.com') return 'github';
  if (authority === 'gitlab.com') return 'gitlab';
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const ghDir = process.env.GH_CONFIG_DIR ||
    (process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'GitHub CLI') : join(configHome, 'gh'));
  const glabDir = process.env.GLAB_CONFIG_DIR || join(configHome, 'glab-cli');
  const github = configuredHosts(join(ghDir, 'hosts.yml'), false).includes(authority);
  const gitlab = configuredHosts(join(glabDir, 'config.yml'), true).includes(authority);
  return github === gitlab ? null : github ? 'github' : 'gitlab';
}

/** Only the CLI can retrieve stored credentials. Never remap a public token to enterprise auth.
 * An enterprise env token is shared by gh across hosts, so require its explicit native GH_HOST. */
export function githubHostEnv(host: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const authority = normalizeForgeHost(host);
  if (!authority) throw new Error('Invalid GitHub host');
  const scoped: NodeJS.ProcessEnv = { ...env, GH_HOST: authority, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
  delete scoped.GH_REPO;
  delete scoped.GITLAB_TOKEN;
  delete scoped.GITLAB_ACCESS_TOKEN;
  delete scoped.GLAB_TOKEN;
  delete scoped.OAUTH_TOKEN;
  delete scoped.CI_JOB_TOKEN;
  delete scoped.JOB_TOKEN;
  if (authority !== 'github.com') {
    delete scoped.GH_TOKEN;
    delete scoped.GITHUB_TOKEN;
  }
  if (authority === 'github.com' || normalizeForgeHost(env.GH_HOST ?? '') !== authority) {
    delete scoped.GH_ENTERPRISE_TOKEN;
    delete scoped.GITHUB_ENTERPRISE_TOKEN;
  }
  return scoped;
}
