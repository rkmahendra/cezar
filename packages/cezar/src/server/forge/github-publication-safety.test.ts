import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftPrInput } from './types.ts';
const { execFile, autosave } = vi.hoisted(() => ({ execFile: vi.fn(), autosave: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile, execFileSync: vi.fn() }));
vi.mock('../../git-worktree.ts', () => ({ autosaveCommit: autosave }));
import { createDraftPr } from './github.ts';

const ref = { host: 'github.com', owner: 'acme', repo: 'demo' };
const fullName = 'acme/demo';
const pr = { number: 42, state: 'open', draft: true, head: { ref: 'feature', repo: { full_name: fullName } }, base: { ref: 'develop', repo: { full_name: fullName } } };
const input = (): DraftPrInput => ({ repoRoot: '/repo', run: { worktreePath: '/worktree', branch: 'cez/stale', baseBranch: 'origin/develop', title: 'Task', task: 'Task' } as DraftPrInput['run'], handoffText: '' });
let respond: (bin: string, args: string[]) => string;
let published: boolean;
function standard(bin: string, args: string[]): string {
  if (bin === 'git') {
    if (args[0] === 'symbolic-ref') return 'feature';
    if (args[0] === 'remote') return 'https://github.com/acme/demo.git';
    if (args[0] === 'status' || args.includes('push') || args[0] === 'check-ref-format') return '';
  }
  if (bin === 'gh') {
    if (args[0] === 'api' && args[1] === 'repos/acme/demo') return JSON.stringify({ full_name: fullName, default_branch: 'main' });
    if (args[0] === 'api' && args[1]?.includes('/pulls?')) return JSON.stringify(published ? [pr] : []);
    if (args[0] === 'pr' && args[1] === 'create') { published = true; return 'https://github.com/acme/demo/pull/42'; }
  }
  throw new Error(`Unexpected mock command: ${bin} ${args.join(' ')}`);
}
const calls = (command: string) => execFile.mock.calls.filter((call) => call[1][0] === command || command === 'push' && call[1].includes('push'));
beforeEach(() => {
  vi.stubEnv('CEZ_DRY_RUN', '0');
  execFile.mockReset();
  autosave.mockReset().mockResolvedValue('nothing-to-do');
  published = false;
  respond = standard;
  execFile.mockImplementation((bin, args, _options, callback) => {
    try { callback(null, respond(bin, args), ''); } catch (error) { callback(error, '', 'request failed'); }
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('GitHub publication safety and retry (offline CLI mocks)', () => {
  it('publishes actual checkout, not stale run metadata, and reuses existing ready PR', async () => {
    expect(await createDraftPr(input(), ref)).toEqual({ ok: true, url: 'https://github.com/acme/demo/pull/42', dryRun: false });
    expect(calls('push')[0]![1]).toEqual(['-c', 'push.pushOption=', 'push', '--no-follow-tags', '--recurse-submodules=no', '-u', '--', 'origin', 'refs/heads/feature:refs/heads/feature']);
    expect(calls('pr')[0]![1]).toEqual(expect.arrayContaining(['--head', 'feature', '--base', 'develop', '--draft']));
    respond = (bin, args) => args[1]?.includes('/pulls?') ? JSON.stringify([{ ...pr, draft: false }]) : standard(bin, args);
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: true });
    expect(calls('pr')).toHaveLength(1);
  });
  it.each(['main', 'develop'])('rejects checkout of protected branch %s before autosave', async (branch) => {
    respond = (bin, args) => args[0] === 'symbolic-ref' ? branch : standard(bin, args);
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: false });
    expect(autosave).not.toHaveBeenCalled();
    expect(calls('push')).toHaveLength(0);
  });
  it('rejects detached HEAD before autosave', async () => {
    respond = (bin, args) => { if (args[0] === 'symbolic-ref') throw new Error('detached'); return standard(bin, args); };
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: false });
    expect(autosave).not.toHaveBeenCalled();
  });
  it('recovers timeout after vendor created PR, without a second create', async () => {
    respond = (bin, args) => { if (args[0] === 'pr') { published = true; throw new Error('timeout'); } return standard(bin, args); };
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: true });
    expect(calls('pr')).toHaveLength(1);
  });
  it('rejects existing PR with wrong base before autosave or push', async () => {
    respond = (bin, args) => args[1]?.includes('/pulls?') ? JSON.stringify([{ ...pr, base: { ...pr.base, ref: 'other' } }]) : standard(bin, args);
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: false });
    expect(autosave).not.toHaveBeenCalled();
    expect(calls('push')).toHaveLength(0);
  });
  it('requires readable clean status after autosave', async () => {
    respond = (bin, args) => args[0] === 'status' ? ' M task.txt' : standard(bin, args);
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: false });
    expect(calls('push')).toHaveLength(0);
  });
  it.each(['lookup-failed', 'malformed', 'truncated', 'fork', 'not-draft', 'branch-changed', 'push-failed'])('fails closed for %s', async (mode) => {
    let heads = 0;
    respond = (bin, args) => {
      if (args[0] === 'symbolic-ref' && mode === 'branch-changed' && ++heads > 1) return 'other';
      if (args.includes('push') && mode === 'push-failed') throw new Error('https://secret@host');
      if (args[1]?.includes('/pulls?')) {
        if (mode === 'lookup-failed') throw new Error('token=secret');
        if (mode === 'malformed') return '{}';
        if (mode === 'truncated') return JSON.stringify(Array.from({ length: 100 }, () => pr));
        if (published && mode === 'fork') return JSON.stringify([{ ...pr, head: { ...pr.head, repo: { full_name: 'other/demo' } } }]);
        if (published && mode === 'not-draft') return JSON.stringify([{ ...pr, draft: false }]);
      }
      return standard(bin, args);
    };
    const result = await createDraftPr(input(), ref);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('secret');
    if (['lookup-failed', 'malformed', 'truncated', 'branch-changed'].includes(mode)) {
      expect(autosave).not.toHaveBeenCalled();
      expect(calls('push')).toHaveLength(0);
    }
  });
  it('does not contact GitHub or push in dry-run', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    expect(await createDraftPr(input(), ref)).toMatchObject({ ok: true, dryRun: true });
    expect(execFile.mock.calls.every((call) => call[0] === 'git')).toBe(true);
    expect(calls('push')).toHaveLength(0);
    expect(autosave).toHaveBeenCalledOnce();
  });
});
