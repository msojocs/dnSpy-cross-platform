import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../app-store'
import { useCategoryFont } from '../fonts'
import {
  concatBytes,
  compressedUIntPrefix,
  csharpArrayText,
  findPatternBytes,
  formatHexOffset,
  hexNumberText,
  hexText,
  lineOf,
  offsetBitSizeFor,
  parseHexBytes,
  resolveBytesPerLine,
  selectionBetween,
  sevenBitLengthPrefix,
  visualBasicArrayText,
  type HexLineFormatOptions,
  type HexSelection,
  type HexValuesFormat,
} from '../hex-model'
import { useLanguage } from '../localization'
import { useAppOptions, type HexEditorView } from './app-options'
import { DsIcon } from './DsIcon'
import {
  HexGoToMetadataDialog,
  HexGoToPositionDialog,
  HexLocalSettingsDialog,
  HexSelectDialog,
  parseHexNumber,
  VALUE_FORMAT_CHOICES,
  type GoToMetadataResult,
  type GoToPositionResult,
  type HexLocalSettings,
  type SelectResult,
} from './HexDialogs'
import { MenuPopup } from './MenuBar'
import type { MenuItem } from './edit-menu'

/** The height one dump line takes, which is also the unit the view scrolls and pages in. */
const ROW_HEIGHT = 20
const OVERSCAN = 20
const FALLBACK_HEIGHT = 600
/** The chunk the view reads at a time, under the backend's 1 MiB read limit and aligned with it. */
const CHUNK_SIZE = 64 * 1024

const visibleRowRange = (count: number, top: number, height: number): { first: number; last: number } => ({
  first: Math.max(0, Math.min(count, Math.floor(top / ROW_HEIGHT) - OVERSCAN)),
  last: Math.min(count, Math.ceil((top + (height > 0 ? height : FALLBACK_HEIGHT)) / ROW_HEIGHT) + OVERSCAN),
})

/** Which of the caret's two halves a keystroke edits: the values column edits a nibble, the ASCII one a byte. */
type HexColumn = 'values' | 'ascii'

interface HexCaret {
  offset: number
  column: HexColumn
  /** The nibble inside the byte the values column is editing; the ASCII column ignores it. */
  nibble: 0 | 1
}

interface HexViewPersisted {
  offset: number
  selectionStart: number
  selectionEnd: number
  bytesPerLine: number
  valuesFormat: HexValuesFormat
}

const viewStateKey = 'dnspy.hexViews.v1'

const loadHexViewStates = (): Record<string, HexViewPersisted> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(viewStateKey) ?? '{}') as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, HexViewPersisted> : {}
  }
  catch {
    return {}
  }
}

/** What one hex tab remembers across a restart — dnSpy's `HexViewUIStateSerializer`. */
const hexViewStateOf = (path: string | undefined): HexViewPersisted | undefined =>
  path === undefined ? undefined : loadHexViewStates()[path]

const saveHexViewState = (path: string | undefined, state: HexViewPersisted): void => {
  if (path === undefined)
    return
  try {
    localStorage.setItem(viewStateKey, JSON.stringify({ ...loadHexViewStates(), [path]: state }))
  }
  catch {
    // A full store must not take the view down with it.
  }
}

/** The line layout dnSpy's hex editor options describe, from the page the options dialog writes. */
const lineFormatOf = (options: ReturnType<typeof useAppOptions>['hexEditor']['hexViewer']): HexLineFormatOptions => ({
  bytesPerLine: 0,
  groupSize: options.general.groupSizeInBytes,
  showOffset: true,
  showValues: true,
  showAscii: true,
  offsetFormat: options.general.hexOffsetFormat,
  offsetBitSize: 0,
  valuesLowerCaseHex: options.general.valuesLowerCaseHex,
  offsetLowerCaseHex: options.general.offsetLowerCaseHex,
  valuesFormat: 'hexByte',
})

const encodings: Record<string, string> = {
  utf8: 'utf-8',
  utf16: 'utf-16le',
  utf16BE: 'utf-16be',
  ascii: 'ascii',
  latin1: 'iso-8859-1',
}

/** The text the ASCII column edits and pastes go through, by the encoding the options page names. */
const encodeText = (text: string, encoding: string): Uint8Array => {
  const name = encodings[encoding] ?? 'utf-8'
  if (name === 'utf-16le' || name === 'utf-16be') {
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      const big = name === 'utf-16be'
      bytes[i * 2 + (big ? 0 : 1)] = code & 0xFF
      bytes[i * 2 + (big ? 1 : 0)] = code >> 8
    }
    return bytes
  }
  if (name === 'ascii' || name === 'iso-8859-1')
    return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xFF)
  return new TextEncoder().encode(text)
}

const base64Of = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Bytes the hex view shows that are not a module's file — the Memory windows' window onto a process's memory.
 * Offsets are from the start of the window; the offset column reads them as addresses from `base`.
 */
export interface HexByteSource {
  /** Where the view's state is remembered; a source without one remembers nothing. */
  stateKey?: string
  length: number
  base: number
  /** Changes whenever the bytes may have: every chunk is read again. */
  revision: string
  /** The bytes from `offset` on, and for each 4 KiB page from the one `offset` is in whether it could be read. */
  read(offset: number, count: number): Promise<{ bytes: Uint8Array; readable?: boolean[] }>
  write(offset: number, data: Uint8Array): Promise<boolean>
  /** Moves the window so it holds `address`; answers the address's offset in the new window. */
  reveal(address: number): number
  /** One past the last address the window may move to, when the source is a window onto a larger space. */
  end?: number
  /** Entries the source's owner adds at the end of the context menu, such as the Memory window's Process submenu. */
  menu?: MenuItem[]
  /** The options page the view follows: the Memory windows have one of their own. */
  optionsView?: HexEditorView
}

const PAGE_SIZE = 4096

export interface HexViewCommands {
  /** dnSpy's Go to Code or Structure (F12): the bytes under the caret are opened as the node they name. */
  onGoToCodeOrStructure?(offset: number): void
  /** dnSpy's Follow Field Value Reference (Ctrl+F12). */
  onFollowReference?(offset: number): void
}

/**
 * dnSpy's hex editor, browse side: the file as lines of offset, grouped bytes and ASCII, with a caret and a
 * selection that can be moved, copied, filled and — for a module that can be edited — typed over. The model
 * behind it is `hex-model.ts`; the numbers the dialogs take are parsed the way dnSpy parses them.
 *
 * The whole file is addressable: rows are drawn from the viewport alone, and the 64 KiB chunk each row sits
 * in is read on demand, so a large file scrolls without ever being loaded.
 */
export const HexView = ({ moduleId = '', source, commands }: { moduleId?: string; source?: HexByteSource; commands?: HexViewCommands }): React.JSX.Element => {
  const hexFont = useCategoryFont('hexEditor')
  const options = useAppOptions()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const modules = useAppStore((state) => state.modules)
  // Every edit bumps the state id, and a byte patch is an edit like any other, so the chunks are read again
  // after one — which is what makes an undo show up here.
  const workspaceStateId = useAppStore((state) => state.workspaceStateId)
  const navigation = useAppStore((state) => state.hexNavigation)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const { locale, t } = useLanguage()

  const modulePath = useMemo(() => source ? source.stateKey : modules.find((module) => module.id === moduleId)?.path, [modules, moduleId, source])
  const saved = useMemo(() => hexViewStateOf(modulePath), [modulePath])
  const [fileLength, setLength] = useState(0)
  const length = source ? source.length : fileLength
  const [caret, setCaret] = useState<HexCaret>({ offset: saved?.offset ?? 0, column: 'values', nibble: 0 })
  const [anchor, setAnchor] = useState<number | undefined>(undefined)
  const [marked, setMarked] = useState<HexSelection | undefined>(undefined)
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 })
  const [dialog, setDialog] = useState<'goto' | 'metadata' | 'select' | 'settings' | 'fill' | 'find' | undefined>(undefined)
  const [fillText, setFillText] = useState('FF')
  const [findText, setFindText] = useState('')
  const [findStatus, setFindStatus] = useState<string | undefined>(undefined)
  /** The byte range the view is narrowed to — dnSpy's Show Only Selected Bytes, cleared by Show All Bytes. */
  const [visibleRange, setVisibleRange] = useState<HexSelection | undefined>(undefined)
  /** The bytes-per-line the context menu sets; 0 is dnSpy's "Fit to width". */
  const [bytesPerLineSetting, setBytesPerLineSetting] = useState<number>(saved?.bytesPerLine ?? 16)
  const [valuesFormat, setValuesFormat] = useState<HexValuesFormat>(saved?.valuesFormat ?? 'hexByte')
  const [offsetFormat, setOffsetFormat] = useState(options.hexEditor[source?.optionsView ?? 'hexViewer'].general.hexOffsetFormat)
  /** The columns the local settings dialog hides; dnSpy keeps this per view, not in the options file. */
  const [columns, setColumns] = useState<{ showOffset: boolean; showValues: boolean; showAscii: boolean }>({ showOffset: true, showValues: true, showAscii: true })
  /** The positions the local settings dialog names: the bytes the view shows, and how the addresses read. */
  const [positions, setPositions] = useState<{ startPosition: number; endPosition: number; basePosition: number; useRelativePositions: boolean }>({ startPosition: 0, endPosition: 0, basePosition: 0, useRelativePositions: false })
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined)

  const contentRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef(false)
  const chunks = useRef(new Map<number, Uint8Array>())
  /** For a source's chunks, the 4 KiB pages that could not be read: their cells read as dnSpy's `??`. */
  const unreadable = useRef(new Map<number, boolean[]>())
  const pending = useRef(new Set<number>())
  const [chunkVersion, setChunkVersion] = useState(0)

  const paneOptions = options.hexEditor[source?.optionsView ?? 'hexViewer']
  const offsetBitSize = offsetBitSizeFor(source ? source.base + length : length)
  const lineFormat = useMemo<HexLineFormatOptions>(() => ({
    ...lineFormatOf(paneOptions),
    bytesPerLine: bytesPerLineSetting,
    valuesFormat,
    offsetBitSize,
    offsetFormat,
    showOffset: columns.showOffset,
    showValues: columns.showValues,
    showAscii: columns.showAscii,
  }), [paneOptions, bytesPerLineSetting, valuesFormat, offsetBitSize, offsetFormat, columns])

  /** The line length the view settles on, once "fit to width" has been worked out from the measured width. */
  const bytesPerLine = useMemo(() => {
    const charsPerLine = Math.max(40, Math.floor((viewport.width - 16) / 7.2))
    return resolveBytesPerLine(lineFormat, offsetBitSize, charsPerLine)
  }, [lineFormat, offsetBitSize, viewport.width])

  const selection = useMemo<HexSelection | undefined>(() => anchor === undefined ? undefined : selectionBetween(anchor, caret.offset), [anchor, caret.offset])
  const fileRange = positions.endPosition > positions.startPosition
    ? { start: Math.min(positions.startPosition, length), end: Math.min(positions.endPosition, length) }
    : { start: 0, end: length }
  const range = visibleRange ?? fileRange
  /** dnSpy's `ToLogicalPosition`: what an address reads once a base and relative positions are in play. */
  const logicalOffset = (offset: number): number => offset - (positions.useRelativePositions ? range.start : 0) + positions.basePosition + (source?.base ?? 0)
  const lineCount = Math.max(1, Math.ceil((range.end - range.start) / bytesPerLine))

  // The file's length, read once per module and again after an edit.
  useEffect(() => {
    if (!workspaceId || source)
      return
    void window.dnSpy.getHexLength(workspaceId, moduleId).then((response) => setLength(response.length))
  }, [workspaceId, moduleId, workspaceStateId, source])

  const measure = useCallback((): void => {
    const element = contentRef.current
    if (!element)
      return
    setViewport((current) => current.top === element.scrollTop && current.height === element.clientHeight && current.width === element.clientWidth
      ? current
      : { top: element.scrollTop, height: element.clientHeight, width: element.clientWidth })
  }, [])

  // A hex command names the module it wants, and this tab is only the one to answer when the names match.
  useEffect(() => {
    if (!navigation || navigation.moduleId !== moduleId)
      return
    setVisibleRange(undefined)
    setAnchor(undefined)
    setCaret({ offset: Math.min(navigation.offset, Math.max(0, length - 1)), column: 'values', nibble: 0 })
    setMarked({ start: navigation.offset, end: navigation.offset + Math.max(navigation.length, 1) })
    const element = contentRef.current
    if (element) {
      element.scrollTop = Math.max(0, (Math.floor(navigation.offset / bytesPerLine) - 2) * ROW_HEIGHT)
      // The rows that are drawn follow the scroll position, so the viewport has to be read back before the
      // chunk under the new position is asked for.
      measure()
    }
  }, [navigation, moduleId, bytesPerLine, length, measure])

  // A dialog hands the focus back to the dump when it closes, the way the view had it before it opened;
  // without this the next shortcut would go to the window instead of the hex editor.
  const previousDialog = useRef(dialog)
  useEffect(() => {
    if (previousDialog.current !== undefined && dialog === undefined && menu === undefined)
      contentRef.current?.focus({ preventScroll: true })
    previousDialog.current = dialog
  }, [dialog, menu])

  // A fresh state id — an edit, an undo — invalidates every chunk, so the patch shows up; so does a source's
  // new stop or new window.
  useEffect(() => {
    chunks.current.clear()
    unreadable.current.clear()
    pending.current.clear()
    setChunkVersion((version) => version + 1)
  }, [workspaceStateId, source?.revision, source?.base])

  const loadRange = useCallback((start: number, end: number): void => {
    if ((!workspaceId && !source) || length === 0)
      return
    const firstChunk = Math.max(0, Math.floor(start / CHUNK_SIZE))
    const lastChunk = Math.min(Math.floor(Math.max(0, length - 1) / CHUNK_SIZE), Math.floor((Math.max(start + 1, end) - 1) / CHUNK_SIZE))
    for (let index = firstChunk; index <= lastChunk; index++) {
      if (chunks.current.has(index) || pending.current.has(index))
        continue
      pending.current.add(index)
      const offset = index * CHUNK_SIZE
      const read = source
        ? source.read(offset, Math.min(CHUNK_SIZE, length - offset)).then((response) => {
          unreadable.current.set(index, (response.readable ?? []).map((readable) => !readable))
          return response.bytes
        })
        : window.dnSpy.readHex(workspaceId!, moduleId, offset, CHUNK_SIZE).then((response) => {
          const binary = atob(response.base64Data)
          return Uint8Array.from(binary, (character) => character.charCodeAt(0))
        })
      void read.then((bytes) => {
        chunks.current.set(index, bytes)
        pending.current.delete(index)
        setChunkVersion((version) => version + 1)
      }).catch(() => {
        // A chunk that cannot be read stays blank, which reads as dnSpy's unreadable cells.
        pending.current.delete(index)
        setChunkVersion((version) => version + 1)
      })
    }
  }, [workspaceId, moduleId, length, source])

  const { first, last } = visibleRowRange(lineCount, viewport.top, viewport.height)
  // `chunkVersion` is in the dependencies so a chunk that an edit invalidated is read again even though the
  // rows on screen are the same ones.
  useLayoutEffect(() => {
    if (length === 0)
      return
    loadRange(range.start + first * bytesPerLine, range.start + last * bytesPerLine)
  }, [first, last, bytesPerLine, range.start, length, loadRange, chunkVersion])

  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !contentRef.current)
      return
    const observer = new ResizeObserver(measure)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [measure])

  /** The caret's line is scrolled into sight whenever it moves outside the viewport. */
  // ---- A source's window ---------------------------------------------------------------------------

  /** The address the view is to show once a source's window has moved, and whether the caret goes there too. */
  const pendingAddress = useRef<{ address: number; caret: boolean } | undefined>(undefined)
  const previousBase = useRef(source?.base ?? 0)
  const rebaseTo = (address: number, caretFollows = true): void => {
    if (!source)
      return
    pendingAddress.current = { address, caret: caretFollows }
    source.reveal(address)
  }
  // The window moved: what was on screen keeps its address, and the caret and selection their bytes.
  useLayoutEffect(() => {
    if (!source)
      return
    const delta = previousBase.current - source.base
    previousBase.current = source.base
    const pending = pendingAddress.current
    pendingAddress.current = undefined
    if (delta === 0 && !pending)
      return
    const clamp = (offset: number): number => Math.max(0, Math.min(source.length - 1, offset))
    if (pending?.caret)
      setCaret((current) => ({ ...current, offset: clamp(pending.address - source.base), nibble: 0 }))
    else
      setCaret((current) => ({ ...current, offset: clamp(current.offset + delta) }))
    setAnchor((current) => current === undefined ? undefined : clamp(current + delta))
    const element = contentRef.current
    if (element && pending) {
      element.scrollTop = Math.max(0, (Math.floor((pending.address - source.base) / bytesPerLine) - (pending.caret ? 2 : 0)) * ROW_HEIGHT)
      measure()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.base])

  /** A scroll that reaches the edge of a source's window moves the window, so the view scrolls on past it. */
  const onScroll = (): void => {
    measure()
    const element = contentRef.current
    if (!element || source?.end === undefined || pendingAddress.current)
      return
    const edge = 64 * ROW_HEIGHT
    const topAddress = source.base + Math.floor(element.scrollTop / ROW_HEIGHT) * bytesPerLine
    if (element.scrollTop < edge && source.base > 0)
      rebaseTo(topAddress, false)
    else if (element.scrollTop + element.clientHeight > element.scrollHeight - edge && source.base + source.length < source.end)
      rebaseTo(topAddress, false)
  }

  const revealCaret = useCallback((offset: number): void => {
    const element = contentRef.current
    if (!element)
      return
    const line = Math.floor((offset - range.start) / bytesPerLine)
    const top = line * ROW_HEIGHT
    if (top < element.scrollTop)
      element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, top + ROW_HEIGHT - element.clientHeight)
    setViewport((current) => current.top === element.scrollTop ? current : { ...current, top: element.scrollTop })
  }, [bytesPerLine, range.start])

  const moveCaret = useCallback((next: number, extend: boolean, column: HexColumn = caret.column): void => {
    // A caret that walks off a source's window takes the window along, over the whole space it is a window onto.
    if (source?.end !== undefined && !extend && (next < 0 || next >= source.length)) {
      const address = Math.max(0, Math.min(source.end - 1, source.base + next))
      if (address !== source.base + caret.offset) {
        rebaseTo(address)
        setAnchor(undefined)
        setMarked(undefined)
        return
      }
    }
    const clamped = Math.max(range.start, Math.min(Math.max(range.start, range.end - 1), next))
    if (extend) {
      if (anchor === undefined)
        setAnchor(caret.offset)
    }
    else
      setAnchor(undefined)
    setCaret({ offset: clamped, column, nibble: caret.nibble })
    setMarked(undefined)
    revealCaret(clamped)
  }, [anchor, caret, range, revealCaret, source])

  const selectRange = useCallback((start: number, end: number): void => {
    if (end <= start)
      return
    const clampedStart = Math.max(range.start, Math.min(range.end, start))
    const clampedEnd = Math.max(range.start, Math.min(range.end, end))
    setAnchor(clampedStart)
    setCaret({ offset: Math.max(clampedStart, clampedEnd - 1), column: 'values', nibble: 0 })
    setMarked(undefined)
    revealCaret(clampedStart)
  }, [range, revealCaret])

  // ---- Edits ---------------------------------------------------------------------------------------

  const readBytes = useCallback(async (offset: number, count: number): Promise<Uint8Array> => {
    if (source)
      return (await source.read(offset, count)).bytes
    if (!workspaceId)
      return new Uint8Array(0)
    const response = await window.dnSpy.readHex(workspaceId, moduleId, offset, count)
    const binary = atob(response.base64Data)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }, [workspaceId, moduleId, source])

  const writeBytes = useCallback(async (offset: number, data: Uint8Array, message?: string): Promise<boolean> => {
    if (!source)
      return useAppStore.getState().hexWriteBytes(moduleId, offset, data, message)
    const written = await source.write(offset, data)
    // A write to memory is no edit of the workspace, so the chunks it touched are read again here.
    for (let index = Math.floor(offset / CHUNK_SIZE); index <= Math.floor((offset + Math.max(1, data.length) - 1) / CHUNK_SIZE); index++)
      chunks.current.delete(index)
    setChunkVersion((version) => version + 1)
    return written
  }, [moduleId, source])

  /** dnSpy's Delete: the selection, or the byte under the caret, becomes zero. */
  const clearBytes = useCallback(async (): Promise<void> => {
    const span = selection ?? { start: caret.offset, end: caret.offset + 1 }
    if (span.end <= span.start)
      return
    await writeBytes(span.start, new Uint8Array(span.end - span.start), t('Cleared {count} byte(s).', { count: span.end - span.start }))
    setAnchor(undefined)
  }, [caret.offset, selection, writeBytes, t])

  const fillWith = useCallback(async (byte: number): Promise<void> => {
    if (!selection || selection.end <= selection.start)
      return
    const data = new Uint8Array(selection.end - selection.start).fill(byte)
    await writeBytes(selection.start, data, t('Filled {count} byte(s) with 0x{value}.', { count: data.length, value: byte.toString(16).toUpperCase().padStart(2, '0') }))
    setAnchor(undefined)
  }, [selection, writeBytes, t])

  const copySelection = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
    }
    catch (error) {
      appendOutput(t('Copy failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }, [appendOutput, t])

  const selectedBytes = useCallback(async (): Promise<Uint8Array> => {
    const span = selection ?? { start: caret.offset, end: caret.offset + 1 }
    if (span.end <= span.start)
      return new Uint8Array(0)
    return readBytes(span.start, span.end - span.start)
  }, [caret.offset, readBytes, selection])

  // ---- Keyboard ------------------------------------------------------------------------------------

  const pagingRows = (): number => Math.max(1, Math.floor((viewport.height > 0 ? viewport.height : FALLBACK_HEIGHT) / ROW_HEIGHT) - 1)

  const typeHexNibble = async (value: number): Promise<void> => {
    if (caret.column === 'ascii')
      return
    const current = await readBytes(caret.offset, 1)
    if (current.length === 0)
      return
    const byte = caret.nibble === 0 ? ((current[0] & 0x0F) | (value << 4)) : ((current[0] & 0xF0) | value)
    await writeBytes(caret.offset, Uint8Array.of(byte))
    setAnchor(undefined)
    if (caret.nibble === 0)
      setCaret({ ...caret, nibble: 1 })
    else {
      const next = Math.min(range.end - 1, caret.offset + 1)
      setCaret({ offset: next, column: 'values', nibble: 0 })
      revealCaret(next)
    }
  }

  const typeAscii = async (text: string): Promise<void> => {
    const data = encodeText(text, paneOptions.general.encoding)
    if (data.length === 0)
      return
    await writeBytes(caret.offset, data)
    const next = Math.min(range.end - 1, caret.offset + data.length)
    setAnchor(undefined)
    setCaret({ offset: next, column: 'ascii', nibble: 0 })
    revealCaret(next)
  }

  const paste = useCallback(async (special?: 'utf8' | 'utf8Length' | 'unicode' | 'unicodeLength' | 'blob'): Promise<void> => {
    let text: string
    try {
      text = await navigator.clipboard.readText()
    }
    catch (error) {
      appendOutput(t('Paste failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      return
    }
    let data: Uint8Array | undefined
    if (special === undefined)
      data = caret.column === 'ascii' ? encodeText(text, paneOptions.general.encoding) : parseHexBytes(text)
    else if (special === 'utf8')
      data = new TextEncoder().encode(text)
    else if (special === 'utf8Length') {
      const bytes = new TextEncoder().encode(text)
      data = concatBytes([sevenBitLengthPrefix(bytes.length), bytes])
    }
    else if (special === 'unicode' || special === 'unicodeLength') {
      const bytes = encodeText(text, 'utf16')
      data = special === 'unicode' ? bytes : concatBytes([sevenBitLengthPrefix(bytes.length), bytes])
    }
    else {
      const bytes = parseHexBytes(text)
      data = bytes === undefined ? undefined : concatBytes([compressedUIntPrefix(bytes.length), bytes])
    }
    if (!data || data.length === 0) {
      appendOutput(t('Paste failed: the clipboard does not hold hexadecimal bytes.'))
      return
    }
    const available = Math.max(0, length - caret.offset)
    const clamped = data.length > available ? data.subarray(0, available) : data
    if (clamped.length === 0)
      return
    await writeBytes(caret.offset, clamped, t('Wrote {count} byte(s) at 0x{offset}.', { count: clamped.length, offset: caret.offset.toString(16).toUpperCase() }))
    const next = Math.min(range.end - 1, caret.offset + clamped.length)
    setAnchor(undefined)
    setCaret({ offset: next, column: caret.column, nibble: 0 })
    revealCaret(next)
  }, [appendOutput, caret, length, paneOptions.general.encoding, range.end, revealCaret, t, writeBytes])

  const find = useCallback(async (reverse: boolean): Promise<void> => {
    if (!workspaceId && !source)
      return
    const pattern = findPatternBytes(findText)
    if (!pattern) {
      setFindStatus(t('Enter hexadecimal bytes or text to search for.'))
      return
    }
    try {
      const start = reverse ? Math.max(0, (selection?.start ?? caret.offset) - 1) : (selection?.end ?? caret.offset)
      const response = source
        ? { offset: await findInSource(source, pattern, start, reverse) }
        : await window.dnSpy.findHex(workspaceId!, moduleId, base64Of(pattern), start, reverse, true)
      if (response.offset < 0) {
        setFindStatus(t('Not found'))
        return
      }
      setFindStatus(undefined)
      setMarked({ start: response.offset, end: response.offset + pattern.length })
      selectRange(response.offset, response.offset + pattern.length)
    }
    catch (error) {
      setFindStatus(error instanceof Error ? error.message : String(error))
    }
  }, [workspaceId, moduleId, source, findText, selection, caret.offset, selectRange, t])

  const goToPosition = useCallback((result: GoToPositionResult): void => {
    void (async () => {
      let offset = result.value
      // A source's offsets are addresses: one outside the window moves the window to it.
      if (source && result.kind !== 'current')
        offset = result.value >= source.base && result.value < source.base + source.length ? result.value - source.base : source.reveal(result.value)
      else if (result.kind === 'rva' && workspaceId) {
        const response = await window.dnSpy.resolveHexPosition(workspaceId, moduleId, 'rva', result.value)
        offset = response.offset
      }
      else if (result.kind === 'current')
        offset = caret.offset + result.value
      setDialog(undefined)
      if (offset < 0)
        return
      setVisibleRange(undefined)
      if (result.selectToNewPosition) {
        const from = selection?.start ?? caret.offset
        selectRange(Math.min(from, offset), Math.max(from, offset) + 1)
      }
      else {
        const clamped = Math.min(offset, Math.max(0, length - 1))
        setAnchor(undefined)
        setCaret({ offset: clamped, column: 'values', nibble: 0 })
        setMarked(undefined)
        revealCaret(clamped)
      }
    })()
  }, [workspaceId, moduleId, source, caret.offset, selection, length, selectRange, revealCaret])

  const goToMetadata = useCallback((result: GoToMetadataResult): void => {
    void (async () => {
      if (!workspaceId)
        return
      try {
        const response = await window.dnSpy.goToHexMetadata(workspaceId, moduleId, result.kind, result.value)
        setDialog(undefined)
        if (!response.range || response.range.offset < 0) {
          appendOutput(t('Nothing was found at 0x{value}.', { value: result.value.toString(16).toUpperCase() }))
          return
        }
        if (response.range.length === 0) {
          const clamped = Math.min(response.range.offset, Math.max(0, length - 1))
          setAnchor(undefined)
          setCaret({ offset: clamped, column: 'values', nibble: 0 })
          revealCaret(clamped)
        }
        else
          selectRange(response.range.offset, response.range.offset + response.range.length)
      }
      catch (error) {
        appendOutput(t('Go to metadata failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      }
    })()
  }, [workspaceId, moduleId, length, selectRange, revealCaret, appendOutput, t])

  const selectFromDialog = useCallback((result: SelectResult): void => {
    setDialog(undefined)
    setVisibleRange(undefined)
    const start = result.start
    const end = result.mode === 'position' ? result.end + 1 : start + result.end
    selectRange(start, end)
  }, [selectRange])

  const saveSelection = useCallback((): void => {
    void (async () => {
      if (!workspaceId || !selection || selection.end <= selection.start)
        return
      try {
        const name = `${modulePath?.split(/[\\/]/).pop() ?? 'bytes'}-${selection.start.toString(16).toUpperCase()}.bin`
        const path = await window.dnSpy.saveHexSelection(workspaceId, moduleId, selection.start, selection.end - selection.start, name)
        if (path)
          appendOutput(t('Saved the selection to {path}.', { path }))
      }
      catch (error) {
        appendOutput(t('Save failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      }
    })()
  }, [workspaceId, moduleId, modulePath, selection, appendOutput, t])

  const refresh = useCallback((): void => {
    chunks.current.clear()
    unreadable.current.clear()
    pending.current.clear()
    setChunkVersion((version) => version + 1)
  }, [])

  const localSettings: HexLocalSettings = {
    showOffset: lineFormat.showOffset,
    showValues: lineFormat.showValues,
    showAscii: lineFormat.showAscii,
    useRelativePositions: positions.useRelativePositions,
    startPosition: positions.startPosition,
    endPosition: positions.endPosition > positions.startPosition ? positions.endPosition : length,
    basePosition: positions.basePosition,
    offsetBitSize,
    bytesPerLine: bytesPerLineSetting,
    valuesFormat,
    offsetFormat,
  }

  const applyLocalSettings = (settings: HexLocalSettings): void => {
    setDialog(undefined)
    setBytesPerLineSetting(settings.bytesPerLine)
    setValuesFormat(settings.valuesFormat)
    setOffsetFormat(settings.offsetFormat)
    setColumns({ showOffset: settings.showOffset, showValues: settings.showValues, showAscii: settings.showAscii })
    setPositions({ startPosition: settings.startPosition, endPosition: settings.endPosition, basePosition: settings.basePosition, useRelativePositions: settings.useRelativePositions })
    // A caret the new range no longer holds moves to its first byte.
    setCaret((current) => current.offset < settings.startPosition || current.offset >= settings.endPosition
      ? { offset: Math.min(settings.startPosition, Math.max(0, length - 1)), column: current.column, nibble: 0 }
      : current)
    setVisibleRange(undefined)
  }

  // Copy Special, from dnSpy's own list of formats.
  const copySpecial = useCallback((kind: 'hex' | 'utf8' | 'unicode' | 'csharp' | 'vb' | 'text' | 'offset' | 'value' | 'uint16' | 'uint16Be' | 'uint32' | 'uint32Be' | 'uint64' | 'uint64Be' | 'fileOffset'): void => {
    void (async () => {
      const upper = !lineFormat.valuesLowerCaseHex
      try {
        if (kind === 'hex') {
          await copySelection(hexText(await selectedBytes(), upper))
          return
        }
        if (kind === 'text') {
          if (selection) {
            const bytes = await selectedBytes()
            const lineStart = caret.offset - ((caret.offset - range.start) % bytesPerLine)
            void lineStart
            await copySelection(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
            return
          }
          const lineStart = caret.offset - ((caret.offset - range.start) % bytesPerLine)
          const count = Math.min(bytesPerLine, length - lineStart)
          const bytes = await readBytes(lineStart, count)
          const line = lineOf(bytes, lineStart, lineStart, length, lineFormat, bytesPerLine)
          await copySelection([line.address, line.values.map((cell) => cell.text).join(' '), line.ascii.map((cell) => cell.text).join(' ')].filter((part) => part !== '').join(' '))
          return
        }
        if (kind === 'offset') {
          await copySelection(formatHexOffset(logicalOffset(caret.offset), offsetBitSize, lineFormat.offsetFormat, lineFormat.offsetLowerCaseHex))
          return
        }
        if (kind === 'value') {
          const info = { hexByte: 1, decimalByte: 1, hexUInt16: 2, decimalUInt16: 2, hexUInt16Be: 2, decimalUInt16Be: 2, hexUInt32: 4, decimalUInt32: 4, hexUInt32Be: 4, decimalUInt32Be: 4, hexUInt64: 8, decimalUInt64: 8, hexUInt64Be: 8, decimalUInt64Be: 8, hexSByte: 1, decimalSByte: 1, hexInt16: 2, decimalInt16: 2, hexInt16Be: 2, decimalInt16Be: 2, hexInt32: 4, decimalInt32: 4, hexInt32Be: 4, decimalInt32Be: 4, hexInt64: 8, decimalInt64: 8, hexInt64Be: 8, decimalInt64Be: 8, single: 4, singleBe: 4, double: 8, doubleBe: 8, bit8: 1 }[valuesFormat]
          const lineStart = caret.offset - ((caret.offset - range.start) % bytesPerLine)
          const count = Math.min(bytesPerLine, length - lineStart)
          const bytes = await readBytes(lineStart, count)
          const line = lineOf(bytes, lineStart, lineStart, length, lineFormat, bytesPerLine)
          const cell = line.values.find((candidate) => caret.offset >= lineStart + candidate.byteOffset && caret.offset < lineStart + candidate.byteOffset + info)
          await copySelection(cell?.text ?? '')
          return
        }
        const bytes = await selectedBytes()
        if (kind === 'utf8') { await copySelection(new TextDecoder('utf-8').decode(bytes)); return }
        if (kind === 'unicode') { await copySelection(new TextDecoder('utf-16le').decode(bytes)); return }
        if (kind === 'csharp') { await copySelection(csharpArrayText(bytes, upper)); return }
        if (kind === 'vb') { await copySelection(visualBasicArrayText(bytes, upper)); return }
        // The integer reads take their bytes from the caret, which is what dnSpy's Buffer.ReadUIntNN does.
        const readAt = await readBytes(caret.offset, 8)
        const integer = (count: number, bigEndian: boolean): bigint => {
          let value = BigInt(0)
          for (let i = 0; i < count; i++) {
            const byte = readAt[bigEndian ? i : count - 1 - i] ?? 0
            value = (value << BigInt(8)) | BigInt(byte)
          }
          return value
        }
        if (kind === 'uint16') { await copySelection(hexNumberText(integer(2, false))); return }
        if (kind === 'uint16Be') { await copySelection(hexNumberText(integer(2, true))); return }
        if (kind === 'uint32') { await copySelection(hexNumberText(integer(4, false))); return }
        if (kind === 'uint32Be') { await copySelection(hexNumberText(integer(4, true))); return }
        if (kind === 'uint64') { await copySelection(hexNumberText(integer(8, false))); return }
        if (kind === 'uint64Be') { await copySelection(hexNumberText(integer(8, true))); return }
        if (kind === 'fileOffset') { await copySelection(hexNumberText(caret.offset)); return }
      }
      catch (error) {
        appendOutput(t('Copy failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
      }
    })()
  }, [appendOutput, bytesPerLine, caret.offset, copySelection, length, lineFormat, offsetBitSize, range.start, readBytes, selectedBytes, selection, t, valuesFormat])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (dialog !== undefined)
      return
    if ((event.target as HTMLElement).matches('input, textarea, select'))
      return
    const page = pagingRows() * bytesPerLine
    const lineStart = caret.offset - ((caret.offset - range.start) % bytesPerLine)
    const extend = event.shiftKey
    const single = (offset: number): void => moveCaret(offset, extend)
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyG') { event.preventDefault(); setDialog('goto'); return }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyM' && !source) { event.preventDefault(); setDialog('metadata'); return }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyL') { event.preventDefault(); setDialog('select'); return }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyF') { event.preventDefault(); setDialog('find'); return }
    if (event.key === 'F3') { event.preventDefault(); void find(event.shiftKey); return }
    if (!event.ctrlKey && event.key === 'F5') { event.preventDefault(); refresh(); return }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyA') {
      event.preventDefault()
      if (range.end > range.start) {
        setAnchor(range.start)
        setCaret({ offset: range.end - 1, column: caret.column, nibble: 0 })
      }
      return
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyD') { event.preventDefault(); setVisibleRange(undefined); return }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyD') { event.preventDefault(); if (selection) setVisibleRange(selection); return }
    if (event.ctrlKey && event.altKey && event.code === 'KeyS' && !source) { event.preventDefault(); saveSelection(); return }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyC') { event.preventDefault(); copySpecial('hex'); return }
    if (event.ctrlKey && !event.shiftKey && event.code === 'KeyV') { event.preventDefault(); void paste(); return }
    if (event.key === 'Delete') { event.preventDefault(); void clearBytes(); return }
    if (event.ctrlKey && event.code === 'Home') { event.preventDefault(); moveCaret(range.start, extend); return }
    if (event.ctrlKey && event.code === 'End') { event.preventDefault(); moveCaret(range.end - 1, extend); return }
    // The values column has two halves per byte, so left and right step a nibble before they step a byte.
    const stepWithinByte = (direction: -1 | 1): void => {
      if (caret.column !== 'values') {
        single(caret.offset + direction)
        return
      }
      const nextNibble = caret.nibble + direction
      if (nextNibble === 0 || nextNibble === 1) {
        if (extend && anchor === undefined)
          setAnchor(caret.offset)
        else if (!extend)
          setAnchor(undefined)
        setCaret({ ...caret, nibble: nextNibble as 0 | 1 })
        return
      }
      single(caret.offset + direction)
    }
    switch (event.key) {
      case 'ArrowLeft': event.preventDefault(); stepWithinByte(-1); return
      case 'ArrowRight': event.preventDefault(); stepWithinByte(1); return
      case 'ArrowUp': event.preventDefault(); single(caret.offset - bytesPerLine); return
      case 'ArrowDown': event.preventDefault(); single(caret.offset + bytesPerLine); return
      case 'PageUp': event.preventDefault(); single(caret.offset - page); return
      case 'PageDown': event.preventDefault(); single(caret.offset + page); return
      case 'Home': event.preventDefault(); single(lineStart); return
      case 'End': event.preventDefault(); single(Math.min(range.end - 1, lineStart + bytesPerLine - 1)); return
      case 'Tab': event.preventDefault(); setCaret({ offset: caret.offset, column: caret.column === 'values' ? 'ascii' : 'values', nibble: 0 }); return
      case 'F12':
        event.preventDefault()
        if (event.ctrlKey) commands?.onFollowReference?.(caret.offset)
        else commands?.onGoToCodeOrStructure?.(caret.offset)
        return
      default: break
    }
    if (event.ctrlKey || event.altKey || event.metaKey)
      return
    // Typing: a hex digit edits a nibble of the values column, a printable character a byte of the ASCII one.
    if (/^[0-9A-Fa-f]$/.test(event.key) && caret.column === 'values') {
      event.preventDefault()
      void typeHexNibble(Number.parseInt(event.key, 16))
      return
    }
    if (event.key.length === 1 && event.key >= ' ' && caret.column === 'ascii') {
      event.preventDefault()
      void typeAscii(event.key)
    }
  }

  /** The byte a click landed on, from whichever column it was in. */
  const byteAtPoint = (target: HTMLElement): { offset: number; column: HexColumn } | undefined => {
    const cell = target.closest<HTMLElement>('[data-hex-byte]')
    if (!cell)
      return undefined
    const offset = Number(cell.dataset.hexByte)
    if (!Number.isFinite(offset))
      return undefined
    return { offset: Math.max(0, Math.min(length - 1, offset)), column: cell.dataset.hexColumn === 'ascii' ? 'ascii' : 'values' }
  }

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0)
      return
    // A click anywhere in the dump gives it the focus, the way dnSpy's hex view does; only a click on a
    // byte also moves the caret.
    contentRef.current?.focus({ preventScroll: true })
    const target = byteAtPoint(event.target as HTMLElement)
    if (!target)
      return
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-hex-byte]')
    const nibbleNode = cell?.querySelector<HTMLElement>('[data-hex-nibble]')
    let nibble: 0 | 1 = 0
    if (nibbleNode) {
      const bounds = nibbleNode.getBoundingClientRect()
      if (bounds.width > 0)
        nibble = event.clientX - bounds.left > bounds.width / 2 ? 1 : 0
    }
    dragRef.current = true
    setMarked(undefined)
    if (event.shiftKey)
      setAnchor(anchor ?? caret.offset)
    else
      setAnchor(undefined)
    setCaret({ offset: target.offset, column: target.column, nibble })
    contentRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    const onUp = (): void => { dragRef.current = false }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  const onMouseMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!dragRef.current)
      return
    const target = byteAtPoint(event.target as HTMLElement)
    if (!target || target.offset === caret.offset)
      return
    if (anchor === undefined)
      setAnchor(caret.offset)
    setCaret({ offset: target.offset, column: target.column, nibble: 0 })
    revealCaret(target.offset)
  }

  // ---- The context menu ---------------------------------------------------------------------------

  const buildMenu = (): MenuItem[] => {
    const hasSelection = selection !== undefined && selection.end > selection.start
    return [
      { label: t('Go to Offset...'), shortcut: 'Ctrl+G', action: () => setDialog('goto') },
      // A process's memory has no metadata to go to and no file to save a part of.
      ...(source ? [] : [{ label: t('Go to Metadata...'), shortcut: 'Ctrl+M', action: () => setDialog('metadata') }]),
      { separator: true },
      ...(source ? [] : [{ label: t('Save Selection...'), icon: 'Save', shortcut: 'Ctrl+Alt+S', disabled: !hasSelection, action: saveSelection }]),
      { label: t('Show Only Selected Bytes'), shortcut: 'Ctrl+D', disabled: !hasSelection, action: () => { if (selection) setVisibleRange(selection) } },
      { label: t('Show All Bytes'), shortcut: 'Ctrl+Shift+D', disabled: visibleRange === undefined, action: () => setVisibleRange(undefined) },
      { separator: true },
      { label: hasSelection ? t('Clear Selected Bytes') : t('Clear Byte'), icon: 'Cancel', shortcut: 'Del', action: () => void clearBytes() },
      { label: t('Fill Selection...'), icon: 'Fill', disabled: !hasSelection, action: () => { setFillText('FF'); setDialog('fill') } },
      { separator: true },
      {
        label: t('Bytes per Line'),
        submenu: [0, 8, 16, 32, 48, 64].map((value) => ({
          label: value === 0 ? t('Fit to Width') : t('{count} bytes', { count: value }),
          checked: bytesPerLineSetting === value,
          action: () => setBytesPerLineSetting(value),
        })),
      },
      {
        label: t('Value Format'),
        submenu: VALUE_FORMAT_CHOICES.map((choice) => ({
          label: t(choice.label),
          checked: valuesFormat === choice.value,
          action: () => setValuesFormat(choice.value),
        })),
      },
      { label: t('Hex Editor Settings...'), icon: 'Settings', action: () => setDialog('settings') },
      { separator: true },
      {
        label: t('Copy Special'),
        icon: 'Copy',
        disabled: !hasSelection,
        submenu: [
          { label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', action: () => copySpecial('hex') },
          { label: t('Copy UTF-8 String'), shortcut: 'Ctrl+Shift+8', action: () => copySpecial('utf8') },
          { label: t('Copy Unicode String'), shortcut: 'Ctrl+Shift+U', action: () => copySpecial('unicode') },
          { label: t('Copy C# Array'), shortcut: 'Ctrl+Shift+H', action: () => copySpecial('csharp') },
          { label: t('Copy Visual Basic Array'), shortcut: 'Ctrl+Shift+B', action: () => copySpecial('vb') },
          { label: t('Copy Text'), shortcut: 'Ctrl+Shift+C', action: () => copySpecial('text') },
          { label: t('Copy Offset'), shortcut: 'Ctrl+Alt+O', action: () => copySpecial('offset') },
          { label: t('Copy ({format})', { format: 'UInt16' }), action: () => copySpecial('uint16') },
          { label: t('Copy ({format})', { format: 'UInt16 (big endian)' }), action: () => copySpecial('uint16Be') },
          { label: t('Copy ({format})', { format: 'UInt32' }), shortcut: 'Ctrl+Shift+Q', action: () => copySpecial('uint32') },
          { label: t('Copy ({format})', { format: 'UInt32 (big endian)' }), action: () => copySpecial('uint32Be') },
          { label: t('Copy ({format})', { format: 'UInt64' }), action: () => copySpecial('uint64') },
          { label: t('Copy ({format})', { format: 'UInt64 (big endian)' }), action: () => copySpecial('uint64Be') },
          { label: t('Copy File Offset'), shortcut: 'Ctrl+Shift+O', action: () => copySpecial('fileOffset') },
        ],
      },
      {
        label: t('Paste Special'),
        icon: 'Paste',
        submenu: [
          { label: t('Paste'), icon: 'Paste', shortcut: 'Ctrl+V', action: () => void paste() },
          { label: t('Paste UTF-8 String'), shortcut: 'Ctrl+8', action: () => void paste('utf8') },
          { label: t('Paste UTF-8 String + Length'), shortcut: 'Ctrl+K, Ctrl+8', action: () => void paste('utf8Length') },
          { label: t('Paste Unicode String'), shortcut: 'Ctrl+U', action: () => void paste('unicode') },
          { label: t('Paste Unicode String + Length'), shortcut: 'Ctrl+K, Ctrl+U', action: () => void paste('unicodeLength') },
          { label: t('.NET Metadata Blob'), shortcut: 'Ctrl+B', action: () => void paste('blob') },
        ],
      },
      { label: t('Select...'), icon: 'Select', shortcut: 'Ctrl+L', action: () => setDialog('select') },
      { separator: true },
      { label: t('Find...'), icon: 'Search', shortcut: 'Ctrl+F', action: () => setDialog('find') },
      { label: t('Refresh'), icon: 'Refresh', shortcut: 'F5', action: refresh },
      ...(source?.menu?.length ? [{ separator: true }, ...source.menu] : []),
    ]
  }

  // ---- Rendering ----------------------------------------------------------------------------------

  const lineIndexes = useMemo(() => {
    const indexes: number[] = []
    for (let index = first; index < last; index++)
      indexes.push(index)
    return indexes
  }, [first, last])

  const span = selection
  const byteClass = (absolute: number, column: HexColumn, group: number): string => {
    const classes = ['hex-byte']
    if (group === 1)
      classes.push('hex-group-1')
    // dnSpy's selection lives in one column at a time: the selection and the current line are drawn in the
    // column the caret is in, which is also the column typing and copying read.
    if (caret.column === column) {
      if (span && absolute >= span.start && absolute < span.end)
        classes.push('hex-byte-selected')
      if (marked && absolute >= marked.start && absolute < marked.end)
        classes.push('hex-byte-marked')
      if (absolute === caret.offset)
        classes.push('hex-byte-caret')
    }
    return classes.join(' ')
  }

  return (
    <div className="hex-view">
      {dialog === 'find' && (
        <div className="hex-find" role="search">
          <input
            autoFocus
            aria-label={t('Find')}
            placeholder={t('Find')}
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void find(event.shiftKey) }
              else if (event.key === 'Escape') { event.preventDefault(); setDialog(undefined) }
            }}
          />
          <button className="icon-button" title={t('Find Next')} aria-label={t('Find Next')} onClick={() => void find(false)}><DsIcon name="Search" /></button>
          <button className="icon-button" title={t('Find Previous')} aria-label={t('Find Previous')} onClick={() => void find(true)}><DsIcon name="PreviousBookmark" /></button>
          <button className="icon-button" title={t('Close')} aria-label={t('Close')} onClick={() => setDialog(undefined)}><DsIcon name="Cancel" /></button>
          {findStatus && <span className="hex-find-status">{findStatus}</span>}
        </div>
      )}
      <div
        ref={contentRef}
        className={`hex-content${paneOptions.general.highlightCurrentLine ? ' hex-highlight-current-line' : ''}${paneOptions.advanced.showColumnLines ? ' hex-column-lines' : ''}`}
        style={{ fontFamily: hexFont.fontFamily, fontSize: hexFont.fontSize }}
        role="textbox"
        aria-label={t('Hex')}
        aria-readonly="false"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onScroll={onScroll}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }) }}
      >
        {first > 0 && <div className="hex-spacer" aria-hidden="true" style={{ height: first * ROW_HEIGHT }} />}
        {lineIndexes.map((index) => {
          const offset = range.start + index * bytesPerLine
          const chunkStart = Math.floor(offset / CHUNK_SIZE) * CHUNK_SIZE
          const bytes = chunks.current.get(Math.floor(offset / CHUNK_SIZE)) ?? new Uint8Array(0)
          const line = maskUnreadable(lineOf(bytes, chunkStart, offset, range.end, { ...lineFormat, offsetBitSize, showOffset: lineFormat.showOffset }, bytesPerLine), unreadable.current.get(Math.floor(offset / CHUNK_SIZE)), chunkStart)
          const address = lineFormat.showOffset ? formatHexOffset(logicalOffset(offset), offsetBitSize, lineFormat.offsetFormat, lineFormat.offsetLowerCaseHex) : ''
          const currentLine = offset <= caret.offset && caret.offset < offset + bytesPerLine
          return (
            <div className={`hex-line${currentLine ? ' hex-current-line' : ''}`} key={offset} style={{ height: ROW_HEIGHT }}>
              {lineFormat.showOffset && <span className="hex-address">{address}</span>}
              {lineFormat.showValues && (
                <span className="hex-values">
                  {line.values.map((cell, cellIndex) => (
                    <Fragment key={cellIndex}>
                      <span className={byteClass(offset + cell.byteOffset, 'values', cell.group)} data-hex-byte={offset + cell.byteOffset} data-hex-column="values">
                        <span data-hex-nibble>{cell.text}</span>
                      </span>
                      {cellIndex + 1 < line.values.length ? ' ' : ''}
                    </Fragment>
                  ))}
                </span>
              )}
              {lineFormat.showAscii && (
                <span className="hex-ascii">
                  {line.ascii.map((cell, cellIndex) => (
                    <span key={cellIndex} className={byteClass(offset + cell.byteOffset, 'ascii', cell.group)} data-hex-byte={offset + cell.byteOffset} data-hex-column="ascii">{cell.text}</span>
                  ))}
                </span>
              )}
            </div>
          )
        })}
        {last < lineCount && <div className="hex-spacer" aria-hidden="true" style={{ height: (lineCount - last) * ROW_HEIGHT }} />}
      </div>
      <div className="hex-status">
        <span className="hex-status-offset">{formatHexOffset(logicalOffset(caret.offset), offsetBitSize, lineFormat.offsetFormat, lineFormat.offsetLowerCaseHex)}</span>
        <span>{t('{value} bytes', { value: length.toLocaleString(locale) })}</span>
        {span && span.end > span.start && (
          <span>{t('Sel: 0x{start} - 0x{end} ({count} bytes)', { start: span.start.toString(16).toUpperCase(), end: (span.end - 1).toString(16).toUpperCase(), count: span.end - span.start })}</span>
        )}
      </div>
      {menu && (
        <div className="hex-context-menu" style={{ left: menu.x, top: menu.y }}>
          <MenuPopup items={buildMenu()} onClose={() => setMenu(undefined)} />
        </div>
      )}
      {dialog === 'goto' && <HexGoToPositionDialog initial={caret.offset} onAccept={goToPosition} onClose={() => setDialog(undefined)} />}
      {dialog === 'metadata' && <HexGoToMetadataDialog initial={0} onAccept={goToMetadata} onClose={() => setDialog(undefined)} />}
      {dialog === 'select' && <HexSelectDialog start={span?.start ?? caret.offset} end={span?.end ?? caret.offset + 1} onAccept={selectFromDialog} onClose={() => setDialog(undefined)} />}
      {dialog === 'settings' && <HexLocalSettingsDialog settings={localSettings} fileLength={length} onAccept={applyLocalSettings} onClose={() => setDialog(undefined)} />}
      {dialog === 'fill' && (
        <FillDialog
          value={fillText}
          onChange={setFillText}
          onAccept={() => {
            const value = parseHexNumber(fillText)
            setDialog(undefined)
            if (value !== undefined && value <= 0xFF)
              void fillWith(value)
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      <HexViewPersistence path={modulePath} state={{ offset: caret.offset, selectionStart: span?.start ?? caret.offset, selectionEnd: span?.end ?? caret.offset, bytesPerLine: bytesPerLineSetting, valuesFormat }} />
    </div>
  )
}

/** A line of a source's chunk with the cells of pages that could not be read shown as dnSpy shows them: `??`. */
const maskUnreadable = (line: ReturnType<typeof lineOf>, pages: boolean[] | undefined, chunkStart: number): ReturnType<typeof lineOf> => {
  if (!pages?.some((page) => page))
    return line
  const unreadableAt = (offset: number): boolean => pages[Math.floor((offset - chunkStart) / PAGE_SIZE)] === true
  return {
    ...line,
    values: line.values.map((cell) => unreadableAt(line.offset + cell.byteOffset) ? { ...cell, text: '?'.repeat(cell.text.length) } : cell),
    ascii: line.ascii.map((cell) => unreadableAt(line.offset + cell.byteOffset) ? { ...cell, text: '?' } : cell),
  }
}

/** Find over a source's window, read a chunk at a time; a match may straddle two chunks. */
const findInSource = async (source: HexByteSource, pattern: Uint8Array, start: number, reverse: boolean): Promise<number> => {
  const matchAt = (bytes: Uint8Array, index: number): boolean => {
    for (let i = 0; i < pattern.length; i++)
      if (bytes[index + i] !== pattern[i]) return false
    return true
  }
  const overlap = pattern.length - 1
  if (!reverse) {
    for (let offset = start; offset < source.length; offset += CHUNK_SIZE) {
      const { bytes } = await source.read(offset, Math.min(CHUNK_SIZE + overlap, source.length - offset))
      for (let index = 0; index + pattern.length <= bytes.length; index++)
        if (matchAt(bytes, index)) return offset + index
    }
    return -1
  }
  for (let end = start + 1; end > 0; end -= CHUNK_SIZE) {
    const offset = Math.max(0, end - CHUNK_SIZE)
    const { bytes } = await source.read(offset, Math.min(end - offset + overlap, source.length - offset))
    for (let index = Math.min(end - offset, bytes.length - pattern.length); index >= 0; index--)
      if (matchAt(bytes, index)) return offset + index
  }
  return -1
}

const FillDialog = ({ value, onChange, onAccept, onClose }: { value: string; onChange(value: string): void; onAccept(): void; onClose(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const parsed = parseHexNumber(value)
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal hex-dialog" role="dialog" aria-modal="true" aria-label={t('Fill Selection')}>
        <div className="modal-title"><span>{t('Fill Selection')}</span></div>
        <div className="hex-dialog-body">
          <label className="hex-field"><span>{t('Value')}</span><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} /></label>
        </div>
        <div className="modal-actions"><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={parsed === undefined || parsed > 0xFF} onClick={onAccept}>{t('OK')}</button></div>
      </div>
    </div>
  )
}

/** Writes the view state back to local storage on every change, which is cheap and means a crash keeps it. */
const HexViewPersistence = ({ path, state }: { path: string | undefined; state: HexViewPersisted }): null => {
  useEffect(() => {
    saveHexViewState(path, state)
  }, [path, state.offset, state.selectionStart, state.selectionEnd, state.bytesPerLine, state.valuesFormat])
  return null
}
