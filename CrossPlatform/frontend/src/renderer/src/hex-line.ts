/**
 * dnSpy's `HexBufferLineFormatterImpl` and `HexBufferLine`: how the bytes between a start and an end position are
 * cut into lines, and what one line is — a single string of offset, values and ASCII separated by one space,
 * with every cell's place in that string. The hex view draws the string and lays the caret, the selection and
 * every marker over it by character position, the way dnSpy's text-based hex view does.
 */
import {
  formatHexOffset,
  formatHexValue,
  hexValueFormatInfo,
  MAX_BYTES_PER_LINE,
  offsetTextLength,
  valueByteIndex,
  type HexOffsetFormatKind,
  type HexValuesFormat,
} from './hex-model'

/** A stretch of a line's text, as a start and an exclusive end. */
export interface TextSpan {
  start: number
  end: number
}

export type HexColumnType = 'offset' | 'values' | 'ascii'

/** dnSpy's `HexCell`: one value (or one ASCII character) of a line, and where it sits in the line's text. */
export interface HexCell {
  index: number
  groupIndex: 0 | 1
  /** Whether the line has the cell's bytes; the cells past the end of the last line are blank. */
  hasData: boolean
  /** Whether every byte of the cell could be read; one that could not is in the error colour (`DefaultTagger.IsValid`). */
  valid: boolean
  bufferStart: number
  bufferEnd: number
  /** The characters of the value, without the spaces it is padded with. */
  textSpan: TextSpan
  /** The cell, padding included. */
  cellSpan: TextSpan
  /** The space after a value cell, empty after the last one and after every ASCII cell. */
  separatorSpan: TextSpan
  fullSpan: TextSpan
}

/** dnSpy's `HexGroupInformation`: the cells of one group, with and without the separator that follows them. */
export interface HexGroupInformation {
  groupIndex: 0 | 1
  fullSpan: TextSpan
  span: TextSpan
}

export interface HexBufferLine {
  lineNumber: number
  bufferStart: number
  bufferEnd: number
  logicalOffset: number
  text: string
  valueCells: HexCell[]
  asciiCells: HexCell[]
  /** The values and ASCII text of the cells that have data. */
  visibleValuesSpan: TextSpan
  visibleAsciiSpan: TextSpan
}

export interface HexLineFormatterOptions {
  /** Characters a line may take, which "fit to width" (a `bytesPerLine` of 0) fills. */
  charsPerLine: number
  bytesPerLine: number
  groupSizeInBytes: number
  showOffset: boolean
  showValues: boolean
  showAscii: boolean
  offsetFormat: HexOffsetFormatKind
  startPosition: number
  endPosition: number
  basePosition: number
  useRelativePositions: boolean
  offsetLowerCaseHex: boolean
  valuesLowerCaseHex: boolean
  /** 0 picks the narrowest width that holds the first and the last logical offset. */
  offsetBitSize: number
  valuesFormat: HexValuesFormat
}

const DEFAULT_GROUP_SIZE_IN_BYTES = 8

/** What a character of a line is: dnSpy's `HexLinePositionInfo`. */
export type HexLinePositionInfo =
  | { type: 'offset'; position: number }
  | { type: 'valueCell'; position: number; cell: HexCell; cellPosition: number }
  | { type: 'valueCellSeparator'; position: number; cell: HexCell }
  | { type: 'asciiCell'; position: number; cell: HexCell; cellPosition: number }
  | { type: 'columnSeparator'; position: number }
  | { type: 'virtualSpace'; position: number }

/** dnSpy's `HexCellPosition`: a column, the byte the caret is on, and the character of the cell it is at. */
export interface HexCellPosition {
  column: 'values' | 'ascii'
  position: number
  cellPosition: number
}

const spanContains = (span: TextSpan, position: number): boolean => position >= span.start && position < span.end

/** A byte of the buffer, or -1 when it cannot be read: what a line's cells are formatted from. */
export type ReadByte = (position: number) => number

const offsetBitSizeOf = (logical: number): number => {
  if (logical <= 0xFF) return 8
  if (logical <= 0xFFFF) return 16
  if (logical <= 0xFFFFFF) return 24
  if (logical <= 0xFFFFFFFF) return 32
  if (logical <= 0xFF_FFFFFFFF) return 40
  if (logical <= 0xFFFF_FFFFFFFF) return 48
  if (logical <= 0xFFFFFF_FFFFFFFF) return 56
  return 64
}

export class HexLineFormatter {
  readonly options: HexLineFormatterOptions
  readonly bytesPerLine: number
  readonly groupSizeInBytes: number
  readonly offsetBitSize: number
  readonly charsPerLine: number
  readonly lineCount: number
  readonly offsetSpan: TextSpan
  readonly valuesSpan: TextSpan
  readonly asciiSpan: TextSpan
  readonly valuesGroup: HexGroupInformation[]
  readonly asciiGroup: HexGroupInformation[]
  readonly bytesPerValue: number
  readonly formattedValueLength: number
  readonly columnOrder: HexColumnType[] = ['offset', 'values', 'ascii']

  constructor(options: HexLineFormatterOptions) {
    this.options = options
    const info = hexValueFormatInfo(options.valuesFormat)
    this.bytesPerValue = info.byteCount
    this.formattedValueLength = info.formattedLength
    let bitSize = options.offsetBitSize
    if (bitSize === 0)
      bitSize = Math.max(offsetBitSizeOf(this.toLogicalPosition(options.startPosition)), offsetBitSizeOf(this.toLogicalPosition(options.endPosition > 0 ? options.endPosition - 1 : 0)))
    this.offsetBitSize = Math.ceil(bitSize / 4) * 4

    let bytesPerLine = options.bytesPerLine
    if (bytesPerLine === 0)
      bytesPerLine = this.calculateBytesPerLine(options.charsPerLine)
    if (bytesPerLine % info.byteCount !== 0)
      bytesPerLine = bytesPerLine - bytesPerLine % info.byteCount + info.byteCount
    if (bytesPerLine > MAX_BYTES_PER_LINE)
      bytesPerLine = Math.floor(MAX_BYTES_PER_LINE / info.byteCount) * info.byteCount
    this.bytesPerLine = Math.max(info.byteCount, bytesPerLine)

    let groupSize = options.groupSizeInBytes
    if (groupSize === 0)
      groupSize = DEFAULT_GROUP_SIZE_IN_BYTES
    if (groupSize > this.bytesPerLine)
      groupSize = this.bytesPerLine
    this.groupSizeInBytes = Math.ceil(groupSize / info.byteCount) * info.byteCount

    const totalBytes = Math.max(0, options.endPosition - options.startPosition)
    this.lineCount = totalBytes === 0 ? 1 : Math.ceil(totalBytes / this.bytesPerLine)

    // Column spans: offset, values and ASCII in that order, one space between the ones shown.
    let position = 0
    let needSeparator = false
    let offsetSpan: TextSpan = { start: 0, end: 0 }
    let valuesSpan: TextSpan = { start: 0, end: 0 }
    let asciiSpan: TextSpan = { start: 0, end: 0 }
    if (options.showOffset) {
      offsetSpan = { start: position, end: position + this.offsetLength }
      position = offsetSpan.end
      needSeparator = true
    }
    if (options.showValues) {
      if (needSeparator)
        position++
      const cellCount = this.bytesPerLine / info.byteCount
      valuesSpan = { start: position, end: position + info.formattedLength * cellCount + cellCount - 1 }
      position = valuesSpan.end
      needSeparator = true
    }
    if (options.showAscii) {
      if (needSeparator)
        position++
      asciiSpan = { start: position, end: position + this.bytesPerLine }
      position = asciiSpan.end
    }
    this.offsetSpan = offsetSpan
    this.valuesSpan = valuesSpan
    this.asciiSpan = asciiSpan
    this.charsPerLine = position
    this.valuesGroup = this.calculateValuesGroups()
    this.asciiGroup = this.calculateAsciiGroups()
  }

  get startPosition(): number { return this.options.startPosition }
  get endPosition(): number { return this.options.endPosition }
  get showOffset(): boolean { return this.options.showOffset }
  get showValues(): boolean { return this.options.showValues }
  get showAscii(): boolean { return this.options.showAscii }
  get valuesFormat(): HexValuesFormat { return this.options.valuesFormat }
  get valuesLowerCaseHex(): boolean { return this.options.valuesLowerCaseHex }

  private get offsetLength(): number {
    return offsetTextLength(this.offsetBitSize, this.options.offsetFormat)
  }

  /** `CalculateBytesPerLine`: the most value cells (and their ASCII) that fit the characters a line may take. */
  private calculateBytesPerLine(charsPerLine: number): number {
    const { showOffset, showValues, showAscii } = this.options
    const info = hexValueFormatInfo(this.options.valuesFormat)
    const columnCount = (showOffset ? 1 : 0) + (showValues ? 1 : 0) + (showAscii ? 1 : 0)
    if (columnCount === 0)
      return 1
    let fixedLength = columnCount - 1
    if (showOffset)
      fixedLength += this.offsetLength
    if (fixedLength >= charsPerLine)
      return showValues ? info.byteCount : 1
    const remaining = charsPerLine - fixedLength
    if (showValues && showAscii)
      return Math.max(1, Math.floor((remaining + 1) / (info.formattedLength + 1 + info.byteCount))) * info.byteCount
    if (showValues)
      return Math.max(1, Math.floor((remaining + 1) / (info.formattedLength + 1))) * info.byteCount
    if (showAscii)
      return Math.max(1, remaining)
    return 1
  }

  private calculateValuesGroups(): HexGroupInformation[] {
    const groups: HexGroupInformation[] = []
    if (!this.options.showValues)
      return groups
    let bytePosition = 0
    let position = 0
    let group0 = true
    while (bytePosition < this.bytesPerLine) {
      const groupByteEnd = bytePosition + this.groupSizeInBytes
      const groupStart = position
      let needSeparator = false
      while (bytePosition < this.bytesPerLine && bytePosition < groupByteEnd) {
        if (needSeparator)
          position++
        needSeparator = true
        position += this.formattedValueLength
        bytePosition += this.bytesPerValue
      }
      const span = { start: groupStart, end: position }
      let fullSpan = span
      if (bytePosition < this.bytesPerLine) {
        fullSpan = { start: span.start, end: span.end + 1 }
        position++
      }
      groups.push({ groupIndex: group0 ? 0 : 1, fullSpan: this.shift(fullSpan, this.valuesSpan.start), span: this.shift(span, this.valuesSpan.start) })
      group0 = !group0
    }
    return groups
  }

  private calculateAsciiGroups(): HexGroupInformation[] {
    const groups: HexGroupInformation[] = []
    if (!this.options.showAscii)
      return groups
    let position = 0
    let group0 = true
    while (position < this.bytesPerLine) {
      const groupStart = position
      position += Math.min(this.bytesPerLine - position, this.groupSizeInBytes)
      const span = this.shift({ start: groupStart, end: position }, this.asciiSpan.start)
      groups.push({ groupIndex: group0 ? 0 : 1, fullSpan: span, span })
      group0 = !group0
    }
    return groups
  }

  private shift(span: TextSpan, by: number): TextSpan {
    return { start: span.start + by, end: span.end + by }
  }

  toLogicalPosition(physical: number): number {
    return physical - (this.options.useRelativePositions ? this.options.startPosition : 0) + this.options.basePosition
  }

  toPhysicalPosition(logical: number): number {
    return logical - this.options.basePosition + (this.options.useRelativePositions ? this.options.startPosition : 0)
  }

  formatOffset(logical: number): string {
    return formatHexOffset(logical, this.offsetBitSize, this.options.offsetFormat, this.options.offsetLowerCaseHex)
  }

  /** `IsValidPosition`: a position inside the bytes the view shows, the end included. */
  isValidPosition(position: number): boolean {
    return position >= this.startPosition && position <= this.endPosition
  }

  /** `FilterAndVerify`: a position, kept off the end so it names a byte when the view has any. */
  filterAndVerify(position: number): number {
    if (position === this.endPosition && position > this.startPosition)
      return position - 1
    return Math.max(this.startPosition, Math.min(this.endPosition, position))
  }

  getLineNumber(position: number): number {
    return Math.floor((this.filterAndVerify(position) - this.startPosition) / this.bytesPerLine)
  }

  getLineStart(lineNumber: number): number {
    return this.startPosition + lineNumber * this.bytesPerLine
  }

  /** The line holding a position: its text and its cells, formatted from the bytes `readByte` answers. */
  getLine(position: number, readByte: ReadByte): HexBufferLine {
    const lineNumber = this.getLineNumber(position)
    const lineStart = this.getLineStart(lineNumber)
    const lineEnd = Math.min(lineStart + this.bytesPerLine, this.endPosition)
    const parts: string[] = []
    let textLength = 0
    const append = (text: string): void => {
      parts.push(text)
      textLength += text.length
    }
    let valueCells: HexCell[] = []
    let asciiCells: HexCell[] = []
    let visibleValuesSpan: TextSpan = { start: 0, end: 0 }
    let visibleAsciiSpan: TextSpan = { start: 0, end: 0 }
    let needSeparator = false
    if (this.options.showOffset) {
      append(this.formatOffset(this.toLogicalPosition(lineStart)))
      needSeparator = true
    }
    if (this.options.showValues) {
      if (needSeparator)
        append(' ')
      needSeparator = true
      const cellCount = this.bytesPerLine / this.bytesPerValue
      let visibleStart: number | undefined
      let visibleEnd: number | undefined
      for (let i = 0; i < cellCount; i++) {
        if (i !== 0)
          append(' ')
        const cellStart = textLength
        const position = lineStart + i * this.bytesPerValue
        const groupIndex = (Math.floor(i * this.bytesPerValue / this.groupSizeInBytes) & 1) as 0 | 1
        let spaces: number
        let hasData: boolean
        let valid = true
        if (position < lineEnd) {
          visibleStart ??= textLength
          const bytes: number[] = []
          for (let b = 0; b < this.bytesPerValue && position + b < this.endPosition; b++)
            bytes.push(readByte(position + b))
          valid = bytes.every((value) => value >= 0)
          const text = !valid
            ? '?'.repeat(this.formattedValueLength)
            : formatHexValue(Uint8Array.from(bytes), 0, this.options.valuesFormat, this.options.valuesLowerCaseHex)
          spaces = text.length - text.trimStart().length
          append(text)
          hasData = true
        }
        else {
          if (visibleStart !== undefined && visibleEnd === undefined)
            visibleEnd = textLength
          append(' '.repeat(this.formattedValueLength))
          spaces = this.formattedValueLength
          hasData = false
        }
        const separatorSpan = { start: textLength, end: textLength + (i + 1 < cellCount ? 1 : 0) }
        valueCells.push({
          index: i,
          groupIndex,
          hasData,
          valid,
          bufferStart: position,
          bufferEnd: hasData ? Math.min(this.endPosition, position + this.bytesPerValue) : position,
          textSpan: { start: cellStart + spaces, end: textLength },
          cellSpan: { start: cellStart, end: textLength },
          separatorSpan,
          fullSpan: { start: cellStart, end: separatorSpan.end },
        })
      }
      if (visibleStart !== undefined)
        visibleValuesSpan = { start: visibleStart, end: visibleEnd ?? textLength }
    }
    else
      valueCells = []
    if (this.options.showAscii) {
      if (needSeparator)
        append(' ')
      let visibleStart: number | undefined
      let visibleEnd: number | undefined
      for (let i = 0; i < this.bytesPerLine; i++) {
        const position = lineStart + i
        const cellStart = textLength
        const groupIndex = (Math.floor(i / this.groupSizeInBytes) & 1) as 0 | 1
        const hasData = position < lineEnd
        let valid = true
        if (hasData) {
          visibleStart ??= textLength
          const value = readByte(position)
          valid = value >= 0
          append(value < 0 ? '?' : value < 0x20 || value > 0x7E ? '.' : String.fromCharCode(value))
        }
        else {
          if (visibleStart !== undefined && visibleEnd === undefined)
            visibleEnd = textLength
          append(' ')
        }
        const cellSpan = { start: cellStart, end: textLength }
        asciiCells.push({
          index: i,
          groupIndex,
          hasData,
          valid,
          bufferStart: position,
          bufferEnd: hasData ? position + 1 : position,
          textSpan: cellSpan,
          cellSpan,
          separatorSpan: { start: cellSpan.end, end: cellSpan.end },
          fullSpan: cellSpan,
        })
      }
      if (visibleStart !== undefined)
        visibleAsciiSpan = { start: visibleStart, end: visibleEnd ?? textLength }
    }
    else
      asciiCells = []
    return {
      lineNumber,
      bufferStart: lineStart,
      bufferEnd: lineEnd,
      logicalOffset: this.toLogicalPosition(lineStart),
      text: parts.join(''),
      valueCells,
      asciiCells,
      visibleValuesSpan,
      visibleAsciiSpan,
    }
  }

  /** `GetCharsPerCellIncludingSeparator`. */
  charsPerCellIncludingSeparator(column: 'values' | 'ascii'): number {
    return column === 'values' ? this.formattedValueLength + 1 : 1
  }

  /** `HexBufferLineFormatter.GetValueBufferSpan`: the byte a character of a value cell edits. */
  valueBufferPosition(cell: HexCell, cellPosition: number): number {
    return cell.bufferStart + valueByteIndex(this.options.valuesFormat, cellPosition)
  }
}

/** `HexCellCollection.GetCell`: the cell of a line that has the byte at `position`. */
export function cellAt(cells: HexCell[], position: number): HexCell | undefined {
  for (const cell of cells) {
    if (cell.hasData && position >= cell.bufferStart && position < cell.bufferEnd)
      return cell
  }
  return undefined
}

/** `HexBufferLine.GetLinePositionInfo`: what the character at `linePosition` of a line is. */
export function linePositionInfo(formatter: HexLineFormatter, line: HexBufferLine, linePosition: number): HexLinePositionInfo {
  if (linePosition >= line.text.length)
    return { type: 'virtualSpace', position: linePosition }
  if (formatter.showOffset && spanContains(formatter.offsetSpan, linePosition))
    return { type: 'offset', position: linePosition }
  if (formatter.showValues && spanContains(formatter.valuesSpan, linePosition)) {
    const index = Math.floor((linePosition - formatter.valuesSpan.start) / formatter.charsPerCellIncludingSeparator('values'))
    const cell = line.valueCells[index]
    if (spanContains(cell.separatorSpan, linePosition))
      return { type: 'valueCellSeparator', position: linePosition, cell }
    return { type: 'valueCell', position: linePosition, cell, cellPosition: linePosition - cell.cellSpan.start }
  }
  if (formatter.showAscii && spanContains(formatter.asciiSpan, linePosition)) {
    const cell = line.asciiCells[linePosition - formatter.asciiSpan.start]
    return { type: 'asciiCell', position: linePosition, cell, cellPosition: 0 }
  }
  return { type: 'columnSeparator', position: linePosition }
}

const distanceTo = (linePosition: number, cell: HexCell): number =>
  Math.min(Math.abs(linePosition - cell.fullSpan.start), Math.abs(linePosition - (cell.fullSpan.end - 1)))

/** `HexBufferLine.GetClosestCellPosition`: the cell position a click at `linePosition` puts the caret on. */
export function closestCellPosition(formatter: HexLineFormatter, line: HexBufferLine, info: HexLinePositionInfo, onlyVisibleCells: boolean): HexCellPosition | undefined {
  let resolved: HexLinePositionInfo = info
  if (info.type === 'valueCellSeparator')
    resolved = { type: 'valueCell', position: info.cell.cellSpan.end - 1, cell: info.cell, cellPosition: info.cell.cellSpan.end - 1 - info.cell.cellSpan.start }
  else if (info.type === 'offset' || info.type === 'columnSeparator' || info.type === 'virtualSpace') {
    let closest: { column: 'values' | 'ascii'; cell: HexCell } | undefined
    let cellPosition = -1
    const candidates: { column: 'values' | 'ascii'; cell: HexCell }[] = [
      ...(formatter.showValues ? line.valueCells.map((cell) => ({ column: 'values' as const, cell })) : []),
      ...(formatter.showAscii ? line.asciiCells.map((cell) => ({ column: 'ascii' as const, cell })) : []),
    ]
    for (const candidate of candidates) {
      if (closest === undefined || distanceTo(info.position, candidate.cell) < distanceTo(info.position, closest.cell)) {
        closest = candidate
        cellPosition = Math.max(0, Math.min(candidate.cell.cellSpan.end - candidate.cell.cellSpan.start - 1, info.position - candidate.cell.cellSpan.start))
      }
    }
    if (!closest)
      return undefined
    const position = closest.cell.cellSpan.start + cellPosition
    resolved = closest.column === 'values'
      ? { type: 'valueCell', position, cell: closest.cell, cellPosition }
      : { type: 'asciiCell', position, cell: closest.cell, cellPosition }
  }
  if (resolved.type !== 'valueCell' && resolved.type !== 'asciiCell')
    return undefined
  const cells = resolved.type === 'valueCell' ? line.valueCells : line.asciiCells
  let cell = resolved.cell
  let cellPosition = resolved.cellPosition
  if (onlyVisibleCells && !cell.hasData) {
    const visible = visibleNeighbour(cells, cell)
    if (!visible)
      return undefined
    cell = visible.cell
    cellPosition = visible.cellPosition
  }
  if (resolved.type === 'asciiCell')
    return { column: 'ascii', position: cell.bufferStart, cellPosition }
  return { column: 'values', position: formatter.valueBufferPosition(cell, cellPosition), cellPosition }
}

const visibleNeighbour = (cells: HexCell[], cell: HexCell): { cell: HexCell; cellPosition: number } | undefined => {
  for (let i = cell.index + 1; i < cells.length; i++) {
    if (cells[i].hasData)
      return { cell: cells[i], cellPosition: 0 }
  }
  for (let i = cell.index - 1; i >= 0; i--) {
    if (cells[i].hasData)
      return { cell: cells[i], cellPosition: cells[i].cellSpan.end - cells[i].cellSpan.start - 1 }
  }
  return undefined
}

/**
 * `HexBufferLine.GetSpans` for a byte range: the text it covers on a line, a column at a time — from the first
 * cell holding one of its bytes to the last, the separators between them included (`Cell`), or with the last
 * cell's separator too (`includeSeparator`, dnSpy's full span).
 */
export function columnSpansOf(line: HexBufferLine, start: number, end: number, columns: { values: boolean; ascii: boolean }, includeSeparator = false): { column: 'values' | 'ascii'; span: TextSpan }[] {
  const result: { column: 'values' | 'ascii'; span: TextSpan }[] = []
  const lo = Math.max(start, line.bufferStart)
  const hi = Math.min(end, line.bufferEnd)
  if (lo >= hi)
    return result
  const add = (column: 'values' | 'ascii', cells: HexCell[]): void => {
    let textStart = Number.MAX_SAFE_INTEGER
    let textEnd = -1
    for (const cell of cells) {
      if (!cell.hasData || cell.bufferEnd <= lo || cell.bufferStart >= hi)
        continue
      const span = includeSeparator ? cell.fullSpan : cell.cellSpan
      textStart = Math.min(textStart, span.start)
      textEnd = Math.max(textEnd, span.end)
    }
    if (textEnd >= 0)
      result.push({ column, span: { start: textStart, end: textEnd } })
  }
  if (columns.values)
    add('values', line.valueCells)
  if (columns.ascii)
    add('ascii', line.asciiCells)
  return result
}

/** `HexBufferLine.GetText`: the line's text with the cells outside `start..end` blanked, which is what Copy Text
 * puts on the clipboard for each line of a selection. */
export function lineTextWithin(line: HexBufferLine, start: number, end: number): string {
  if (start <= line.bufferStart && end >= line.bufferEnd)
    return line.text
  const chars = line.text.split('')
  for (const cell of [...line.valueCells, ...line.asciiCells]) {
    if (!cell.hasData)
      continue
    if (cell.bufferStart >= start && cell.bufferEnd <= end)
      continue
    for (let i = cell.textSpan.start; i < cell.textSpan.end; i++)
      chars[i] = ' '
  }
  return chars.join('')
}
