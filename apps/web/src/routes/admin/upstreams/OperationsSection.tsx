import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput
} from '@mantine/core'
import type { OperationDecision, OperationView } from '@ctxlayer/shared'
import { fetchUpstreamOperations, decideUpstreamOperation } from '../../../lib/api/operations'
import { Section, explain } from './helpers'
import { ApiError } from '../../../lib/api/core'

function explainDecision(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
    if (err.body.error === 'approver_required')
      return 'A different active admin assigned to this project must approve or reconcile this operation.'
    if (err.body.error === 'approval_snapshot_changed')
      return 'The policy, credential, or tool changed. The requester must submit a new operation for review.'
    if (err.body.error === 'operation_state_conflict')
      return 'This operation changed or expired. Refresh the list before deciding.'
  }
  return explain(err)
}

export function OperationsSection({ upstreamId }: { upstreamId: string }) {
  const [operations, setOperations] = useState<OperationView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const result = await fetchUpstreamOperations(upstreamId, signal)
      if (!signal?.aborted) {
        setOperations(result.operations)
        setLoaded(true)
        setError(null)
      }
    },
    [upstreamId]
  )
  useEffect(() => {
    const ctrl = new AbortController()
    void reload(ctrl.signal).catch((err: unknown) => {
      if (!ctrl.signal.aborted) setError(explain(err))
    })
    return () => ctrl.abort()
  }, [reload])
  return (
    <Section title="Operations and approvals">
      <Stack gap="sm">
        <Text size="sm">
          Review the exact action and arguments before approval. A different admin with project
          access must approve. Approval alone does not execute the operation.
        </Text>
        {error && <Alert color="red">{error}</Alert>}
        <Button
          variant="light"
          onClick={() => void reload().catch((err: unknown) => setError(explain(err)))}
        >
          Refresh operations
        </Button>
        {loaded && operations.length === 0 && (
          <Text c="dimmed" size="sm">
            No operations in your project scope.
          </Text>
        )}
        {operations.map((operation) => (
          <OperationCard
            key={operation.id}
            upstreamId={upstreamId}
            operation={operation}
            onChanged={() => reload()}
          />
        ))}
      </Stack>
    </Section>
  )
}

function OperationCard({
  upstreamId,
  operation,
  onChanged
}: {
  upstreamId: string
  operation: OperationView
  onChanged: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [reference, setReference] = useState('')
  const [outcome, setOutcome] = useState<'succeeded' | 'failed'>('succeeded')
  async function decide(decision: OperationDecision) {
    setBusy(true)
    setError(null)
    try {
      await decideUpstreamOperation(upstreamId, operation.id, decision)
      await onChanged()
    } catch (err) {
      setError(explainDecision(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{operation.tool}</Text>
          <Badge>{operation.state}</Badge>
        </Group>
        <Text size="xs">Requested by {operation.requesterLabel ?? operation.requesterId}</Text>
        <Text size="xs" c="dimmed">
          Approval expires {new Date(operation.expiresAt * 1000).toLocaleString()}
        </Text>
        <Code block>{JSON.stringify(operation.args, null, 2)}</Code>
        {operation.errorCode && (
          <Text c="red" size="sm">
            {operation.errorCode}
          </Text>
        )}
        {error && <Alert color="red">{error}</Alert>}
        {operation.state === 'pending' && (
          <Group>
            <Button loading={busy} onClick={() => void decide({ action: 'approve' })}>
              Approve exact operation
            </Button>
            <Button
              color="red"
              variant="light"
              disabled={busy}
              onClick={() => void decide({ action: 'reject' })}
            >
              Reject operation
            </Button>
          </Group>
        )}
        {operation.state === 'approved' && (
          <Text size="sm">Approved — waiting for the requester to execute.</Text>
        )}
        {operation.state === 'unknown' && (
          <>
            <Alert color="yellow">
              The provider may have applied this action. Verify its records before recording an
              outcome. This does not resend the operation.
            </Alert>
            <Select
              label="Verified outcome"
              value={outcome}
              onChange={(v) => {
                if (v === 'succeeded' || v === 'failed') setOutcome(v)
              }}
              data={['succeeded', 'failed']}
            />
            <TextInput
              label="Provider record or investigation reference"
              value={reference}
              onChange={(e) => setReference(e.currentTarget.value)}
              maxLength={200}
            />
            <Textarea
              label="Reconciliation note"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              maxLength={1000}
            />
            <Button
              loading={busy}
              disabled={note.length < 10 || !reference}
              onClick={() => void decide({ action: 'resolve', outcome, note, reference })}
            >
              Record verified outcome
            </Button>
          </>
        )}
        {operation.resolution && (
          <Text size="sm">
            Reconciled: {operation.resolution.note} ({operation.resolution.reference})
          </Text>
        )}
        {operation.result != null && (
          <details>
            <summary>Recorded result</summary>
            <Code block>{JSON.stringify(operation.result, null, 2)}</Code>
          </details>
        )}
      </Stack>
    </Paper>
  )
}
