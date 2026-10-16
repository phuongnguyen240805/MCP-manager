import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { InvocationPolicySection } from './InvocationPolicySection'
import { ApiError } from '../../../lib/api/core'
import { fetchInvocationPolicy, saveInvocationPolicy } from '../../../lib/api/upstreams'

vi.mock('../../../lib/api/upstreams', () => ({
  fetchInvocationPolicy: vi.fn(),
  saveInvocationPolicy: vi.fn()
}))
const policy = { productId: 'p1', rules: [] }

beforeEach(() => {
  vi.mocked(fetchInvocationPolicy).mockReset().mockResolvedValue({ policy, version: 7 })
  vi.mocked(saveInvocationPolicy).mockReset().mockResolvedValue({ policy, version: 8 })
})

function mount() {
  return render(
    <MantineProvider>
      <InvocationPolicySection
        upstreamId="up1"
        products={[{ id: 'p1', slug: 'p1', displayName: 'Project One' }]}
      />
    </MantineProvider>
  )
}

describe('invocation policy editor', () => {
  it('saves using the version loaded from the server and explains empty-rule denial', async () => {
    mount()
    const save = screen.getByRole('button', { name: 'Save invocation policy' })
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    await waitFor(() =>
      expect(saveInvocationPolicy).toHaveBeenCalledWith('up1', { expectedVersion: 7, policy })
    )
    expect(await screen.findByText(/Policy saved/)).toBeInTheDocument()
    expect(screen.getByText(/An empty list blocks every tool/)).toBeInTheDocument()
  })

  it('rejects malformed JSON before sending it to the server', async () => {
    mount()
    const save = screen.getByRole('button', { name: 'Save invocation policy' })
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.change(screen.getByLabelText('Tool and action rules (JSON)'), {
      target: { value: '{bad' }
    })
    fireEvent.click(save)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(saveInvocationPolicy).not.toHaveBeenCalled()
  })

  it('surfaces a stale-edit conflict and never claims that the policy was saved', async () => {
    vi.mocked(saveInvocationPolicy).mockRejectedValue(
      new ApiError(409, { message: 'Reload the policy before saving.' })
    )
    mount()
    const save = screen.getByRole('button', { name: 'Save invocation policy' })
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    expect(await screen.findByText('Reload the policy before saving.')).toBeInTheDocument()
    expect(screen.queryByText(/Policy saved/)).not.toBeInTheDocument()
  })
})
