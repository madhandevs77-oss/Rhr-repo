import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ handler: null, calls: [], signedInAs: { id: 'u1', username: 'alice', permissions: ['bookings.view'] } }))
vi.mock('../api', () => ({
  setUnauthorizedHandler: (fn) => { h.handler = fn },
  api: {
    get: vi.fn(async (p) => {
      h.calls.push(p)
      if (p === '/api/auth/me') return { user: h.signedInAs }
      if (p === '/api/halls') return { halls: [{ id: 'h1', name: 'Alice Private Hall' }] }
      if (p === '/api/settings') return { business: { name: 'Alice Restaurant', phone: '', address: '' }, finance: { taxLabel: 'GST', defaultTaxRate: 5 } }
      if (p === '/api/catering/options') return { options: [{ id: 'o1', name: 'Alice Option', active: true }] }
      return {}
    }),
    post: vi.fn(async () => ({ ok: true })),
  },
}))
import { AppProvider, useApp } from '../store'

function Probe() {
  const a = useApp()
  return (
    <div>
      <span data-testid="user">{a.user === undefined ? 'checking' : a.user ? a.user.username : 'none'}</span>
      <span data-testid="halls">{a.halls.map((x) => x.name).join(',') || '-'}</span>
      <span data-testid="biz">{a.settings.business.name}</span>
      <span data-testid="tax">{a.settings.finance.defaultTaxRate}</span>
      <span data-testid="opts">{a.options.map((x) => x.name).join(',') || '-'}</span>
      <span data-testid="picked">{a.picked.join(',') || '-'}</span>
      <button onClick={() => a.togglePicked('dish1')}>pick</button>
      <button onClick={() => a.logout()}>logout</button>
    </div>
  )
}
const mount = () => render(<AppProvider><Probe /></AppProvider>)
const expectCleared = () => {
  expect(screen.getByTestId('user')).toHaveTextContent('none')
  expect(screen.getByTestId('halls')).toHaveTextContent('-')
  expect(screen.getByTestId('biz')).toHaveTextContent('RHR Veg Restaurant')
  expect(screen.getByTestId('tax')).toHaveTextContent('0')
  expect(screen.getByTestId('opts')).toHaveTextContent('-')
  expect(screen.getByTestId('picked')).toHaveTextContent('-')
}

describe('account state is cleared when the session ends', () => {
  beforeEach(() => { h.calls.length = 0 })
  test('logout clears user, halls, settings, catering options and picked dishes, and asks the service worker to wipe caches', async () => {
    const post = vi.fn(); Object.defineProperty(navigator, 'serviceWorker', { value: { controller: { postMessage: post } }, configurable: true })
    mount()
    await waitFor(() => expect(screen.getByTestId('opts')).toHaveTextContent('Alice Option'))
    expect(screen.getByTestId('biz')).toHaveTextContent('Alice Restaurant')
    await userEvent.setup().click(screen.getByText('pick'))
    expect(screen.getByTestId('picked')).toHaveTextContent('dish1')
    await userEvent.setup().click(screen.getByText('logout'))
    await waitFor(() => expectCleared())
    expect(post).toHaveBeenCalledWith({ type: 'CLEAR_CACHES' })
  })
  test('an expired session (401 from any API call) clears everything the same way', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('halls')).toHaveTextContent('Alice Private Hall'))
    act(() => h.handler())
    await waitFor(() => expectCleared())
  })
})
