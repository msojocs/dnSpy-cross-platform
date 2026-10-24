import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { HexView } from './SpecialDocuments'
import { loadAppOptions, saveAppOptions } from './app-options'

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
      getRoots: vi.fn(async () => ({ nodes: [] })),
      findHex: vi.fn(async () => ({ offset: -1 })),
      resolveHexPosition: vi.fn(async () => ({ offset: -1 })),
      goToHexMetadata: vi.fn(async () => ({ range: null })),
      pickHexSaveFile: vi.fn(async () => undefined),
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

/** Waits until the drawn rows hold the file's bytes, which they do once the chunk under them is read. */
const loadedLines = async (container: HTMLElement): Promise<HTMLElement[]> => {
  await waitFor(() => expect(container.querySelector('.hex-byte[data-hex-column="values"]')).not.toBeNull())
  return lines(container)
}

const view = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.hex-view')!

describe('HexView', () => {
  it('draws the file as offsets, grouped bytes and an ASCII column', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)

    const drawn = await loadedLines(container)
    // The first chunk is read once and every row on screen comes out of it.
    expect(readHex).toHaveBeenCalledWith('w1', moduleId, 0, fileLength)

    const first = drawn[0]
    // dnSpy narrows the offset column to the file: 8 KiB needs four digits, not eight.
    expect(first.querySelector('.hex-offset')).toHaveTextContent('0000')
    // One line of text: offset, values and ASCII separated by a space, as HexBufferLineFormatterImpl writes it.
    expect(first.textContent).toContain('0000 00 01 02 03')
    // 0x00 is not printable, so the ASCII column of the first row is dots.
    expect([...first.querySelectorAll('.hex-ascii')].map((cell) => cell.textContent).join('')).toBe('.'.repeat(16))
  })

  it('writes two uppercase digits per byte, with dnSpy’s groups in their two colours', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    const drawn = await loadedLines(container)

    const cells = [...drawn[0].querySelectorAll<HTMLElement>('.hex-byte[data-hex-column="values"]')]
    expect(cells).toHaveLength(16)
    expect(cells[0].textContent).toBe('00')
    // dnSpy's default group size is 8, so the second half of the row is the other group.
    expect(cells[7].className).toContain('hex-byte0')
    expect(cells[8].className).toContain('hex-byte1')
  })

  it('selects the range a hex command named, the caret on its first byte', async () => {
    // "Show ... in Hex Editor" names a file offset; dnSpy selects the bytes and puts the caret on the first one.
    act(() => { useAppStore.getState().showHexAt(moduleId, 0x120, 2) })
    const { container } = render(<HexView moduleId={moduleId} />)

    await waitFor(() => expect(view(container).dataset.selectionStart).toBe(String(0x120)))
    expect(view(container).dataset.selectionEnd).toBe(String(0x122))
    expect(view(container).dataset.caret).toBe(String(0x120))
    const selected = () => [...container.querySelectorAll<HTMLElement>('[data-hex-column="values"][data-selected]')]
    await waitFor(() => expect(selected().map((cell) => cell.textContent)).toEqual([
      fileByte(0x120).toString(16).toUpperCase().padStart(2, '0'),
      fileByte(0x121).toString(16).toUpperCase().padStart(2, '0'),
    ]))
  })

  it('leaves another module’s tab where it was', async () => {
    act(() => { useAppStore.getState().showHexAt('other', 0x1500 + 3, 2) })
    const { container } = render(<HexView moduleId={moduleId} />)

    await loadedLines(container)
    expect(readHex).toHaveBeenCalledWith('w1', moduleId, 0, fileLength)
    expect(view(container).dataset.selectionStart).toBeUndefined()
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
    await loadedLines(container)
    const content = container.querySelector<HTMLElement>('.hex-content')!

    fireEvent.keyDown(content, { key: 'ArrowRight', code: 'ArrowRight' })
    // Right moves a nibble at a time in the values column, so one press stays on the first byte.
    expect(view(container).dataset.caret).toBe('0')
    fireEvent.keyDown(content, { key: 'ArrowRight', code: 'ArrowRight' })
    expect(view(container).dataset.caret).toBe('1')

    fireEvent.keyDown(content, { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(content, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true })
    expect(view(container).dataset.selectionStart).toBe('1')
    expect(view(container).dataset.selectionEnd).toBe(String(1 + 16 + 1))
  })

  it('selects the whole file with Ctrl+A', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)

    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'a', code: 'KeyA', ctrlKey: true })

    expect(view(container).dataset.selectionStart).toBe('0')
    expect(view(container).dataset.selectionEnd).toBe(String(fileLength))
  })

  it('opens the search control with Ctrl+F and finds through the backend', async () => {
    const searchHex = vi.fn(async () => ({ offsets: [0x40] }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, searchHex } })
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)

    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'f', code: 'KeyF', ctrlKey: true })
    const box = await screen.findByRole('textbox', { name: 'Find' })
    fireEvent.change(box, { target: { value: '40 41' } })

    await waitFor(() => expect(view(container).dataset.selectionStart).toBe(String(0x40)))
    expect(searchHex).toHaveBeenCalledWith('w1', moduleId, expect.objectContaining({ base64Pattern: base64Of([0x40, 0x41]), maxResults: 1, wrap: true }))
  })

  it('shows Quick Info for the structure field under the mouse', async () => {
    const getHexToolTipInfo = vi.fn(async () => ({
      fields: [{ offset: 0, length: 2, kind: 'currentField' }, { offset: 0, length: 0x40, kind: 'structure' }],
      toolTip: { image: 'FieldPublic', sections: [[{ text: 'IMAGE_DOS_HEADER', color: 'valueType' }, { text: '.', color: 'operator' }, { text: 'e_magic', color: 'instanceField' }]] },
    }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, getHexToolTipInfo } })
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    const content = container.querySelector<HTMLElement>('.hex-content')!
    // jsdom has no layout: the first value cell is at character 5 of the first row.
    content.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.mouseMove(content, { clientX: 2 + 5.5 * 13.333 * 0.6, clientY: 5, buttons: 0 })

    expect(await screen.findByRole('tooltip')).toHaveTextContent('IMAGE_DOS_HEADER.e_magic')
    expect(getHexToolTipInfo).toHaveBeenCalledWith('w1', moduleId, 0)
    // The structure under the mouse is highlighted, the field in its own colour.
    expect(container.querySelector('.hex-tooltip-current-field')).not.toBeNull()
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

  it('serializes code-page encoding, writing and caret movement for rapid ASCII input', async () => {
    let finishFirst: ((value: { base64Data: string }) => void) | undefined
    const encodeText = vi.fn((_codePage: number, text: string): Promise<{ base64Data: string }> => {
      if (text === '你')
        return new Promise((resolve) => { finishFirst = resolve })
      return Promise.resolve({ base64Data: base64Of([0xBA, 0xC3]) })
    })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, encodeText } })
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    act(() => {
      const options = loadAppOptions()
      options.hexEditor.hexViewer.general.encoding = '936'
      saveAppOptions(options)
    })
    const content = container.querySelector('.hex-content')!
    fireEvent.keyDown(content, { key: 'Tab', code: 'Tab' })
    fireEvent.keyDown(content, { key: '你' })
    fireEvent.keyDown(content, { key: '好' })
    await waitFor(() => expect(encodeText).toHaveBeenCalledTimes(1))
    expect(patchHex).not.toHaveBeenCalled()
    await act(async () => { finishFirst!({ base64Data: base64Of([0xC4, 0xE3]) }) })
    await waitFor(() => expect(patchHex).toHaveBeenCalledTimes(2))
    expect(patchHex.mock.calls).toEqual([
      ['w1', 'tx1', moduleId, 0, base64Of([0xC4, 0xE3])],
      ['w1', 'tx1', moduleId, 2, base64Of([0xBA, 0xC3])],
    ])
    expect(view(container).dataset.caret).toBe('4')
  })

  it('recovers after an encoding error without advancing the caret', async () => {
    const encodeText = vi.fn().mockRejectedValueOnce(new Error('encoding failed')).mockResolvedValue({ base64Data: base64Of([0xBA, 0xC3]) })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, encodeText } })
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    act(() => {
      const options = loadAppOptions()
      options.hexEditor.hexViewer.general.encoding = '936'
      saveAppOptions(options)
    })
    const content = container.querySelector('.hex-content')!
    fireEvent.keyDown(content, { key: 'Tab', code: 'Tab' })
    fireEvent.keyDown(content, { key: '你' })
    fireEvent.keyDown(content, { key: '好' })
    await waitFor(() => expect(patchHex).toHaveBeenCalledTimes(1))
    expect(patchHex).toHaveBeenCalledWith('w1', 'tx1', moduleId, 0, base64Of([0xBA, 0xC3]))
    expect(view(container).dataset.caret).toBe('2')
  })

  it('opens Go to Offset even when the current memory cannot be read', async () => {
    const { container } = render(<HexView source={{
      length: 0x10000, revision: 'unmapped',
      read: async () => { throw new Error('unreadable memory') },
      write: async () => false,
    }} />)
    fireEvent.keyDown(container.querySelector('.hex-content')!, { key: 'g', code: 'KeyG', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: 'Go to Offset' })).toBeInTheDocument()
  })

  it('has no pagination: the whole file is one scrollable dump', async () => {
    render(<HexView moduleId={moduleId} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull())
    expect(screen.getByRole('textbox', { name: 'Hex' })).toBeInTheDocument()
  })
})

describe('HexView, as dnSpy’s operations behave', () => {
  /** The module search over the test file: FindAll forward from the start, wrapping, as far as `maxResults`. */
  const searchHex = vi.fn(async (_workspaceId: string, _moduleId: string, request: { base64Pattern: string; start: number; reverse: boolean; rangeStart: number; rangeEnd: number; maxResults: number; noOverlaps: boolean }) => {
    const pattern = Array.from(atob(request.base64Pattern), (character) => character.charCodeAt(0))
    const matchAt = (offset: number): boolean => offset + pattern.length <= request.rangeEnd && pattern.every((byte, index) => fileByte(offset + index) === byte)
    const offsets: number[] = []
    for (let offset = request.start; offset < request.rangeEnd && offsets.length < request.maxResults; offset++) {
      if (matchAt(offset)) {
        offsets.push(offset)
        if (request.noOverlaps)
          offset += pattern.length - 1
      }
    }
    for (let offset = request.rangeStart; offset < request.start && offsets.length < request.maxResults; offset++) {
      if (matchAt(offset))
        offsets.push(offset)
    }
    return { offsets }
  })

  beforeEach(() => {
    searchHex.mockClear()
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, searchHex } })
  })

  const content = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.hex-content')!

  it('runs nothing for a second key that completes no chord', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    fireEvent.keyDown(content(container), { key: 'e', code: 'KeyE', ctrlKey: true })
    fireEvent.keyDown(content(container), { key: 'ArrowRight', code: 'ArrowRight' })
    expect(view(container).dataset.caret).toBe('0')
    fireEvent.keyDown(content(container), { key: 'ArrowRight', code: 'ArrowRight' })
    fireEvent.keyDown(content(container), { key: 'ArrowRight', code: 'ArrowRight' })
    expect(view(container).dataset.caret).toBe('1')
  })

  it('keeps an incremental search going through its own matches, the typed keys never written', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    fireEvent.keyDown(content(container), { key: 'i', code: 'KeyI', ctrlKey: true })
    for (const key of '0102') {
      fireEvent.keyDown(content(container), { key })
      // Each key searches before the next is typed, as the user would see it.
      await waitFor(() => expect(searchHex).toHaveBeenCalled())
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
    await waitFor(() => {
      expect(view(container).dataset.selectionStart).toBe('1')
      expect(view(container).dataset.selectionEnd).toBe('3')
    })
    expect(patchHex).not.toHaveBeenCalled()
    // F3 ends the incremental search and finds the next match with the Find options.
    fireEvent.keyDown(content(container), { key: 'F3', code: 'F3' })
    await waitFor(() => expect(view(container).dataset.selectionStart).toBe(String(252)))
  })

  it('closes the search control with Esc even with bytes selected, the selection kept', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    fireEvent.keyDown(content(container), { key: 'f', code: 'KeyF', ctrlKey: true })
    await screen.findByRole('textbox', { name: 'Find' })
    fireEvent.keyDown(content(container), { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(content(container), { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Find' })).toBeNull())
    expect(view(container).dataset.selectionEnd).toBe('1')
  })

  it('replaces every match as one edit', async () => {
    const hexWriteBytesMany = vi.fn(async () => true)
    useAppStore.setState({ hexWriteBytesMany })
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    fireEvent.keyDown(content(container), { key: 'h', code: 'KeyH', ctrlKey: true })
    const find = await screen.findByRole('textbox', { name: 'Find' })
    fireEvent.change(find, { target: { value: '0102' } })
    const replaceAll = screen.getByRole('button', { name: 'Replace all' })
    // Replace All needs a valid replacement: "zz" is not bytes.
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace' }), { target: { value: 'zz' } })
    await waitFor(() => expect(replaceAll).toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace' }), { target: { value: 'FFFF' } })
    await waitFor(() => expect(replaceAll).toBeEnabled())
    fireEvent.click(replaceAll)
    await waitFor(() => expect(hexWriteBytesMany).toHaveBeenCalledTimes(1))
    const [, patches] = hexWriteBytesMany.mock.calls[0] as unknown as [string, { offset: number; data: Uint8Array }[]]
    expect(patches.map((patch) => patch.offset)).toEqual(Array.from({ length: Math.ceil((fileLength - 2) / 251) }, (_, index) => 1 + index * 251).filter((offset) => offset + 2 <= fileLength))
    expect(Array.from(patches[0].data)).toEqual([0xFF, 0xFF])
  })

  it('draws a 0x3F byte in the ASCII colour and only bytes that cannot be read in the error colour', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    for (let i = 0; i < 3; i++)
      fireEvent.keyDown(content(container), { key: 'ArrowDown', code: 'ArrowDown' })
    await waitFor(() => expect(container.querySelector('[data-hex-column="ascii"][data-hex-byte="63"]')).not.toBeNull())
    const question = container.querySelector<HTMLElement>('[data-hex-column="ascii"][data-hex-byte="63"]')!
    expect(question.textContent).toBe('?')
    expect(question.className).toContain('hex-ascii')
    expect(question.className).not.toContain('hex-byte-error')
  })

  it('scrolls with Ctrl+wheel when mouse wheel zoom is off', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    const options = loadAppOptions()
    act(() => saveAppOptions({ ...options, hexEditor: { ...options.hexEditor, hexViewer: { ...options.hexEditor.hexViewer, advanced: { ...options.hexEditor.hexViewer.advanced, enableMouseWheelZoom: false } } } }))
    fireEvent.wheel(content(container), { deltaY: 100, ctrlKey: true })
    await waitFor(() => expect(lines(container)[0].dataset.lineOffset).toBe(String(3 * 16)))
  })

  it('treats a fourth click as a click', async () => {
    const { container } = render(<HexView moduleId={moduleId} />)
    await loadedLines(container)
    // Well inside the values column, past the offset.
    fireEvent.mouseDown(content(container), { button: 0, detail: 3, clientX: 200, clientY: 1 })
    expect(view(container).dataset.selectionEnd).toBe('16')
    fireEvent.mouseUp(window)
    fireEvent.mouseDown(content(container), { button: 0, detail: 4, clientX: 200, clientY: 1 })
    expect(view(container).dataset.selectionEnd).toBeUndefined()
  })
})
