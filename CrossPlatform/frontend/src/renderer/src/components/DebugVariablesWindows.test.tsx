import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugVariable } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { LocalsPane, WatchPane } from './DebugVariablesWindows'

const shape: DebugVariable = {
  name: 'shape',
  value: 'Shape "square" with 4 sides',
  type: 'DebugTarget.Program.Shape',
  variablesReference: 11,
  evaluateName: 'shape',
  nameParts: [{ text: 'shape', color: 'local' }],
  valueParts: [{ text: 'Shape "square" with 4 sides', color: 'debuggerDisplayAttributeEval' }],
  typeParts: [{ text: 'DebugTarget.Program.Shape', color: 'type' }],
  image: 'FieldPublic',
}

const factor: DebugVariable = { name: 'factor', value: '2', type: 'int', variablesReference: 0, evaluateName: 'factor', canEdit: true, editText: '2' }

const getDebugChildren = vi.fn(async () => ({
  variables: [{ name: 'Sides', value: '4', type: 'int', variablesReference: 0, evaluateName: 'shape.Sides', canEdit: true }],
  totalCount: 1,
}))
const setDebugExpression = vi.fn(async () => ({ node: factor, error: null }))
const readDebugMemory = vi.fn(async (_session: string, _address: string, count: number) => ({ address: '0x1000', data: 'AAECAw==', readable: [true], pageSize: 4096, count }))
const saveBinary = vi.fn(async () => '/tmp/factor.bin')

beforeEach(() => {
  getDebugChildren.mockClear()
  setDebugExpression.mockClear()
  readDebugMemory.mockClear()
  saveBinary.mockClear()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      getDebugChildren,
      setDebugExpression,
      readDebugMemory,
      saveBinary,
      getDebugScopes: vi.fn(async () => []),
      getDebugVariables: vi.fn(async () => []),
      evaluateDebugExpression: vi.fn(async (_session: string, _frame: number, expression: string) => ({ name: expression, value: '42', type: 'int', variablesReference: 0 })),
      showMessage: vi.fn(async () => undefined),
    },
  })
  useAppStore.setState({
    debugSessionId: 'session',
    debugState: 'stopped',
    activeDebugFrameId: 1,
    debugVariables: [shape, factor],
    watches: [],
    watchValues: [],
    debugCapabilities: { supportsEvaluate: true },
  })
})

afterEach(() => {
  cleanup()
})

describe('LocalsPane', () => {
  it('draws each column in the colours the engine wrote it in', () => {
    render(<LocalsPane />)

    expect(screen.getByText('shape')).toHaveClass('tc-local')
    expect(screen.getByText('Shape "square" with 4 sides')).toHaveClass('tc-debuggerDisplayAttributeEval')
    expect(screen.getByText('DebugTarget.Program.Shape')).toHaveClass('tc-type')
  })

  it('shows the object id after a value that was given one', () => {
    useAppStore.setState({ debugVariables: [{ ...factor, objectId: '$1' }] })
    render(<LocalsPane />)

    expect(screen.getByText(/\{\$1\}/)).toHaveClass('tc-debugObjectIdName')
  })

  it('saves a value\'s raw bytes and shows its address span in a Memory window', async () => {
    useAppStore.setState({ debugVariables: [{ ...factor, address: '0x1000', size: 4 }] })
    render(<LocalsPane />)
    const row = screen.getByText('factor').closest('.debug-table-row')!

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Save\.\.\./ }))
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalledWith('session', '0x1000', 4))
    await waitFor(() => expect(saveBinary).toHaveBeenCalledWith('factor.bin', 'AAECAw=='))

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: /Show in Memory Window/ }))
    expect(useAppStore.getState().memoryNavigation).toMatchObject({ window: 'memory', sessionId: 'session', address: 0x1000, length: 4 })
  })

  it('copies every selected row in the variables window format', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<LocalsPane />)
    const rows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-selected') !== null)

    fireEvent.mouseDown(rows[0])
    fireEvent.keyDown(screen.getByRole('treegrid', { name: 'Locals' }), { key: 'a', ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('treegrid', { name: 'Locals' }), { key: 'c', ctrlKey: true })

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('shape\tShape "square" with 4 sides\tDebugTarget.Program.Shape'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('factor\t2\tint'))
  })

  it('reads a row\'s members when it is expanded', async () => {
    render(<LocalsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand shape' }))

    expect(await screen.findByText('Sides')).toBeVisible()
    expect(getDebugChildren).toHaveBeenCalledWith('session', 11, 0, 1000)
    expect(screen.getByRole('row', { name: /shape/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('edits a value in place and writes it through its expression', async () => {
    render(<LocalsPane />)

    fireEvent.doubleClick(screen.getByText('2'))
    const editor = screen.getByRole('textbox', { name: 'Value' })
    fireEvent.change(editor, { target: { value: '7' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(setDebugExpression).toHaveBeenCalledWith('session', 1, 'factor', '7'))
  })
})

describe('changed values', () => {
  it('draws a value that differs from the last stop\'s in the changed colour', () => {
    useAppStore.setState({ debugGeneration: 1 })
    render(<LocalsPane />)
    expect(screen.getByText('2').closest('span[title]')).not.toHaveClass('debug-value-changed')

    act(() => {
      useAppStore.setState({ debugGeneration: 2, debugVariables: [shape, { ...factor, value: '3' }] })
    })

    expect(screen.getByText('3').closest('span[title]')).toHaveClass('debug-value-changed')
    expect(screen.getByText('Shape "square" with 4 sides').closest('span[title]')).not.toHaveClass('debug-value-changed')
  })
})

describe('WatchPane', () => {
  it('adds a watch from the empty row at the bottom', async () => {
    render(<WatchPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Add watch' }))
    const editor = screen.getByRole('textbox', { name: 'Watch expression' })
    fireEvent.change(editor, { target: { value: 'numbers.Length' } })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })

    expect(useAppStore.getState().watches).toEqual(['numbers.Length'])
    expect(await screen.findByText('42')).toBeVisible()
  })
})
