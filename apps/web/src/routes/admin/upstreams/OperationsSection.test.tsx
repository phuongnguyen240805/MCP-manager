import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { OperationView } from '@ctxlayer/shared'
import { OperationsSection } from './OperationsSection'
import { fetchUpstreamOperations, decideUpstreamOperation } from '../../../lib/api/operations'
import { ApiError } from '../../../lib/api/core'

vi.mock('../../../lib/api/operations', () => ({
  fetchUpstreamOperations: vi.fn(),
  decideUpstreamOperation: vi.fn()
}))
const operation: OperationView = {
  id: '00000000-0000-4000-8000-000000000001',
  requesterId: 'user',
  requesterLabel: 'requester@test.local',
  upstreamId: 'up',
  tool: 'orders',
  args: { action: 'create', amount: 100 },
  state: 'pending',
  policyVersion: 1,
  createdAt: 0,
  expiresAt: 9999999999
}
beforeEach(() => {
  vi.mocked(fetchUpstreamOperations)
    .mockReset()
    .mockResolvedValue({ operations: [operation] })
  vi.mocked(decideUpstreamOperation)
    .mockReset()
    .mockResolvedValue({ ...operation, state: 'approved' })
})
function mount() {
  return render(
    <MantineProvider>
      <OperationsSection upstreamId="up" />
    </MantineProvider>
  )
}

describe('operation approval editor', () => {
  it('explains that self-approval or missing project access cannot authorize execution', async () => {
    vi.mocked(decideUpstreamOperation).mockRejectedValue(
      new ApiError(403, { error: 'approver_required' })
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve exact operation' }))
    expect(
      await screen.findByText(/A different active admin assigned to this project/)
    ).toBeInTheDocument()
  })
  it('shows the exact request and records approval without executing it', async () => {
    mount()
    const approve = await screen.findByRole('button', { name: 'Approve exact operation' })
    expect(screen.getByText(/requester@test.local/)).toBeInTheDocument()
    expect(screen.getByText(/"amount": 100/)).toBeInTheDocument()
    fireEvent.click(approve)
    await waitFor(() =>
      expect(decideUpstreamOperation).toHaveBeenCalledWith('up', operation.id, {
        action: 'approve'
      })
    )
  })
  it('requires a note and provider reference before reconciling an ambiguous result', async () => {
    vi.mocked(fetchUpstreamOperations).mockResolvedValue({
      operations: [{ ...operation, state: 'unknown' }]
    })
    mount()
    const resolve = await screen.findByRole('button', { name: 'Record verified outcome' })
    expect(resolve).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Provider record or investigation reference'), {
      target: { value: 'order-123' }
    })
    fireEvent.change(screen.getByLabelText('Reconciliation note'), {
      target: { value: 'Verified the order in provider records' }
    })
    expect(resolve).not.toBeDisabled()
    fireEvent.click(resolve)
    await waitFor(() =>
      expect(decideUpstreamOperation).toHaveBeenCalledWith('up', operation.id, {
        action: 'resolve',
        outcome: 'succeeded',
        note: 'Verified the order in provider records',
        reference: 'order-123'
      })
    )
  })
})
