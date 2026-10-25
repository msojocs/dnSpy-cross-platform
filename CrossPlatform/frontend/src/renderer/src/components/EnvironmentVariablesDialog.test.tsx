import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentVariablesDialog, environmentOfRows, formatEnvironmentRows, parseEnvironmentRows } from './EnvironmentVariablesDialog'

afterEach(() => cleanup())

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Environment Variables' })

describe('the environment editor', () => {
  it('edits the rows it opened on and writes them back on OK', () => {
    const onAccept = vi.fn()
    render(<EnvironmentVariablesDialog initial={[{ key: 'A', value: '1' }]} onClose={vi.fn()} onAccept={onAccept} />)

    fireEvent.change(within(dialog()).getByLabelText('Value 1'), { target: { value: '2' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add' }))
    fireEvent.change(within(dialog()).getByLabelText('Key 2'), { target: { value: 'B' } })
    fireEvent.change(within(dialog()).getByLabelText('Value 2'), { target: { value: '3' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(onAccept).toHaveBeenCalledWith([{ key: 'A', value: '2' }, { key: 'B', value: '3' }])
  })

  it('adds many semicolon-separated variables and rejects invalid input without closing', () => {
    const onAccept = vi.fn()
    render(<EnvironmentVariablesDialog initial={[]} onClose={vi.fn()} onAccept={onAccept} />)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add Many' }))
    const input = within(dialog()).getByLabelText('Add Many')
    fireEvent.change(input, { target: { value: 'A=1;B=two' } })
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Add' }).at(-1)!)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add Many' }))
    fireEvent.change(within(dialog()).getByLabelText('Add Many'), { target: { value: 'NOT-A-PAIR' } })
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Add' }).at(-1)!)
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('Invalid Input String')

    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))
    expect(onAccept).toHaveBeenCalledWith([{ key: 'A', value: '1' }, { key: 'B', value: 'two' }])
  })

  it('resets to the rows the dialog was opened with', () => {
    const onAccept = vi.fn()
    render(<EnvironmentVariablesDialog initial={[{ key: 'A', value: '1' }]} onClose={vi.fn()} onAccept={onAccept} />)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reset' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'OK' }))

    expect(onAccept).toHaveBeenCalledWith([{ key: 'A', value: '1' }])
  })
})

describe('the environment strings', () => {
  it('round-trips rows through the launch memory', () => {
    expect(parseEnvironmentRows(formatEnvironmentRows([{ key: 'A', value: '1' }, { key: 'B', value: 'two=3' }])))
      .toEqual([{ key: 'A', value: '1' }, { key: 'B', value: 'two=3' }])
  })

  it('leaves blank keys out of the launch request', () => {
    expect(environmentOfRows([{ key: '', value: 'ignored' }, { key: 'A', value: '1' }])).toEqual({ A: '1' })
  })
})
