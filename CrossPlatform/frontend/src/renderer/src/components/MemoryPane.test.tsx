import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HexPositionInfoResponse, HexToolTipInfoResponse } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { MemoryPane } from './DebugNativeWindows'

// The Disassembly tab next to it is Monaco, which jsdom cannot host.
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('../monaco', () => ({ monacoThemeName: () => 'vs' }))

const toBase64 = (bytes: Uint8Array): string => {
  let text = ''
  for (let start = 0; start < bytes.length; start += 0x8000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(text)
}

// The debuggee's memory: the first 4 KiB page of every window is unmapped, the rest reads as its address's low byte.
const readDebugMemory = vi.fn(async (_session: string, address: string, count: number) => {
  const start = Number(BigInt(address))
  const bytes = Uint8Array.from({ length: count }, (_, index) => (start + index) & 0xFF)
  const pages = Math.ceil(count / 4096)
  return { address, data: toBase64(bytes), readable: Array.from({ length: pages }, (_, page) => page > 0), pageSize: 4096 }
})
const writeDebugMemory = vi.fn(async () => undefined)
const getDebugMemoryToolTipInfo = vi.fn(async (_session: string, address: number): Promise<HexToolTipInfoResponse> => ({
  fields: [{ offset: address, length: 2, kind: 'currentField' }, { offset: address, length: 0x40, kind: 'structure' }],
  toolTip: { image: 'FieldPublic', sections: [[{ text: 'IMAGE_DOS_HEADER.e_magic', color: 'instanceField' }]] },
}))
const getDebugMemoryPositionInfo = vi.fn(async (_session: string, address: number): Promise<HexPositionInfoResponse> => ({
  file: { offset: address, length: 0x1000 }, nestedFile: null, structure: { offset: address, length: 0x40 },
  editField: null, rva: 0, fileOffset: 0, fieldReference: { offset: address + 0x20, length: 4 }, reference: null,
}))
const resolveDebugMemoryPosition = vi.fn(async () => ({ offset: -1 }))
const goToDebugMemoryMetadata = vi.fn(async () => ({ range: null }))
const getDebugMemoryFileInfo = vi.fn(async () => ({ hasMetadata: true, hasPeHeaders: true }))
const refreshDebugMemory = vi.fn(async () => undefined)
const SPACE_END = 2 ** 47
const getDebugMemorySpace = vi.fn(async () => ({ end: SPACE_END }))
// The readable regions: [0x1000, 0x5000) and [0x9000, 0xA000), nothing else.
const regions = [{ start: 0x1000, end: 0x5000 }, { start: 0x9000, end: 0xA000 }]
const getDebugMemoryValidSpan = vi.fn(async (_session: string, position: number, bounds: number, forward: boolean) => {
  const found = forward
    ? regions.find((region) => region.end > position && region.start < bounds)
    : [...regions].reverse().find((region) => region.start <= position && region.end > bounds)
  return found ?? { start: null, end: null }
})
const searchDebugMemory = vi.fn(async () => ({ offsets: [0x9010] }))
const pickHexSaveFile = vi.fn(async () => '/tmp/memory.bin')
const writeHexFileChunk = vi.fn(async (_path: string, _base64Data: string, _append: boolean) => undefined)
const deleteHexFile = vi.fn(async () => undefined)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy, readDebugMemory, writeDebugMemory, getDebugMemoryToolTipInfo, getDebugMemoryPositionInfo, resolveDebugMemoryPosition,
      goToDebugMemoryMetadata, getDebugMemoryFileInfo, refreshDebugMemory, getDebugMemorySpace, getDebugMemoryValidSpan, searchDebugMemory,
      pickHexSaveFile, writeHexFileChunk, deleteHexFile, showMessage: vi.fn(async () => undefined),
    },
  })
  useAppStore.setState({ debugSessionId: 'session', debugState: 'stopped', debugSessions: [], debugGeneration: 1 })
})

afterEach(() => cleanup())

const caretOffset = (container: HTMLElement): string => container.querySelector('.hex-view')!.getAttribute('data-caret-offset') ?? ''
const caret = (container: HTMLElement): number => Number(container.querySelector('.hex-view')!.getAttribute('data-caret'))

describe('MemoryPane', () => {
  it('is the hex editor over the process\'s whole address space, with unmapped pages shown as ??', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalledWith('session', '0x0', 64 * 1024))
    expect(getDebugMemorySpace).toHaveBeenCalledWith('session')
    const firstLine = () => container.querySelector('.hex-line')?.textContent ?? ''
    await waitFor(() => expect(firstLine()).toContain('??'))
    // The offset column is an address of a 47-bit space: twelve digits, whatever line is at the top.
    expect(container.querySelector('.hex-offset')!.textContent).toBe('000000000000')
    expect(container.querySelector('.hex-byte-error')).not.toBeNull()
  })

  it('goes to the last address and back to the first with Ctrl+End and Ctrl+Home', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    await waitFor(() => expect(caretOffset(container)).toBe('7FFFFFFFFFFF'))
    await waitFor(() => expect(readDebugMemory.mock.calls.some(([, address]) => BigInt(address) >= BigInt(SPACE_END - 0x10000))).toBe(true))
    fireEvent.keyDown(view, { key: 'Home', code: 'Home', ctrlKey: true })
    await waitFor(() => expect(caretOffset(container)).toBe('000000000000'))
  })

  it('selects the whole address space with Ctrl+A', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'a', code: 'KeyA', ctrlKey: true })
    await waitFor(() => {
      const hex = container.querySelector('.hex-view')!
      expect(hex.getAttribute('data-selection-start')).toBe('0')
      expect(hex.getAttribute('data-selection-end')).toBe(String(SPACE_END))
    })
  })

  it('moves between the starts and ends of the readable regions with Alt+Down and Alt+Up', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    const altDown = () => fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    const altUp = () => fireEvent.keyDown(view, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })
    // Before the first region: to its start; inside it: to its last byte; on its last byte: to the next one's start.
    altDown()
    await waitFor(() => expect(caret(container)).toBe(0x1000))
    altDown()
    await waitFor(() => expect(caret(container)).toBe(0x4FFF))
    altDown()
    await waitFor(() => expect(caret(container)).toBe(0x9000))
    // Back: on a region's start, to the previous region's last byte, then to that region's start.
    altUp()
    await waitFor(() => expect(caret(container)).toBe(0x4FFF))
    altUp()
    await waitFor(() => expect(caret(container)).toBe(0x1000))
    // Shift extends the selection from where the caret was.
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true })
    await waitFor(() => {
      const hex = container.querySelector('.hex-view')!
      expect(hex.getAttribute('data-selection-start')).toBe(String(0x1000))
      expect(hex.getAttribute('data-selection-end')).toBe(String(0x5000))
    })
    expect(getDebugMemoryValidSpan).toHaveBeenCalledWith('session', 0, SPACE_END, true, false)
  })

  it('searches the readable memory of the process in the backend', async () => {
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'f', code: 'KeyF', ctrlKey: true })
    const input = await findByRole('textbox', { name: 'Find' })
    fireEvent.change(input, { target: { value: '1011' } })
    await waitFor(() => expect(searchDebugMemory).toHaveBeenCalledWith('session', expect.objectContaining({ base64Pattern: toBase64(Uint8Array.of(0x10, 0x11)), rangeEnd: SPACE_END, maxResults: 1 })))
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-selection-start')).toBe(String(0x9010)))
  })

  it('uses the process structure model for keyboard Quick Info and highlights the field', async () => {
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    fireEvent.keyDown(view, { key: 'k', code: 'KeyK', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'i', code: 'KeyI', ctrlKey: true })
    expect(await findByRole('tooltip')).toHaveTextContent('IMAGE_DOS_HEADER.e_magic')
    expect(getDebugMemoryToolTipInfo).toHaveBeenCalledWith('session', 0)
    expect(container.querySelector('.hex-tooltip-current-field')).not.toBeNull()
  })

  it('follows a structure reference far from the caret', async () => {
    getDebugMemoryPositionInfo.mockResolvedValueOnce({
      file: null, nestedFile: null, structure: null, editField: null, rva: null, fileOffset: 0,
      fieldReference: { offset: 0x4000020, length: 4 }, reference: null,
    })
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'F12', code: 'F12', ctrlKey: true })
    await waitFor(() => expect(caretOffset(container)).toBe('000004000020'))
    await waitFor(() => expect(readDebugMemory.mock.calls.some(([, address]) => BigInt(address) >= 0x3800000n)).toBe(true))
  })

  it('selects a complete module larger than 16 MiB', async () => {
    getDebugMemoryPositionInfo.mockResolvedValueOnce({
      file: { offset: 0x2000000, length: 0x2000000 }, nestedFile: null, structure: null, editField: null,
      rva: null, fileOffset: 0, fieldReference: null, reference: null,
    })
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'e', code: 'KeyE', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'f', code: 'KeyF', ctrlKey: true })
    await waitFor(() => expect(getDebugMemoryPositionInfo).toHaveBeenCalledWith('session', 0))
    await waitFor(() => {
      const hex = container.querySelector('.hex-view')!
      expect(hex.getAttribute('data-selection-start')).toBe(String(0x2000000))
      expect(hex.getAttribute('data-selection-end')).toBe(String(0x4000000))
    })
  })

  it('does not use a position translation that arrives after the next stop', async () => {
    let answer!: (value: { offset: number }) => void
    resolveDebugMemoryPosition.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'g', code: 'KeyG', ctrlKey: true })
    const dialog = await findByRole('dialog', { name: 'Go to Offset' })
    fireEvent.change(dialog.querySelector('select[aria-label="Position"]')!, { target: { value: 'rva' } })
    fireEvent.change(dialog.querySelector('input')!, { target: { value: '0x20' } })
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'OK')!)
    await waitFor(() => expect(resolveDebugMemoryPosition).toHaveBeenCalled())
    act(() => useAppStore.setState({ debugGeneration: 2 }))
    await act(async () => { answer({ offset: 0x4000020 }) })
    expect(caretOffset(container)).toBe('000000000000')
  })

  it('saves a selection a chunk at a time under a progress dialog', async () => {
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'l', code: 'KeyL', ctrlKey: true })
    const dialog = await findByRole('dialog', { name: 'Select' })
    const inputs = dialog.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: '0' } })
    fireEvent.change(inputs[1], { target: { value: '0x10000F' } })
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'OK')!)
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-selection-end')).toBe(String(0x100010)))
    readDebugMemory.mockClear()
    fireEvent.keyDown(view, { key: 's', code: 'KeyS', ctrlKey: true, altKey: true })
    await waitFor(() => expect(writeHexFileChunk).toHaveBeenCalledTimes(2))
    const [first, second] = writeHexFileChunk.mock.calls
    expect(first[0]).toBe('/tmp/memory.bin')
    expect(first[2]).toBe(false)
    expect(second[2]).toBe(true)
    const bytes = atob(first[1]) + atob(second[1])
    expect(bytes.length).toBe(0x100010)
    expect(bytes.charCodeAt(0x10000F)).toBe(0x0F)
    expect(readDebugMemory.mock.calls.every(([, , count]) => count <= 1024 * 1024)).toBe(true)
    expect(deleteHexFile).not.toHaveBeenCalled()
  })

  it('deletes the file a cancelled save had begun', async () => {
    let release!: () => void
    writeHexFileChunk.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(undefined) }))
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'a', code: 'KeyA', ctrlKey: true })
    fireEvent.keyDown(view, { key: 's', code: 'KeyS', ctrlKey: true, altKey: true })
    const progress = await findByRole('dialog', { name: 'Save Selection 0x0-0x7FFFFFFFFFFF' })
    expect(progress).toHaveTextContent('/tmp/memory.bin')
    fireEvent.click([...progress.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!)
    await act(async () => { release() })
    await waitFor(() => expect(deleteHexFile).toHaveBeenCalledWith('/tmp/memory.bin'))
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
  })

  it('copies the caret\'s address as its absolute offset', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    const oldClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const { container } = render(<MemoryPane />)
      await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
      const view = container.querySelector('.hex-content')!
      fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
      await waitFor(() => expect(caretOffset(container)).toBe('7FFFFFFFFFFF'))
      fireEvent.keyDown(view, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('0x7FFFFFFFFFFF'))
    }
    finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: oldClipboard })
    }
  })

  it('invalidates process structure information on Refresh as well as rereading bytes', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    readDebugMemory.mockClear()
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'F5', code: 'F5' })
    await waitFor(() => expect(refreshDebugMemory).toHaveBeenCalledWith('session'))
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
  })

  it('does not show a late structure tooltip after the process continues', async () => {
    let answer!: (value: HexToolTipInfoResponse) => void
    getDebugMemoryToolTipInfo.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const { container, queryByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'k', code: 'KeyK', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'i', code: 'KeyI', ctrlKey: true })
    await waitFor(() => expect(getDebugMemoryToolTipInfo).toHaveBeenCalled())
    act(() => useAppStore.setState({ debugState: 'running' }))
    await act(async () => { answer({ fields: [], toolTip: { image: null, sections: [[{ text: 'stale field', color: 'text' }]] } }) })
    expect(queryByRole('tooltip')).toBeNull()
  })

  it('says why there is nothing to show while the process runs', () => {
    useAppStore.setState({ debugState: 'running' })
    const { container } = render(<MemoryPane />)
    expect(container.textContent).toContain('Memory can only be read while the process is paused.')
  })

  it('reads the memory again on every stop', async () => {
    render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    readDebugMemory.mockClear()
    act(() => useAppStore.setState({ debugGeneration: 2 }))
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
  })
})
