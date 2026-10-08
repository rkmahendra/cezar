import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ForgeConnection } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { ForgeSection } from './forge-section'

const connection: ForgeConnection = { kind: 'gitlab', host: 'gitlab.example.com', repository: 'team/sub/repo', url: 'https://gitlab.example.com/team/sub/repo', status: 'untested', reason: null }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function mount(projectId = 'project-a') {
  const client = createQueryClient()
  const view = (id: string) => <QueryClientProvider client={client}><ProjectScopeProvider projectId={id}><ForgeSection /></ProjectScopeProvider></QueryClientProvider>
  const rendered = render(view(projectId))
  return { ...rendered, changeProject: (id: string) => rendered.rerender(view(id)) }
}

it('shows headless setup, tests only on click and reloads without repeating a vendor probe', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url)
    return json({ ...connection, status: url.includes('test=1') ? 'available' : 'untested' })
  }))
  mount()
  await screen.findByText('team/sub/repo')
  expect(screen.getByRole('status').textContent).toBe('Not tested')
  expect(screen.getByText('glab auth login --hostname "gitlab.example.com"')).toBeTruthy()
  expect(requests).toEqual(['/api/v1/p/project-a/forge/connection'])
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByText('Repository read access verified')
  expect(requests[1]).toBe('/api/v1/p/project-a/forge/connection?test=1')
  fireEvent.click(screen.getByRole('button', { name: 'Reload connection' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Not tested'))
  expect(requests.at(-1)).toBe('/api/v1/p/project-a/forge/connection')
})

it('explains unknown hosts, offers both CLI instructions and never probes an unconfigured provider', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ...connection, kind: null, url: null, status: 'unconfigured', reason: 'Unknown host' })))
  mount()
  await screen.findByText('Unknown host')
  expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('CLI setup provider'), { target: { value: 'gitlab' } })
  expect(screen.getByText('glab auth login --hostname "gitlab.example.com"')).toBeTruthy()
})

it('clears old test state when project changes and ignores late success from the old project', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('test=1')) return new Promise<Response>(resolve => { finish = resolve })
    return json({ ...connection, repository: url.includes('project-b') ? 'other/repo' : connection.repository })
  }))
  const page = mount()
  await screen.findByText('team/sub/repo')
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  page.changeProject('project-b')
  await screen.findByText('other/repo')
  finish(json({ ...connection, status: 'available' }))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Not tested'))
  expect(screen.queryByText('team/sub/repo')).toBeNull()
})

it('renders network failures and demo results without claiming real access', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('test=1')
    ? json({ ...connection, status: 'demo', reason: 'Demo mode: no real connection was tested.' }) : json(connection)))
  mount()
  await screen.findByText('team/sub/repo')
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByText('Demo only')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('status').textContent).toBe('Connection check unavailable')
})
