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

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, readDebugMemory, writeDebugMemory, getDebugMemoryToolTipInfo, getDebugMemoryPositionInfo, resolveDebugMemoryPosition, goToDebugMemoryMetadata, getDebugMemoryFileInfo, refreshDebugMemory },
  })
  useAppStore.setState({ debugSessionId: 'session', debugState: 'stopped', debugSessions: [], debugGeneration: 1 })
})

afterEach(() => cleanup())

describe('MemoryPane', () => {
  it('is the hex editor over the process\'s memory, with unmapped pages shown as ??', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalledWith('session', '0x0', 64 * 1024))
    const firstLine = () => container.querySelector('.hex-line')?.textContent ?? ''
    await waitFor(() => expect(firstLine()).toContain('??'))
    // A 16 MiB window onto a 64-bit address space: the offset column is an address.
    expect(container.querySelector('.hex-offset')!.textContent).toMatch(/^0+$/)
  })

  it('moves its window along when the caret walks off the end of it', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    readDebugMemory.mockClear()
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
    // The view reached the window's end, so the window moved on — 8 MiB in — and the caret went one line past
    // the old window's last byte.
    await waitFor(() => expect(readDebugMemory.mock.calls.some(([, address]) => BigInt(address) >= 0x800000n)).toBe(true))
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
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

  it('asks about addresses, not window offsets, after moving to another memory window', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
    fireEvent.keyDown(view, { key: 'F12', code: 'F12', ctrlKey: true })
    await waitFor(() => expect(getDebugMemoryPositionInfo).toHaveBeenCalledWith('session', 0x100000F))
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100002F$/i))
  })

  it('follows a structure reference outside the current memory window', async () => {
    getDebugMemoryPositionInfo.mockResolvedValueOnce({
      file: null, nestedFile: null, structure: null, editField: null, rva: null, fileOffset: 0,
      fieldReference: { offset: 0x4000020, length: 4 }, reference: null,
    })
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'F12', code: 'F12', ctrlKey: true })
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*4000020$/i))
    expect(readDebugMemory.mock.calls.some(([, address]) => BigInt(address) >= 0x3800000n)).toBe(true)
  })

  it('selects the complete module even when it exceeds the ordinary memory window', async () => {
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
      const start = Number(hex.getAttribute('data-selection-start'))
      const end = Number(hex.getAttribute('data-selection-end'))
      expect(end - start).toBe(0x2000000)
    })
  })

  it('selects relative to the current address after moving to a nonzero window', async () => {
    const { container, findByRole } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector('.hex-content')!
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
    const before = Number(container.querySelector('.hex-view')!.getAttribute('data-caret'))
    fireEvent.keyDown(view, { key: 'l', code: 'KeyL', ctrlKey: true })
    const dialog = await findByRole('dialog', { name: 'Select' })
    fireEvent.change(dialog.querySelector('select[aria-label="Position"]')!, { target: { value: 'current' } })
    const inputs = dialog.querySelectorAll('input')
    fireEvent.change(inputs[0], { target: { value: '0' } })
    fireEvent.change(inputs[1], { target: { value: '1' } })
    fireEvent.click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'OK')!)
    await waitFor(() => {
      const hex = container.querySelector('.hex-view')!
      expect(hex.getAttribute('data-selection-start')).toBe(String(before))
      expect(hex.getAttribute('data-selection-end')).toBe(String(before + 2))
      expect(hex.getAttribute('data-caret-offset')).toMatch(/0*1000010$/i)
    })
  })

  it('does not use a late position translation to move a newer memory window', async () => {
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
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
    await act(async () => { answer({ offset: 0x4000020 }) })
    expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i)
  })

  it('saves a memory selection beyond the debugger read limit without truncating it', async () => {
    const saveHexBytes = vi.fn(async (_base64Data: string) => undefined)
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, saveHexBytes } })
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
    await waitFor(() => expect(saveHexBytes).toHaveBeenCalled())
    const bytes = atob(saveHexBytes.mock.calls[0][0])
    expect(bytes.length).toBe(0x100010)
    expect(bytes.charCodeAt(0x10000F)).toBe(0x0F)
    expect(readDebugMemory.mock.calls.every(([, , count]) => count <= 1024 * 1024)).toBe(true)
    expect(readDebugMemory).toHaveBeenCalledWith('session', '0x100000', 16)
  })

  it('copies an absolute memory address rather than its window-relative offset', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    const oldClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const { container } = render(<MemoryPane />)
      await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
      const view = container.querySelector('.hex-content')!
      fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
      fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
      await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
      fireEvent.keyDown(view, { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('0x100000F'))
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
