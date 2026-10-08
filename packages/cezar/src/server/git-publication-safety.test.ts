import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTaskBranch, commitAll, pushCurrentBranch } from './git-changes.ts';

const exec = promisify(execFile);
let dir: string;
let repo: string;
const git = async (args: string[], cwd = repo) => (await exec('git', args, { cwd })).stdout.trim();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cez-git-publication-'));
  repo = join(dir, 'repo');
  await git(['init', '-q', '-b', 'main', repo], dir);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'user.email', 'test@local']);
  await writeFile(join(repo, 'task.txt'), 'base\n');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'base']);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('local git mutation safety (temporary repositories only)', () => {
  it('guards configured and native default branches without forbidding another feature checkout', async () => {
    expect(await checkTaskBranch(repo)).toMatchObject({ ok: false });
    await git(['switch', '-qc', 'develop']);
    expect(await checkTaskBranch(repo, 'origin/develop')).toMatchObject({ ok: false });
    await git(['update-ref', 'refs/remotes/origin/develop', 'HEAD']);
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
    expect(await checkTaskBranch(repo, 'release')).toMatchObject({ ok: false });
    await git(['switch', '-qc', 'another-feature']);
    expect(await checkTaskBranch(repo, 'release')).toEqual({ ok: true, branch: 'another-feature' });
    await git(['checkout', '--detach', '-q']);
    expect(await checkTaskBranch(repo, 'release')).toMatchObject({ ok: false });
  });

  it('pushes only current branch despite matching defaults, pushRemote and followTags', async () => {
    const origin = join(dir, 'origin.git');
    const elsewhere = join(dir, 'elsewhere.git');
    await git(['init', '--bare', '-q', origin]);
    await git(['init', '--bare', '-q', elsewhere]);
    await git(['remote', 'add', 'origin', origin]);
    await git(['remote', 'add', 'elsewhere', elsewhere]);
    await git(['push', '-u', 'origin', 'main']);
    await git(['push', 'elsewhere', 'main']);
    const base = await git(['rev-parse', 'main']);
    await writeFile(join(repo, 'task.txt'), 'unrelated base work\n');
    await git(['commit', '-qam', 'unrelated']);
    await git(['switch', '-qc', 'feature']);
    await git(['push', '-u', 'origin', 'feature']);
    await git(['push', 'elsewhere', 'feature']);
    await writeFile(join(repo, 'task.txt'), 'task change\n');
    await git(['commit', '-qam', 'task']);
    await git(['tag', '-a', 'unrelated-tag', '-m', 'not requested']);
    await git(['config', 'push.default', 'matching']);
    await git(['config', 'push.followTags', 'true']);
    await git(['config', 'remote.pushDefault', 'elsewhere']);
    // An inherited GitLab push option could create a ready MR or enable auto-merge.
    // This local bare remote rejects push options, making accidental forwarding observable.
    await git(['config', 'push.pushOption', 'merge_request.merge_when_pipeline_succeeds']);
    const beforeElsewhere = await git(['rev-parse', 'refs/heads/feature'], elsewhere);
    expect(await pushCurrentBranch(repo)).toMatchObject({ ok: true, branch: 'feature', remote: 'origin' });
    expect(await git(['rev-parse', 'refs/heads/feature'], origin)).toBe(await git(['rev-parse', 'HEAD']));
    expect(await git(['rev-parse', 'refs/heads/main'], origin)).toBe(base);
    expect(await git(['rev-parse', 'refs/heads/feature'], elsewhere)).toBe(beforeElsewhere);
    expect(await git(['tag', '--list'], origin)).toBe('');
  });

  it('does not stage away unmerged entries or commit conflict text', async () => {
    await git(['switch', '-qc', 'other']);
    await writeFile(join(repo, 'task.txt'), 'other\n');
    await git(['commit', '-qam', 'other']);
    await git(['switch', '-q', 'main']);
    await writeFile(join(repo, 'task.txt'), 'ours\n');
    await git(['commit', '-qam', 'ours']);
    await git(['merge', 'other']).catch(() => undefined);
    const head = await git(['rev-parse', 'HEAD']);
    const index = await git(['ls-files', '--unmerged']);
    expect(index).not.toBe('');
    expect(await commitAll(repo, 'unsafe')).toMatchObject({ ok: false, error: expect.stringMatching(/unmerged|conflict/i) });
    expect(await git(['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(['ls-files', '--unmerged'])).toBe(index);
  });
});
