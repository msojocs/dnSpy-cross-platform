import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { HexView } from './SpecialDocuments'

const moduleId = 'mod1'
const fileLength = 0x2000

/** A file whose byte at `offset` is `offset % 251`, so any chunk is tellable from any other. */
const fileByte = (offset: number): number => offset % 251

const base64Of = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))

const getHexLength = vi.fn(async () => ({ length: fileLength }))
const readHex = vi.fn(async (_workspaceId: string, _moduleId: string, offset: number, count: number) => ({
  offset,
  base64Data: base64Of(Array.from({ length: Math.max(0, Math.min(count, fileLength - offset)) }, (_, index) => fileByte(offset + index))),
  endOfFile: offset + count >= fileLength,
}))
const beginEdit = vi.fn(async () => ({ transactionId: 'tx1' }))
const patchHex = vi.fn(async () => undefined)
const commitEdit = vi.fn(async () => ({ stateId: 'state-2', canUndo: true, canRedo: false, savedStateId: 'state-1', changedNodeIds: [] }))

beforeEach(() => {
  // The view remembers where each file was left, so a test must not inherit the last one's caret.
  localStorage.clear()
  getHexLength.mockClear()
  readHex.mockClear()
  beginEdit.mockClear()
  patchHex.mockClear()
  commitEdit.mockClear()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      getHexLength,
      readHex,
      beginEdit,
      patchHex,
      commitEdit,
      findHex: vi.fn(async () => ({ offset: -1 })),
      resolveHexPosition: vi.fn(async () => ({ offset: -1 })),
      goToHexMetadata: vi.fn(async () => ({ range: null })),
      saveHexSelection: vi.fn(async () => undefined),
    },
  })
  useAppStore.setState({
    workspaceId: 'w1',
    workspaceStateId: 'state-1',
    hexNavigation: undefined,
    modules: [{ id: moduleId, name: 'test.dll', path: '/tmp/test.dll', hasPdb: false }],
  })
})

afterEach(cleanup)

/** The rows the view drew: only what fits the viewport, since the rest is scrolled to. */
const lines = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.hex-line')]

/** Waits until the drawn rows hold real bytes rather than the unreadable cells a chunk shows before it loads. */
const loadedLines = async (container: HTMLElement): Promise<HTMLElement[]> => {
  await waitFor(() => expect(lines(container).length).toBeGreaterThan(0))
  await waitFor(() => expect(container.querySelector('.hex-values')!.textContent).not.toContain('?'))
  return lines(container)
}

describe('HexView', () => {
  it('draws the file as addresses, grouped bytes and an ASCII column', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)

    const drawn = await loadedLines(container)
    // The first chunk is read once and every row on screen comes out of it.
    expect(readHex).toHaveBeenCalledWith('w1', moduleId, 0, 64 * 1024)

    const first = drawn[0]
    // dnSpy narrows the offset column to the file: 8 KiB needs four digits, not eight.
    expect(first.querySelector('.hex-address')).toHaveTextContent('0000')
    expect(first.querySelector('.hex-values')!.textContent).toContain('00 01 02 03')
    // 0x00 is not printable, so the ASCII column of the first row is dots.
    expect(first.querySelector('.hex-ascii')!.textContent).toBe('.'.repeat(16))
  })

  it('writes two uppercase digits per byte, with dnSpy’s groups kept apart', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    const drawn = await loadedLines(container)

    const cells = [...drawn[0].querySelectorAll<HTMLElement>('.hex-values .hex-byte')]
    expect(cells).toHaveLength(16)
    expect(cells[0].textContent).toBe('00')
    // dnSpy's default group size is 8, so the second half of the row is the odd group.
    expect(cells[7].className).not.toContain('hex-group-1')
    expect(cells[8].className).toContain('hex-group-1')
  })

  it('jumps to the range a hex command named and marks it', async () => {
    // "Show ... in Hex Editor" names a file offset; the careet lands there and the range is marked. (jsdom
    // lays nothing out, so a scroll cannot move the drawn rows; the offset chosen is on the first screen.)
    act(() => { useAppStore.getState().showHexAt(moduleId, 0x120, 2) })
    const { container } = render(<HexView moduleId={moduleId} />)

    const marked = () => [...container.querySelectorAll<HTMLElement>('.hex-byte-marked')]
    await waitFor(() => expect(marked()).toHaveLength(2))
    expect(marked().map((cell) => cell.textContent)).toEqual([
      fileByte(0x120).toString(16).toUpperCase().padStart(2, '0'),
      fileByte(0x121).toString(16).toUpperCase().padStart(2, '0'),
    ])
    expect(container.querySelector('.hex-status-offset')).toHaveTextContent('0120')
  })

  it('leaves another module’s tab where it was', async () => {
    act(() => { useAppStore.getState().showHexAt('other', 0x1500 + 3, 2) })
    const { container } = render(<HexView moduleId={moduleId} />)

    await waitFor(() => expect(lines(container).length).toBeGreaterThan(0))
    expect(readHex).toHaveBeenCalledWith('w1', moduleId, 0, 64 * 1024)
    expect(container.querySelectorAll('.hex-byte-marked')).toHaveLength(0)
  })

  it('reads the file again after an edit, so an undo shows up here', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(readHex).toHaveBeenCalledTimes(1))

    // A byte patch is an edit like any other, and every edit bumps the state id.
    act(() => { useAppStore.setState({ workspaceStateId: 'state-2' }) })

    await waitFor(() => expect(readHex).toHaveBeenCalledTimes(2))
    expect(lines(container).length).toBeGreaterThan(0)
  })

  it('moves the caret with the keyboard and selects with Shift', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(lines(container).length).toBeGreaterThan(0))
    const content = container.querySelector<HTMLElement>('.hex-content')!

    fireEvent.keyDown(content, { key: 'ArrowRight' })
    fireEvent.keyDown(content, { key: 'ArrowRight' })
    // Right moves a nibble at a time in the values column, so two presses land on the second nibble.
    await waitFor(() => expect(container.querySelector('.hex-byte-caret')).not.toBeNull())

    fireEvent.keyDown(content, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(content, { key: 'ArrowRight', shiftKey: true })
    await waitFor(() => expect(container.querySelectorAll('.hex-byte-selected').length).toBeGreaterThan(0))
  })

  it('selects the whole file with Ctrl+A and shows the selection in the status bar', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(lines(container).length).toBeGreaterThan(0))

    // Monaco-style handlers key off `code`, so the synthetic event has to carry it too.
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'a', code: 'KeyA', ctrlKey: true })

    await waitFor(() => expect(container.querySelector('.hex-status')!.textContent).toMatch(/\(\d[\d,]* bytes\)/))
    expect(container.querySelectorAll('.hex-byte-selected').length).toBeGreaterThan(0)
  })

  it('writes a typed hex digit through the edit transaction', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(lines(container).length).toBeGreaterThan(0))

    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'A' })

    await waitFor(() => expect(patchHex).toHaveBeenCalled())
    // The first byte of the file is 0x00, so its high nibble becomes 0xA and the byte is 0xA0.
    expect(patchHex).toHaveBeenCalledWith('w1', 'tx1', moduleId, 0, base64Of([0xA0]))
    expect(commitEdit).toHaveBeenCalledWith('w1', 'tx1')
  })

  it('has no pagination: the whole file is one scrollable dump', async () => {
    render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull())
    expect(screen.getByRole('textbox', { name: 'Hex' })).toBeInTheDocument()
  })
})
