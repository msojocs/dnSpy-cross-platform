import { buildClipboardHtml, type ColoredRun } from './document-viewer'
import { HexLineFormatter, lineTextWithin, type HexBufferLine, type HexCell, type ReadByte } from './hex-line'
import { CHUNK_SIZE, PAGE_SIZE, type HexChunkReader } from './hex-view-data'

/** `HexEditorOperationsImpl`'s limits: equal to the limit is still allowed. */
export const HEX_HTML_COPY_LIMIT = 1024 * 1024
export const HEX_TEXT_COPY_LIMIT = 10 * 1024 * 1024
export const HEX_COPY_TOO_MUCH_DATA = 'Too much data selected'

export interface HexClipboardColors {
  defaultText?: string
  offset?: string
  byte0?: string
  byte1?: string
  error?: string
  ascii?: string
}

export interface HexClipboardTextOptions {
  formatter: HexLineFormatter
  reader: HexChunkReader
  caretPosition: number
  selection?: { start: number; end: number }
  fontFamily: string
  fontSize: number
  colorize: boolean
  colors?: HexClipboardColors
}

/** The colours of `DefaultTagger`, using readability rather than the displayed '?' to identify an error. */
const lineRuns = (line: HexBufferLine, text: string, formatter: HexLineFormatter, readByte: ReadByte, colorize: boolean, colors: HexClipboardColors): ColoredRun[] => {
  const characters = new Array<string | undefined>(text.length).fill(colors.defaultText)
  const paint = (start: number, end: number, color: string | undefined): void => {
    for (let index = start; index < end && index < characters.length; index++)
      characters[index] = color ?? colors.defaultText
  }
  const unreadable = (cell: HexCell): boolean => {
    if (!cell.hasData)
      return false
    for (let position = cell.bufferStart; position < cell.bufferEnd; position++) {
      if (readByte(position) < 0)
        return true
    }
    return false
  }
  if (colorize) {
    if (formatter.showOffset)
      paint(formatter.offsetSpan.start, formatter.offsetSpan.end, colors.offset)
    for (const cell of line.valueCells)
      paint(cell.textSpan.start, cell.textSpan.end, unreadable(cell) ? colors.error : cell.groupIndex === 0 ? colors.byte0 : colors.byte1)
    for (const cell of line.asciiCells)
      paint(cell.cellSpan.start, cell.cellSpan.end, unreadable(cell) ? colors.error : colors.ascii)
  }
  const runs: ColoredRun[] = []
  for (let index = 0; index < text.length; index++) {
    const previous = runs[runs.length - 1]
    if (previous && previous.color === characters[index])
      previous.text += text[index]
    else
      runs.push({ text: text[index], color: characters[index] })
  }
  return runs
}

/**
 * `CopySelectionText`: selected lines with the other cells blanked, or the caret's line without a plain-text newline.
 * The caller supplies a snapshot of the view and reader; no later caret, option or source changes enter the copy.
 */
export const buildHexClipboardText = async (options: HexClipboardTextOptions): Promise<{ text: string; html?: string }> => {
  const formatter = new HexLineFormatter({ ...options.formatter.options })
  const { reader, fontFamily, fontSize, colorize } = options
  const colors = { ...options.colors }
  const selection = options.selection && options.selection.start !== options.selection.end
    ? { start: Math.min(options.selection.start, options.selection.end), end: Math.max(options.selection.start, options.selection.end) }
    : undefined
  const totalBytes = selection ? selection.end - selection.start : Math.min(formatter.bytesPerLine, formatter.endPosition - formatter.getLineStart(formatter.getLineNumber(options.caretPosition)))
  if (totalBytes > HEX_TEXT_COPY_LIMIT)
    return { text: HEX_COPY_TOO_MUCH_DATA }

  const firstLine = formatter.getLineNumber(selection?.start ?? options.caretPosition)
  const lastLine = selection ? formatter.getLineNumber(Math.max(selection.start, selection.end - 1)) : firstLine
  const start = formatter.getLineStart(firstLine)
  const end = Math.min(formatter.endPosition, formatter.getLineStart(lastLine) + formatter.bytesPerLine)
  const chunks = new Map<number, Awaited<ReturnType<HexChunkReader>>>()
  // Read at most once per chunk, rather than one RPC per displayed line. Alignment also keeps page masks unambiguous.
  for (let offset = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE; offset < end; offset += CHUNK_SIZE)
    chunks.set(offset, await reader(offset, Math.min(CHUNK_SIZE, formatter.endPosition - offset)))
  const readByte: ReadByte = (position) => {
    const offset = Math.floor(position / CHUNK_SIZE) * CHUNK_SIZE
    const chunk = chunks.get(offset)
    const page = Math.floor(position / PAGE_SIZE) - Math.floor(offset / PAGE_SIZE)
    if (!chunk || chunk.readable?.[page] === false)
      return -1
    return chunk.bytes[position - offset] ?? -1
  }

  const textLines: string[] = []
  const htmlLines: ColoredRun[][] | undefined = totalBytes <= HEX_HTML_COPY_LIMIT ? [] : undefined
  for (let index = firstLine; index <= lastLine; index++) {
    const line = formatter.getLine(formatter.getLineStart(index), readByte)
    const text = selection ? lineTextWithin(line, selection.start, selection.end) : line.text
    textLines.push(selection ? `${text}\n` : text)
    htmlLines?.push(lineRuns(line, text, formatter, readByte, colorize, colors))
  }
  // HexHtmlBuilder writes <br/> after every line, including an unselected current line.
  htmlLines?.push([])
  return {
    text: textLines.join(''),
    html: htmlLines ? buildClipboardHtml(htmlLines, fontFamily, fontSize, 4) : undefined,
  }
}
