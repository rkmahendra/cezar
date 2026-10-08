import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgeKindOfHost, githubHostEnv, normalizeForgeHost, parseRemote } from './host-discovery.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-hosts-'));
  for (const tool of ['gh', 'glab']) mkdirSync(join(dir, tool));
  vi.stubEnv('GH_CONFIG_DIR', join(dir, 'gh'));
  vi.stubEnv('GLAB_CONFIG_DIR', join(dir, 'glab'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const ghConfig = (content: string) => writeFileSync(join(dir, 'gh', 'hosts.yml'), content);
const glabConfig = (content: string) => writeFileSync(join(dir, 'glab', 'config.yml'), content);

describe('offline forge discovery', () => {
  it('recognizes public hosts but never guesses a provider from a name', () => {
    expect(forgeKindOfHost('GitHub.com')).toBe('github');
    expect(forgeKindOfHost('gitlab.com')).toBe('gitlab');
    for (const host of ['github.example', 'gitlab.internal', 'github.com.evil.test', 'gitlab.com:8443']) {
      expect(forgeKindOfHost(host)).toBeNull();
    }
  });
  it('recognizes native inventories including keychain-only and exact port entries', () => {
    ghConfig('code.example:\n  user: alice\n');
    glabConfig('hosts:\n  "code.example:8443":\n    user: bob\n');
    expect(forgeKindOfHost('code.example')).toBe('github');
    expect(forgeKindOfHost('code.example:8443')).toBe('gitlab');
    expect(forgeKindOfHost('code.example:9443')).toBeNull();
    expect(forgeKindOfHost('sub.code.example')).toBeNull();
  });
  it('fails closed on conflicting provider entries, malformed YAML and removed config', () => {
    ghConfig('code.example: { user: alice }');
    glabConfig('hosts: { code.example: { user: alice } }');
    expect(forgeKindOfHost('code.example')).toBeNull();
    glabConfig('hosts: [broken');
    expect(forgeKindOfHost('code.example')).toBe('github');
    rmSync(join(dir, 'gh', 'hosts.yml'));
    expect(forgeKindOfHost('code.example')).toBeNull();
  });
  it('reloads changed config without retaining credentials and rejects invalid entry shapes', () => {
    ghConfig('old.example: { oauth_token: fake-old }');
    expect(forgeKindOfHost('old.example')).toBe('github');
    ghConfig('new.example: { user: bob }\ninvalid.example: token\n"https://bad.example": {}\n');
    expect(forgeKindOfHost('old.example')).toBeNull();
    expect(forgeKindOfHost('new.example')).toBe('github');
    expect(forgeKindOfHost('invalid.example')).toBeNull();
    expect(forgeKindOfHost('bad.example')).toBeNull();
  });
  it('uses native XDG defaults when CLI override dirs are absent', () => {
    vi.stubEnv('GH_CONFIG_DIR', ''); vi.stubEnv('GLAB_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    mkdirSync(join(dir, 'glab-cli'));
    ghConfig('code.example: {}');
    writeFileSync(join(dir, 'glab-cli', 'config.yml'), 'hosts: { lab.example: {} }');
    expect(forgeKindOfHost('code.example')).toBe('github');
    expect(forgeKindOfHost('lab.example')).toBe('gitlab');
  });
});

describe('remote authority and namespace', () => {
  it('keeps all namespace segments and the web port but not credentials or SSH port', () => {
    expect(parseRemote('https://user:secret@code.example:8443/group/sub/project.git')).toEqual({ host: 'code.example:8443', owner: 'group/sub', repo: 'project' });
    expect(parseRemote('ssh://git@code.example:2222/group/sub/project.git')).toEqual({ host: 'code.example', owner: 'group/sub', repo: 'project' });
    expect(parseRemote('git@code.example:group/sub/project.git')).toEqual({ host: 'code.example', owner: 'group/sub', repo: 'project' });
    expect(normalizeForgeHost('GitHub.com:443')).toBe('github.com');
  });
  it.each(['https://github.com/o/r?token=x', 'https://github.com/o/r#secret', 'file:///o/r', '/srv/repo', 'git@code.example:o//r', 'git@code.example:o/../r', 'https://code.example/group/../o/r', 'https://code.example/o/%2e%2e/r', 'https://code.example/o\\r'])('rejects malformed or non-forge remote %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('GitHub credential environment isolation', () => {
  const env = { GH_TOKEN: 'public-gh', GITHUB_TOKEN: 'public-github', GH_ENTERPRISE_TOKEN: 'enterprise-gh', GITHUB_ENTERPRISE_TOKEN: 'enterprise-github', GH_HOST: 'code.example', GH_REPO: 'wrong/repo', GITLAB_TOKEN: 'lab', GLAB_TOKEN: 'lab2', OAUTH_TOKEN: 'lab3', PATH: '/bin' };
  it('never forwards public tokens or another enterprise host token to GHES', () => {
    const own = githubHostEnv('code.example', env);
    expect(own.GH_TOKEN).toBeUndefined(); expect(own.GITHUB_TOKEN).toBeUndefined();
    expect(own.GH_ENTERPRISE_TOKEN).toBe('enterprise-gh');
    expect(own.GITHUB_ENTERPRISE_TOKEN).toBe('enterprise-github');
    const other = githubHostEnv('other.example', env);
    expect(other.GH_ENTERPRISE_TOKEN).toBeUndefined(); expect(other.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(other.GH_REPO).toBeUndefined(); expect(other.GITLAB_TOKEN).toBeUndefined();
    expect(other.GLAB_TOKEN).toBeUndefined(); expect(other.OAUTH_TOKEN).toBeUndefined();
    expect(other.GH_HOST).toBe('other.example'); expect(other.PATH).toBe('/bin');
    expect(env.GH_TOKEN).toBe('public-gh');
  });
  it('preserves public GitHub auth but does not broadcast unbound enterprise env tokens', () => {
    const pub = githubHostEnv('github.com', env);
    expect(pub.GH_TOKEN).toBe('public-gh'); expect(pub.GITHUB_TOKEN).toBe('public-github');
    expect(pub.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(githubHostEnv('code.example', { GH_ENTERPRISE_TOKEN: 'unbound' }).GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(githubHostEnv('code.example:8443', env).GH_ENTERPRISE_TOKEN).toBeUndefined();
  });
});
