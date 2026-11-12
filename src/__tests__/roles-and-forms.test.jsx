import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ perms: [], logout: vi.fn(), post: vi.fn() }))
vi.mock('../store', () => ({
  useApp: () => ({ can: (p) => h.perms.includes(p), logout: h.logout, user: { username: 'tester' } }),
  useLoad: () => ({ data: { payments: [] }, loading: false, error: null, reload: () => {} }),
}))
vi.mock('../api', () => ({ api: { get: vi.fn(), post: (...a) => h.post(...a) }, errMsg: (e) => e.message }))
vi.mock('../components/common', async (orig) => ({ ...(await orig()), useToast: () => () => {} }))
import { ChangePassword, More } from '../screens/Admin'

const STAFF = ['customers.view', 'invoices.view', 'notifications.view', 'settings.view']
const ADMIN = [...STAFF, 'payments.verify', 'halls.manage', 'mealmenu.manage', 'menu.manage', 'vendors.view', 'users.manage', 'reports.view', 'audit.view']
const nav = { go: vi.fn() }

describe('role-based menu (More)', () => {
  beforeEach(() => { nav.go.mockClear() })
  test('a staff account does not see admin-only entries', () => {
    h.perms = STAFF
    render(<More nav={nav} />)
    for (const hidden of ['Users & roles', 'Manage Halls', 'Audit Log', 'Reports', 'Payments to verify', 'Catering Prices']) expect(screen.queryByRole('button', { name: new RegExp('^' + hidden) }), hidden).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Customers/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Change password/ })).toBeInTheDocument()
  })
  test('an admin sees every management entry, and an entry navigates to its screen', async () => {
    h.perms = ADMIN
    render(<More nav={nav} />)
    for (const shown of ['Users & roles', 'Manage Halls', 'Audit Log', 'Reports', 'Payments to verify', 'Catering Prices']) expect(screen.getByRole('button', { name: new RegExp('^' + shown) }), shown).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /^Users & roles/ }))
    expect(nav.go).toHaveBeenCalledWith('users')
  })
})

describe('Change password form', () => {
  beforeEach(() => { h.post.mockReset(); h.logout.mockClear(); h.perms = STAFF })
  test('submit is disabled until both password fields are filled', async () => {
    render(<ChangePassword />)
    const btn = screen.getByRole('button', { name: 'Change password' })
    expect(btn).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText('Current password'), 'old-password-1')
    expect(btn).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText('New password'), 'NewPassw0rd!')
    expect(btn).toBeEnabled()
  })
  test('mismatching repeat is refused on the client and nothing is sent', async () => {
    render(<ChangePassword />)
    const u = userEvent.setup()
    await u.type(screen.getByLabelText('Current password'), 'old-password-1')
    await u.type(screen.getByLabelText('New password'), 'NewPassw0rd!')
    await u.type(screen.getByLabelText('Repeat new password'), 'Different1!')
    await u.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')
    expect(h.post).not.toHaveBeenCalled()
  })
  test('a server rejection is shown and the user is NOT signed out; success signs out', async () => {
    h.post.mockRejectedValueOnce(new Error('Password must be at least 10 characters'))
    render(<ChangePassword />)
    const u = userEvent.setup()
    await u.type(screen.getByLabelText('Current password'), 'old-password-1')
    await u.type(screen.getByLabelText('New password'), 'short')
    await u.type(screen.getByLabelText('Repeat new password'), 'short')
    await u.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 10')
    expect(h.logout).not.toHaveBeenCalled()
    h.post.mockResolvedValueOnce({ ok: true })
    await u.clear(screen.getByLabelText('New password')); await u.type(screen.getByLabelText('New password'), 'LongEnough123')
    await u.clear(screen.getByLabelText('Repeat new password')); await u.type(screen.getByLabelText('Repeat new password'), 'LongEnough123')
    await u.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(h.logout).toHaveBeenCalledTimes(1))
    expect(h.post).toHaveBeenLastCalledWith('/api/auth/change-password', { currentPassword: 'old-password-1', newPassword: 'LongEnough123' })
  })
})
