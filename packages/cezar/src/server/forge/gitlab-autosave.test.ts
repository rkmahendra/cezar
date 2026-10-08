import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitlabDriver } from './gitlab.ts';
import type { DraftPrInput } from './types.ts';

const exec = promisify(execFile);
const identity = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Real local git plus CEZ_DRY_RUN: the shared autosave guard must run before the offline
 * shortcut. No remote is configured, so these tests cannot push or contact GitLab. */
describe('GitLab final autosave with real git', () => {
  let root: string;
  const git = (args: string[]) => exec('git', args, { cwd: root });
  const input = (): DraftPrInput => ({
    repoRoot: root,
    handoffText: '## Goal\n\nComplete task\n',
    run: { worktreePath: root, branch: 'cez/old', title: 'Complete task', task: 'Complete task' } as DraftPrInput['run'],
  });
  const driver = () => createGitlabDriver(root, { host: 'gitlab.example.com', owner: 'team/subgroup', repo: 'repo' });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cez-gitlab-autosave-'));
    await git(['init', '-q', '-b', 'feat/current']);
    await writeFile(join(root, 'task.txt'), 'before\n');
    await git(['add', '-A']);
    await git([...identity, 'commit', '-q', '-m', 'initial']);
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  it('commits final work on the current branch, even with stale run.branch', async () => {
    await writeFile(join(root, 'task.txt'), 'complete\n');
    expect(await driver().createPR(input())).toEqual({ ok: true, dryRun: true, url: 'https://gitlab.example.com/team/subgroup/repo/-/merge_requests/777' });
    expect((await git(['log', '-1', '--format=%s'])).stdout.trim()).toBe('cezar autosave (pre-PR)');
    expect((await git(['show', 'feat/current:task.txt'])).stdout).toBe('complete\n');
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
  });

  it('refuses tracked conflict markers without overwriting the unresolved file', async () => {
    const conflict = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n';
    await writeFile(join(root, 'task.txt'), conflict);
    expect(await driver().createPR(input())).toMatchObject({ ok: false, error: expect.stringContaining('unresolved merge conflicts') });
    expect((await git(['log', '-1', '--format=%s'])).stdout.trim()).toBe('initial');
    expect(await readFile(join(root, 'task.txt'), 'utf8')).toBe(conflict);
  });

  it('refuses an unmerged index', async () => {
    await git(['checkout', '-q', '-b', 'other']);
    await writeFile(join(root, 'task.txt'), 'other\n');
    await git(['add', '-A']);
    await git([...identity, 'commit', '-q', '-m', 'other']);
    await git(['checkout', '-q', 'feat/current']);
    await writeFile(join(root, 'task.txt'), 'ours\n');
    await git(['add', '-A']);
    await git([...identity, 'commit', '-q', '-m', 'ours']);
    await expect(git([...identity, 'merge', 'other'])).rejects.toThrow();
    expect(await driver().createPR(input())).toMatchObject({ ok: false, error: expect.stringContaining('unresolved merge conflicts') });
    expect((await git(['status', '--porcelain'])).stdout).toContain('UU task.txt');
  });

  it('refuses detached HEAD without committing dirty work', async () => {
    await git(['checkout', '-q', '--detach']);
    await writeFile(join(root, 'task.txt'), 'do not publish\n');
    expect(await driver().createPR(input())).toMatchObject({ ok: false });
    expect((await git(['log', '-1', '--format=%s'])).stdout.trim()).toBe('initial');
    expect(await readFile(join(root, 'task.txt'), 'utf8')).toBe('do not publish\n');
  });
});
