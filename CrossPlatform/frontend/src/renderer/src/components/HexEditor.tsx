import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { HexCodeReference, HexEditField, HexMetadataKind, HexPositionInfoResponse, HexRange, HexToolTip, HexToolTipInfoResponse } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useCategoryFont } from '../fonts'
import { hexChordCommand, hexChordPrefix, hexKeyCommand, type HexChordPrefix, type HexCommand } from '../hex-commands'
import { HexLineFormatter, cellAt, columnSpansOf, linePositionInfo, type HexBufferLine } from '../hex-line'
import { buildHexClipboardText } from '../hex-clipboard'
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
import { encodeHexText, hexCodePageOf } from '../hex-encodings'
import { findAllInBytes, type HexSearchPattern } from '../hex-search'
import { NOT_LOADED, PAGE_SIZE, useHexChunks, type HexChunkReader } from '../hex-view-data'
import { HexViewModel } from '../hex-view-model'
import { useLanguage } from '../localization'
import { useHexSearch, type HexSearchRun } from '../use-hex-search'
import { normalizeZoom, zoomIn, zoomLevels, zoomOut } from '../zoom'
import { loadAppOptions, saveAppOptions, useAppOptions, type HexEditorView } from './app-options'
import { AskDialog } from './AskDialog'
import { ColoredText } from './ColoredText'
import { DsIcon } from './DsIcon'
import { HexGoToMetadataDialog, HexGoToPositionDialog, HexLocalSettingsDialog, HexSaveProgressDialog, HexSelectDialog, parseUnsignedText, type HexLocalSettings } from './HexDialogs'
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
/** `RepeatButton`'s defaults: the first repeat after the keyboard delay, then at the keyboard speed. */
const REPEAT_DELAY = 500
const REPEAT_INTERVAL = 33
/** The shortest the vertical bar's thumb gets. */
const MIN_THUMB = 16
const CARET_BLINK_MS = 530
/** `HexEditorOperationsImpl`'s copy limits and the text it copies instead past them. */
const BYTES_MAX_TO_COPY = 10 * 1024 * 1024
const TOO_MUCH_DATA = 'Too much data selected'

/** A theme colour the stylesheet holds as a custom property, for the HTML a copy carries. */
const themeColor = (name: string): string | undefined => {
  if (typeof document === 'undefined')
    return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? undefined : value
}

/**
 * Bytes the hex view shows that are not a module's file — the Memory windows' process memory, every position an
 * address, from 0 to the end of the process's address space (dnSpy's `HexProcessSimpleBufferStream`).
 */
export interface HexByteSource {
  /** Where the view's state is remembered; a source without one remembers nothing. */
  stateKey?: string
  length: number
  /** Changes whenever the bytes may have: every chunk is read again. */
  revision: string
  /** The bytes from `offset` on, and for each 4 KiB page from the one `offset` is in whether it could be read. */
  read(offset: number, count: number): Promise<{ bytes: Uint8Array; readable?: boolean[] }>
  write(offset: number, data: Uint8Array): Promise<boolean>
  /** Refreshes volatile structure data before the view reads its bytes again. */
  refresh?(): Promise<void>
  /**
   * `HexBuffer.GetNextValidSpan` (`forward`, no further than `bounds`) or `GetPreviousValidSpan` (no lower than
   * `bounds`): the readable bytes around a position, consecutive ones merged. Without it every byte is readable.
   */
  validSpan?(position: number, bounds: number, forward: boolean, fullSpan: boolean): Promise<{ start: number; end: number } | undefined>
  /** dnSpy's FindAll over the source's readable bytes; without it the view searches the bytes it reads. */
  search?(pattern: HexSearchPattern, run: HexSearchRun): Promise<number[]>
  /** Entries the source's owner adds to the context menu, such as the Memory window's Process submenu. */
  menu?: MenuItem[]
  /** The options page the view follows: the Memory windows have one of their own. */
  optionsView?: HexEditorView
  /** The files in the bytes and their structures — the modules a process has loaded. */
  structures?: HexStructureSource
}

/**
 * What the view asks the structures of its bytes (dnSpy's `HexBufferFileService` and `HexFileStructureInfoService`),
 * every position an offset of the view's own bytes.
 */
export interface HexStructureSource {
  toolTipInfo(position: number): Promise<HexToolTipInfoResponse>
  positionInfo(position: number): Promise<HexPositionInfoResponse>
  /** A file offset or an RVA as a window offset (possibly negative); NaN when that file has no PE headers. */
  resolvePosition(caret: number, kind: 'file' | 'rva', value: number): Promise<number>
  /** `GetGoToMetadataSpan` over the metadata of the file at the caret. */
  goToMetadata(caret: number, kind: HexMetadataKind, value: number): Promise<HexRange | null>
  /** Whether the file at the caret has metadata and PE headers: Go to Metadata and its Method Body kind need them. */
  fileInfo(caret: number): Promise<{ hasMetadata: boolean; hasPeHeaders: boolean }>
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

const utf16Of = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    bytes[i * 2] = text.charCodeAt(i) & 0xFF
    bytes[i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return bytes
}

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

/** `TryParseUnsigned`'s errors for a byte: a minus sign, no number at all, or a number past 255. */
const fillByteError = (text: string, t: (key: string, args?: Record<string, string | number>) => string): string | undefined => {
  if (parseFillByte(text) !== undefined)
    return undefined
  if (parseUnsignedText(text) !== undefined)
    return t('Value must be between {min} and {max} (0x{maxHex}) inclusive', { min: 0, max: 255, maxHex: 'FF' })
  return text.trim().startsWith('-') ? t('Only non-negative integers are allowed') : t('The value is not an unsigned hexadecimal or decimal integer')
}

/**
 * dnSpy's hex editor: the bytes between a start and an end position as lines of offset, values and ASCII, with
 * dnSpy's caret, selection, keyboard, mouse, context menu, search control, Quick Info over the file's structures,
 * margins, zoom and options. The line layout is `hex-line.ts`, the operations `hex-view-model.ts`.
 */
export const HexView = ({ moduleId = '', source, initialState, commands, goto }: { moduleId?: string; source?: HexByteSource; initialState?: HexViewUiState; commands?: HexViewCommands; goto?: { start: number; length: number; nonce: number } }): React.JSX.Element => {
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
    if (!reader)
      return new Uint8Array(0)
    const parts: Uint8Array[] = []
    for (let position = 0; position < count; position += 1024 * 1024)
      parts.push((await reader(offset + position, Math.min(1024 * 1024, count - position))).bytes)
    return concatBytes(parts)
  }, [reader])

  /** The bytes from `offset` on, -1 for each one a source could not read (`TryGetByte`). */
  const readBytesChecked = useCallback(async (offset: number, count: number): Promise<number[]> => {
    const result: number[] = []
    if (count <= 0 || !reader)
      return result
    for (let position = 0; position < count; position += 1024 * 1024) {
      const start = offset + position
      const part = await reader(start, Math.min(1024 * 1024, count - position))
      const firstPage = Math.floor(start / PAGE_SIZE)
      for (let i = 0; i < Math.min(1024 * 1024, count - position); i++) {
        const readable = part.readable?.[Math.floor((start + i) / PAGE_SIZE) - firstPage] ?? true
        result.push(readable && i < part.bytes.length ? part.bytes[i] : -1)
      }
    }
    return result
  }, [reader])

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

  /** Several writes as one edit (Replace All): a module's file in one transaction, a process's memory one by one. */
  const writeAllBytes = useCallback(async (patches: { offset: number; data: Uint8Array }[]): Promise<boolean> => {
    if (patches.length === 0)
      return false
    if (source) {
      let any = false
      for (const patch of patches)
        any = await source.write(patch.offset, patch.data) || any
      data.invalidate()
      return any
    }
    return useAppStore.getState().hexWriteBytesMany(moduleId, patches)
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
    basePosition: local.basePosition,
    useRelativePositions: local.useRelativePositions,
    offsetLowerCaseHex: pane.general.offsetLowerCaseHex,
    valuesLowerCaseHex: pane.general.valuesLowerCaseHex,
    offsetBitSize: local.offsetBitSize,
    valuesFormat: local.valuesFormat,
  }), [charsPerLine, textAreaWidth, local, pane.general, startPosition, endPosition])

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

  /** A position a command goes to: the caret there with nothing selected, or a span selected. */
  const revealPosition = (position: number, selection?: { anchor: number; active: number; moveCaret: boolean }): void => {
    if (!Number.isFinite(position))
      return
    if (selection) {
      if (selection.moveCaret)
        model.selectAndMoveCaret(selection.anchor, selection.active)
      else
        model.selectSpan(selection.anchor, selection.active)
    }
    else {
      model.clearSelection()
      model.moveCaretTo(position)
      model.ensureSpanVisible(position, position, true)
      model.ensureCaretVisible()
    }
  }

  // A Show in Memory Window request from another window: select the span the module occupies.
  useEffect(() => {
    if (!goto || length === 0)
      return
    const end = Math.min(length, goto.start + Math.max(1, goto.length)) - 1
    if (end > goto.start)
      revealPosition(goto.start, { anchor: goto.start, active: end, moveCaret: false })
    else
      revealPosition(goto.start)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goto?.nonce, length])

  // ---- Structures: Quick Info, references and the caret's field ----------------------------------------
  const hasFile = !source && workspaceId !== undefined
  // A module's file asks the workspace; a process's memory asks its source, which knows the loaded modules.
  const structures = useMemo<HexStructureSource | undefined>(() => {
    if (source)
      return source.structures
    if (!workspaceId)
      return undefined
    return {
      toolTipInfo: (position) => window.dnSpy.getHexToolTipInfo(workspaceId, moduleId, position),
      positionInfo: (position) => window.dnSpy.getHexPositionInfo(workspaceId, moduleId, position),
      resolvePosition: async (_caret, kind, value) => {
        const offset = (await window.dnSpy.resolveHexPosition(workspaceId, moduleId, kind, value)).offset
        return offset < 0 ? Number.NaN : offset
      },
      goToMetadata: async (_caret, kind, value) => (await window.dnSpy.goToHexMetadata(workspaceId, moduleId, kind, value)).range,
      // The file at the caret is the module's: it has metadata when its Module table has a row, PE headers when an
      // RVA can be turned into an offset.
      fileInfo: async () => {
        const [metadata, peHeaders] = await Promise.all([
          window.dnSpy.goToHexMetadata(workspaceId, moduleId, 'table', 0x00000001),
          window.dnSpy.resolveHexPosition(workspaceId, moduleId, 'rva', 0),
        ])
        return { hasMetadata: metadata.range !== null, hasPeHeaders: peHeaders.offset >= 0 }
      },
    }
  }, [source, workspaceId, moduleId])
  const hasStructures = structures !== undefined
  const positionInfo = useCallback(async (position: number): Promise<HexPositionInfoResponse | undefined> => {
    if (!structures)
      return undefined
    try {
      return await structures.positionInfo(position)
    }
    catch {
      return undefined
    }
  }, [structures])
  const [toolTip, setToolTip] = useState<{ position: number; row: number; x: number; toolTip: HexToolTip; fields: { offset: number; length: number; kind: string }[]; span: { start: number; end: number } } | undefined>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverPosition = useRef<number | undefined>(undefined)
  const dismissToolTip = useCallback((): void => {
    clearTimeout(hoverTimer.current)
    hoverPosition.current = undefined
    setToolTip(undefined)
  }, [])
  const showQuickInfo = useCallback(async (position: number, row: number, x: number): Promise<void> => {
    if (!structures)
      return
    try {
      const info = await structures.toolTipInfo(position)
      if (!info.toolTip || hoverPosition.current !== position)
        return
      const current = info.fields.find((field) => field.kind === 'currentField')
      setToolTip({ position, row, x, toolTip: info.toolTip, fields: info.fields, span: current ? { start: current.offset, end: current.offset + current.length } : { start: position, end: position + 1 } })
    }
    catch {
      // A file the structures cannot be read from has no Quick Info.
    }
  }, [structures])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  useEffect(() => { dismissToolTip() }, [workspaceStateId, source?.revision, topLine, formatter, dismissToolTip])

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
  // A file the workspace no longer holds is shown as it is on disk, with no document to keep an edit in.
  const readOnly = !source && (!hasFile || moduleId.startsWith('hexfile:'))
  const codePage = hexCodePageOf(pane.general.encoding)

  const editQueue = useRef(Promise.resolve())
  const editContext = `${workspaceId}:${moduleId}:${source?.revision ?? ''}`
  const currentEditContext = useRef<string | undefined>(editContext)
  currentEditContext.current = editContext
  useEffect(() => () => { currentEditContext.current = undefined }, [])
  const enqueueEdit = (action: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    const context = editContext
    const isCurrent = (): boolean => currentEditContext.current === context
    const pending = editQueue.current.then(async () => {
      if (isCurrent())
        await action(isCurrent)
    }).catch((error: unknown) => {
      if (isCurrent())
        appendOutput(t('An error occurred: {message}', { message: error instanceof Error ? error.message : String(error) }))
    })
    editQueue.current = pending
    return pending
  }

  /** `InsertText`: each key is a transaction, including encoding and advancing the caret, before the next key. */
  const insertText = (text: string): Promise<void> => enqueueEdit(async (isCurrent) => {
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
      if (!isCurrent() || !edit || !await writeBytes(cell.bufferStart + edit.offset, edit.data) || !isCurrent())
        return
      model.clearSelection()
      model.moveToNextCharacter(false)
      return
    }
    const bytes = await encodeHexText(text, codePage)
    if (!isCurrent() || !await writeBytes(position.position, bytes) || !isCurrent())
      return
    model.moveCaretAfterWrite(position.position, bytes.length)
  })

  /** `PasteData`: bytes written from the caret's cell on, the caret after them. */
  const pasteData = (bytes: Uint8Array | undefined): Promise<void> => enqueueEdit(async (isCurrent) => {
    if (!bytes || readOnly)
      return
    if (bytes.length === 0)
      return
    const line = model.line(model.caretPosition)
    const cell = cellAt(model.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, model.caretPosition)
    if (!cell)
      return
    // The buffer takes what fits in it, whatever part of it the view shows (Show Only Selected Bytes).
    const available = Math.max(0, length - cell.bufferStart)
    const data = bytes.length > available ? bytes.subarray(0, available) : bytes
    if (!await writeBytes(cell.bufferStart, data) || !isCurrent())
      return
    model.moveCaretAfterWrite(cell.bufferStart, data.length)
  })

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
  /** `bytesMaxTotalBytesToCopy`: past 10 MiB dnSpy copies a note instead of the bytes. */
  const copySelected = (format: (bytes: Uint8Array) => string): void => {
    if (model.selectionEnd - model.selectionStart > BYTES_MAX_TO_COPY) {
      void copy(TOO_MUCH_DATA)
      return
    }
    void selectedBytes().then((bytes) => copy(format(bytes)))
  }
  /** The arrays write a byte that cannot be read as `??`. */
  const copySelectedChecked = (format: (bytes: number[]) => string): void => {
    if (model.selectionEnd - model.selectionStart > BYTES_MAX_TO_COPY) {
      void copy(TOO_MUCH_DATA)
      return
    }
    void readBytesChecked(model.selectionStart, model.selectionEnd - model.selectionStart).then((bytes) => copy(format(bytes)))
  }
  const copyData = (kind: 'uint16' | 'uint16Be' | 'uint32Be' | 'uint64' | 'uint64Be'): void => {
    const sizes = { uint16: [2, false], uint16Be: [2, true], uint32Be: [4, true], uint64: [8, false], uint64Be: [8, true] } as const
    const [size, bigEndian] = sizes[kind]
    void readInteger(size, bigEndian).then((value) => copy(hexNumber(value)))
  }

  /** `CopySelectionText`: the selected lines' text, or the caret's line when nothing is selected — as text and,
   * up to a MiB of bytes, as HTML in the colours the view draws them in (`HexHtmlBuilder`). */
  const copyText = async (): Promise<void> => {
    if (!reader)
      return
    const { text, html } = await buildHexClipboardText({
      formatter,
      reader,
      caretPosition: model.caretPosition,
      selection: model.isSelectionEmpty ? undefined : { start: model.selectionStart, end: model.selectionEnd },
      fontFamily: hexFont.fontFamily,
      fontSize,
      colorize: pane.general.enableColorization,
      colors: {
        defaultText: themeColor('--tc-hextext') ?? themeColor('--tc-defaulttext'),
        offset: themeColor('--tc-hexoffset'),
        byte0: themeColor('--tc-hexbyte0'),
        byte1: themeColor('--tc-hexbyte1'),
        error: themeColor('--tc-hexbyteerror'),
        ascii: themeColor('--tc-hexascii'),
      },
    })
    try {
      const items: Record<string, Blob> = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
      if (html !== undefined)
        items['text/html'] = new Blob([html], { type: 'text/html' })
      await navigator.clipboard.write([new ClipboardItem(items)])
    }
    catch {
      await copy(text)
    }
  }

  // ---- Commands ----------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<{ kind: 'goToPosition' | 'goToMetadata' | 'select' | 'settings' | 'fill'; initial?: number; hasPeHeaders?: boolean } | undefined>()
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
    run: source ? (source.search ?? localSearch) : workspaceId ? moduleSearch : undefined,
    readBytes,
    write: writeBytes,
    writeAll: writeAllBytes,
    canWrite: !readOnly,
    focusView,
    visibleRange: { start: firstVisible, end: lastVisibleEnd },
  })

  /** The buffer's readable bytes around a position: a source asks its process, a file is readable throughout. */
  const validSpan = async (position: number, bounds: number, forward: boolean): Promise<{ start: number; end: number } | undefined> => {
    if (source?.validSpan)
      return source.validSpan(position, bounds, forward, false)
    if (length === 0)
      return undefined
    return (forward ? position < Math.min(bounds, length) : position >= bounds) ? { start: 0, end: length } : undefined
  }
  /** `MoveToNextValidStartEnd` / `MoveToPreviousValidStartEnd`: Alt+Down and Alt+Up, to the start or the end of the
   * readable bytes the caret is in, or on to the next (previous) ones. */
  const moveToValidStartEnd = async (forward: boolean, extendSelection: boolean): Promise<void> => {
    const m = model
    const startPos = m.caretPosition
    const context = editContext
    const still = (): boolean => currentEditContext.current === context && m.caretPosition === startPos
    let newPos: number
    try {
      if (forward) {
        let span = await validSpan(startPos, m.bufferEnd, true)
        if (!span || span.end === span.start || !still())
          return
        if (startPos < span.start)
          newPos = span.start
        else if (startPos < span.end - 1)
          newPos = span.end - 1
        else {
          if (startPos >= m.bufferEnd)
            return
          span = await validSpan(startPos + 1, m.bufferEnd, true)
          if (!span || !still())
            return
          newPos = span.start
        }
      }
      else {
        let span = await validSpan(startPos, m.bufferStart, false)
        if (!span || span.end === span.start || !still())
          return
        if (startPos >= span.end)
          newPos = span.end - 1
        else if (startPos > span.start)
          newPos = span.start
        else {
          if (startPos <= m.bufferStart)
            return
          span = await validSpan(startPos - 1, m.bufferStart, false)
          if (!span || span.end === span.start || !still())
            return
          newPos = span.end - 1
        }
      }
    }
    catch {
      return
    }
    m.moveToValidStartEnd(newPos, extendSelection)
  }

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
      case 'up': m.moveLineUp(false); break
      case 'upExt': m.moveLineUp(true); break
      case 'down': m.moveLineDown(false); break
      case 'downExt': m.moveLineDown(true); break
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
      case 'moveToNextValidStartEnd': void moveToValidStartEnd(true, false); break
      case 'moveToNextValidStartEndExt': void moveToValidStartEnd(true, true); break
      case 'moveToPreviousValidStartEnd': void moveToValidStartEnd(false, false); break
      case 'moveToPreviousValidStartEndExt': void moveToValidStartEnd(false, true); break
      case 'selectAll': m.selectAll(); break
      case 'selectCurrentWord': m.selectCurrentWord(); break
      case 'swapAnchor': m.swapCaretAndAnchor(); break
      case 'tab': m.toggleColumn(); break
      case 'cancel': m.clearSelection(); break
      case 'delete': {
        // ClearData: the selection, or the cell under the caret, becomes zeros.
        const span = m.selectedSpanOrCell()
        if (!span || readOnly || span.end - span.start > BYTES_MAX_TO_COPY)
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
      case 'copy': if (!m.isSelectionEmpty) copySelected((bytes) => hexText(bytes, !formatter.valuesLowerCaseHex)); break
      case 'copyText': void copyText().catch((error: unknown) => appendOutput(t('An error occurred: {message}', { message: error instanceof Error ? error.message : String(error) }))); break
      case 'copyUtf8String': copySelected((bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)); break
      case 'copyUnicodeString': copySelected((bytes) => new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes)); break
      case 'copyCSharpArray': copySelectedChecked((bytes) => csharpArrayText(bytes, !formatter.valuesLowerCaseHex)); break
      case 'copyVisualBasicArray': copySelectedChecked((bytes) => visualBasicArrayText(bytes, !formatter.valuesLowerCaseHex)); break
      case 'copyOffset': void copy(formatter.formatOffset(formatter.toLogicalPosition(m.caretPosition))); break
      case 'copyValue': {
        if (!formatter.showValues)
          break
        void (async () => {
          const line = m.line(m.caretPosition)
          const cell = cellAt(line.valueCells, m.caretPosition)
          if (!cell)
            return
          // The cell's text as the view shows it, `?` for bytes that cannot be read.
          const bytes = await readBytesChecked(cell.bufferStart, cell.bufferEnd - cell.bufferStart)
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
      case 'refresh':
        dismissToolTip()
        void Promise.resolve().then(() => source?.refresh?.()).then(() => data.invalidate()).catch((error: unknown) => {
          appendOutput(t('An error occurred: {message}', { message: error instanceof Error ? error.message : String(error) }))
        })
        break
      case 'goToCodeOrStructure': void positionInfo(m.caretPosition).then((info) => { if (info?.reference) void navigate(info.reference) }); break
      case 'followFieldValueReference':
        void positionInfo(m.caretPosition).then((info) => {
          const span = info?.fieldReference
          // FollowFieldValueReference: only to a position the view shows.
          if (span && formatter.isValidPosition(span.offset))
            revealPosition(span.offset)
        })
        break
      case 'selectFile':
      case 'selectNestedFile':
      case 'selectStructure':
        void positionInfo(m.caretPosition).then((info) => {
          const span = command === 'selectFile' ? info?.file : command === 'selectNestedFile' ? info?.nestedFile : info?.structure
          if (span)
            revealPosition(span.offset, { anchor: span.offset, active: span.offset + span.length, moveCaret: false })
        })
        break
      case 'goToPosition':
        void readInteger(4, false).catch(() => BigInt(0)).then((value) => {
          if (currentEditContext.current === editContext)
            setDialog({ kind: 'goToPosition', initial: Number(value) })
        })
        break
      case 'goToMetadata':
        // GoToMetadata: nothing happens without metadata in the file at the caret.
        if (structures) {
          const caret = m.caretPosition
          void structures.fileInfo(caret).then(async (info) => {
            if (info.hasMetadata) {
              const initial = Number(await readInteger(4, false))
              if (currentEditContext.current === editContext)
                setDialog({ kind: 'goToMetadata', initial, hasPeHeaders: info.hasPeHeaders })
            }
          }).catch(() => undefined)
        }
        break
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

  /**
   * dnSpy's Save Selection (HexBufferDataSaver): the selected bytes to a file the user picks, read and written a chunk
   * at a time under a progress dialog whose Cancel stops it. A save that is cancelled or fails deletes the file it
   * began, and a failure is reported in a message box.
   */
  const [saveProgress, setSaveProgress] = useState<{ title: string; filePath: string; done: number; total: number } | undefined>()
  const saveCancelled = useRef(false)
  const saveSelection = (): void => {
    if (model.isSelectionEmpty || !reader)
      return
    const start = model.selectionStart
    const end = model.selectionEnd
    void (async () => {
      let filePath: string | undefined
      try {
        filePath = await window.dnSpy.pickHexSaveFile()
        if (!filePath)
          return
        saveCancelled.current = false
        const title = t('Save Selection 0x{start}-0x{end}', { start: start.toString(16).toUpperCase(), end: (end - 1).toString(16).toUpperCase() })
        setSaveProgress({ title, filePath, done: 0, total: end - start })
        const chunk = 1024 * 1024
        let position = start
        do {
          if (saveCancelled.current)
            throw new DOMException('cancelled', 'AbortError')
          const count = Math.min(chunk, end - position)
          const { bytes } = count > 0 ? await reader(position, count) : { bytes: new Uint8Array(0) }
          // A page that cannot be read is saved as zeros.
          const data = bytes.length === count ? bytes : (() => { const padded = new Uint8Array(count); padded.set(bytes.subarray(0, count)); return padded })()
          await window.dnSpy.writeHexFileChunk(filePath, toBase64(data), position !== start)
          position += count
          setSaveProgress((current) => current && { ...current, done: position - start })
        } while (position < end)
      }
      catch (error) {
        if (filePath)
          await window.dnSpy.deleteHexFile(filePath).catch(() => undefined)
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          await window.dnSpy.showMessage(t('An error occurred: {message}', { message: error instanceof Error ? error.message : String(error) }))
      }
      finally {
        setSaveProgress(undefined)
        focusView()
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

  // `PositionWithoutCoveringSpan`: a match the search control would cover sends the control to the bottom right.
  const searchControlRef = useRef<HTMLDivElement>(null)
  const [searchAtBottom, setSearchAtBottom] = useState(false)
  useEffect(() => { if (!search.visible) setSearchAtBottom(false) }, [search.visible])
  useLayoutEffect(() => {
    const control = searchControlRef.current
    const area = textAreaRef.current
    if (!search.visible || !control || !area || model.isSelectionEmpty)
      return
    const controlWidth = control.offsetWidth
    const controlHeight = control.offsetHeight
    const covers = (bottom: boolean): boolean => {
      const top = bottom ? viewport.height - controlHeight : 0
      const left = viewport.width - controlWidth
      for (const { line } of lines) {
        const row = line.lineNumber - topLine
        const y = row * lineHeight
        if (y + lineHeight <= top || y >= top + controlHeight)
          continue
        for (const { span } of columnSpansOf(line, model.selectionStart, model.selectionEnd, { values: true, ascii: true })) {
          if (spanLeft(geometry, span.end) - scrollLeft > left && spanLeft(geometry, span.start) - scrollLeft < viewport.width)
            return true
        }
      }
      return false
    }
    setSearchAtBottom(covers(false) && !covers(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.visible, model.selectionStart, model.selectionEnd, topLine])

  // ---- Current value highlight ---------------------------------------------------------------------------
  const [currentValue, setCurrentValue] = useState<{ column: 'values' | 'ascii'; format: HexValuesFormat; bytes: number[] } | undefined>()
  const highlightCurrentValue = pane.general.highlightCurrentValue && model.isSelectionEmpty
  useEffect(() => {
    if (!highlightCurrentValue) {
      setCurrentValue(undefined)
      return
    }
    const read = (): { column: 'values' | 'ascii'; format: HexValuesFormat; bytes: number[] } | undefined => {
      const column = model.caret.activeColumn
      const line = model.line(model.caretPosition)
      const cell = cellAt(column === 'values' ? line.valueCells : line.asciiCells, model.caretPosition)
      if (!cell)
        return undefined
      const bytes: number[] = []
      for (let position = cell.bufferStart; position < cell.bufferEnd; position++)
        bytes.push(data.readByte(position))
      return bytes.every((byte) => byte >= 0) ? { column, format: formatter.valuesFormat, bytes } : undefined
    }
    // SavedValue.TryUpdate: a caret that moves to the same value in the same column and format keeps the highlight.
    const now = read()
    if (currentValue && now && currentValue.column === now.column && currentValue.format === now.format
      && currentValue.bytes.length === now.bytes.length && currentValue.bytes.every((byte, index) => byte === now.bytes[index]))
      return
    // dnSpy clears the old highlight at once and shows the new one after a pause, so paging stays fast.
    setCurrentValue(undefined)
    const handle = setTimeout(() => setCurrentValue(read()), HIGHLIGHT_CURRENT_VALUE_DELAY)
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
  // The caret and the current line are drawn on a line that is only partly in the viewport too.
  const caretLineVisible = model.caretLine >= topLine && model.caretLine < topLine + drawnLines
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
  const chord = useRef<{ prefix: HexChordPrefix } | undefined>(undefined)
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).matches('input, textarea, select') || dialog || menu || saveProgress)
      return
    const stop = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key))
      return
    if (toolTip)
      dismissToolTip()
    // RegisteredCommandElement.GetCommand: a second key that completes no chord runs nothing (and has no time limit).
    const armed = chord.current
    chord.current = undefined
    let command: HexCommand | undefined
    if (armed)
      command = hexChordCommand(armed.prefix, event)
    else {
      const prefix = hexChordPrefix(event)
      if (prefix) {
        stop()
        chord.current = { prefix }
        return
      }
      command = hexKeyCommand(event)
    }
    // Typing a character: dnSpy's TYPECHAR, which an incremental search takes first.
    const typed = !command && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey ? event.key : undefined
    if (search.incrementalKey(typed ?? '', command)) {
      stop()
      return
    }
    // The search control's filter comes first: Esc closes it, whatever is selected.
    if (command === 'cancel' && search.visible) {
      stop()
      search.close()
      return
    }
    if (command === 'cancel' && model.isSelectionEmpty)
      return
    if (command) {
      stop()
      run(command)
      return
    }
    if (typed) {
      stop()
      void insertText(typed)
    }
  }

  // ---- Mouse -------------------------------------------------------------------------------------------
  /**
   * `HexMouseLocation.Create`: the line a point of the text area is over — the first or the last line on screen
   * for a point above or below them — and where on it the point is, `x` in characters from the line's start.
   */
  const hitTest = (clientX: number, clientY: number): { lineNumber: number; linePosition: number; x: number } | undefined => {
    const area = textAreaRef.current
    if (!area)
      return undefined
    const bounds = area.getBoundingClientRect()
    const top = model.topLine
    const linesOnScreen = Math.max(1, Math.min(formatter.lineCount - top, Math.ceil(viewport.height / lineHeight)))
    const row = Math.max(0, Math.min(linesOnScreen - 1, Math.floor((clientY - bounds.top) / lineHeight)))
    const x = Math.max(0, (clientX - bounds.left + scrollLeft - TEXT_LEFT) / charWidth)
    const lineNumber = Math.max(0, Math.min(formatter.lineCount - 1, top + row))
    return { lineNumber, linePosition: Math.floor(x), x }
  }
  const drag = useRef<{ x: number; y: number; clicks: number; captured: boolean; span: { start: number; end: number }; formatter: HexLineFormatter } | undefined>(undefined)

  // DefaultHexViewMouseProcessor's scrolling while a drag is outside the viewport: a timer in the direction the drag
  // first left it, faster the further the mouse is.
  type ScrollDirection = 'left' | 'right' | 'up' | 'down'
  const autoScroll = useRef<{ direction: ScrollDirection; interval: number; timer: ReturnType<typeof setInterval>; x: number } | undefined>(undefined)
  const stopAutoScroll = useCallback((): void => {
    if (autoScroll.current)
      clearInterval(autoScroll.current.timer)
    autoScroll.current = undefined
  }, [])
  useEffect(() => stopAutoScroll, [stopAutoScroll])
  /** `OnScroll`: one step of the drag's scrolling, the selection extended to the line or character it reaches. */
  const onAutoScroll = (direction: ScrollDirection, x: number): void => {
    const m = model
    switch (direction) {
      case 'left': {
        const line = m.line(m.caretPosition)
        if (scrollLeft <= 0)
          stopAutoScroll()
        else if (m.caretPosition !== line.bufferStart)
          m.moveToPreviousCharacter(true)
        else {
          setScrollLeft(0)
          stopAutoScroll()
        }
        break
      }
      case 'right': {
        const line = m.line(m.caretPosition)
        const textRight = TEXT_LEFT + line.text.length * charWidth
        if (textRight <= scrollLeft + viewport.width)
          stopAutoScroll()
        else if (m.caretPosition < line.bufferEnd)
          m.moveToNextCharacter(true)
        else {
          setScrollLeft(Math.max(0, textRight - viewport.width))
          stopAutoScroll()
        }
        break
      }
      case 'up': {
        const line = Math.max(0, m.topLine - 1)
        if (line < m.topLine)
          m.setTopLine(line)
        if (line === 0)
          stopAutoScroll()
        m.moveCaretByMouse(line, x, true)
        break
      }
      case 'down': {
        const line = Math.min(m.lineCount - 1, m.topLine + m.viewportLines)
        if (line >= m.topLine + m.viewportLines)
          m.setTopLine(line - m.viewportLines + 1)
        if (line === m.lineCount - 1)
          stopAutoScroll()
        m.moveCaretByMouse(line, x, true)
        break
      }
    }
    m.ensureCaretVisible()
  }
  const onAutoScrollRef = useRef(onAutoScroll)
  onAutoScrollRef.current = onAutoScroll
  /** `UpdateScrolling`. */
  const updateAutoScroll = (clientX: number, clientY: number): void => {
    const bounds = textAreaRef.current?.getBoundingClientRect()
    if (!bounds)
      return
    const x = Math.max(0, (clientX - bounds.left + scrollLeft - TEXT_LEFT) / charWidth)
    const bottom = bounds.top + viewport.height
    const right = bounds.left + viewport.width
    // GetInterval: 250 ms within two lines (or characters) of the edge, sixteen times as fast past them.
    const interval = (distance: number, size: number): number => Math.abs(distance) < 2 * size ? 250 : 250 / 16
    let direction: ScrollDirection | undefined
    let every = 0
    if (clientY < bounds.top) { direction = 'up'; every = interval(clientY - bounds.top, lineHeight) }
    else if (clientY >= bottom) { direction = 'down'; every = interval(clientY - bottom, lineHeight) }
    else if (clientX < bounds.left) { direction = 'left'; every = interval(clientX - bounds.left, charWidth) }
    else if (clientX >= right) { direction = 'right'; every = interval(clientX - right, charWidth) }
    if (!direction) {
      stopAutoScroll()
      model.ensureCaretVisible()
      return
    }
    const current = autoScroll.current
    if (current) {
      current.x = x
      if (current.interval !== every) {
        clearInterval(current.timer)
        current.interval = every
        current.timer = setInterval(() => onAutoScrollRef.current(current.direction, current.x), every)
      }
      return
    }
    const state = { direction, interval: every, x, timer: undefined as unknown as ReturnType<typeof setInterval> }
    state.timer = setInterval(() => onAutoScrollRef.current(state.direction, state.x), every)
    autoScroll.current = state
    onAutoScroll(direction, x)
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
      model.moveCaretToLinePosition(hit.lineNumber, hit.x, true)
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
    // A fourth click and more are a click again, as in dnSpy's switch on the click count.
    let clicks = event.detail === 2 || event.detail === 3 ? event.detail : 1
    if (isOffset)
      clicks = 3
    else if (event.ctrlKey && !event.shiftKey)
      clicks = 2
    if (clicks === 1)
      model.moveCaretByMouse(hit.lineNumber, hit.x, event.shiftKey)
    else if (clicks === 2) {
      model.moveCaretToLinePosition(hit.lineNumber, hit.x, true)
      model.selectCurrentWord()
    }
    else {
      model.selectLine(hit.lineNumber, false)
      // dnSpy moves the caret to the line's start when the click is before the line's text ends (and a character).
      if (hit.x < line.text.length + 1)
        model.moveCaretTo(line.bufferStart)
    }
    model.ensureCaretVisible()
    drag.current = { x: event.clientX, y: event.clientY, clicks, captured: false, formatter, span: { start: model.isSelectionEmpty ? model.caretPosition : model.selectionStart, end: model.isSelectionEmpty ? model.caretPosition : model.selectionEnd } }
  }

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const state = drag.current
      if (!state || (event.buttons & 1) === 0)
        return
      // New line options while the button is down end the drag (`TryUpdateBufferLines`).
      if (state.formatter !== formatter) {
        drag.current = undefined
        stopAutoScroll()
        return
      }
      if (!state.captured) {
        if (Math.abs(event.clientX - state.x) < 4 && Math.abs(event.clientY - state.y) < 4)
          return
        state.captured = true
        return
      }
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit)
        return
      if (state.clicks === 1) {
        model.moveCaretByMouse(hit.lineNumber, hit.x, true)
        updateAutoScroll(event.clientX, event.clientY)
        return
      }
      stopAutoScroll()
      // A word or a line selection grows a word or a line at a time and does not scroll.
      const bounds = textAreaRef.current?.getBoundingClientRect()
      if (!bounds || event.clientY < bounds.top || event.clientY >= bounds.top + viewport.height)
        return
      model.moveCaretToLinePosition(hit.lineNumber, hit.x, true)
      if (state.clicks === 2)
        model.selectCurrentWord()
      else
        model.selectLine(model.caretLine, false)
      const selStart = model.isSelectionEmpty ? model.caretPosition : model.selectionStart
      const selEnd = model.isSelectionEmpty ? model.caretPosition : model.selectionEnd
      if (selStart < state.span.start) {
        model.select(state.span.end, selStart, true)
        model.moveCaretTo(selStart)
      }
      else {
        model.select(state.span.start, selEnd, true)
        model.moveCaretTo(state.clicks === 2 && selStart + 1 === selEnd ? selStart : selEnd)
      }
      model.ensureCaretVisible()
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
    }
  })

  const onHover = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (drag.current || event.buttons !== 0 || !hasStructures)
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
    // WpfHexViewHostImpl: Ctrl+wheel zooms when the options let it, and scrolls like any wheel otherwise.
    if (event.ctrlKey && pane.advanced.enableMouseWheelZoom) {
      event.preventDefault()
      event.stopPropagation()
      if (event.deltaY !== 0)
        zoomTo(event.deltaY < 0 ? zoomIn(zoom) : zoomOut(zoom))
      return
    }
    if (event.ctrlKey)
      event.stopPropagation()
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const delta = event.shiftKey ? event.deltaY : event.deltaX
      setScrollLeft((current) => Math.max(0, Math.min(Math.max(0, contentWidth - viewport.width), current + delta)))
      return
    }
    const lines = event.deltaMode === 1 ? event.deltaY : Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 100 * WHEEL_LINES))
    model.setTopLine(model.topLine + lines)
    dismissToolTip()
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
      if (!next || !marginDrag.current)
        return
      model.selectLine(next.lineNumber, true)
      // Above or below the viewport the view scrolls a line for each move, as long as there is more to show.
      const bounds = textAreaRef.current?.getBoundingClientRect()
      if (!bounds)
        return
      if (move.clientY <= bounds.top)
        model.scrollByLineAndMoveCaret('up')
      else if (move.clientY >= bounds.top + viewport.height) {
        const lastOnScreen = Math.min(model.lineCount, model.topLine + Math.ceil(viewport.height / lineHeight)) - 1
        if (lastOnScreen !== model.lineCount - 1 || model.topLine + model.viewportLines - 1 < model.lineCount - 1)
          model.scrollByLineAndMoveCaret('down')
      }
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
    void positionInfo(model.caretPosition).then((info) => {
      if (currentEditContext.current === editContext)
        setMenu({ ...at, editField: info?.editField ?? undefined })
    })
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
        position = formatter.toPhysicalPosition(result.value)
      else if (result.kind === 'current')
        position = origin + result.value
      else {
        // ToBufferPosition: through the PE headers of the file at the caret, the number itself without any.
        let resolved = Number.NaN
        try {
          if (structures)
            resolved = await structures.resolvePosition(origin, result.kind === 'rva' ? 'rva' : 'file', result.value)
        }
        catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError')
            return
        }
        position = Number.isFinite(resolved) ? resolved : result.value
      }
      if (currentEditContext.current !== editContext || !Number.isFinite(position) || position < 0)
        return
      position = Math.max(model.bufferStart, Math.min(model.bufferEnd, position))
      if (!result.selectToNewPosition) {
        revealPosition(position)
        return
      }
      // UserValueToSelection from the selection's start (or the caret) to the new position.
      const from = model.isSelectionEmpty ? origin : (model.anchorPoint < model.activePoint ? model.anchorPoint : model.anchorPoint - 1)
      revealPosition(position, from <= position
        ? { anchor: from, active: position + 1, moveCaret: true }
        : { anchor: from + 1, active: position, moveCaret: true })
    })()
  }

  const goToMetadata = (result: { kind: string; value: number }): void => {
    void (async () => {
      setDialog(undefined)
      focusView()
      if (!structures)
        return
      const range = await structures.goToMetadata(model.caretPosition, result.kind as HexMetadataKind, result.value).catch(() => null)
      if (!range)
        return
      // GoToMetadata: the caret at the item's start, nothing selected.
      revealPosition(range.offset)
    })()
  }
  const validateMetadata = useCallback(async (kind: string, value: number): Promise<boolean> => {
    if (!structures)
      return false
    try {
      const range = await structures.goToMetadata(model.caretPosition, kind as HexMetadataKind, value)
      return range !== null
    }
    catch {
      return false
    }
  }, [structures, model])

  const select = (result: { kind: string; start: number; end: number; mode: 'position' | 'length' }): void => {
    void (async () => {
      setDialog(undefined)
      focusView()
      // SelectionToUserValue: the start the dialog showed, which follows the anchor of a reversed selection.
      // dnSpy adds a Current Position value to that start's logical position.
      const origin = formatter.toLogicalPosition(model.isSelectionEmpty ? model.caretPosition : model.anchorPoint < model.activePoint ? model.anchorPoint : model.anchorPoint - 1)
      const toBuffer = async (value: number): Promise<number> => {
        if (result.kind === 'absolute')
          return formatter.toPhysicalPosition(value)
        if (result.kind === 'current')
          return origin + value
        let resolved = Number.NaN
        try {
          if (structures)
            resolved = await structures.resolvePosition(model.caretPosition, result.kind === 'rva' ? 'rva' : 'file', value)
        }
        catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError')
            return Number.NaN
        }
        return Number.isFinite(resolved) ? resolved : value
      }
      const start = await toBuffer(result.start)
      const end = result.mode === 'length' ? (result.end === 0 ? start : start + result.end - 1) : await toBuffer(result.end)
      if (currentEditContext.current !== editContext || !Number.isFinite(start) || !Number.isFinite(end) || Math.min(start, end) < 0)
        return
      // MoveTo: nothing happens unless the selection's ends and the caret are all in the view's bytes.
      const selection = start <= end ? { anchor: start, active: end + 1 } : { anchor: start + 1, active: end }
      if (!formatter.isValidPosition(selection.anchor) || !formatter.isValidPosition(selection.active) || !formatter.isValidPosition(end))
        return
      revealPosition(end, { ...selection, moveCaret: true })
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
              replaceReady={search.replaceReady}
              focusRequest={search.focusRequest}
              atBottom={searchAtBottom}
              controlRef={searchControlRef}
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
        {showVertical && <HexVerticalScrollBar topLine={topLine} maxTopLine={model.maxTopLine} viewportLines={model.viewportLines} onScroll={(line) => { model.setTopLine(line); dismissToolTip() }} />}
      </div>
      {showHorizontal && (
        <div className="hex-hscroll-row">
          {showZoomControl && <HexZoomControl zoom={zoom} onZoom={zoomTo} onDone={focusView} />}
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
      {saveProgress && (
        <HexSaveProgressDialog
          title={saveProgress.title}
          description={saveProgress.filePath}
          progress={saveProgress.total === 0 ? 1 : saveProgress.done / saveProgress.total}
          onCancel={() => { saveCancelled.current = true }}
        />
      )}
      {dialog?.kind === 'goToPosition' && <HexGoToPositionDialog initial={dialog.initial ?? 0} onAccept={goToPosition} onClose={() => { setDialog(undefined); focusView() }} />}
      {dialog?.kind === 'goToMetadata' && <HexGoToMetadataDialog initial={dialog.initial ?? 0} hasPeHeaders={dialog.hasPeHeaders !== false} validate={validateMetadata} onAccept={goToMetadata} onClose={() => { setDialog(undefined); focusView() }} />}
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
          validate={(text) => fillByteError(text, t)}
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
    else if (ctrl && !event.shiftKey && event.code === 'KeyF') handled(() => search.showFind(true))
    else if (ctrl && !event.shiftKey && event.code === 'KeyH') handled(() => search.showReplace(true))
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
const HexZoomControl = ({ zoom, onZoom, onDone }: { zoom: number; onZoom(value: number): void; onDone(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(`${zoom} %`)
  // OnLostKeyboardFocus forgets the zoom Escape goes back to; the box gets it again when it is focused.
  const original = useRef<number | undefined>(undefined)
  useEffect(() => setText(`${zoom} %`), [zoom])
  const parse = (value: string): number | undefined => {
    const level = Number.parseFloat(value.replace('%', '').trim())
    return Number.isFinite(level) && level >= zoomLevels[0] && level <= zoomLevels[zoomLevels.length - 1] ? level : undefined
  }
  const apply = (): void => {
    const value = parse(text)
    if (value !== undefined)
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
        onFocus={() => { original.current = zoom }}
        onChange={(event) => {
          setText(event.target.value)
          // OnSelectionChanged: a level picked from the list applies at once.
          const native = event.nativeEvent as InputEvent
          if (native.inputType === undefined || native.inputType === 'insertReplacementText') {
            const value = parse(event.target.value)
            if (value !== undefined && zoomLevels.includes(value))
              onZoom(value)
          }
        }}
        onBlur={() => { original.current = undefined; setText(`${zoom} %`) }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
            onDone()
          }
          else if (event.key === 'Escape') {
            event.preventDefault()
            if (original.current !== undefined)
              onZoom(original.current)
            setText(`${original.current ?? zoom} %`)
            onDone()
          }
        }}
      />
      <datalist id="hex-zoom-levels">{[...zoomLevels].reverse().map((level) => <option key={level} value={`${level} %`} />)}</datalist>
    </div>
  )
}

/**
 * dnSpy's VerticalScrollBarMargin: a bar over the lines — an arrow a line, the track a page, both repeating while
 * held, and the thumb's place in the track the top line's place in the bytes, however many lines there are.
 */
const HexVerticalScrollBar = ({ topLine, maxTopLine, viewportLines, onScroll }: { topLine: number; maxTopLine: number; viewportLines: number; onScroll(line: number): void }): React.JSX.Element => {
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackHeight, setTrackHeight] = useState(0)
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track)
      return
    const measure = (): void => setTrackHeight(track.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined')
      return
    const observer = new ResizeObserver(measure)
    observer.observe(track)
    return () => observer.disconnect()
  }, [])
  const latest = useRef({ topLine, maxTopLine, viewportLines, onScroll })
  latest.current = { topLine, maxTopLine, viewportLines, onScroll }
  const thumb = Math.min(trackHeight, Math.max(MIN_THUMB, trackHeight * viewportLines / Math.max(1, maxTopLine + viewportLines)))
  const thumbTop = maxTopLine === 0 ? 0 : (trackHeight - thumb) * topLine / maxTopLine
  const scrollTo = (line: number): void => {
    const { maxTopLine: max, onScroll: scroll } = latest.current
    scroll(Math.max(0, Math.min(max, Math.round(line))))
  }
  /** RepeatButton: the action at once, then again and again while the button stays down. */
  const repeat = (event: React.PointerEvent<HTMLElement>, action: () => boolean): void => {
    if (event.button !== 0)
      return
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    if (!action())
      return
    let interval: ReturnType<typeof setInterval> | undefined
    const delay = setTimeout(() => { interval = setInterval(() => { if (!action()) stop() }, REPEAT_INTERVAL) }, REPEAT_DELAY)
    const stop = (): void => {
      clearTimeout(delay)
      clearInterval(interval)
      target.removeEventListener('pointerup', stop)
      target.removeEventListener('pointercancel', stop)
    }
    target.addEventListener('pointerup', stop)
    target.addEventListener('pointercancel', stop)
  }
  const line = (delta: number) => (event: React.PointerEvent<HTMLElement>): void =>
    repeat(event, () => { scrollTo(latest.current.topLine + delta); return true })
  // The track pages towards the pointer until the thumb is under it.
  const onTrackDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget)
      return
    let pointerY = event.clientY
    const track = event.currentTarget
    const onMove = (move: PointerEvent): void => { pointerY = move.clientY }
    track.addEventListener('pointermove', onMove)
    const up = (): void => {
      track.removeEventListener('pointermove', onMove)
      track.removeEventListener('pointerup', up)
    }
    track.addEventListener('pointerup', up)
    repeat(event, () => {
      const { topLine: top, maxTopLine: max, viewportLines: page } = latest.current
      const bounds = track.getBoundingClientRect()
      const height = track.clientHeight
      const size = Math.min(height, Math.max(MIN_THUMB, height * page / Math.max(1, max + page)))
      const start = bounds.top + (max === 0 ? 0 : (height - size) * top / max)
      if (pointerY < start)
        scrollTo(top - page)
      else if (pointerY >= start + size)
        scrollTo(top + page)
      else
        return false
      return true
    })
  }
  const onThumbDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0)
      return
    event.preventDefault()
    const thumbElement = event.currentTarget
    thumbElement.setPointerCapture?.(event.pointerId)
    const startY = event.clientY
    const startTop = latest.current.topLine
    const onMove = (move: PointerEvent): void => {
      const { maxTopLine: max } = latest.current
      const free = trackHeight - thumb
      if (free > 0)
        scrollTo(startTop + (move.clientY - startY) / free * max)
    }
    const up = (): void => {
      thumbElement.removeEventListener('pointermove', onMove)
      thumbElement.removeEventListener('pointerup', up)
      thumbElement.removeEventListener('pointercancel', up)
    }
    thumbElement.addEventListener('pointermove', onMove)
    thumbElement.addEventListener('pointerup', up)
    thumbElement.addEventListener('pointercancel', up)
  }
  return (
    <div className="hex-vscroll" role="scrollbar" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={maxTopLine} aria-valuenow={topLine} aria-controls={undefined}>
      <button type="button" tabIndex={-1} className="hex-vscroll-arrow hex-vscroll-up" aria-label="Line up" disabled={topLine <= 0} onPointerDown={line(-1)} />
      <div ref={trackRef} className="hex-vscroll-track" onPointerDown={onTrackDown}>
        {maxTopLine > 0 && <div className="hex-vscroll-thumb" style={{ top: thumbTop, height: thumb }} onPointerDown={onThumbDown} />}
      </div>
      <button type="button" tabIndex={-1} className="hex-vscroll-arrow hex-vscroll-down" aria-label="Line down" disabled={topLine >= maxTopLine} onPointerDown={line(1)} />
    </div>
  )
}
