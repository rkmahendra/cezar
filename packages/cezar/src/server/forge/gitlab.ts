import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { autosaveCommit } from '../../git-worktree.ts';
import { buildPrBody } from './github.ts';
import type { DraftPrInput, DraftPrOutcome, ForgeAvailability, ForgeDriver, ForgeItem, ForgePrStatus } from './types.ts';

/** GitLab REST v4 via the user's installed glab. Community/Enterprise use the same API.
 * No credentials are stored here. Authenticate each host with `glab auth login --hostname HOST`.
 * Construction and detectCached are memory-only; only an explicit operation contacts GitLab.
 * List errors throw controlled messages so the caller reports unavailable, not an empty project.
 * Optional merge, diff and creation-feed methods are deliberately absent, never fake successes.
 */
const exec = promisify(execFile);
const CACHE_MS = 30_000;
const ITEM_CAP = 100;
const BODY_CAP = 60_000;
const namespacePart = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/).max(255);
const repoRefSchema = z.object({
  host: z.string().max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?$/)
    .refine((host) => { try { return new URL(`https://${host}`).host === host.toLowerCase(); } catch { return false; } }),
  owner: z.string().max(1024).refine((owner) => owner.split('/').every((part) => namespacePart.safeParse(part).success)),
  repo: namespacePart,
});
export type GitlabRepoRef = z.infer<typeof repoRefSchema>;
const webUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
});
const projectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullable(),
  web_url: webUrlSchema,
});
const issueSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  author: z.object({ username: z.string() }).nullish(),
  created_at: z.iso.datetime({ offset: true }),
  labels: z.array(z.string()).default([]),
  description: z.string().nullish(),
  web_url: webUrlSchema,
  user_notes_count: z.number().int().nonnegative(),
});
const mrSchema = issueSchema.extend({
  state: z.enum(['opened', 'locked', 'closed', 'merged']),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number().int().positive().nullable(),
  target_project_id: z.number().int().positive(),
  head_pipeline: z.object({ status: z.string() }).nullish(),
});
const mrListSchema = z.array(mrSchema).max(ITEM_CAP);
type MergeRequest = z.infer<typeof mrSchema>;
type Cache = {
  availability?: { at: number; result: ForgeAvailability };
  probe?: Promise<ForgeAvailability>;
  lists: Map<string, { at: number; items: ForgeItem[] }>;
};
const caches = new Map<string, Cache>();

class GitlabError extends Error {}
const failure = (error: unknown): string => error instanceof GitlabError ? error.message : 'GitLab returned an invalid response.';
const cappedLimit = (limit = 50): number => Number.isFinite(limit) ? Math.max(1, Math.min(ITEM_CAP, Math.floor(limit))) : 50;
const isDraft = (mr: MergeRequest): boolean => mr.draft === true || mr.work_in_progress === true || /^(?:Draft:|WIP:|\[Draft\]|\(Draft\))/i.test(mr.title);
function checks(mr: MergeRequest): ForgePrStatus['checks'] {
  const status = mr.head_pipeline?.status;
  if (!status || status === 'skipped') return null;
  if (status === 'success') return 'passing';
  if (status === 'failed' || status === 'canceled') return 'failing';
  return 'pending'; // manual/blocked/unknown is not evidence of a passing pipeline
}

export function createGitlabDriver(repoRoot: string, repoRef: GitlabRepoRef): ForgeDriver {
  const parsed = repoRefSchema.safeParse(repoRef);
  const ref = parsed.success ? parsed.data : null;
  const base = ref ? `https://${ref.host}/${ref.owner.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(ref.repo)}` : '';
  const projectPath = ref ? `${ref.owner}/${ref.repo}` : '';
  const endpoint = `projects/${encodeURIComponent(projectPath)}`;
  const key = JSON.stringify([repoRoot, ref]);
  function cache(): Cache {
    let value = caches.get(key);
    if (!value) {
      value = { lists: new Map() };
      caches.set(key, value);
      while (caches.size > 50) caches.delete(caches.keys().next().value!);
    }
    return value;
  }
  function remember(result: ForgeAvailability): ForgeAvailability {
    cache().availability = { at: Date.now(), result };
    return result;
  }
  function requireRef(): GitlabRepoRef {
    if (!ref) throw new GitlabError('GitLab repository reference is invalid.');
    return ref;
  }
  async function command(bin: 'glab' | 'git', args: string[], cwd = repoRoot, timeout = 15_000): Promise<string> {
    // Global token/host overrides bypass glab's per-host credential lookup. Never send one
    // project's token to another host. GLAB_CONFIG_DIR still selects the user's CLI store.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0' };
    if (bin === 'glab') {
      for (const name of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'GLAB_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN', 'JOB_TOKEN',
        'GITLAB_HOST', 'GITLAB_URI', 'GITLAB_URL', 'GL_HOST', 'REMOTE_ALIAS', 'GIT_REMOTE_URL_VAR']) delete env[name];
    }
    try {
      const { stdout } = await exec(bin, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env });
      return stdout;
    } catch (error) {
      // Never echo argv, stderr or URLs from a failed process: they can contain credentials
      // from git remotes, the user's prompt or a vendor's response body.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GitlabError(`${bin} CLI not found. Install it before using GitLab.`);
      throw new GitlabError(bin === 'glab'
        ? `GitLab request failed. Check connectivity and run glab auth login --hostname ${ref?.host ?? 'HOST'}.`
        : 'Git operation failed. Check the worktree, origin remote and git authentication.');
    }
  }
  async function api<T>(path: string, schema: z.ZodType<T>, fields?: Record<string, string>): Promise<T> {
    const validRef = requireRef();
    const args = ['api', '--hostname', validRef.host, '--method', fields ? 'POST' : 'GET', path];
    // --raw-field treats @file, true, numbers and placeholders as literal user text.
    for (const [name, value] of Object.entries(fields ?? {})) args.push('--raw-field', `${name}=${value}`);
    return schema.parse(JSON.parse(await command('glab', args)));
  }
  async function project() {
    const value = await api(endpoint, projectSchema);
    if (value.path_with_namespace.toLowerCase() !== projectPath.toLowerCase()) throw new GitlabError('GitLab returned a different project.');
    return value;
  }
  function item(row: z.infer<typeof issueSchema>, kind: 'issue' | 'pr'): ForgeItem {
    return {
      kind, number: row.iid, title: row.title, author: row.author?.username ?? '?', createdAt: row.created_at,
      labels: row.labels, body: (row.description ?? '').slice(0, 8000), comments: row.user_notes_count,
      // Rebuild from the validated host/namespace. Never surface credential-bearing vendor URLs.
      url: `${base}/-/${kind === 'pr' ? 'merge_requests' : 'issues'}/${row.iid}`,
      ...(kind === 'pr' ? { isDraft: isDraft(row as MergeRequest), checks: null } : {}),
    };
  }
  async function rows(kind: 'issue' | 'pr', query: URLSearchParams): Promise<ForgeItem[]> {
    const path = `${endpoint}/${kind === 'pr' ? 'merge_requests' : 'issues'}?${query}`;
    return kind === 'pr'
      ? (await api(path, mrListSchema)).map((row) => item(row, kind))
      : (await api(path, z.array(issueSchema).max(ITEM_CAP))).map((row) => item(row, kind));
  }
  async function list(kind: 'issue' | 'pr', opts?: { limit?: number; refresh?: boolean }): Promise<ForgeItem[]> {
    if (process.env.CEZ_DRY_RUN === '1') return [];
    const limit = cappedLimit(opts?.limit);
    const slot = `${kind}:${limit}`;
    const hit = cache().lists.get(slot);
    if (!opts?.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.items;
    try {
      const items = (await rows(kind, new URLSearchParams({ state: 'opened', scope: 'all', order_by: 'created_at', sort: 'desc', per_page: String(limit), page: '1' }))).slice(0, limit);
      cache().lists.set(slot, { at: Date.now(), items });
      while (cache().lists.size > 8) cache().lists.delete(cache().lists.keys().next().value!);
      remember({ available: true });
      return items;
    } catch (error) {
      const reason = failure(error);
      remember({ available: false, reason });
      throw new GitlabError(reason);
    }
  }
  async function branchMrs(branch: string, state: 'all' | 'opened'): Promise<MergeRequest[]> {
    const query = new URLSearchParams({ scope: 'all', state, source_branch: branch, order_by: 'updated_at', sort: 'desc', per_page: String(ITEM_CAP), page: '1' });
    const rows = await api(`${endpoint}/merge_requests?${query}`, mrListSchema);
    const matches = rows.filter((mr) => mr.source_branch === branch && mr.source_project_id === mr.target_project_id && (state === 'all' || mr.state === 'opened'));
    if (!matches.length && rows.length === ITEM_CAP) throw new GitlabError('GitLab merge request lookup was truncated. Check existing merge requests before publishing.');
    return matches;
  }
  async function validBranch(branch: string, cwd: string): Promise<void> {
    if (!branch || branch.length > 1024 || branch.startsWith('-') || branch.includes('@{') || /[\x00-\x20\x7f]/.test(branch)) throw new GitlabError('Cannot publish an invalid branch.');
    await command('git', ['check-ref-format', '--branch', branch], cwd);
  }
  function matchesRemote(remote: string): boolean {
    if (!remote || /[\r\n]/.test(remote)) return false;
    try {
      const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
      const url = new URL(remote.includes('://') ? remote : `ssh://${scp?.[1]}/${scp?.[2]}`);
      const host = ['http:', 'https:'].includes(url.protocol) ? url.host : url.hostname;
      return ['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol) && host.toLowerCase() === ref?.host.toLowerCase()
        && url.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, '') === projectPath;
    } catch { return false; }
  }
  async function createPR(input: DraftPrInput): Promise<DraftPrOutcome> {
    try {
      requireRef();
      const { run } = input;
      const cwd = run.worktreePath;
      if (!cwd || !run.branch) throw new GitlabError('This task has no worktree/branch to publish.');
      // Agents may check out a different branch. Publish what holds the final autosave,
      // never a stale run.branch or detached HEAD. Full refs below prevent refspec injection.
      const branch = (await command('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).trim();
      await validBranch(branch, cwd);
      const saved = await autosaveCommit(cwd, 'pre-PR');
      if (saved === 'refused') throw new GitlabError('Worktree has unresolved merge conflicts. Resolve them, then publish again.');
      if (saved === 'failed') throw new GitlabError('Could not commit the final changes. Check git status in the worktree.');
      // autosave's recovery-oriented helper treats an unreadable status as nothing-to-do.
      // Publishing cannot: prove the final flush left a readable, clean worktree.
      // Test mutation: final status guard removed temporarily.
      if (process.env.CEZ_DRY_RUN === '1') return { ok: true, url: `${base}/-/merge_requests/777`, dryRun: true };

      // Refuse a switched origin or fork push URL, including multiple push URLs. API routing
      // must describe the project receiving the push, not merely the original worktree remote.
      const remote = (await command('git', ['remote', 'get-url', '--push', '--all', 'origin'], cwd)).trim();
      if (!matchesRemote(remote)) throw new GitlabError('The worktree origin push URL does not match this GitLab project.');
      const targetProject = await project();
      const configured = run.baseBranch?.replace(/^origin\//, '');
      // Match GitHub: a detached fork SHA is not a base branch, so use the project default.
      const target = configured && !/^[0-9a-f]{7,40}$/i.test(configured) ? configured : targetProject.default_branch;
      if (!target) throw new GitlabError('GitLab project has no default branch.');
      await validBranch(target, cwd);
      if (branch === target || branch === targetProject.default_branch) throw new GitlabError('Cannot publish the target or default branch as a task merge request.');
      const existing = (await branchMrs(branch, 'opened')).find((mr) => mr.target_project_id === targetProject.id);
      if (existing && existing.target_branch !== target) throw new GitlabError('This branch already has an open merge request with a different target branch.');
      const current = (await command('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).trim();
      if (current !== branch) throw new GitlabError('The worktree branch changed during publication. Try again.');
      await command('git', ['push', '-u', '--', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], cwd, 60_000);
      const outcome = (mr: MergeRequest): DraftPrOutcome => ({ ok: true, url: `${base}/-/merge_requests/${mr.iid}`, dryRun: false });
      // Keep an existing MR's human-selected draft/ready state. Never duplicate or auto-merge.
      if (existing) return outcome(existing);
      const title = (run.title || run.task).replace(/[\x00-\x1f\x7f]/g, ' ').trim().replace(/^(?:Draft:|WIP:)\s*/i, '').slice(0, 248);
      try {
        const mr = await api(`${endpoint}/merge_requests`, mrSchema, {
          source_branch: branch, target_branch: target, title: `Draft: ${title || 'Cezar task'}`,
          description: Buffer.from(buildPrBody(input.handoffText, run.task).replace(/\0/g, '')).subarray(0, BODY_CAP).toString('utf8'),
        });
        if (!isDraft(mr) || mr.source_branch !== branch || mr.target_branch !== target || mr.source_project_id !== targetProject.id || mr.target_project_id !== targetProject.id) {
          throw new GitlabError('GitLab returned an unexpected merge request. Check the project before retrying.');
        }
        cache().lists.clear();
        return outcome(mr);
      } catch (error) {
        // Concurrent clicks or a timed-out POST can already have created the MR. A bounded
        // re-read makes retries idempotent without interpreting vendor error text.
        const raced = (await branchMrs(branch, 'opened')).find((mr) => isDraft(mr) && mr.target_project_id === targetProject.id && mr.target_branch === target);
        if (raced) return outcome(raced);
        throw error;
      }
    } catch (error) { return { ok: false, error: failure(error) }; }
  }
  return {
    kind: 'gitlab',
    detect: async () => {
      if (!ref) return remember({ available: false, reason: 'GitLab repository reference is invalid.' });
      if (process.env.CEZ_DRY_RUN === '1') return { available: true };
      const state = cache();
      if (state.availability && Date.now() - state.availability.at < CACHE_MS) return state.availability.result;
      if (state.probe) return state.probe;
      state.probe = project().then(() => remember({ available: true }), (error: unknown) => remember({ available: false, reason: failure(error) })).finally(() => { delete state.probe; });
      return state.probe;
    },
    detectCached: () => {
      if (!ref) return { available: false, reason: 'GitLab repository reference is invalid.' };
      if (process.env.CEZ_DRY_RUN === '1') return { available: true };
      return caches.get(key)?.availability?.result ?? null;
    },
    listIssues: (opts) => list('issue', opts),
    listPRs: (opts) => list('pr', opts),
    searchItems: async (kind, query, opts) => {
      try {
        requireRef();
        if (process.env.CEZ_DRY_RUN === '1') return { available: true, items: [], truncated: false };
        if (!query.trim() || query.length > 1000 || /[\x00-\x1f\x7f]/.test(query)) return { available: false, items: [], reason: 'GitLab search requires 1 to 1000 characters without control characters.' };
        const limit = cappedLimit(opts?.limit);
        // GitLab's literal title/description search, not GitHub's qualifier language. One page
        // only; a full page reports truncation rather than claiming all results were found.
        const items = (await rows(kind, new URLSearchParams({ state: 'all', scope: 'all', search: query, per_page: String(limit), page: '1' }))).slice(0, limit);
        return { available: true, items, truncated: items.length >= limit };
      } catch (error) { return { available: false, items: [], reason: failure(error) }; }
    },
    createPR,
    prStatus: async (branch) => {
      if (process.env.CEZ_DRY_RUN === '1') return null;
      try {
        if (!branch || branch.length > 1024 || /[\x00-\x1f\x7f]/.test(branch)) return null;
        const matches = await branchMrs(branch, 'all');
        const match = matches.find((mr) => mr.state === 'opened' || mr.state === 'locked') ?? matches[0];
        if (!match) return null;
        const mr = await api(`${endpoint}/merge_requests/${match.iid}`, mrSchema);
        if (mr.source_branch !== branch || mr.source_project_id !== mr.target_project_id) return null;
        return { number: mr.iid, url: `${base}/-/merge_requests/${mr.iid}`, state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open', isDraft: isDraft(mr), checks: checks(mr) };
      } catch { return null; }
    },
    viewUrl: (kind, value) => {
      if (!ref) return null;
      if (kind === 'repo') return base;
      const text = String(value);
      if (!text || /[\x00-\x1f\x7f]/.test(text) || text.split('/').some((part) => part === '.' || part === '..')) return null;
      if ((kind === 'issue' || kind === 'pr') && !/^[1-9]\d*$/.test(text)) return null;
      const path = text.split('/').map(encodeURIComponent).join('/');
      const segment = { issue: 'issues', pr: 'merge_requests', branch: 'tree', commit: 'commit' }[kind];
      return `${base}/-/${segment}/${path}`;
    },
  };
}
