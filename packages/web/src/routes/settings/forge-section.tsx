import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { getForgeConnection } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { isHttpUrl } from '@/lib/utils'

/** No global health fallback: a headless server can host projects on different forges. */
export function ForgeSection() {
  const { projectId } = useProjectScope()
  return <ForgeConnectionPanel key={projectId ?? 'default'} projectId={projectId} />
}

function ForgeConnectionPanel({ projectId }: { projectId: string | null }) {
  const queryClient = useQueryClient()
  const queryKey = ['forge-connection', projectId ?? 'default'] as const
  const reconcile = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.health })
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
    // Stale lists must reload on next visit, not launch vendor reads from Settings.
    void queryClient.invalidateQueries({ queryKey: [projectId ?? 'default', 'github'], refetchType: 'none' })
    void queryClient.invalidateQueries({ queryKey: [projectId ?? 'default', 'repo'], refetchType: 'none' })
  }
  const connection = useQuery({ queryKey, queryFn: ({ signal }) => getForgeConnection(false, { signal }), staleTime: Infinity, refetchOnMount: 'always' })
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github')
  const test = useMutation({
    mutationFn: () => getForgeConnection(true),
    onSuccess: data => { queryClient.setQueryData(queryKey, data); reconcile() },
  })
  const data = connection.data
  const kind = data?.kind ?? provider
  const cli = kind === 'gitlab' ? 'glab' : 'gh'
  const host = data?.host ?? (kind === 'gitlab' ? 'gitlab.com' : 'github.com')
  const busy = connection.isFetching || test.isPending
  const error = test.error ?? connection.error
  const status = test.isPending ? 'Testing…' : error ? 'Connection check unavailable' : ({
    unconfigured: 'Not configured', untested: 'Not tested', available: 'Repository read access verified',
    unavailable: 'Unavailable', demo: 'Demo only',
  } as const)[data?.status ?? 'untested']

  return <div className="min-w-0 max-w-3xl space-y-5 p-4 md:p-6" data-slot="forge-connection">
    <p className="text-sm text-muted-foreground">Use existing GitHub or GitLab CLI authentication on the server. This panel does not save tokens or change Git remotes.</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border p-4 text-sm">
      <dt>Provider</dt><dd>{data?.kind === 'gitlab' ? 'GitLab' : data?.kind === 'github' ? 'GitHub' : 'Not detected'}</dd>
      <dt>Hostname</dt><dd className="break-all font-mono">{data?.host ?? 'Not configured'}</dd>
      <dt>Repository</dt><dd className="break-all font-mono">{data?.repository ?? 'Not configured'}</dd>
      <dt>Status</dt><dd role="status" aria-live="polite">{connection.isPending ? 'Loading…' : status}</dd>
    </dl>
    {error ? <p role="alert" className="text-sm text-danger">{error.message}</p> : data?.reason ? <p className="text-sm text-muted-foreground">{data.reason}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !data?.kind || connection.isError} onClick={() => test.mutate()}>Test connection</Button>
      <Button variant="outline" disabled={busy} onClick={() => { test.reset(); void connection.refetch().then(reconcile) }}>Reload connection</Button>
      {data?.url && isHttpUrl(data.url) ? <Button variant="outline" asChild><a href={data.url} target="_blank" rel="noopener noreferrer">Open repository</a></Button> : null}
    </div>
    <p className="text-xs text-muted-foreground">Testing performs a fresh repository read, not a push or permission change. A successful test does not prove Git push access. Nothing is tested automatically.</p>
    <section className="space-y-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-semibold">Connect on the server</h2>
      {!data?.kind ? <label className="flex items-center gap-3 text-sm">CLI setup for
        <select aria-label="CLI setup provider" value={provider} onChange={event => setProvider(event.target.value as 'github' | 'gitlab')} className="rounded border border-border bg-background p-1 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <option value="github">GitHub / GitHub Enterprise Server</option><option value="gitlab">GitLab / GitLab self-managed</option>
        </select>
      </label> : null}
      <p className="text-sm text-muted-foreground">Install {cli} and run this over SSH as the OS user running cezar, not as root or your laptop user. Complete CLI authentication there, then reload and test here.</p>
      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs"><code>{`${cli} auth login --hostname ${JSON.stringify(host)}`}</code></pre>
      {!data?.repository ? <p className="text-sm text-muted-foreground">Clone the intended repository or configure its Git remote on the server first. This panel never changes the destination.</p> : null}
      <p className="text-xs text-muted-foreground">Self-hosted hosts must appear in the matching CLI's host inventory. Configure only one provider per hostname. Git push needs separate SSH or HTTPS Git credentials. Keep cezar loopback-bound behind an SSH tunnel or authenticated HTTPS proxy.</p>
    </section>
  </div>
}
