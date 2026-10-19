import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HexStructure, MetadataRow, MetadataTable } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useMetadataTableCommands } from '../metadata-table'
import { HexStructureView } from './HexStructureView'
import { MetadataTableView } from './MetadataTableView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useMetadataTableCommands.setState({ active: undefined })
})

const fileHeader: HexStructure = {
  nodeId: 'fh',
  name: 'File Header',
  offset: 0x84,
  length: 20,
  fields: [
    { name: 'Machine', offset: 0x84, size: 2, kind: 'uint16', value: 0x14C, text: '0x14C', bits: [{ name: 'Machine', bit: 0, count: 16, values: [{ value: 0x14C, name: 'I386' }, { value: 0x8664, name: 'AMD64' }] }] },
    { name: 'TimeDateStamp', offset: 0x88, size: 4, kind: 'uint32', value: 0x5F000000, text: '0x5F000000', note: '2020-07-03 13:15:12' },
    { name: 'Characteristics', offset: 0x96, size: 2, kind: 'uint16', value: 0x2022, text: '0x2022', group: 'Flags', bits: [{ name: 'ExecutableImage', bit: 1, count: 1 }, { name: 'Dll', bit: 13, count: 1 }] },
  ],
}

describe('HexStructureView', () => {
  it('shows each field with its offset and writes what is typed, a combo box or a check box as the field\'s bytes', async () => {
    const hexWriteBytes = vi.fn(async () => true)
    useAppStore.setState({ workspaceId: 'ws', workspaceStateId: 's1', hexWriteBytes })
    Object.assign(window.dnSpy, { getHexStructure: vi.fn(async () => fileHeader) })
    render(<HexStructureView nodeId="fh" />)

    const machine = await screen.findByLabelText('Machine', { selector: 'input' })
    expect(machine).toHaveValue('0x14C')
    expect(screen.getByDisplayValue('0x00000084')).toBeInTheDocument()
    expect(screen.getByDisplayValue('2020-07-03 13:15:12')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Flags' })).toBeInTheDocument()

    // Nothing is written while the text is not a value, or before the box loses the focus.
    fireEvent.change(machine, { target: { value: 'nonsense' } })
    expect(machine).toHaveAttribute('aria-invalid', 'true')
    fireEvent.blur(machine)
    expect(hexWriteBytes).not.toHaveBeenCalled()
    fireEvent.change(machine, { target: { value: '0x8664' } })
    fireEvent.blur(machine)
    expect(hexWriteBytes).toHaveBeenLastCalledWith('fh', 0x84, Uint8Array.of(0x64, 0x86))

    fireEvent.change(screen.getByRole('combobox', { name: 'Machine' }), { target: { value: String(0x8664) } })
    expect(hexWriteBytes).toHaveBeenLastCalledWith('fh', 0x84, Uint8Array.of(0x64, 0x86))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dll' }))
    expect(hexWriteBytes).toHaveBeenLastCalledWith('fh', 0x96, Uint8Array.of(0x22, 0x00))
  })

  it('reads the structure again when the workspace changes, so an undo shows in it', async () => {
    const getHexStructure = vi.fn(async () => fileHeader)
    useAppStore.setState({ workspaceId: 'ws', workspaceStateId: 's1' })
    Object.assign(window.dnSpy, { getHexStructure })
    render(<HexStructureView nodeId="fh" />)
    await screen.findByLabelText('Machine', { selector: 'input' })
    getHexStructure.mockResolvedValueOnce({ ...fileHeader, fields: [{ ...fileHeader.fields[0], value: 0x8664, text: '0x8664' }] })
    act(() => useAppStore.setState({ workspaceStateId: 's2' }))
    await waitFor(() => expect(screen.getByLabelText('Machine', { selector: 'input' })).toHaveValue('0x8664'))
  })
})

const typeDefTable: MetadataTable = {
  nodeId: 'tbl',
  table: 2,
  name: '02 TypeDef',
  rows: 3,
  rowSize: 6,
  offset: 0x300,
  columns: [{ name: 'Flags', offset: 0, size: 4 }, { name: 'Name', offset: 4, size: 2 }],
  hasInfo: true,
  canSort: true,
}

const row = (rid: number): MetadataRow => ({ rid, token: 0x02000000 + rid, offset: 0x300 + (rid - 1) * 6, values: [0x100000 + rid, rid * 0x10], info: `Type${rid}` })

describe('MetadataTableView', () => {
  const renderTable = (overrides: Partial<typeof window.dnSpy> = {}): { hexWriteBytes: ReturnType<typeof vi.fn>; onShowHex: ReturnType<typeof vi.fn> } => {
    const hexWriteBytes = vi.fn(async () => true)
    const onShowHex = vi.fn()
    useAppStore.setState({ workspaceId: 'ws', workspaceStateId: 's1', hexWriteBytes })
    Object.assign(window.dnSpy, {
      getMetadataTable: vi.fn(async () => typeDefTable),
      getMetadataTableRows: vi.fn(async (_workspaceId: string, _nodeId: string, startRid: number, count: number) => ({ rows: [1, 2, 3].filter((rid) => rid >= startRid && rid < startRid + count).map(row) })),
      resolveHexTarget: vi.fn(async () => ({ moduleId: 'root', fileLength: 4096, method: null, fieldInitialValue: null, resource: null })),
      ...overrides,
    })
    render(<MetadataTableView nodeId="tbl" onShowHex={onShowHex} />)
    return { hexWriteBytes, onShowHex }
  }

  it('lists the rows with RID, token, offset, a box per column and the Info column, and writes an edited column', async () => {
    const { hexWriteBytes } = renderTable()
    const grid = await screen.findByRole('grid', { name: '02 TypeDef' })
    expect(within(grid).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['RID', 'Token', 'Offset', 'Flags', 'Name', 'Info'])
    expect(await screen.findByLabelText('Token 2')).toHaveValue('0x02000002')
    expect(screen.getByLabelText('Offset 2')).toHaveValue('0x00000306')
    expect(screen.getByLabelText('Info 3')).toHaveValue('Type3')
    const name = screen.getByLabelText('Name 2')
    expect(name).toHaveValue('0x20')
    fireEvent.change(name, { target: { value: '0x21' } })
    fireEvent.blur(name)
    expect(hexWriteBytes).toHaveBeenCalledWith('tbl', 0x306 + 4, Uint8Array.of(0x21, 0))
  })

  it('selects rows like an extended ListView and runs the table commands on them', async () => {
    const sortMetadataTable = vi.fn(async () => ({ offset: 0x306, base64Data: btoa('\u0001\u0002') }))
    const getMetadataTableText = vi.fn(async () => ({ text: 'RID\tToken\n' }))
    const { hexWriteBytes, onShowHex } = renderTable({ sortMetadataTable, getMetadataTableText })
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText, readText: vi.fn(async () => '010000000000') } })
    await screen.findByLabelText('Token 3')
    const rows = screen.getAllByRole('row').filter((element) => element.getAttribute('aria-rowindex'))
    fireEvent.mouseDown(rows[1])
    fireEvent.mouseDown(rows[2], { shiftKey: true })
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    expect(rows[2]).toHaveAttribute('aria-selected', 'true')

    // The Edit menu sees the table's commands once it has had the focus.
    fireEvent.focus(screen.getByRole('grid'))
    const commands = useMetadataTableCommands.getState().active?.commands
    expect(commands).toMatchObject({ canSort: true, canSortSelection: true, hasSelection: true, canShowInHex: true })

    fireEvent.contextMenu(screen.getByRole('grid'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Sort Selection/ }))
    await waitFor(() => expect(sortMetadataTable).toHaveBeenCalledWith('ws', 'tbl', 2, 2))
    await waitFor(() => expect(hexWriteBytes).toHaveBeenCalledWith('tbl', 0x306, Uint8Array.of(1, 2)))

    fireEvent.keyDown(screen.getByRole('grid'), { key: 'c', ctrlKey: true })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('020010002000' + '030010003000'))
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'C', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(getMetadataTableText).toHaveBeenCalledWith('ws', 'tbl', [2, 3]))
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'x', ctrlKey: true })
    await waitFor(() => expect(onShowHex).toHaveBeenCalledWith('root', 0x306, 12))
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'v', ctrlKey: true })
    await waitFor(() => expect(hexWriteBytes).toHaveBeenLastCalledWith('tbl', 0x306, Uint8Array.of(1, 0, 0, 0, 0, 0)))
  })

  it('goes to a RID it asks for, and refuses one the table does not have', async () => {
    renderTable()
    await screen.findByLabelText('Token 1')
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'g', ctrlKey: true })
    const box = screen.getByRole('textbox', { name: 'RID' })
    fireEvent.change(box, { target: { value: '4' } })
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Value must be between 1')
    fireEvent.change(box, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    const rows = screen.getAllByRole('row').filter((element) => element.getAttribute('aria-rowindex'))
    expect(rows[2]).toHaveAttribute('aria-selected', 'true')
  })
})
