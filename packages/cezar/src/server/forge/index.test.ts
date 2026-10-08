import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { createGitlabDriver, execFile, execFileSync } = vi.hoisted(() => ({
  createGitlabDriver: vi.fn(() => ({ kind: 'gitlab' })), execFile: vi.fn(), execFileSync: vi.fn(),
}));
vi.mock('./gitlab.ts', () => ({ createGitlabDriver }));
vi.mock('node:child_process', () => ({ execFile, execFileSync }));
import type { RepoInfo } from '../git.ts';
import { forgeKindOfRemote, forgeWebRoot, parseRemote, resolveForge } from './index.ts';

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('parseRemote', () => {
  it.each([
    ['https://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://user:token@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@github.com:acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['ssh://git@github.com:2222/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git://github.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://GitHub.com/acme/demo.git', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['https://github.com/acme/demo/', { host: 'github.com', owner: 'acme', repo: 'demo' }],
    ['git@gitlab.com:group/sub/project.git', { host: 'gitlab.com', owner: 'group/sub', repo: 'project' }],
    ['https://code.example:8443/group/sub/project.git', { host: 'code.example:8443', owner: 'group/sub', repo: 'project' }],
  ])('parses %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  it.each([
    ['/srv/git/demo.git'], // local bare path — not a forge
    ['../relative/path'],
    ['https://github.com/only-owner'],
    [''],
  ])('rejects %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('forgeKindOfRemote', () => {
  // The registry probe's classification (#698) — same host table as resolveForge,
  // but string-only: no driver, no repo root, no `gh`.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', 'gitlab'],
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s', (remote, expected) => {
    expect(forgeKindOfRemote(remote)).toBe(expected);
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  it('maps public GitLab including nested groups', () => {
    expect(resolveForge(info('git@gitlab.com:group/sub/demo.git'))?.kind).toBe('gitlab');
    expect(createGitlabDriver).toHaveBeenCalledWith('/repo', { host: 'gitlab.com', owner: 'group/sub', repo: 'demo' });
  });

  it('routes native enterprise inventories without spawning and strips link credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-routing-'));
    try {
      vi.stubEnv('GH_CONFIG_DIR', dir); vi.stubEnv('GLAB_CONFIG_DIR', dir);
      writeFileSync(join(dir, 'hosts.yml'), 'code.example: { user: alice }');
      writeFileSync(join(dir, 'config.yml'), 'hosts: { "lab.example:8443": { user: bob } }');
      const gh = 'https://secret:token@code.example/o/r.git';
      const lab = 'https://secret:token@lab.example:8443/group/sub/r.git';
      expect(forgeKindOfRemote(gh)).toBe('github');
      expect(resolveForge(info(gh))?.viewUrl('pr', 2)).toBe('https://code.example/o/r/pull/2');
      expect(forgeKindOfRemote(lab)).toBe('gitlab');
      expect(resolveForge(info(lab))?.kind).toBe('gitlab');
      expect(createGitlabDriver).toHaveBeenCalledWith('/repo', { host: 'lab.example:8443', owner: 'group/sub', repo: 'r' });
      expect(forgeWebRoot(lab)).toBe('https://lab.example:8443/group/sub/r');
      expect(forgeWebRoot('https://lab.example/group/sub/r')).toBeNull();
      expect(execFile).not.toHaveBeenCalled(); expect(execFileSync).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null for a self-hosted host', () => {
    expect(resolveForge(info('https://git.example.com/acme/demo.git'))).toBeNull();
  });

  it('returns null when the repo has no remote', () => {
    expect(resolveForge(info(undefined))).toBeNull();
  });

  it('returns null when not in a git repo at all', () => {
    expect(resolveForge(null)).toBeNull();
  });

  it('returns null for a local-path remote', () => {
    expect(resolveForge(info('/srv/git/demo.git'))).toBeNull();
  });
});

describe('GitHub driver viewUrl', () => {
  const driver = resolveForge(info('git@github.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://github.com/acme/demo'],
    ['issue', 142, 'https://github.com/acme/demo/issues/142'],
    ['pr', 128, 'https://github.com/acme/demo/pull/128'],
    ['branch', 'feat/cockpit ui', 'https://github.com/acme/demo/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://github.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});
