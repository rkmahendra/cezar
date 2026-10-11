import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { ApiError, createWorkflow } from '@/api/client'
import { queryKeys } from '@/api/queries'
import type { AttachmentInput, PlanResponse, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'

export type PendingPlan = PlanResponse & { task: string; images: AttachmentInput[] }

/** Spec 008: planning never launches work. Review, reorder/remove, then Start or save a chain. */
export function PlanReview({ plan, starting, startAvailable, onStepsChange, onStart, onDiscard }: {
  plan: PendingPlan
  starting: boolean
  startAvailable: boolean
  onStepsChange: (steps: WorkflowStepDef[]) => void
  onStart: () => void
  onDiscard: () => void
}) {
  const queryClient = useQueryClient()
  const saveButton = useRef<HTMLButtonElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const save = useMutation({
    mutationFn: () => createWorkflow({ name: name.trim(), steps: plan.steps, ...(overwrite ? { overwrite: true } : {}) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflows })
      setSaving(false)
      setOverwrite(false)
      toast('Chain saved')
    },
    onError: (error) => {
      if (error instanceof ApiError && error.exists) setOverwrite(true)
      else toast(error.message, { tone: 'danger' })
    },
  })
  const move = (from: number, to: number) => {
    const steps = [...plan.steps]
    const [step] = steps.splice(from, 1)
    if (!step) return
    steps.splice(to, 0, step)
    onStepsChange(steps)
  }
  const busy = starting || save.isPending
  const empty = plan.steps.length === 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDiscard() }}>
      <DialogContent
        showCloseButton={false}
        data-slot="plan-review"
        className="flex flex-col overflow-y-auto max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 sm:max-h-[85dvh] sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task for the agent"]')?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Proposed chain</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">{plan.task}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {plan.fallback ? 'Planner unavailable: single-step plan.' : plan.rationale}
        </p>
        <fieldset disabled={busy} className="shrink-0">
          <legend className="sr-only">Proposed steps</legend>
          <ol className="space-y-2">
            {plan.steps.map((step, index) => (
              <li
                key={step.id}
                draggable={!busy}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  if (!busy && dragIndex !== null) move(dragIndex, index)
                  setDragIndex(null)
                }}
                onDragEnd={() => setDragIndex(null)}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{index + 1}. {step.name ?? step.id}</p>
                  {step.skill ? <p className="text-xs text-muted-foreground">{step.skill}</p> : null}
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{step.command ?? step.prompt}</p>
                </div>
                {/* Native drag handles do not work on touch. Buttons keep ordering accessible. */}
                <Button variant="ghost" size="sm" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</Button>
                <Button variant="ghost" size="sm" aria-label={`Move step ${index + 1} down`} disabled={index === plan.steps.length - 1} onClick={() => move(index, index + 1)}>↓</Button>
                <Button variant="ghost" size="sm" aria-label={`Remove step ${index + 1}`} onClick={() => onStepsChange(plan.steps.filter((_, i) => i !== index))}>Remove</Button>
              </li>
            ))}
          </ol>
          {empty ? <p className="text-sm">No steps left. Discard and plan again.</p> : null}
        </fieldset>
        {!startAvailable ? (
          <p className="text-xs text-muted-foreground">Wait for skills and providers to load, or <Link className="underline" to="/settings/agents#providers">configure providers</Link>.</p>
        ) : null}
        <div className="flex flex-wrap gap-2 pb-[env(safe-area-inset-bottom)]">
          <Button disabled={empty || busy || !startAvailable} onClick={onStart}>{starting ? 'Starting…' : 'Start'}</Button>
          <Button ref={saveButton} variant="outline" disabled={empty || busy} onClick={() => setSaving(true)}>Save as chain</Button>
          <Button variant="ghost" disabled={busy} className="ml-auto" onClick={onDiscard}>Discard</Button>
        </div>
        <Dialog open={saving} onOpenChange={(open) => { if (!save.isPending) { setSaving(open); setOverwrite(false) } }}>
          <DialogContent showCloseButton={false} onCloseAutoFocus={(event) => {
            event.preventDefault()
            saveButton.current?.focus()
          }}>
            <DialogHeader>
              <DialogTitle>Save as chain</DialogTitle>
              <DialogDescription>Save these steps as a reusable workflow.</DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && !save.isPending) save.mutate() }}>
              <Input aria-label="Chain name" autoFocus maxLength={80} value={name} disabled={save.isPending} onChange={(event) => { setName(event.target.value); setOverwrite(false) }} />
              {overwrite ? <p role="alert" className="mt-2 text-sm">“{name.trim()}” already exists. Overwrite replaces its steps with this plan.</p> : null}
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={save.isPending} onClick={() => { setSaving(false); setOverwrite(false) }}>Cancel</Button>
                <Button type="submit" disabled={!name.trim() || save.isPending}>{save.isPending ? 'Saving…' : overwrite ? 'Overwrite' : 'Save'}</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
