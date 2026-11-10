import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { Async, AsyncButton, Confirm, ErrorState, Field, KebabMenu } from '../components/common'

describe('Field', () => {
  test('label is programmatically tied to its input', () => {
    render(<Field label="Customer name *"><input /></Field>)
    expect(screen.getByLabelText('Customer name *')).toBeInTheDocument()
  })
})

describe('Async states', () => {
  test('loading shows a spinner, error shows an alert with retry, data renders', async () => {
    const reload = vi.fn()
    const { rerender } = render(<Async res={{ loading: true, data: null }}>{() => <p>data</p>}</Async>)
    expect(screen.queryByText('data')).not.toBeInTheDocument()
    rerender(<Async res={{ loading: false, error: new Error('Boom'), reload }}>{() => <p>data</p>}</Async>)
    expect(screen.getByRole('alert')).toHaveTextContent('Boom')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(reload).toHaveBeenCalled()
    rerender(<Async res={{ loading: false, data: { a: 1 } }}>{(d) => <p>data {d.a}</p>}</Async>)
    expect(screen.getByText('data 1')).toBeInTheDocument()
  })
  test('ErrorState falls back to a generic message', () => {
    render(<ErrorState error={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
  })
})

describe('AsyncButton prevents duplicate submissions', () => {
  test('a second click while the first is running is ignored', async () => {
    let finish
    const onClick = vi.fn(() => new Promise((r) => { finish = r }))
    render(<AsyncButton onClick={onClick}>Save</AsyncButton>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const btn = await screen.findByRole('button', { name: 'Please wait…' })
    expect(btn).toBeDisabled()
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    finish()
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled()
  })
})

describe('Confirm dialog', () => {
  test('runs onConfirm then closes; Cancel only closes', async () => {
    const onConfirm = vi.fn(), onClose = vi.fn()
    render(<Confirm title="Delete?" message="Sure?" confirmLabel="Delete" danger onConfirm={onConfirm} onClose={onClose} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('KebabMenu (dropdown)', () => {
  test('opens, runs an action, closes; Escape closes; disabled items cannot run', async () => {
    const edit = vi.fn(), del = vi.fn()
    render(<KebabMenu label="Actions for Dish" items={[{ label: 'Edit', onClick: edit }, { label: 'Delete', onClick: del, danger: true, disabled: true }]} />)
    const user = userEvent.setup()
    const btn = screen.getByRole('button', { name: 'Actions for Dish' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await user.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(del).not.toHaveBeenCalled()
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(edit).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await user.click(btn)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
