import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { AdminUserRow } from '@ctxlayer/shared'
import { DialogProvider } from '../../lib/dialogs'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)

const kedi: AdminUserRow = {
  id: 'u-kedi',
  email: 'ada@example.com',
  name: 'Ada',
  avatarUrl: null,
  role: 'user',
  idp: 'kedi',
  status: 'active',
  createdAt: 1,
  lastSeenAt: null,
  teams: [],
  roles: [],
  credentialCount: 0
}

vi.mock('../../lib/api', () => ({
  fetchAdminUsers: vi.fn(async () => [kedi]),
  fetchRoles: vi.fn(async () => []),
  fetchInvites: vi.fn(async () => []),
  adminCreateInvites: vi.fn(),
  adminDeleteInvite: vi.fn()
}))

import { AdminUsers } from './users'
import { AdminInvites } from './invites'

function renderIn(node: ReactNode) {
  return render(
    <MantineProvider>
      <DialogProvider>{node}</DialogProvider>
    </MantineProvider>
  )
}

describe('kedi admin notes', () => {
  it('tells admins that email invites do not admit gateway users', async () => {
    renderIn(<AdminInvites />)
    expect(await screen.findByText(/do not admit Kedi gateway users/i)).toBeInTheDocument()
  })

  it('does not offer a local role change for a kedi user', async () => {
    renderIn(<AdminUsers />)
    fireEvent.click(await screen.findByText('ada@example.com'))
    expect(await screen.findByText(/Kedi manages this role/i)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /administrator/i })).toBeDisabled()
  })
})
