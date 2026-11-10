import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import Login from '../screens/Login'

const { login } = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('../store', () => ({ useApp: () => ({ login }) }))
const typeCreds = async (u, p) => {
  const user = userEvent.setup()
  if (u) await user.type(screen.getByLabelText('Username'), u)
  if (p) await user.type(screen.getByLabelText('Password'), p)
  return user
}

describe('Login form', () => {
  beforeEach(() => login.mockClear())
  test('submit stays disabled until both fields are filled', async () => {
    render(<Login />)
    const btn = screen.getByRole('button', { name: 'Sign in' })
    expect(btn).toBeDisabled()
    await typeCreds('admin', '')
    expect(btn).toBeDisabled()
    await userEvent.setup().type(screen.getByLabelText('Password'), 'x')
    expect(btn).toBeEnabled()
  })
  test('trims the username and sends credentials once', async () => {
    login.mockResolvedValue()
    render(<Login />)
    const user = await typeCreds('  admin  ', 'secret-pw')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(login).toHaveBeenCalledTimes(1)
    expect(login).toHaveBeenCalledWith('admin', 'secret-pw')
  })
  test('shows the server error in an alert and re-enables the form', async () => {
    login.mockRejectedValueOnce(new Error('Invalid username or password'))
    render(<Login />)
    const user = await typeCreds('admin', 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
  test('shows "Signing in…" and blocks a second submit while the request is running', async () => {
    let done
    login.mockReturnValue(new Promise((r) => { done = r }))
    render(<Login />)
    const user = await typeCreds('admin', 'pw12345678')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const busy = await screen.findByRole('button', { name: 'Signing in…' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    expect(login).toHaveBeenCalledTimes(1)
    done()
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))
  })
})
