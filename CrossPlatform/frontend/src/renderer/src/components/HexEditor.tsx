import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { HexCodeReference, HexEditField, HexPositionInfoResponse, HexToolTip } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useCategoryFont } from '../fonts'
import { hexChordCommand, hexChordPrefix, hexKeyCommand, type HexChordPrefix, type HexCommand } from '../hex-commands'
import { HexLineFormatter, cellAt, columnSpansOf, lineTextWithin, linePositionInfo, type HexBufferLine } from '../hex-line'
import {
  canEditValues,
  compressedUIntPrefix,
  concatBytes,
  csharpArrayText,
  editValueCell,
  hexText,
  parseHexBytes,
  sevenBitLengthPrefix,
  visualBasicArrayText,
  type HexValuesFormat,
} from '../hex-model'
import { findAllInBytes, type HexSearchPattern } from '../hex-search'
import { NOT_LOADED, useHexChunks, type HexChunkReader } from '../hex-view-data'
import { HexViewModel } from '../hex-view-model'
import { useLanguage } from '../localization'
import { useHexSearch, type HexSearchRun } from '../use-hex-search'
import { normalizeZoom, zoomIn, zoomLevels, zoomOut } from '../zoom'
import { loadAppOptions, saveAppOptions, useAppOptions, type HexEditorView } from './app-options'
import { AskDialog } from './AskDialog'
import { ColoredText } from './ColoredText'
import { DsIcon } from './DsIcon'
import { HexGoToMetadataDialog, HexGoToPositionDialog, HexLocalSettingsDialog, HexSelectDialog, parseUnsignedText, type HexLocalSettings } from './HexDialogs'
import { HexLines, spanLeft, type HexLineGeometry, type HexLineMarker } from './HexLines'
import { HexSearchControl } from './HexSearchControl'
import { buildHexViewMenu } from './hex-view-menu'
import { MenuPopup } from './MenuBar'
import type { MenuItem } from './edit-menu'

/** dnSpy's `HexGlyphMargin.MARGIN_WIDTH` and `SpacerMargin.SELECTION_MARGIN_WIDTH`. */
const GLYPH_MARGIN_WIDTH = 17
const SELECTION_MARGIN_WIDTH = 10
/** `HexCaretLayer.INACTIVE_CARET_HEIGHT`. */
const INACTIVE_CARET_HEIGHT = 2
/** `DefaultHexViewOptions.DefaultHighlightCurrentValueDelayMilliSeconds`. */
const HIGHLIGHT_CURRENT_VALUE_DELAY = 100
/** `WpfHexViewImpl.MouseHoverHelper`'s default delay, after which Quick Info asks for the field. */
const MOUSE_HOVER_DELAY = 150
/** The room a line's text gets on its left. */
const TEXT_LEFT = 2
/** Lines a wheel notch scrolls (`SystemParameters.WheelScrollLines`). */
const WHEEL_LINES = 3
/** The tallest scroll range the vertical bar is given; a longer file maps onto it. */
const MAX_SCROLL_HEIGHT = 1_000_000
const CARET_BLINK_MS = 530

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
  /** Entries the source's owner adds to the context menu, such as the Memory window's Process submenu. */
  menu?: MenuItem[]
  /** The options page the view follows: the Memory windows have one of their own. */
  optionsView?: HexEditorView
}

/** dnSpy's `HexViewUIState`: what a hex tab keeps across a restart and a trip through the tab history. */
export interface HexViewUiState {
  showOffsetColumn: boolean
  showValuesColumn: boolean
  showAsciiColumn: boolean
  startPosition: number
  /** Exclusive; -1 for the end of the file, whatever its length turns out to be. */
  endPosition: number
  basePosition: number
  useRelativePositions: boolean
  offsetBitSize: number
  valuesFormat: HexValuesFormat
  bytesPerLine: number
  activeColumn: 'values' | 'ascii'
  valuesPosition: number
  valuesCellPosition: number
  asciiPosition: number
  viewportLeft: number
  topLinePosition: number
  anchorPoint: number
  activePoint: number
}

export interface HexViewCommands {
  /** Where a file's state goes when it changes, which the tab keeps. */
  onStateChange?(state: HexViewUiState): void
}

/** `HexEditorGroupFactoryServiceImpl.GetDefaultLocalOptions`. */
const defaultLocalSettings = (): HexLocalSettings => ({
  showOffset: true,
  showValues: true,
  showAscii: true,
  useRelativePositions: false,
  startPosition: 0,
  endPosition: -1,
  basePosition: 0,
  offsetBitSize: 0,
  bytesPerLine: 0,
  valuesFormat: 'hexByte',
})

const localFromState = (state: HexViewUiState | undefined): HexLocalSettings => state === undefined
  ? defaultLocalSettings()
  : {
      showOffset: state.showOffsetColumn,
      showValues: state.showValuesColumn,
      showAscii: state.showAsciiColumn,
      useRelativePositions: state.useRelativePositions,
      startPosition: state.startPosition,
      endPosition: state.endPosition,
      basePosition: state.basePosition,
      offsetBitSize: state.offsetBitSize,
      bytesPerLine: state.bytesPerLine,
      valuesFormat: state.valuesFormat,
    }

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (data: string): Uint8Array => Uint8Array.from(atob(data), (character) => character.charCodeAt(0))

const encodings: Record<string, string> = { utf8: 'utf-8', utf16: 'utf-16le', utf16BE: 'utf-16be', ascii: 'ascii', latin1: 'iso-8859-1' }

/** The bytes the ASCII column types and pastes, in the encoding the options page names. */
const encodeText = (text: string, encoding: string): Uint8Array => {
  const name = encodings[encoding] ?? 'utf-8'
  if (name === 'utf-16le' || name === 'utf-16be') {
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      const big = name === 'utf-16be'
      bytes[i * 2 + (big ? 0 : 1)] = code >> 8
      bytes[i * 2 + (big ? 1 : 0)] = code & 0xFF
    }
    return bytes
  }
  if (name === 'ascii' || name === 'iso-8859-1')
    return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xFF)
  return new TextEncoder().encode(text)
}

const utf16Of = (text: string): Uint8Array => encodeText(text, 'utf16')

let measureContext: CanvasRenderingContext2D | null | undefined

/** The width of a character of a monospaced font, measured in a canvas; jsdom has none, so it guesses. */
const measureCharWidth = (fontFamily: string, fontSize: number): number => {
  if (measureContext === undefined)
    measureContext = typeof document === 'undefined' ? null : (document.createElement('canvas').getContext?.('2d') ?? null)
  if (!measureContext)
    return fontSize * 0.6
  measureContext.font = `${fontSize}px ${fontFamily}`
  const width = measureContext.measureText('0'.repeat(100)).width / 100
  return width > 0 ? width : fontSize * 0.6
}

/** `SimpleTypeConverter.ParseByte` for Fill Selection's box. */
const parseFillByte = (text: string): number | undefined => {
  const value = parseUnsignedText(text, 0xFF)
  return value === undefined ? undefined : value
}

/**
 * dnSpy's hex editor: the bytes between a start and an end position as lines of offset, values and ASCII, with
 * dnSpy's caret, selection, keyboard, mouse, context menu, search control, Quick Info over the file's structures,
 * margins, zoom and options. The line layout is `hex-line.ts`, the operations `hex-view-model.ts`.
 */
export const HexView = ({ moduleId = '', source, initialState, commands }: { moduleId?: string; source?: HexByteSource; initialState?: HexViewUiState; commands?: HexViewCommands }): React.JSX.Element => {
  const options = useAppOptions()
  const paneKey: HexEditorView = source?.optionsView ?? 'hexViewer'
  const pane = options.hexEditor[paneKey]
  const zoom = pane.zoomLevel ?? 100
  const hexFont = useCategoryFont('hexEditor')
  const workspaceId = useAppStore((state) => state.workspaceId)
  const workspaceStateId = useAppStore((state) => state.workspaceStateId)
  const navigation = useAppStore((state) => state.hexNavigation)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const { t } = useLanguage()

  // ---- Geometry ----------------------------------------------------------------------------------------
  const fontSize = hexFont.fontSize * zoom / 100
  const charWidth = useMemo(() => measureCharWidth(hexFont.fontFamily, fontSize), [hexFont.fontFamily, fontSize])
  const lineHeight = Math.round(fontSize * (pane.advanced.removeExtraTextLineVerticalPixels ? 1.25 : 1.4))
  const geometry: HexLineGeometry = { charWidth, lineHeight, textLeft: TEXT_LEFT }
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [scrollLeft, setScrollLeft] = useState(initialState?.viewportLeft ?? 0)
  const [focused, setFocused] = useState(false)
  const textAreaRef = useRef<HTMLDivElement>(null)
  const vScrollRef = useRef<HTMLDivElement>(null)
  const hScrollRef = useRef<HTMLDivElement>(null)

  // ---- The bytes ---------------------------------------------------------------------------------------
  const [fileLength, setFileLength] = useState(0)
  const length = source ? source.length : fileLength
  useEffect(() => {
    if (!workspaceId || source)
      return
    void window.dnSpy.getHexLength(workspaceId, moduleId).then((response) => setFileLength(response.length), () => setFileLength(0))
  }, [workspaceId, moduleId, workspaceStateId, source])
  const reader = useMemo<HexChunkReader | undefined>(() => {
    if (source)
      return (offset, count) => source.read(offset, count)
    if (!workspaceId)
      return undefined
    return async (offset, count) => ({ bytes: fromBase64((await window.dnSpy.readHex(workspaceId, moduleId, offset, count)).base64Data) })
  }, [source, workspaceId, moduleId])
  const revision = source ? `${source.revision}` : String(workspaceStateId ?? '')
  const data = useHexChunks(reader, length, revision)

  const readBytes = useCallback(async (offset: number, count: number): Promise<Uint8Array> => {
    if (count <= 0)
      return new Uint8Array(0)
    if (source)
      return (await source.read(offset, count)).bytes
    if (!workspaceId)
      return new Uint8Array(0)
    const parts: Uint8Array[] = []
    for (let position = 0; position < count; position += 1024 * 1024)
      parts.push(fromBase64((await window.dnSpy.readHex(workspaceId, moduleId, offset + position, Math.min(1024 * 1024, count - position))).base64Data))
    return concatBytes(parts)
  }, [source, workspaceId, moduleId])

  const writeBytes = useCallback(async (offset: number, bytes: Uint8Array): Promise<boolean> => {
    if (bytes.length === 0)
      return true
    if (source) {
      const written = await source.write(offset, bytes)
      data.invalidate(offset, offset + bytes.length)
      return written
    }
    return useAppStore.getState().hexWriteBytes(moduleId, offset, bytes)
  }, [source, moduleId, data])

  // ---- Local settings and the line layout --------------------------------------------------------------
  const [local, setLocal] = useState<HexLocalSettings>(() => localFromState(initialState))
  const startPosition = Math.min(local.startPosition, length)
  const endPosition = local.endPosition < 0 ? length : Math.max(startPosition, Math.min(local.endPosition, length))
  const textAreaWidth = Math.max(0, viewport.width)
  const charsPerLine = Math.max(1, Math.floor((textAreaWidth - TEXT_LEFT) / charWidth))
  const formatter = useMemo(() => new HexLineFormatter({
    charsPerLine,
    // A view that has not been laid out yet (and jsdom, which lays nothing out) fits 16 bytes a line.
    bytesPerLine: local.bytesPerLine === 0 && textAreaWidth === 0 ? 16 : local.bytesPerLine,
    groupSizeInBytes: pane.general.groupSizeInBytes,
    showOffset: local.showOffset,
    showValues: local.showValues,
    showAscii: local.showAscii,
    offsetFormat: pane.general.hexOffsetFormat,
    startPosition,
    endPosition,
    basePosition: local.basePosition + (source?.base ?? 0),
    useRelativePositions: local.useRelativePositions,
    offsetLowerCaseHex: pane.general.offsetLowerCaseHex,
    valuesLowerCaseHex: pane.general.valuesLowerCaseHex,
    offsetBitSize: local.offsetBitSize,
    valuesFormat: local.valuesFormat,
  }), [charsPerLine, textAreaWidth, local, pane.general, startPosition, endPosition, source?.base])

  const modelRef = useRef<HexViewModel | undefined>(undefined)
  if (!modelRef.current)
    modelRef.current = new HexViewModel(formatter)
  const model = modelRef.current
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  useEffect(() => model.subscribe(rerender), [model])
  if (model.formatter !== formatter)
    model.setFormatter(formatter)
  const visibleLineCount = Math.max(1, Math.floor(viewport.height / lineHeight))
  useLayoutEffect(() => model.setViewportLines(visibleLineCount), [model, visibleLineCount])

  // dnSpy's HexViewUIState, put back once the file's length is known.
  const restored = useRef(initialState === undefined)
  useEffect(() => {
    if (restored.current || length === 0 || !initialState)
      return
    restored.current = true
    const valid = (position: number): boolean => position >= model.bufferStart && position <= model.bufferEnd
    if (valid(initialState.valuesPosition) && valid(initialState.asciiPosition)) {
      model.moveCaretToCell(initialState.activeColumn === 'values'
        ? { column: 'values', position: initialState.valuesPosition, cellPosition: initialState.valuesCellPosition }
        : { column: 'ascii', position: initialState.asciiPosition, cellPosition: 0 })
    }
    if (valid(initialState.anchorPoint) && valid(initialState.activePoint))
      model.select(initialState.anchorPoint, initialState.activePoint, false)
    if (valid(initialState.topLinePosition))
      model.setTopLine(formatter.getLineNumber(initialState.topLinePosition))
  }, [length, initialState, model, formatter])

  // The state a tab keeps, handed on whenever it changes.
  const onStateChange = commands?.onStateChange
  const uiState = useMemo<HexViewUiState>(() => ({
    showOffsetColumn: local.showOffset,
    showValuesColumn: local.showValues,
    showAsciiColumn: local.showAscii,
    startPosition: local.startPosition,
    endPosition: local.endPosition,
    basePosition: local.basePosition,
    useRelativePositions: local.useRelativePositions,
    offsetBitSize: local.offsetBitSize,
    valuesFormat: local.valuesFormat,
    bytesPerLine: local.bytesPerLine,
    activeColumn: model.caret.activeColumn,
    valuesPosition: model.caret.valuePosition.position,
    valuesCellPosition: model.caret.valuePosition.cellPosition,
    asciiPosition: model.caret.asciiPosition.position,
    viewportLeft: scrollLeft,
    topLinePosition: formatter.getLineStart(model.topLine),
    anchorPoint: model.anchorPoint,
    activePoint: model.activePoint,
  }), [local, model.caret, model.topLine, model.anchorPoint, model.activePoint, scrollLeft, formatter]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!restored.current || !onStateChange)
      return
    // Moves come in bursts — a held arrow key — so the state settles before it is handed on.
    const handle = setTimeout(() => onStateChange(uiState), 250)
    return () => clearTimeout(handle)
  }, [uiState, onStateChange])

  // ---- Measuring ---------------------------------------------------------------------------------------
  const measure = useCallback((): void => {
    const element = textAreaRef.current
    if (!element)
      return
    setViewport((current) => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight })
  }, [])
  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !textAreaRef.current)
      return
    const observer = new ResizeObserver(measure)
    observer.observe(textAreaRef.current)
    return () => observer.disconnect()
  }, [measure])

  // ---- The lines on screen -----------------------------------------------------------------------------
  const topLine = model.topLine
  const drawnLines = Math.min(formatter.lineCount - topLine, visibleLineCount + 1)
  const firstVisible = formatter.getLineStart(topLine)
  const lastVisibleEnd = Math.min(model.bufferEnd, formatter.getLineStart(topLine + drawnLines))
  useEffect(() => { data.ensure(firstVisible, lastVisibleEnd) }, [data, firstVisible, lastVisibleEnd, data.version])
  const lines = useMemo(() => {
    const result: { line: HexBufferLine; loaded: boolean }[] = []
    if (length === 0 && model.bufferEnd === 0)
      return result
    for (let row = 0; row < drawnLines; row++) {
      const line = formatter.getLine(formatter.getLineStart(topLine + row), data.readByte)
      let loaded = true
      for (let position = line.bufferStart; position < line.bufferEnd; position++) {
        if (data.readByte(position) === NOT_LOADED) {
          loaded = false
          break
        }
      }
      result.push({ line, loaded })
    }
    return result
  }, [formatter, topLine, drawnLines, data.readByte, length, model.bufferEnd])
  const contentWidth = TEXT_LEFT + formatter.charsPerLine * charWidth + charWidth

  // ---- Scrolling ---------------------------------------------------------------------------------------
  const scrollRange = Math.min(MAX_SCROLL_HEIGHT, formatter.lineCount * lineHeight)
  const syncingScroll = useRef(false)
  useLayoutEffect(() => {
    const bar = vScrollRef.current
    if (!bar)
      return
    const max = Math.max(0, bar.scrollHeight - bar.clientHeight)
    const target = model.maxTopLine === 0 ? 0 : Math.round(topLine / model.maxTopLine * max)
    if (Math.abs(bar.scrollTop - target) > 1) {
      syncingScroll.current = true
      bar.scrollTop = target
    }
  }, [topLine, model.maxTopLine, scrollRange])
  const onVerticalScroll = (): void => {
    const bar = vScrollRef.current
    if (!bar)
      return
    if (syncingScroll.current) {
      syncingScroll.current = false
      return
    }
    const max = Math.max(1, bar.scrollHeight - bar.clientHeight)
    model.setTopLine(Math.round(bar.scrollTop / max * model.maxTopLine))
    moveSourceWindowIfAtEdge()
  }
  useLayoutEffect(() => {
    const maxLeft = Math.max(0, contentWidth - viewport.width)
    if (scrollLeft > maxLeft)
      setScrollLeft(maxLeft)
    if (hScrollRef.current && Math.abs(hScrollRef.current.scrollLeft - scrollLeft) > 1)
      hScrollRef.current.scrollLeft = scrollLeft
  }, [scrollLeft, contentWidth, viewport.width])

  /** `HexCaret.EnsureVisible`, horizontally: the caret's cell is scrolled into the viewport with dnSpy's margin. */
  const ensureCaretVisibleHorizontally = useCallback((): void => {
    const line = model.line(model.caretPosition)
    const cells = model.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells
    const cell = cellAt(cells, model.caretPosition)
    if (!cell)
      return
    const left = spanLeft(geometry, cell.cellSpan.start)
    const right = spanLeft(geometry, cell.cellSpan.end)
    const width = viewport.width
    if (width === 0)
      return
    const extra = Math.min(200, Math.max(0, width - (right - left)) / 2)
    if (left < scrollLeft)
      setScrollLeft(Math.max(0, left - extra))
    else if (right > scrollLeft + width)
      setScrollLeft(right + extra - width)
  }, [model, geometry.charWidth, viewport.width, scrollLeft]) // eslint-disable-line react-hooks/exhaustive-deps

  // A source's window moves when the view reaches its edge, so the view scrolls on through the address space.
  const previousBase = useRef(source?.base ?? 0)
  const pendingReveal = useRef<{ address: number; caret: boolean } | undefined>(undefined)
  const revealAddress = (address: number, caret: boolean): void => {
    if (!source)
      return
    pendingReveal.current = { address, caret }
    source.reveal(address)
  }
  useLayoutEffect(() => {
    if (!source)
      return
    const delta = previousBase.current - source.base
    previousBase.current = source.base
    const pending = pendingReveal.current
    pendingReveal.current = undefined
    if (delta === 0 && !pending)
      return
    const clamp = (position: number): number => Math.max(0, Math.min(source.length - 1, position))
    if (pending?.caret) {
      model.moveCaretTo(clamp(pending.address - source.base))
      model.clearSelection()
    }
    else {
      model.moveCaretToCell({ ...model.activePosition, position: clamp(model.caretPosition + delta) }, false)
      model.select(clamp(model.anchorPoint + delta), clamp(model.activePoint + delta), false)
    }
    if (pending)
      model.displayLineContaining(clamp(pending.address - source.base), 'top', pending.caret ? 2 : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.base])
  const moveSourceWindowIfAtEdge = (): void => {
    if (!source || source.end === undefined || pendingReveal.current)
      return
    const edge = 64
    const topAddress = source.base + formatter.getLineStart(model.topLine)
    if (model.topLine < edge && source.base > 0)
      revealAddress(topAddress, false)
    else if (model.topLine + model.viewportLines > model.lineCount - edge && source.base + source.length < source.end)
      revealAddress(topAddress, false)
  }

  // ---- Structures: Quick Info, references and the caret's field ----------------------------------------
  const hasFile = !source && workspaceId !== undefined
  const positionInfo = useCallback(async (position: number): Promise<HexPositionInfoResponse | undefined> => {
    if (!hasFile || !workspaceId)
      return undefined
    try {
      return await window.dnSpy.getHexPositionInfo(workspaceId, moduleId, position)
    }
    catch {
      return undefined
    }
  }, [hasFile, workspaceId, moduleId])
  const [toolTip, setToolTip] = useState<{ position: number; row: number; x: number; toolTip: HexToolTip; fields: { offset: number; length: number; kind: string }[]; span: { start: number; end: number } } | undefined>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverPosition = useRef<number | undefined>(undefined)
  const dismissToolTip = useCallback((): void => {
    clearTimeout(hoverTimer.current)
    hoverPosition.current = undefined
    setToolTip(undefined)
  }, [])
  const showQuickInfo = useCallback(async (position: number, row: number, x: number): Promise<void> => {
    if (!hasFile || !workspaceId)
      return
    try {
      const info = await window.dnSpy.getHexToolTipInfo(workspaceId, moduleId, position)
      if (!info.toolTip || hoverPosition.current !== position)
        return
      const current = info.fields.find((field) => field.kind === 'currentField')
      setToolTip({ position, row, x, toolTip: info.toolTip, fields: info.fields, span: current ? { start: current.offset, end: current.offset + current.length } : { start: position, end: position + 1 } })
    }
    catch {
      // A file the structures cannot be read from has no Quick Info.
    }
  }, [hasFile, workspaceId, moduleId])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => { dismissToolTip() }, [workspaceStateId, topLine, formatter, dismissToolTip])

  const navigate = useCallback(async (reference: HexCodeReference): Promise<void> => {
    const store = useAppStore.getState()
    const open = store.followNodeById ?? store.openNodeById
    if (!open || !workspaceId)
      return
    try {
      if (reference.kind === 'node' && reference.nodeId) {
        if (!await open(reference.nodeId))
          await store.revealNode(reference.nodeId)
        return
      }
      if (reference.kind === 'method' && reference.modulePath && reference.metadataToken !== null) {
        const found = await window.dnSpy.findMember(workspaceId, reference.modulePath, reference.metadataToken)
        if (!found.nodeId)
          return
        const documentId = await open(found.nodeId)
        if (documentId && reference.ilOffset !== null)
          await revealStatement(documentId, reference.modulePath, reference.metadataToken, reference.ilOffset)
      }
    }
    catch (error) {
      appendOutput(t('Navigation failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }, [workspaceId, appendOutput, t])

  // ---- Edits -------------------------------------------------------------------------------------------
  const readOnly = !source && !hasFile
  const encoding = pane.general.encoding

  /** `InsertText`: a hex digit edits the character of the value cell under the caret, text the ASCII bytes. */
  const insertText = async (text: string): Promise<void> => {
    if (readOnly || text.length === 0)
      return
    const position = model.activePosition
    if (model.caret.activeColumn === 'values') {
      if (text.length !== 1 || !canEditValues(formatter.valuesFormat))
        return
      const cell = cellAt(model.line(position.position).valueCells, position.position)
      if (!cell)
        return
      const bytes = await readBytes(cell.bufferStart, formatter.bytesPerValue)
      const edit = editValueCell(formatter.valuesFormat, bytes, position.cellPosition, text)
      if (!edit || !await writeBytes(cell.bufferStart + edit.offset, edit.data))
        return
      model.clearSelection()
      model.moveToNextCharacter(false)
      return
    }
    const bytes = encodeText(text, encoding)
    if (!await writeBytes(position.position, bytes))
      return
    model.moveCaretAfterWrite(position.position, bytes.length)
  }

  /** `PasteData`: bytes written from the caret's cell on, the caret after them. */
  const pasteData = async (bytes: Uint8Array | undefined): Promise<void> => {
    if (!bytes || readOnly)
      return
    if (bytes.length === 0)
      return
    const line = model.line(model.caretPosition)
    const cell = cellAt(model.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, model.caretPosition)
    if (!cell)
      return
    const available = Math.max(0, model.bufferEnd - cell.bufferStart)
    const data = bytes.length > available ? bytes.subarray(0, available) : bytes
    if (!await writeBytes(cell.bufferStart, data))
      return
    model.moveCaretAfterWrite(cell.bufferStart, data.length)
  }

  const clipboardText = async (): Promise<string | undefined> => {
    try {
      return await navigator.clipboard.readText()
    }
    catch {
      return undefined
    }
  }

  const copy = useCallback(async (text: string | undefined): Promise<void> => {
    if (text === undefined)
      return
    try {
      await navigator.clipboard.writeText(text)
    }
    catch (error) {
      appendOutput(t('Copy failed: {message}', { message: error instanceof Error ? error.message : String(error) }))
    }
  }, [appendOutput, t])

  const hexNumber = (value: number | bigint): string => `0x${value.toString(16).toUpperCase()}`
  const readInteger = async (byteCount: number, bigEndian: boolean): Promise<bigint> => {
    const bytes = await readBytes(model.caretPosition, byteCount)
    let value = BigInt(0)
    for (let i = 0; i < byteCount; i++)
      value = (value << BigInt(8)) | BigInt(bytes[bigEndian ? i : byteCount - 1 - i] ?? 0)
    return value
  }
  const selectedBytes = (): Promise<Uint8Array> => readBytes(model.selectionStart, model.selectionEnd - model.selectionStart)
  const copyData = (kind: 'uint16' | 'uint16Be' | 'uint32Be' | 'uint64' | 'uint64Be'): void => {
    const sizes = { uint16: [2, false], uint16Be: [2, true], uint32Be: [4, true], uint64: [8, false], uint64Be: [8, true] } as const
    const [size, bigEndian] = sizes[kind]
    void readInteger(size, bigEndian).then((value) => copy(hexNumber(value)))
  }

  /** `CopySelectionText`: the selected lines' text, or the caret's line when nothing is selected. */
  const copyText = async (): Promise<string> => {
    const readLine = async (position: number): Promise<HexBufferLine> => {
      const start = formatter.getLineStart(formatter.getLineNumber(position))
      const bytes = await readBytes(start, Math.min(formatter.bytesPerLine, model.bufferEnd - start))
      return formatter.getLine(start, (at) => bytes[at - start] ?? -1)
    }
    if (model.isSelectionEmpty)
      return (await readLine(model.caretPosition)).text
    const parts: string[] = []
    for (let position = model.selectionStart; ;) {
      const line = await readLine(position)
      parts.push(lineTextWithin(line, model.selectionStart, model.selectionEnd) + '\n')
      position = line.bufferEnd
      if (position >= model.selectionEnd || line.bufferEnd <= line.bufferStart)
        break
    }
    return parts.join('')
  }

  // ---- Commands ----------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<{ kind: 'goToPosition' | 'goToMetadata' | 'select' | 'settings' | 'fill'; initial?: number } | undefined>()
  const [menu, setMenu] = useState<{ x: number; y: number; editField?: HexEditField } | undefined>()
  const focusView = useCallback(() => textAreaRef.current?.focus({ preventScroll: true }), [])
  const localSearch = useCallback(async (pattern: HexSearchPattern, run: HexSearchRun): Promise<number[]> => {
    const bytes = await readBytes(run.rangeStart, run.rangeEnd - run.rangeStart)
    return findAllInBytes(pattern, bytes, run.rangeStart, run.start, run)
  }, [readBytes])
  const moduleSearch = useCallback(async (pattern: HexSearchPattern, run: HexSearchRun): Promise<number[]> => {
    if (!workspaceId)
      return []
    const response = await window.dnSpy.searchHex(workspaceId, moduleId, {
      base64Pattern: toBase64(pattern.pattern),
      base64Mask: pattern.mask ? toBase64(pattern.mask) : null,
      base64Alternate: pattern.alternate ? toBase64(pattern.alternate) : null,
      charLengths: pattern.charLengths ?? null,
      ...run,
      start: Math.max(run.rangeStart, Math.min(run.rangeEnd, run.start)),
    })
    // A reverse wrap can name the match that ends on the start twice; one of each is enough.
    return [...new Set(response.offsets)]
  }, [workspaceId, moduleId])
  const search = useHexSearch({
    model,
    run: source ? localSearch : workspaceId ? moduleSearch : undefined,
    readBytes,
    write: writeBytes,
    canWrite: !readOnly,
    focusView,
    visibleRange: { start: firstVisible, end: lastVisibleEnd },
  })

  const setLocalSettings = (next: Partial<HexLocalSettings>): void => setLocal((current) => ({ ...current, ...next }))
  const zoomTo = (level: number): void => {
    const current = loadAppOptions()
    saveAppOptions({ ...current, hexEditor: { ...current.hexEditor, [paneKey]: { ...current.hexEditor[paneKey], zoomLevel: normalizeZoom(level) } } })
  }

  const run = (command: HexCommand): void => {
    const m = model
    switch (command) {
      case 'left': m.moveToPreviousCharacter(false); break
      case 'leftExt': m.moveToPreviousCharacter(true); break
      case 'right': m.moveToNextCharacter(false); break
      case 'rightExt': m.moveToNextCharacter(true); break
      case 'up':
      case 'upExt':
        // A caret walking off a source's window takes the window along.
        if (source && source.base > 0 && m.caretLine === 0 && command === 'up')
          revealAddress(source.base + m.caretPosition - formatter.bytesPerLine, true)
        else m.moveLineUp(command === 'upExt')
        break
      case 'down':
      case 'downExt':
        if (source && source.end !== undefined && m.caretLine === m.lineCount - 1 && command === 'down' && source.base + source.length < source.end)
          revealAddress(source.base + m.caretPosition + formatter.bytesPerLine, true)
        else m.moveLineDown(command === 'downExt')
        break
      case 'pageUp': m.pageUp(false); break
      case 'pageUpExt': m.pageUp(true); break
      case 'pageDown': m.pageDown(false); break
      case 'pageDownExt': m.pageDown(true); break
      case 'bol': m.moveToStartOfLine(false); break
      case 'bolExt': m.moveToStartOfLine(true); break
      case 'eol': m.moveToEndOfLine(false); break
      case 'eolExt': m.moveToEndOfLine(true); break
      case 'home': m.moveToStartOfDocument(false); break
      case 'homeExt': m.moveToStartOfDocument(true); break
      case 'end': m.moveToEndOfDocument(false); break
      case 'endExt': m.moveToEndOfDocument(true); break
      case 'topLine': m.moveToTopOfView(false); break
      case 'topLineExt': m.moveToTopOfView(true); break
      case 'bottomLine': m.moveToBottomOfView(false); break
      case 'bottomLineExt': m.moveToBottomOfView(true); break
      case 'scrollUp': m.scrollByLineAndMoveCaret('up'); break
      case 'scrollDown': m.scrollByLineAndMoveCaret('down'); break
      case 'wordNext': m.moveToNextWord(false); break
      case 'wordNextExt': m.moveToNextWord(true); break
      case 'wordPrev': m.moveToPreviousWord(false); break
      case 'wordPrevExt': m.moveToPreviousWord(true); break
      case 'moveToNextValidStartEnd': m.moveToNextValidStartEnd(false); break
      case 'moveToNextValidStartEndExt': m.moveToNextValidStartEnd(true); break
      case 'moveToPreviousValidStartEnd': m.moveToPreviousValidStartEnd(false); break
      case 'moveToPreviousValidStartEndExt': m.moveToPreviousValidStartEnd(true); break
      case 'selectAll': m.selectAll(); break
      case 'selectCurrentWord': m.selectCurrentWord(); break
      case 'swapAnchor': m.swapCaretAndAnchor(); break
      case 'tab': m.toggleColumn(); break
      case 'cancel': m.clearSelection(); break
      case 'delete': {
        // ClearData: the selection, or the cell under the caret, becomes zeros.
        const span = m.selectedSpanOrCell()
        if (!span || readOnly)
          break
        const empty = m.isSelectionEmpty
        void writeBytes(span.start, new Uint8Array(span.end - span.start)).then((written) => {
          if (!written)
            return
          if (empty)
            m.moveCaretAfterWrite(span.start, span.end - span.start)
          else {
            m.clearSelection()
            m.ensureCaretVisible()
          }
        })
        break
      }
      case 'zoomIn': zoomTo(zoomIn(zoom)); break
      case 'zoomOut': zoomTo(zoomOut(zoom)); break
      case 'zoomReset': zoomTo(100); break
      case 'quickInfo': {
        const line = m.line(m.caretPosition)
        hoverPosition.current = m.caretPosition
        const cell = cellAt(m.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, m.caretPosition)
        void showQuickInfo(m.caretPosition, m.caretLine - m.topLine, cell ? spanLeft(geometry, cell.cellSpan.start) - scrollLeft : 0)
        break
      }
      case 'copy': if (!m.isSelectionEmpty) void selectedBytes().then((bytes) => copy(hexText(bytes, !formatter.valuesLowerCaseHex))); break
      case 'copyText': void copyText().then(copy); break
      case 'copyUtf8String': void selectedBytes().then((bytes) => copy(new TextDecoder('utf-8').decode(bytes))); break
      case 'copyUnicodeString': void selectedBytes().then((bytes) => copy(new TextDecoder('utf-16le').decode(bytes))); break
      case 'copyCSharpArray': void selectedBytes().then((bytes) => copy(csharpArrayText(bytes, !formatter.valuesLowerCaseHex))); break
      case 'copyVisualBasicArray': void selectedBytes().then((bytes) => copy(visualBasicArrayText(bytes, !formatter.valuesLowerCaseHex))); break
      case 'copyOffset': void copy(formatter.formatOffset(formatter.toLogicalPosition(m.caretPosition))); break
      case 'copyValue': {
        if (!formatter.showValues)
          break
        void (async () => {
          const line = m.line(m.caretPosition)
          const cell = cellAt(line.valueCells, m.caretPosition)
          if (!cell)
            return
          const bytes = await readBytes(cell.bufferStart, formatter.bytesPerValue)
          const text = formatter.getLine(line.bufferStart, (at) => at >= cell.bufferStart && at < cell.bufferEnd ? bytes[at - cell.bufferStart] ?? -1 : 0).text
          await copy(text.slice(cell.textSpan.start, cell.textSpan.end))
        })()
        break
      }
      case 'copyUInt32': void readInteger(4, false).then((value) => copy(hexNumber(value))); break
      case 'copyAbsoluteFileOffset': void copy(hexNumber(m.caretPosition)); break
      case 'copyFileOffset': void positionInfo(m.caretPosition).then((info) => copy(hexNumber(info?.fileOffset ?? m.caretPosition))); break
      case 'copyRva': void positionInfo(m.caretPosition).then((info) => { if (info?.rva !== null && info?.rva !== undefined) void copy(hexNumber(info.rva)) }); break
      case 'paste':
        void clipboardText().then((text) => {
          if (text === undefined || text.length === 0)
            return
          return m.caret.activeColumn === 'values' ? pasteData(parseHexBytes(text)) : insertText(text)
        })
        break
      case 'pasteUtf8String': void clipboardText().then((text) => text ? pasteData(new TextEncoder().encode(text)) : undefined); break
      case 'pasteUtf8StringLength': void clipboardText().then((text) => { if (text !== undefined) { const bytes = new TextEncoder().encode(text); void pasteData(concatBytes([sevenBitLengthPrefix(bytes.length), bytes])) } }); break
      case 'pasteUnicodeString': void clipboardText().then((text) => text ? pasteData(utf16Of(text)) : undefined); break
      case 'pasteUnicodeStringLength': void clipboardText().then((text) => { if (text !== undefined) { const bytes = utf16Of(text); void pasteData(concatBytes([sevenBitLengthPrefix(bytes.length), bytes])) } }); break
      case 'pasteBlob': void clipboardText().then((text) => { const bytes = text === undefined ? undefined : parseHexBytes(text); if (bytes) void pasteData(concatBytes([compressedUIntPrefix(bytes.length), bytes])) }); break
      case 'showOnlySelectedBytes': if (!m.isSelectionEmpty) setLocalSettings({ startPosition: m.selectionStart, endPosition: m.selectionEnd }); break
      case 'showAllBytes': setLocalSettings({ startPosition: 0, endPosition: -1 }); break
      case 'refresh': data.invalidate(); break
      case 'goToCodeOrStructure': void positionInfo(m.caretPosition).then((info) => { if (info?.reference) void navigate(info.reference) }); break
      case 'followFieldValueReference':
        void positionInfo(m.caretPosition).then((info) => {
          const span = info?.fieldReference
          if (!span || !formatter.isValidPosition(span.offset))
            return
          m.ensureSpanVisible(span.offset, span.offset, true)
          m.moveCaretTo(span.offset)
          m.ensureCaretVisible()
          m.clearSelection()
        })
        break
      case 'selectFile':
      case 'selectNestedFile':
      case 'selectStructure':
        void positionInfo(m.caretPosition).then((info) => {
          const span = command === 'selectFile' ? info?.file : command === 'selectNestedFile' ? info?.nestedFile : info?.structure
          if (span)
            m.selectSpan(span.offset, span.offset + span.length)
        })
        break
      case 'goToPosition': void readInteger(4, false).then((value) => setDialog({ kind: 'goToPosition', initial: Number(value) })); break
      case 'goToMetadata': if (hasFile) void readInteger(4, false).then((value) => setDialog({ kind: 'goToMetadata', initial: Number(value) })); break
      case 'select': setDialog({ kind: 'select' }); break
      case 'saveSelection': saveSelection(); break
      case 'toggleUseRelativePositions': setLocalSettings({ useRelativePositions: !local.useRelativePositions }); break
      case 'find': search.showFind(); break
      case 'replace': search.showReplace(); break
      case 'incrementalSearchForward': search.showIncremental(true); break
      case 'incrementalSearchBackward': search.showIncremental(false); break
      case 'findNext': search.findNext(true); break
      case 'findPrevious': search.findNext(false); break
      case 'findNextSelected': search.findNextSelected(true); break
      case 'findPreviousSelected': search.findNextSelected(false); break
      case 'cut': case 'backspace': case 'return': break
    }
  }

  const saveSelection = (): void => {
    if (!workspaceId || model.isSelectionEmpty || source)
      return
    void (async () => {
      try {
        const name = `${moduleId.split(/[\\/]/).pop() ?? 'bytes'}.bin`
        await window.dnSpy.saveHexSelection(workspaceId, moduleId, model.selectionStart, model.selectionEnd - model.selectionStart, name)
      }
      catch (error) {
        appendOutput(t('An error occurred: {message}', { message: error instanceof Error ? error.message : String(error) }))
      }
    })()
  }

  // A hex command elsewhere — Show Method Body in Hex Editor and the rest — names the bytes this view selects.
  useEffect(() => {
    if (!navigation || navigation.moduleId !== moduleId || source || length === 0)
      return
    const start = navigation.offset
    const end = Math.min(length, start + navigation.length)
    if (start < model.bufferStart || end > model.bufferEnd)
      setLocal((current) => ({ ...current, startPosition: 0, endPosition: -1 }))
    // HexAddressReferenceFileTabContentCreator.InitializeHexView: the bytes selected, the caret on the first one.
    model.select(start, end, false)
    model.moveCaretTo(Math.min(start, Math.max(0, length - 1)), formatter.showValues ? 'values' : 'ascii')
    model.ensureSpanVisible(start, Math.max(end, start + 1), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, length])

  // The caret's moves end an incremental search and are kept in view.
  const caretKey = `${model.caretPosition}:${model.caret.activeColumn}:${model.activePosition.cellPosition}`
  const previousCaretKey = useRef(caretKey)
  useEffect(() => {
    if (previousCaretKey.current === caretKey)
      return
    previousCaretKey.current = caretKey
    search.caretMoved()
    ensureCaretVisibleHorizontally()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caretKey])

  // ---- Current value highlight ---------------------------------------------------------------------------
  const [currentValue, setCurrentValue] = useState<{ column: 'values' | 'ascii'; bytes: number[] } | undefined>()
  const highlightCurrentValue = pane.general.highlightCurrentValue && model.isSelectionEmpty
  useEffect(() => {
    if (!highlightCurrentValue) {
      setCurrentValue(undefined)
      return
    }
    // dnSpy clears the old highlight at once and shows the new one after a pause, so paging stays fast.
    setCurrentValue(undefined)
    const handle = setTimeout(() => {
      const column = model.caret.activeColumn
      const line = model.line(model.caretPosition)
      const cell = cellAt(column === 'values' ? line.valueCells : line.asciiCells, model.caretPosition)
      if (!cell)
        return
      const bytes: number[] = []
      for (let position = cell.bufferStart; position < cell.bufferEnd; position++)
        bytes.push(data.readByte(position))
      if (bytes.every((byte) => byte >= 0))
        setCurrentValue({ column, bytes })
    }, HIGHLIGHT_CURRENT_VALUE_DELAY)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightCurrentValue, caretKey, data.version, formatter])

  // ---- Markers -----------------------------------------------------------------------------------------
  const markers: HexLineMarker[] = []
  const rowOf = (line: HexBufferLine): number => line.lineNumber - topLine
  const addRange = (start: number, end: number, className: string, columns = { values: true, ascii: true }): void => {
    if (end <= start)
      return
    for (const { line } of lines) {
      if (line.bufferEnd <= start || line.bufferStart >= end)
        continue
      for (const { span } of columnSpansOf(line, start, end, columns))
        markers.push({ row: rowOf(line), span, className })
    }
  }
  const caretLineVisible = model.isLineVisible(model.caretLine)
  if (pane.general.highlightCurrentLine && model.isSelectionEmpty && caretLineVisible)
    markers.push({ row: model.caretLine - topLine, span: { start: Math.floor((scrollLeft - TEXT_LEFT) / charWidth), end: Math.ceil((scrollLeft + viewport.width) / charWidth) }, className: focused ? 'hex-current-line' : 'hex-current-line-no-focus' })
  if (!model.isSelectionEmpty)
    addRange(model.selectionStart, model.selectionEnd, focused ? 'hex-selection' : 'hex-inactive-selection')
  for (const match of search.markers)
    addRange(match.start, match.start + match.length, 'hex-find-match')
  if (toolTip && pane.general.highlightStructureUnderMouseCursor) {
    // HexToolTipInfoCollection: the field with the tooltip in its own colour, the others alternating by start.
    let index = 0
    for (const field of [...toolTip.fields].sort((a, b) => a.offset - b.offset)) {
      const className = field.kind === 'currentField' ? 'hex-tooltip-current-field' : (index++ & 1) === 0 ? 'hex-tooltip-field0' : 'hex-tooltip-field1'
      addRange(field.offset, field.offset + field.length, className)
    }
  }
  if (currentValue) {
    for (const { line } of lines) {
      const cells = currentValue.column === 'values' ? line.valueCells : line.asciiCells
      for (const cell of cells) {
        if (!cell.hasData || cell.bufferEnd - cell.bufferStart !== currentValue.bytes.length)
          continue
        let same = true
        for (let i = 0; i < currentValue.bytes.length && same; i++)
          same = data.readByte(cell.bufferStart + i) === currentValue.bytes[i]
        if (same)
          markers.push({ row: rowOf(line), span: cell.cellSpan, className: currentValue.column === 'values' ? 'hex-current-value-cell' : 'hex-current-ascii-cell' })
      }
    }
  }

  // ---- Carets ------------------------------------------------------------------------------------------
  const [blinkOn, setBlinkOn] = useState(true)
  useEffect(() => {
    setBlinkOn(true)
    if (!focused)
      return
    const handle = setInterval(() => setBlinkOn((on) => !on), CARET_BLINK_MS)
    return () => clearInterval(handle)
  }, [focused, caretKey])
  const carets: React.ReactNode[] = []
  if (focused && blinkOn && caretLineVisible) {
    const line = model.line(model.caretPosition)
    const row = model.caretLine - topLine
    for (const column of ['values', 'ascii'] as const) {
      if (column === 'values' ? !formatter.showValues : !formatter.showAscii)
        continue
      const position = column === 'values' ? model.caret.valuePosition : model.caret.asciiPosition
      const cell = cellAt(column === 'values' ? line.valueCells : line.asciiCells, position.position)
      if (!cell)
        continue
      const active = model.caret.activeColumn === column
      const top = row * lineHeight
      if (!active)
        carets.push(<div key={column} className="hex-caret hex-caret-inactive" style={{ left: spanLeft(geometry, cell.cellSpan.start), top: top + lineHeight - INACTIVE_CARET_HEIGHT, width: (cell.cellSpan.end - cell.cellSpan.start) * charWidth, height: INACTIVE_CARET_HEIGHT }} />)
      else {
        const character = cell.cellSpan.start + Math.min(position.cellPosition, cell.cellSpan.end - cell.cellSpan.start - 1)
        carets.push(<div key={column} className={`hex-caret${model.overwriteMode ? ' hex-caret-overwrite' : ''}`} style={{ left: spanLeft(geometry, character), top, width: model.overwriteMode ? charWidth : 2, height: lineHeight }} />)
      }
    }
  }

  // ---- Keyboard ----------------------------------------------------------------------------------------
  const chord = useRef<{ prefix: HexChordPrefix; until: number } | undefined>(undefined)
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).matches('input, textarea, select') || dialog || menu)
      return
    const stop = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key))
      return
    if (toolTip)
      dismissToolTip()
    const armed = chord.current
    chord.current = undefined
    let command: HexCommand | undefined
    if (armed && armed.until > Date.now())
      command = hexChordCommand(armed.prefix, event)
    if (!command && !armed) {
      const prefix = hexChordPrefix(event)
      if (prefix) {
        stop()
        chord.current = { prefix, until: Date.now() + 2000 }
        return
      }
    }
    command ??= hexKeyCommand(event)
    // Typing a character: dnSpy's TYPECHAR, which an incremental search takes first.
    const typed = !command && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey ? event.key : undefined
    if (search.incrementalKey(typed ?? '', command)) {
      stop()
      return
    }
    if (command === 'cancel' && model.isSelectionEmpty) {
      if (search.visible) {
        stop()
        search.close()
      }
      return
    }
    if (command) {
      stop()
      run(command)
      if (command !== 'cut' && command !== 'backspace' && command !== 'return')
        moveSourceWindowIfAtEdge()
      return
    }
    if (typed) {
      stop()
      void insertText(typed)
    }
  }

  // ---- Mouse -------------------------------------------------------------------------------------------
  /** The line and the character a point of the text area is over. */
  const hitTest = (clientX: number, clientY: number): { lineNumber: number; linePosition: number; insertion: number } | undefined => {
    const area = textAreaRef.current
    if (!area)
      return undefined
    const bounds = area.getBoundingClientRect()
    const row = Math.floor((clientY - bounds.top) / lineHeight)
    const x = clientX - bounds.left + scrollLeft - TEXT_LEFT
    const lineNumber = Math.max(0, Math.min(formatter.lineCount - 1, topLine + row))
    return { lineNumber, linePosition: Math.max(0, Math.floor(x / charWidth)), insertion: Math.max(0, Math.round(x / charWidth)) }
  }
  const drag = useRef<{ x: number; y: number; clicks: number; captured: boolean; span: { start: number; end: number } } | undefined>(undefined)
  const scrollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const stopAutoScroll = (): void => {
    clearInterval(scrollTimer.current)
    scrollTimer.current = undefined
  }

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('.hex-search-control, .hex-tooltip'))
      return
    focusView()
    dismissToolTip()
    const hit = hitTest(event.clientX, event.clientY)
    if (!hit)
      return
    if (event.button === 2) {
      // OnMouseRightButtonDown: the caret goes to the click; a click outside the selection clears it.
      const before = { start: model.selectionStart, end: model.selectionEnd, empty: model.isSelectionEmpty }
      model.moveCaretToLinePosition(hit.lineNumber, hit.linePosition, true)
      if (before.empty || model.caretPosition < before.start || model.caretPosition >= before.end)
        model.clearSelection()
      else
        model.select(model.anchorPoint, model.activePoint, false)
      model.ensureCaretVisible()
      return
    }
    if (event.button !== 0)
      return
    event.preventDefault()
    const line = model.line(formatter.getLineStart(hit.lineNumber))
    const isOffset = linePositionInfo(formatter, line, hit.linePosition).type === 'offset'
    let clicks = Math.min(3, event.detail || 1)
    if (isOffset)
      clicks = 3
    else if (event.ctrlKey && !event.shiftKey)
      clicks = 2
    if (clicks === 1)
      model.moveCaretByMouse(hit.lineNumber, hit.linePosition, event.shiftKey)
    else if (clicks === 2) {
      model.moveCaretToLinePosition(hit.lineNumber, hit.linePosition, true)
      model.selectCurrentWord()
    }
    else {
      model.selectLine(hit.lineNumber, false)
      // dnSpy moves the caret to the line's start when the click is on the line's text.
      if (hit.linePosition <= formatter.charsPerLine + 1)
        model.moveCaretTo(model.line(formatter.getLineStart(hit.lineNumber)).bufferStart)
    }
    model.ensureCaretVisible()
    drag.current = { x: event.clientX, y: event.clientY, clicks, captured: false, span: { start: model.isSelectionEmpty ? model.caretPosition : model.selectionStart, end: model.isSelectionEmpty ? model.caretPosition : model.selectionEnd } }
  }

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const state = drag.current
      if (!state || (event.buttons & 1) === 0)
        return
      if (!state.captured) {
        if (Math.abs(event.clientX - state.x) < 4 && Math.abs(event.clientY - state.y) < 4)
          return
        state.captured = true
      }
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit)
        return
      if (state.clicks === 1) {
        model.moveCaretByMouse(hit.lineNumber, hit.linePosition, true)
        // UpdateScrolling: past the viewport's top or bottom the view scrolls while the mouse stays there.
        const bounds = textAreaRef.current?.getBoundingClientRect()
        stopAutoScroll()
        if (bounds && (event.clientY < bounds.top || event.clientY > bounds.bottom)) {
          const up = event.clientY < bounds.top
          scrollTimer.current = setInterval(() => {
            model.scrollByLineAndMoveCaret(up ? 'up' : 'down')
            const again = hitTest(event.clientX, up ? bounds.top + 1 : bounds.bottom - 1)
            if (again)
              model.moveCaretByMouse(again.lineNumber, again.linePosition, true)
          }, 50)
        }
        return
      }
      // A word or a line selection grows a word or a line at a time and does not scroll.
      if (!model.isLineVisible(hit.lineNumber))
        return
      model.moveCaretToLinePosition(hit.lineNumber, hit.linePosition, true)
      if (state.clicks === 2)
        model.selectCurrentWord()
      else
        model.selectLine(hit.lineNumber, false)
      const selStart = model.isSelectionEmpty ? model.caretPosition : model.selectionStart
      const selEnd = model.isSelectionEmpty ? model.caretPosition : model.selectionEnd
      if (selStart < state.span.start) {
        model.select(state.span.end, selStart, true)
        model.moveCaretTo(selStart)
      }
      else {
        model.select(state.span.start, selEnd, true)
        model.moveCaretTo(state.clicks === 2 && selStart + 1 === selEnd ? selStart : Math.max(selStart, selEnd - 1))
      }
    }
    const onUp = (): void => {
      drag.current = undefined
      stopAutoScroll()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopAutoScroll()
    }
  })

  const onHover = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (drag.current || event.buttons !== 0 || !hasFile)
      return
    if ((event.target as HTMLElement).closest('.hex-search-control, .hex-tooltip'))
      return
    const hit = hitTest(event.clientX, event.clientY)
    if (!hit)
      return
    const line = lines[hit.lineNumber - topLine]?.line
    if (!line)
      return
    const info = linePositionInfo(formatter, line, hit.linePosition)
    let position: number | undefined
    if ((info.type === 'valueCell' || info.type === 'asciiCell') && info.cell.hasData)
      position = info.type === 'valueCell' ? formatter.valueBufferPosition(info.cell, info.cellPosition) : info.cell.bufferStart
    else if (info.type === 'valueCellSeparator' && info.cell.hasData)
      position = formatter.valueBufferPosition(info.cell, info.cell.cellSpan.end - info.cell.cellSpan.start - 1)
    // The tooltip stays while the mouse is over the field it is about (trackMouse).
    if (toolTip && position !== undefined && position >= toolTip.span.start && position < toolTip.span.end)
      return
    if (position === hoverPosition.current)
      return
    clearTimeout(hoverTimer.current)
    setToolTip(undefined)
    hoverPosition.current = position
    if (position === undefined)
      return
    const row = hit.lineNumber - topLine
    const x = event.clientX - (textAreaRef.current?.getBoundingClientRect().left ?? 0)
    hoverTimer.current = setTimeout(() => void showQuickInfo(position!, row, x), MOUSE_HOVER_DELAY)
  }

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey) {
      event.preventDefault()
      event.stopPropagation()
      if (pane.advanced.enableMouseWheelZoom && event.deltaY !== 0)
        zoomTo(event.deltaY < 0 ? zoomIn(zoom) : zoomOut(zoom))
      return
    }
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const delta = event.shiftKey ? event.deltaY : event.deltaX
      setScrollLeft((current) => Math.max(0, Math.min(Math.max(0, contentWidth - viewport.width), current + delta)))
      return
    }
    const lines = event.deltaMode === 1 ? event.deltaY : Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 100 * WHEEL_LINES))
    model.setTopLine(model.topLine + lines)
    dismissToolTip()
    moveSourceWindowIfAtEdge()
  }

  // The selection margin: a click selects the line, a drag extends it a line at a time (`LeftSelectionMargin`).
  const marginDrag = useRef(false)
  const onMarginMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0)
      return
    event.preventDefault()
    focusView()
    const hit = hitTest(event.clientX, event.clientY)
    if (!hit)
      return
    model.selectLine(hit.lineNumber, event.shiftKey)
    marginDrag.current = true
    const onMove = (move: MouseEvent): void => {
      const next = hitTest(move.clientX, move.clientY)
      if (next && marginDrag.current)
        model.selectLine(next.lineNumber, true)
    }
    const onUp = (): void => {
      marginDrag.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---- The context menu --------------------------------------------------------------------------------
  const openMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const at = { x: event.clientX, y: event.clientY }
    void positionInfo(model.caretPosition).then((info) => setMenu({ ...at, editField: info?.editField ?? undefined }))
  }
  const editFieldItem = (field: HexEditField, index: number): void => {
    const item = field.items[index]
    const value = BigInt(field.value)
    const mask = BigInt(item.mask)
    const itemValue = BigInt(item.value)
    // EditFlagsFieldCommand: a flag toggles; an enum value (and a flags field's enum part) is set.
    const next = item.isFlag && (value & mask) !== BigInt(0) ? value & ~mask : (value & ~mask) | itemValue
    const bytes = new Uint8Array(field.size)
    for (let i = 0; i < field.size; i++)
      bytes[i] = Number((next >> BigInt(8 * i)) & BigInt(0xFF))
    void writeBytes(field.offset, bytes)
  }
  const menuItems = (editField: HexEditField | undefined): MenuItem[] => buildHexViewMenu({
    t,
    hasSelection: !model.isSelectionEmpty,
    narrowed: model.bufferStart !== 0 || model.bufferEnd !== length,
    readOnly,
    volatile: source !== undefined,
    hasFile,
    bytesPerLine: local.bytesPerLine,
    valuesFormat: local.valuesFormat,
    editField,
    run,
    dialog: (kind) => {
      if (kind === 'goToPosition' || kind === 'goToMetadata')
        run(kind)
      else
        setDialog({ kind })
    },
    setBytesPerLine: (value) => setLocalSettings({ bytesPerLine: value }),
    setValuesFormat: (value) => setLocalSettings({ valuesFormat: value }),
    copyData,
    editFieldItem: (index) => { if (editField) editFieldItem(editField, index) },
    extra: source?.menu ?? [],
  })

  // ---- Dialogs -----------------------------------------------------------------------------------------
  const goToPosition = (result: { kind: string; value: number; selectToNewPosition: boolean }): void => {
    void (async () => {
      setDialog(undefined)
      focusView()
      const origin = model.caretPosition
      let position: number
      if (result.kind === 'absolute')
        position = source ? (result.value >= source.base && result.value < source.base + source.length ? result.value - source.base : source.reveal(result.value)) : formatter.toPhysicalPosition(result.value)
      else if (result.kind === 'current')
        position = origin + result.value
      else if (workspaceId && !source)
        position = (await window.dnSpy.resolveHexPosition(workspaceId, moduleId, result.kind === 'rva' ? 'rva' : 'file', result.value)).offset
      else
        position = result.value
      if (position < 0)
        return
      position = Math.max(model.bufferStart, Math.min(model.bufferEnd, position))
      if (!result.selectToNewPosition) {
        model.clearSelection()
        model.moveCaretTo(position)
        model.ensureSpanVisible(position, position, true)
        model.ensureCaretVisible()
        return
      }
      // UserValueToSelection from the selection's start (or the caret) to the new position.
      const from = model.isSelectionEmpty ? origin : (model.anchorPoint < model.activePoint ? model.anchorPoint : model.anchorPoint - 1)
      if (from <= position)
        model.selectAndMoveCaret(from, Math.min(model.bufferEnd, position + 1))
      else
        model.selectAndMoveCaret(Math.min(model.bufferEnd, from + 1), position)
    })()
  }

  const goToMetadata = (result: { kind: string; value: number }): void => {
    void (async () => {
      setDialog(undefined)
      focusView()
      if (!workspaceId)
        return
      const response = await window.dnSpy.goToHexMetadata(workspaceId, moduleId, result.kind as never, result.value)
      if (!response.range || response.range.offset < 0)
        return
      // GoToMetadata: the caret at the item's start, nothing selected.
      model.clearSelection()
      model.moveCaretTo(Math.min(response.range.offset, model.bufferEnd))
      model.ensureSpanVisible(response.range.offset, response.range.offset + Math.max(1, response.range.length), true)
    })()
  }
  const validateMetadata = useCallback(async (kind: string, value: number): Promise<boolean> => {
    if (!workspaceId)
      return false
    try {
      const response = await window.dnSpy.goToHexMetadata(workspaceId, moduleId, kind as never, value)
      return response.range !== null && response.range.offset >= 0
    }
    catch {
      return false
    }
  }, [workspaceId, moduleId])

  const select = (result: { kind: string; start: number; end: number; mode: 'position' | 'length' }): void => {
    void (async () => {
      setDialog(undefined)
      focusView()
      const origin = formatter.toLogicalPosition(model.isSelectionEmpty ? model.caretPosition : model.selectionStart)
      const toBuffer = async (value: number): Promise<number> => {
        if (result.kind === 'absolute')
          return formatter.toPhysicalPosition(value)
        if (result.kind === 'current')
          return origin + value
        if (workspaceId && !source)
          return (await window.dnSpy.resolveHexPosition(workspaceId, moduleId, result.kind === 'rva' ? 'rva' : 'file', value)).offset
        return value
      }
      const start = await toBuffer(result.start)
      const end = result.mode === 'length' ? (result.end === 0 ? start : start + result.end - 1) : await toBuffer(result.end)
      if (start < 0 || end < 0)
        return
      if (start <= end)
        model.selectAndMoveCaret(start, Math.min(model.bufferEnd, end + 1))
      else
        model.selectAndMoveCaret(Math.min(model.bufferEnd, start + 1), end)
    })()
  }

  // ---- Rendering ---------------------------------------------------------------------------------------
  const showVertical = pane.scrollBars.verticalScrollBar
  const showHorizontal = pane.scrollBars.horizontalScrollBar
  const showZoomControl = pane.advanced.zoomControl && showHorizontal
  const selectionEmpty = model.isSelectionEmpty
  return (
    <div
      className={`hex-view${focused ? ' hex-view-focused' : ''}`}
      data-caret={model.caretPosition}
      data-caret-offset={formatter.formatOffset(formatter.toLogicalPosition(model.caretPosition))}
      data-selection-start={selectionEmpty ? undefined : model.selectionStart}
      data-selection-end={selectionEmpty ? undefined : model.selectionEnd}
      data-bytes-per-line={formatter.bytesPerLine}
      style={{ fontFamily: hexFont.fontFamily, fontSize }}
    >
      <div className="hex-view-main">
        {pane.advanced.glyphMargin && <div className="hex-glyph-margin" style={{ width: GLYPH_MARGIN_WIDTH }} onContextMenu={(event) => event.preventDefault()} />}
        {pane.advanced.selectionMargin && <div className="hex-selection-margin" style={{ width: SELECTION_MARGIN_WIDTH }} onMouseDown={onMarginMouseDown} />}
        <div
          ref={textAreaRef}
          className={`hex-content${pane.general.enableColorization ? ' hex-colorized' : ''}`}
          role="textbox"
          aria-label={t('Hex')}
          aria-readonly={readOnly}
          aria-multiline="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onMouseMove={onHover}
          onMouseLeave={() => { if (!toolTip) { clearTimeout(hoverTimer.current); hoverPosition.current = undefined } }}
          onWheel={onWheel}
          onFocus={() => setFocused(true)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}
          onContextMenu={openMenu}
        >
          <div className="hex-scroll-layer" style={{ transform: `translateX(${-scrollLeft}px)`, width: contentWidth }}>
            <HexLines lines={lines} formatter={formatter} geometry={geometry} colorize={pane.general.enableColorization} markers={markers} overlays={carets} selection={selectionEmpty ? undefined : { start: model.selectionStart, end: model.selectionEnd }} />
          </div>
          {pane.advanced.showColumnLines && lines.length > 0 && <HexColumnLines formatter={formatter} line={lines[0].line} geometry={geometry} scrollLeft={scrollLeft} />}
          {search.visible && (
            <HexSearchControl
              state={search.state}
              canReplace={search.canReplace}
              focusRequest={search.focusRequest}
              onChange={search.change}
              onFindNext={search.findNext}
              onReplaceNext={search.replaceNext}
              onReplaceAll={search.replaceAll}
              onToggleReplace={search.toggleReplace}
              onClose={search.close}
              onKeyDown={(event) => onSearchControlKey(event)}
            />
          )}
          {toolTip && (
            <HexToolTipView toolTip={toolTip.toolTip} left={toolTip.x} top={(toolTip.row + 1) * lineHeight} />
          )}
        </div>
        {showVertical && (
          <div ref={vScrollRef} className="hex-vscroll" onScroll={onVerticalScroll}>
            <div style={{ height: scrollRange + (vScrollRef.current?.clientHeight ?? 0) }} />
          </div>
        )}
      </div>
      {showHorizontal && (
        <div className="hex-hscroll-row">
          {showZoomControl && <HexZoomControl zoom={zoom} onZoom={zoomTo} />}
          <div ref={hScrollRef} className="hex-hscroll" onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}>
            <div style={{ width: contentWidth + GLYPH_MARGIN_WIDTH + SELECTION_MARGIN_WIDTH, height: 1 }} />
          </div>
          {showVertical && <div className="hex-scroll-corner" />}
        </div>
      )}
      {menu && (
        <div className="hex-context-menu" style={{ left: menu.x, top: menu.y }}>
          <MenuPopup items={menuItems(menu.editField)} onClose={() => { setMenu(undefined); focusView() }} />
        </div>
      )}
      {dialog?.kind === 'goToPosition' && <HexGoToPositionDialog initial={dialog.initial ?? 0} onAccept={goToPosition} onClose={() => { setDialog(undefined); focusView() }} />}
      {dialog?.kind === 'goToMetadata' && <HexGoToMetadataDialog initial={dialog.initial ?? 0} hasPeHeaders validate={validateMetadata} onAccept={goToMetadata} onClose={() => { setDialog(undefined); focusView() }} />}
      {dialog?.kind === 'select' && (
        <HexSelectDialog
          start={formatter.toLogicalPosition(selectionEmpty ? model.caretPosition : model.anchorPoint < model.activePoint ? model.anchorPoint : model.anchorPoint - 1)}
          end={formatter.toLogicalPosition(selectionEmpty ? model.caretPosition : model.anchorPoint < model.activePoint ? model.activePoint - 1 : model.activePoint)}
          onAccept={select}
          onClose={() => { setDialog(undefined); focusView() }}
        />
      )}
      {dialog?.kind === 'settings' && (
        <HexLocalSettingsDialog
          settings={{ ...local, endPosition: local.endPosition < 0 ? length : local.endPosition }}
          defaults={{ ...defaultLocalSettings(), endPosition: length }}
          onAccept={(next) => { setDialog(undefined); setLocal({ ...next, endPosition: next.endPosition >= length ? -1 : next.endPosition }); focusView() }}
          onClose={() => { setDialog(undefined); focusView() }}
        />
      )}
      {dialog?.kind === 'fill' && (
        <AskDialog
          title="Enter Value"
          label={t('Byte')}
          initial="0xFF"
          validate={(text) => parseFillByte(text) === undefined ? t('The value is not an unsigned hexadecimal or decimal integer') : undefined}
          onAccept={(text) => {
            setDialog(undefined)
            const value = parseFillByte(text)
            if (value !== undefined && !model.isSelectionEmpty) {
              const start = model.selectionStart
              void writeBytes(start, new Uint8Array(model.selectionEnd - start).fill(value)).then(() => model.clearSelection())
            }
            focusView()
          }}
          onClose={() => { setDialog(undefined); focusView() }}
        />
      )}
    </div>
  )

  /** The search control's own key bindings (`ShowSearchControl`'s InputBindings). */
  function onSearchControlKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    const key = event.key
    const ctrl = event.ctrlKey && !event.altKey
    const alt = event.altKey && !event.ctrlKey && !event.shiftKey
    const handled = (action: () => void): void => {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
    if (key === 'Escape') handled(search.close)
    else if (ctrl && !event.shiftKey && event.code === 'KeyF') handled(search.showFind)
    else if (ctrl && !event.shiftKey && event.code === 'KeyH') handled(search.showReplace)
    else if (key === 'Enter' && (event.target as HTMLElement).matches('input')) handled(() => search.findNext(!event.shiftKey))
    else if (key === 'F3' && !event.ctrlKey) handled(() => search.findNext(!event.shiftKey))
    else if (key === 'F3' && event.ctrlKey) handled(() => search.findNextSelected(!event.shiftKey))
    else if (alt && event.code === 'KeyF') handled(() => search.findNext(true))
    else if (alt && event.code === 'KeyC') handled(() => search.change({ matchCase: !search.state.matchCase }))
    else if (alt && event.code === 'KeyB') handled(() => search.change({ bigEndian: !search.state.bigEndian }))
    else if (alt && event.code === 'KeyH') handled(() => search.change({ dataKind: 'bytes' }))
    else if (alt && event.code === 'KeyU') handled(() => search.change({ dataKind: 'utf16String' }))
    else if (alt && event.code === 'Digit8') handled(() => search.change({ dataKind: 'utf8String' }))
    else if (alt && event.code === 'KeyR') handled(search.replaceNext)
    else if (alt && event.code === 'KeyA') handled(search.replaceAll)
    else
      event.stopPropagation()
  }
}

/** Goes to the statement of a method body that holds an IL offset, once the method's document is open. */
async function revealStatement(documentId: string, modulePath: string, metadataToken: number, ilOffset: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const document = useAppStore.getState().documents[documentId]
    if (document && !document.loading) {
      let best: { line: number; column: number; start: number } | undefined
      for (const statement of document.codeStatements ?? []) {
        if (statement.isHidden || statement.modulePath !== modulePath || statement.sourceMethodToken !== metadataToken)
          continue
        if (statement.ilOffset <= ilOffset && ilOffset < statement.ilEndOffset && (!best || statement.ilOffset >= best.start))
          best = { line: statement.startLine, column: statement.startColumn, start: statement.ilOffset }
      }
      if (best)
        useAppStore.getState().revealCaret(documentId, best.line, best.column)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** dnSpy's column lines: between the columns and between the value groups, the height of the view. */
const HexColumnLines = ({ formatter, line, geometry, scrollLeft }: { formatter: HexLineFormatter; line: HexBufferLine; geometry: HexLineGeometry; scrollLeft: number }): React.JSX.Element => {
  const positions: { at: number; className: string }[] = []
  const columns = [
    formatter.showOffset ? formatter.offsetSpan : undefined,
    formatter.showValues ? formatter.valuesSpan : undefined,
    formatter.showAscii ? formatter.asciiSpan : undefined,
  ].filter((span): span is { start: number; end: number } => span !== undefined)
  for (let i = 1; i < columns.length; i++)
    positions.push({ at: columns[i - 1].end, className: i === 1 ? 'hex-column-line0' : 'hex-column-line1' })
  if (formatter.showValues) {
    const groups = formatter.valuesGroup
    for (let i = 1; i < groups.length; i++)
      positions.push({ at: groups[i - 1].fullSpan.end - 1, className: i % 2 === 1 ? 'hex-column-group-line0' : 'hex-column-group-line1' })
  }
  void line
  return (
    <div className="hex-column-lines" aria-hidden="true">
      {positions.map((entry, index) => (
        <div key={index} className={`hex-column-line ${entry.className}`} style={{ left: Math.round(spanLeft(geometry, entry.at) + geometry.charWidth / 2 - 0.5) - scrollLeft }} />
      ))}
    </div>
  )
}

/** The Quick Info of a field: dnSpy's image beside the first section, the other sections under it. */
const HexToolTipView = ({ toolTip, left, top }: { toolTip: HexToolTip; left: number; top: number }): React.JSX.Element => {
  const [first, ...rest] = toolTip.sections
  return (
    <div className="hex-tooltip" role="tooltip" style={{ left, top }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="hex-tooltip-signature">
        {toolTip.image && <DsIcon name={toolTip.image} />}
        <div><ColoredText parts={first ?? []} /></div>
      </div>
      {rest.map((section, index) => <div key={index} className="hex-tooltip-section"><ColoredText parts={section} /></div>)}
    </div>
  )
}

/** dnSpy's `ZoomControlMargin`: the zoom as "100 %" in an editable box at the start of the horizontal bar. */
const HexZoomControl = ({ zoom, onZoom }: { zoom: number; onZoom(value: number): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(`${zoom} %`)
  useEffect(() => setText(`${zoom} %`), [zoom])
  const apply = (): void => {
    const value = Number.parseFloat(text.replace('%', '').trim())
    if (Number.isFinite(value) && value >= zoomLevels[0] && value <= zoomLevels[zoomLevels.length - 1])
      onZoom(value)
    else
      setText(`${zoom} %`)
  }
  return (
    <div className="hex-zoom-control">
      <input
        aria-label={t('Zoom')}
        list="hex-zoom-levels"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setText(`${zoom} %`)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') { event.preventDefault(); apply() }
          else if (event.key === 'Escape') { event.preventDefault(); setText(`${zoom} %`) }
        }}
      />
      <datalist id="hex-zoom-levels">{[...zoomLevels].reverse().map((level) => <option key={level} value={`${level} %`} />)}</datalist>
    </div>
  )
}
