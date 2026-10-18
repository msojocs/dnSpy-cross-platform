import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IlMethodBody, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { MethodBodyDialog } from './MethodBodyDialog'

const node: TreeNode = { id: 'n1', label: 'Run(int) : void', kind: 'method', hasChildren: false }

const body = (patch: Partial<IlMethodBody> = {}): IlMethodBody => ({
  bodyType: 'cil',
  codeType: 0,
  maxStack: 2,
  keepOldMaxStack: false,
  initLocals: true,
  localVarSigTok: 0,
  headerRva: 0x100,
  headerFileOffset: 0x200,
  rva: 0x10C,
  fileOffset: 0x20C,
  nativeRva: 0,
  locals: [{ name: 'num', type: { kind: 'type', type: { scope: '', namespace: 'System', name: 'Int32' }, valueType: true }, isPinned: false, attributes: 0, display: 'System.Int32' }],
  instructions: [
    { label: 'IL_0000', opCode: 'ldarg.0', operandKind: 'argument', operand: '0', operandDisplay: 'value' },
    { label: 'IL_0001', opCode: 'ret', operandKind: 'none' },
  ],
  exceptionHandlers: [],
  parameterNames: ['value'],
  ...patch,
})

interface Harness {
  queueIlBody: ReturnType<typeof vi.fn>
  transformIlBody: ReturnType<typeof vi.fn>
  commitEdit: ReturnType<typeof vi.fn>
  methodBodyChanged: ReturnType<typeof vi.fn>
}

const renderDialog = (loaded = body(), selection?: { start: number; end: number }): Harness => {
  const queueIlBody = vi.fn(async () => undefined)
  const transformIlBody = vi.fn(async () => ({ locals: loaded.locals, instructions: loaded.instructions }))
  const commitEdit = vi.fn(async () => ({ version: 1, stateId: 's1', changedNodeIds: ['n1'], canUndo: true, canRedo: false }))
  const methodBodyChanged = vi.fn(async () => undefined)
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      getIlBody: vi.fn(async () => loaded),
      transformIlBody,
      beginEdit: vi.fn(async () => ({ transactionId: 't1', baseVersion: 0 })),
      queueIlBody,
      commitEdit,
      rollbackEdit: vi.fn(async () => undefined),
    },
  })
  useAppStore.setState({ workspaceId: 'ws', methodBodyChanged, appendOutput: vi.fn() })
  render(<MethodBodyDialog node={node} selection={selection} onClose={() => undefined} />)
  return { queueIlBody, transformIlBody, commitEdit, methodBodyChanged }
}

const row = (index: number): HTMLElement => screen.getAllByRole('row')[index] as HTMLElement
const openTab = (name: string): void => { fireEvent.click(screen.getByRole('tab', { name })) }
const accept = (): void => { fireEvent.click(screen.getByRole('button', { name: 'OK' })) }

beforeEach(() => {
  useAppStore.setState({ workspaceId: undefined })
})

afterEach(cleanup)

describe('MethodBodyDialog', () => {
  it('draws dnSpy\'s three tabs over the loaded body', async () => {
    renderDialog()

    expect(await screen.findByLabelText('OpCode 0')).toHaveValue('ldarg.0')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Instructions', 'Locals', 'Exception Handlers'])
    expect(screen.getByLabelText('Body Type')).toHaveValue('cil')
    expect(screen.getByLabelText('MaxStack')).toHaveValue(2)
    // The read-only header fields are what dnSpy's CIL page shows beside MaxStack.
    expect(screen.getByDisplayValue('0x100')).toBeInTheDocument()
  })

  it('appends and removes an instruction', async () => {
    renderDialog()
    fireEvent.click(await screen.findByRole('button', { name: 'Append New Instruction' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.getByLabelText('OpCode 2')).toHaveValue('nop')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Instruction 2' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
  })

  it('runs a command over the selected instructions through the backend', async () => {
    const harness = renderDialog()
    await screen.findByLabelText('OpCode 0')
    fireEvent.mouseDown(row(0))
    fireEvent.click(screen.getByRole('button', { name: 'Simplify All Instructions' }))

    await waitFor(() => expect(harness.transformIlBody).toHaveBeenCalledTimes(1))
    expect(harness.transformIlBody.mock.calls[0].slice(1)).toEqual(['n1', 'simplifyAll', body().locals, body().instructions, [0], ['value']])
  })

  it('selects the instructions the statement covered when the editor was opened on one', async () => {
    renderDialog(body(), { start: 0x1, end: 0x2 })
    await screen.findByLabelText('OpCode 1')
    expect(row(1)).toHaveAttribute('aria-selected', 'true')
    expect(row(0)).toHaveAttribute('aria-selected', 'false')
  })

  it('adds a local variable and edits its name', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    openTab('Locals')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Name 1'), { target: { value: 'total' } })
    expect(screen.getByLabelText('Name 1')).toHaveValue('total')
    fireEvent.click(screen.getByRole('button', { name: 'Remove local 1' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1))
  })

  it('adds an exception handler and keeps OK disabled until it has a catch type', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    openTab('Exception Handlers')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1))

    expect(screen.getByLabelText('Handler Type 0')).toHaveValue('catch')
    expect(screen.getByLabelText('TryStart 0')).toHaveValue('IL_0000')
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByText('A catch clause needs a catch type.')).toBeInTheDocument()
  })

  it('writes the body back through the transaction and reports the commit', async () => {
    const harness = renderDialog()
    await screen.findByLabelText('OpCode 0')
    accept()

    await waitFor(() => expect(harness.commitEdit).toHaveBeenCalledWith('ws', 't1'))
    expect(harness.queueIlBody).toHaveBeenCalledWith('ws', 't1', 'n1', body())
    expect(harness.methodBodyChanged).toHaveBeenCalledTimes(1)
  })

  it('reports why the backend refused the body', async () => {
    const harness = renderDialog()
    harness.queueIlBody.mockRejectedValueOnce(new Error('The method contains exception handlers.'))
    await screen.findByLabelText('OpCode 0')
    accept()

    expect(await screen.findByText('The method contains exception handlers.')).toBeInTheDocument()
  })
})
