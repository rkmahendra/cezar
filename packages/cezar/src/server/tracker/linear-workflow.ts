import { z } from 'zod';
import { trackerWorkflowSchema, type TrackerWorkflow } from '@open-mercato/cezar-contract';
import { resolveTrackerAgentEnv, TrackerAgentBindingError } from './agent-credentials.ts';
import { createLinearGraphql } from './linear.ts';
import { requestFailure, runOperation } from './transport.ts';

export class TrackerWorkflowError extends Error {}

type Options = { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; checkOnly?: boolean; assertActive?: () => void };
const stateSchema = z.object({ id: z.uuid(), name: z.string().min(1), type: z.string().min(1) });
const issueSchema = z.object({
  id: z.uuid(), identifier: z.string(), url: z.url(), team: z.object({ id: z.uuid() }), state: stateSchema,
});
const issueQuery = `query CezWorkflowIssue($id: String!) {
  organization { id urlKey }
  issue(id: $id) { id identifier url team { id } state { id name type } }
}`;
const pending = new Map<string, Promise<unknown>>();

/** Serialize this process's same-issue writers, including two independently consented runs. */
async function withIssue<T>(binding: TrackerWorkflow, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([binding.association.source.id, binding.itemId]);
  const previous = pending.get(key);
  const next = (previous ?? Promise.resolve()).catch(() => {}).then(action);
  pending.set(key, next);
  try { return await next; }
  finally { if (pending.get(key) === next) pending.delete(key); }
}

async function operation<T>(root: string, binding: TrackerWorkflow, options: Options,
  action: (read: () => Promise<z.infer<typeof issueSchema>>, graphql: ReturnType<typeof createLinearGraphql>, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    trackerWorkflowSchema.parse(binding);
    return await runOperation(async signal => {
      const env = options.env ?? process.env;
      const credentials = await resolveTrackerAgentEnv(root, binding.association, env);
      if (!credentials.LINEAR_API_KEY) throw new TrackerAgentBindingError();
      const request = createLinearGraphql({ key: credentials.LINEAR_API_KEY }, options.fetcher);
      const assertCurrent = async () => {
        const current = await resolveTrackerAgentEnv(root, binding.association, env);
        if (current.LINEAR_API_KEY !== credentials.LINEAR_API_KEY) throw new TrackerAgentBindingError();
        options.assertActive?.();
        signal.throwIfAborted();
      };
      const graphql: typeof request = async (query, variables) => {
        // Recheck before requests and after in-flight responses, including the final readback.
        await assertCurrent();
        const data = await request(query, variables, signal);
        await assertCurrent();
        return data;
      };
      let issueId: string | undefined;
      const read = async () => {
        const data = z.object({ organization: z.object({ id: z.string(), urlKey: z.string() }), issue: issueSchema.nullable() })
          .parse(await graphql(issueQuery, { id: binding.itemId }, signal));
        const issue = data.issue;
        const url = issue ? new URL(issue.url) : null;
        if (!issue || issueId !== undefined && issue.id !== issueId || data.organization.id !== binding.association.source.id
          || `https://linear.app/${data.organization.urlKey}` !== binding.association.source.webUrl
          || issue.team.id !== binding.association.externalId || issue.identifier !== binding.itemId
          || url?.origin !== 'https://linear.app' || url.username || url.password
          || !url.pathname.startsWith(`/${data.organization.urlKey}/issue/${binding.itemId}/`) && url.pathname !== `/${data.organization.urlKey}/issue/${binding.itemId}`)
          throw new TrackerWorkflowError('Linear issue identity or scope changed. Launch a newly consented run.');
        issueId = issue.id;
        return issue;
      };
      return action(read, graphql, signal);
    });
  } catch (error) {
    if (error instanceof TrackerWorkflowError || error instanceof TrackerAgentBindingError) throw error;
    throw new TrackerWorkflowError(`Linear workflow: ${requestFailure(error).reason}`);
  }
}

/** First spawn only. Later steps/Continue validate identity without regressing workflow state.
 * ponytail: Linear has no compare-and-set here. Fresh reads cannot exclude external writes
 * between read and update. Same-process writers serialize; this is not a background synchronizer. */
export async function startTrackerWorkflow(root: string, binding: TrackerWorkflow, options: Options = {}): Promise<string> {
  if ((options.env ?? process.env).CEZ_DRY_RUN === '1') return 'Linear workflow: dry run, no vendor requests.';
  return withIssue(binding, () => operation(root, binding, options, async (read, graphql, signal) => {
    let issue = await read();
    if (options.checkOnly || binding.startedAt) return 'Linear workflow: issue identity and scope verified, status unchanged.';
    const checkState = () => {
      if (['completed', 'canceled'].includes(issue.state.type)) throw new TrackerWorkflowError('Linear issue is completed or canceled. It will not be reopened.');
      if (!['backlog', 'unstarted', 'started'].includes(issue.state.type)) throw new TrackerWorkflowError('Linear issue state is not eligible for automatic start. Choose its status in Linear and retry.');
    };
    checkState();
    if (issue.state.type === 'started') return 'Linear workflow: already started, status unchanged.';
    const data = z.object({ team: z.object({ id: z.uuid(), states: z.object({ nodes: z.array(stateSchema), pageInfo: z.object({ hasNextPage: z.boolean() }) }) }) })
      .parse(await graphql(`query CezWorkflowStates($id: String!) { team(id: $id) { id states(first: 100) { nodes { id name type } pageInfo { hasNextPage } } } }`, { id: binding.association.externalId }, signal));
    const states = data.team.states.nodes.filter(state => state.type === 'started');
    const named = states.filter(state => state.name.trim().toLowerCase() === 'in progress');
    const targets = named.length ? named : states;
    if (data.team.id !== binding.association.externalId || data.team.states.pageInfo.hasNextPage || targets.length !== 1)
      throw new TrackerWorkflowError('Linear team has no unique started state named In Progress or sole started state. Choose the intended status in Linear and launch a new run.');
    const target = targets[0]!;
    // A person may move the issue while state discovery is in flight. Never knowingly regress it.
    issue = await read();
    checkState();
    if (issue.state.type === 'started') return 'Linear workflow: already started, status unchanged.';
    z.object({ issueUpdate: z.object({ success: z.literal(true) }) }).parse(await graphql(
      'mutation CezWorkflowStart($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: issue.id, stateId: target.id }, signal));
    const observed = await read();
    if (observed.state.id !== target.id) throw new TrackerWorkflowError('Linear start update was not confirmed. Inspect the issue before retrying.');
    return 'Linear workflow: started state confirmed.';
  }));
}

/** Caller MUST supply an URL from a verified draft publication outcome, never run metadata.
 * ponytail: attach only, no guessed review-state transition or cross-process mutation lock. */
export async function attachTrackerWorkflowPublication(root: string, binding: TrackerWorkflow, verifiedPublicationUrl: string, options: Options = {}): Promise<string> {
  if ((options.env ?? process.env).CEZ_DRY_RUN === '1') return 'Linear workflow: dry run, no vendor requests.';
  const url = z.url({ protocol: /^https$/ }).safeParse(verifiedPublicationUrl);
  if (!url.success || new URL(url.data).username || new URL(url.data).password)
    throw new TrackerWorkflowError('Linear publication link must be a verified HTTPS draft URL.');
  return withIssue(binding, () => operation(root, binding, options, async (read, graphql, signal) => {
    const issue = await read();
    const attachments = async () => {
      const data = z.object({ issue: z.object({ id: z.uuid(), attachments: z.object({ nodes: z.array(z.object({ url: z.url() })), pageInfo: z.object({ hasNextPage: z.boolean() }) }) }) })
        .parse(await graphql('query CezWorkflowLinks($id: String!) { issue(id: $id) { id attachments(first: 100) { nodes { url } pageInfo { hasNextPage } } } }', { id: issue.id }, signal));
      if (data.issue.id !== issue.id || data.issue.attachments.pageInfo.hasNextPage)
        throw new TrackerWorkflowError('Linear attachments are incomplete. Inspect existing links before retrying.');
      return data.issue.attachments.nodes;
    };
    if ((await attachments()).some(link => link.url === url.data)) return 'Linear workflow: publication link already attached, status unchanged.';
    await read();
    z.object({ attachmentCreate: z.object({ success: z.literal(true) }) }).parse(await graphql(
      'mutation CezWorkflowAttach($issueId: String!, $url: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: "Draft code review" }) { success } }',
      { issueId: issue.id, url: url.data }, signal));
    await read();
    if (!(await attachments()).some(link => link.url === url.data)) throw new TrackerWorkflowError('Linear publication link was not confirmed. Inspect attachments before retrying.');
    return 'Linear workflow: publication link confirmed, status unchanged.';
  }));
}
