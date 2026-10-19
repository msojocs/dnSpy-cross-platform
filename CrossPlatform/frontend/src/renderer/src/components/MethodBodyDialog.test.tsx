import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IlMethodBody, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { clearIlClipboard } from './il-body-clipboard'
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
      getNodePath: vi.fn(async () => ({ nodes: [{ id: 'root', label: 'A', kind: 'assembly', hasChildren: true }] })),
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
const grid = (name: string): HTMLElement => screen.getByRole('grid', { name })
const newLocalNamed = (name: string): IlMethodBody['locals'][number] => ({ name, type: { kind: 'type', type: { scope: '', namespace: 'System', name: 'Int32' }, valueType: true }, isPinned: false, attributes: 0, display: `System.Int32 ${name}` })
const openTab = (name: string): void => { fireEvent.click(screen.getByRole('tab', { name })) }
const accept = (): void => { fireEvent.click(screen.getByRole('button', { name: 'OK' })) }

beforeEach(() => {
  useAppStore.setState({ workspaceId: undefined })
  clearIlClipboard()
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

  it('appends and removes an instruction with the list\'s gestures', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    const list = grid('Instructions')
    fireEvent.keyDown(list, { key: 'a' })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.getByLabelText('OpCode 2')).toHaveValue('nop')
    // The new row is the selection, which Del takes away again.
    expect(row(2)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'Delete' })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
  })

  it('runs a command through the backend from its gesture', async () => {
    const harness = renderDialog()
    await screen.findByLabelText('OpCode 0')
    fireEvent.mouseDown(row(0))
    fireEvent.keyDown(grid('Instructions'), { key: 's' })

    await waitFor(() => expect(harness.transformIlBody).toHaveBeenCalledTimes(1))
    // Simplify All acts on every instruction, whatever is selected.
    expect(harness.transformIlBody.mock.calls[0].slice(1)).toEqual(['n1', 'simplifyAll', body().locals, body().instructions, [0, 1], ['value']])
  })

  it('leaves a letter typed into an operand box to the box', async () => {
    renderDialog(body({ instructions: [{ label: 'IL_0000', opCode: 'ldstr', operandKind: 'string', operand: 'x' }, { label: 'IL_0005', opCode: 'ret', operandKind: 'none' }] }))
    const operand = await screen.findByLabelText('Operand 0')
    fireEvent.keyDown(operand, { key: 'a' })
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('copies instructions and pastes them with labels of their own before the selection', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    const list = grid('Instructions')
    fireEvent.mouseDown(row(0))
    fireEvent.keyDown(list, { key: 'c', ctrlKey: true })
    fireEvent.mouseDown(row(1))
    fireEvent.keyDown(list, { key: 'v', ctrlKey: true })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.getByLabelText('OpCode 1')).toHaveValue('ldarg.0')
    expect(screen.getByLabelText('Operand 1')).toHaveValue('0')
    expect(screen.getByLabelText('OpCode 2')).toHaveValue('ret')
  })

  it('writes the selected instructions as text, with their offsets', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: async () => '' } })
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    fireEvent.mouseDown(row(0))
    fireEvent.mouseDown(row(1), { shiftKey: true })
    fireEvent.keyDown(grid('Instructions'), { key: 't', ctrlKey: true })
    expect(writeText).toHaveBeenCalledWith('0\t0000\tldarg.0\tvalue (0)\n1\t0001\tret\n')
  })

  it('shows dnSpy\'s commands in the list\'s context menu', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    fireEvent.mouseDown(row(0))
    fireEvent.contextMenu(grid('Instructions'))
    expect(await screen.findByText('NOP Instruction')).toBeInTheDocument()
    expect(screen.getByText('Add New Instruction Before Selection')).toBeInTheDocument()
    expect(screen.getByText('Paste After Selection')).toBeInTheDocument()
    expect(screen.getByText('Copy File Offset')).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
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
    fireEvent.keyDown(grid('Locals'), { key: 'a' })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    fireEvent.change(screen.getByLabelText('Name 1'), { target: { value: 'total' } })
    expect(screen.getByLabelText('Name 1')).toHaveValue('total')
    fireEvent.keyDown(grid('Locals'), { key: 'Delete' })
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1))
  })

  it('points the instructions at where their locals went', async () => {
    const harness = renderDialog(body({
      locals: [newLocalNamed('first'), newLocalNamed('second')],
      instructions: [
        { label: 'IL_0000', opCode: 'ldloc.s', operandKind: 'local', operand: '1', operandDisplay: 'V_1' },
        { label: 'IL_0002', opCode: 'ret', operandKind: 'none' },
      ],
    }))
    await screen.findByLabelText('OpCode 0')
    openTab('Locals')
    fireEvent.mouseDown(screen.getAllByRole('row')[0])
    fireEvent.keyDown(grid('Locals'), { key: 'd' })
    await waitFor(() => expect(screen.getByLabelText('Name 0')).toHaveValue('second'))
    accept()
    await waitFor(() => expect(harness.queueIlBody).toHaveBeenCalled())
    const written = harness.queueIlBody.mock.calls[0][3] as IlMethodBody
    expect(written.instructions[0].operand).toBe('0')
  })

  it('adds an exception handler and keeps OK disabled until it has a catch type', async () => {
    renderDialog()
    await screen.findByLabelText('OpCode 0')
    openTab('Exception Handlers')
    fireEvent.keyDown(grid('Exception Handlers'), { key: 'a' })
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
