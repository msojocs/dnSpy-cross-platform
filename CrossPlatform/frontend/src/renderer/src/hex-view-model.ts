/**
 * The caret, the selection and the viewport of a hex view, and the editor operations that move them — dnSpy's
 * `HexCaretImpl`, `HexSelectionImpl` and the navigation half of `HexEditorOperationsImpl`, kept free of React so
 * they can be tested on their own. Lines are all one height, so the viewport is a first line and a line count.
 */
import { cellAt, closestCellPosition, linePositionInfo, type HexBufferLine, type HexCell, type HexCellPosition, type HexLineFormatter } from './hex-line'

export type HexColumn = 'values' | 'ascii'

/** dnSpy's `HexColumnPosition`: the active column and where the caret is in each column. */
export interface HexCaretPosition {
  activeColumn: HexColumn
  valuePosition: HexCellPosition
  asciiPosition: HexCellPosition
}

/** A layout-only line: the cells of a line without the bytes they show. */
const layoutLine = (formatter: HexLineFormatter, position: number): HexBufferLine => formatter.getLine(position, () => 0)

export class HexViewModel {
  formatter: HexLineFormatter
  caret: HexCaretPosition
  anchorPoint: number
  activePoint: number
  /** The first line in the viewport. */
  topLine = 0
  /** The lines the viewport holds whole. */
  viewportLines = 1
  overwriteMode = true
  /** Where on the line, in characters, the caret wants to be when it moves up or down — `preferredXCoordinate`. */
  private preferredLinePosition: number | undefined
  /** The caret line's place in the viewport, which paging keeps — `preferredYCoordinate`. */
  private preferredViewportLine = 0
  private readonly listeners = new Set<() => void>()

  constructor(formatter: HexLineFormatter) {
    this.formatter = formatter
    const start = formatter.startPosition
    this.caret = { activeColumn: formatter.showValues || !formatter.showAscii ? 'values' : 'ascii', valuePosition: { column: 'values', position: start, cellPosition: 0 }, asciiPosition: { column: 'ascii', position: start, cellPosition: 0 } }
    this.anchorPoint = start
    this.activePoint = start
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners)
      listener()
  }

  // ---- Positions ----------------------------------------------------------------------------------------

  get bufferStart(): number { return this.formatter.startPosition }
  get bufferEnd(): number { return this.formatter.endPosition }
  get lineCount(): number { return this.formatter.lineCount }
  get maxTopLine(): number { return Math.max(0, this.lineCount - 1) }

  /** The caret's active position — `Caret.Position.Position.ActivePosition`. */
  get activePosition(): HexCellPosition {
    return this.caret.activeColumn === 'values' ? this.caret.valuePosition : this.caret.asciiPosition
  }

  /** The byte the caret is on — `ActiveCaretBufferPosition`. */
  get caretPosition(): number { return this.activePosition.position }

  get isSelectionEmpty(): boolean { return this.anchorPoint === this.activePoint }
  get selectionStart(): number { return Math.min(this.anchorPoint, this.activePoint) }
  get selectionEnd(): number { return Math.max(this.anchorPoint, this.activePoint) }
  get isSelectionReversed(): boolean { return this.activePoint < this.anchorPoint }

  get caretLine(): number { return this.formatter.getLineNumber(this.caretPosition) }

  /** Whether the caret line is fully in the viewport. */
  isLineVisible(line: number): boolean { return line >= this.topLine && line < this.topLine + this.viewportLines }

  line(position: number): HexBufferLine { return layoutLine(this.formatter, position) }

  // ---- Formatter and viewport ---------------------------------------------------------------------------

  /** New line options: the caret and the selection keep their bytes, clipped to the new range (`BufferLinesChanged`). */
  setFormatter(formatter: HexLineFormatter): void {
    const firstVisible = this.formatter.getLineStart(this.topLine)
    this.formatter = formatter
    const filter = (position: number): number => Math.max(formatter.startPosition, Math.min(formatter.endPosition, position))
    this.anchorPoint = filter(this.anchorPoint)
    this.activePoint = filter(this.activePoint)
    this.caret = this.updatedCaretPosition()
    this.topLine = Math.min(this.maxTopLine, formatter.getLineNumber(filter(firstVisible)))
    // A new layout moves the characters (a wider offset column, another value format), so the column the caret
    // keeps going up and down in is taken again from where the caret is now.
    this.capturePreferredLinePosition()
    this.changed()
  }

  /**
   * `HexCaretImpl.GetUpdatedCaretPosition`: the caret's byte in the new lines, in the other column when its own has
   * no cell there (a column that is no longer shown), kept as it was when both cells still hold it.
   */
  private updatedCaretPosition(): HexCaretPosition {
    const formatter = this.formatter
    const start = formatter.startPosition
    if ((!formatter.showValues && !formatter.showAscii) || formatter.endPosition === start)
      return { activeColumn: 'values', valuePosition: { column: 'values', position: start, cellPosition: 0 }, asciiPosition: { column: 'ascii', position: start, cellPosition: 0 } }
    // The ASCII position is the byte itself, which a value cell's start is not.
    const position = Math.max(start, Math.min(formatter.endPosition, this.caret.asciiPosition.position))
    const line = this.line(position)
    const valueCell = cellAt(line.valueCells, position)
    const asciiCell = cellAt(line.asciiCells, position)
    let activeColumn = this.caret.activeColumn
    if (activeColumn === 'values' && !valueCell)
      activeColumn = 'ascii'
    else if (activeColumn === 'ascii' && !asciiCell)
      activeColumn = 'values'
    const valuePosition: HexCellPosition = { column: 'values', position: valueCell ? valueCell.bufferStart : start, cellPosition: 0 }
    const asciiPosition: HexCellPosition = { column: 'ascii', position: asciiCell ? (valueCell?.bufferStart ?? asciiCell.bufferStart) : start, cellPosition: 0 }
    const canReUse = (old: HexCellPosition, cell: HexCell | undefined): boolean => cell !== undefined && old.position >= cell.bufferStart && old.position < cell.bufferEnd
    if (canReUse(this.caret.valuePosition, valueCell) && canReUse(this.caret.asciiPosition, asciiCell)) {
      // The character in the cell stays, on a cell that may now be narrower.
      const width = valueCell!.cellSpan.end - valueCell!.cellSpan.start
      return { ...this.caret, valuePosition: { ...this.caret.valuePosition, cellPosition: Math.min(width - 1, this.caret.valuePosition.cellPosition) } }
    }
    return { activeColumn, valuePosition, asciiPosition }
  }

  setViewportLines(count: number): void {
    const lines = Math.max(1, count)
    if (lines === this.viewportLines)
      return
    this.viewportLines = lines
    this.changed()
  }

  setTopLine(line: number): void {
    const top = Math.max(0, Math.min(this.maxTopLine, Math.floor(line)))
    if (top === this.topLine)
      return
    this.topLine = top
    this.changed()
  }

  /** `DisplayHexLineContainingBufferPosition` with a distance of whole lines. */
  displayLineContaining(position: number, relativeTo: 'top' | 'bottom', distanceLines = 0): void {
    const line = this.formatter.getLineNumber(position)
    this.setTopLine(relativeTo === 'top' ? line - distanceLines : line - this.viewportLines + 1 + distanceLines)
  }

  /** `HexCaret.EnsureVisible`, vertically: a caret line outside the viewport is brought to its nearest edge. */
  ensureCaretVisible(): void {
    const line = this.caretLine
    if (this.isLineVisible(line))
      return
    this.displayLineContaining(this.caretPosition, line <= this.topLine ? 'top' : 'bottom')
  }

  /** `HexViewScroller.EnsureSpanVisible`, vertically: a span that is not in view is centered. */
  ensureSpanVisible(start: number, end: number, showStart = true, minimumScroll = false): void {
    const first = this.formatter.getLineNumber(start)
    const last = this.formatter.getLineNumber(end > start ? end - 1 : end)
    const inView = first >= this.topLine && last < this.topLine + this.viewportLines
    if (!inView) {
      if (minimumScroll && last - first + 1 <= this.viewportLines) {
        if (first < this.topLine)
          this.setTopLine(first)
        else
          this.setTopLine(last - this.viewportLines + 1)
        return
      }
      const height = last - first + 1
      const centered = height >= this.viewportLines ? first : first - Math.floor((this.viewportLines - height) / 2)
      this.setTopLine(showStart || height < this.viewportLines ? centered : last - this.viewportLines + 1)
    }
  }

  // ---- The caret ----------------------------------------------------------------------------------------

  private setCaretCore(position: HexCaretPosition): void {
    const filter = (cell: HexCellPosition): HexCellPosition => ({ ...cell, position: this.formatter.filterAndVerify(cell.position) })
    this.caret = { activeColumn: position.activeColumn, valuePosition: filter(position.valuePosition), asciiPosition: filter(position.asciiPosition) }
  }

  /** `CreateValuesCellPosition`: the start of the value cell that has a byte. */
  private valuesCellPosition(position: number): HexCellPosition {
    const cell = cellAt(this.line(position).valueCells, position)
    return { column: 'values', position: cell ? cell.bufferStart : position, cellPosition: 0 }
  }

  /** `CreateColumnPosition`: both columns' positions for a position in one of them. */
  private createColumnPosition(position: HexCellPosition, column: HexColumn = position.column): HexCaretPosition {
    if (position.column === 'values')
      return { activeColumn: column, valuePosition: position, asciiPosition: { column: 'ascii', position: position.position, cellPosition: 0 } }
    return { activeColumn: column, valuePosition: this.valuesCellPosition(position.position), asciiPosition: position }
  }

  private capturePreferredLinePosition(): void {
    const line = this.line(this.caretPosition)
    const cells = this.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells
    const cell = cellAt(cells, this.caretPosition)
    // SavePreferredXCoordinate: the middle of the caret's character.
    this.preferredLinePosition = cell ? cell.cellSpan.start + this.activePosition.cellPosition + 0.5 : undefined
  }

  private capturePreferredViewportLine(): void {
    this.preferredViewportLine = Math.max(0, Math.min(this.viewportLines - 1, this.caretLine - this.topLine))
  }

  /** `HexCaret.MoveTo(HexCellPosition)`. */
  moveCaretToCell(position: HexCellPosition, captureHorizontal = true): void {
    this.setCaretCore(this.createColumnPosition(position))
    if (captureHorizontal)
      this.capturePreferredLinePosition()
    this.capturePreferredViewportLine()
    this.changed()
  }

  /** `HexCaret.MoveTo(HexColumnType, HexBufferPoint)`: the column keeps the caret, a values caret at its cell start. */
  moveCaretTo(position: number, column: HexColumn = this.caret.activeColumn): void {
    const cell = column === 'values' ? this.valuesCellPosition(position) : { column: 'ascii' as const, position, cellPosition: 0 }
    this.setCaretCore(this.createColumnPosition(cell, column))
    this.capturePreferredLinePosition()
    this.capturePreferredViewportLine()
    this.changed()
  }

  /** `HexCaret.MoveTo(HexBufferPoint)` as the operations use it: the active column, at the position. */
  private moveCaretToPosition(position: number): void {
    this.moveCaretTo(position, this.caret.activeColumn)
  }

  /**
   * `HexCaret.MoveTo(HexViewLine, xCoordinate)`: the cell closest to a point of a line, `x` in characters from the
   * line's start. A point on the space between two values goes to the value on its nearer side.
   */
  moveCaretToLinePosition(lineNumber: number, x: number | undefined, captureHorizontal: boolean, captureVertical = true): void {
    const line = this.line(this.formatter.getLineStart(Math.max(0, Math.min(this.lineCount - 1, lineNumber))))
    let position: HexCellPosition | undefined
    if (x === undefined)
      position = { column: this.caret.activeColumn, position: line.bufferStart, cellPosition: 0 }
    else {
      let info = linePositionInfo(this.formatter, line, Math.max(0, Math.floor(x)))
      if (info.type === 'valueCellSeparator') {
        const insertion = linePositionInfo(this.formatter, line, Math.max(0, Math.round(x)))
        if (insertion.type === 'valueCell')
          info = insertion
      }
      position = closestCellPosition(this.formatter, line, info, true)
    }
    position ??= { column: this.caret.activeColumn, position: line.bufferStart, cellPosition: 0 }
    this.setCaretCore(this.createColumnPosition(position))
    if (captureHorizontal)
      this.capturePreferredLinePosition()
    if (captureVertical)
      this.capturePreferredViewportLine()
    this.changed()
  }

  /** `HexCaret.MoveTo(HexViewLine)`: a line, at the character the caret last chose. */
  private moveCaretToLine(lineNumber: number): void {
    this.moveCaretToLinePosition(lineNumber, this.preferredLinePosition, false)
  }

  /** `HexCaret.MoveToPreferredCoordinates`: the line at the caret's place in the viewport. */
  private moveCaretToPreferredCoordinates(): void {
    this.moveCaretToLinePosition(Math.min(this.lineCount - 1, this.topLine + this.preferredViewportLine), this.preferredLinePosition, false, false)
  }

  /** `HexCaret.ToggleActiveColumn`. */
  toggleColumn(): void {
    if (!(this.formatter.showValues && this.formatter.showAscii))
      return
    this.caret = { ...this.caret, activeColumn: this.caret.activeColumn === 'values' ? 'ascii' : 'values' }
    this.capturePreferredLinePosition()
    this.ensureCaretVisible()
    this.changed()
  }

  /** `MoveToNextCaretPosition`: the next character of the cell, then the next cell. */
  private moveToNextCaretPosition(): void {
    const position = this.activePosition
    const line = this.line(position.position)
    const cell = cellAt(this.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, position.position)
    if (!cell)
      return
    const cellPosition = position.cellPosition + 1
    if (cellPosition < cell.cellSpan.end - cell.cellSpan.start) {
      this.moveCaretToCell({ ...position, cellPosition })
      return
    }
    const next = cell.bufferEnd
    if (!this.formatter.isValidPosition(next) || next === this.bufferEnd)
      return
    this.moveCaretToCell({ ...position, position: next, cellPosition: 0 })
  }

  /** `MoveToPreviousCaretPosition`: the previous character, then the last character of the previous cell. */
  private moveToPreviousCaretPosition(): void {
    const position = this.activePosition
    const line = this.line(position.position)
    const cell = cellAt(this.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, position.position)
    if (!cell)
      return
    const cellPosition = position.cellPosition - 1
    if (cellPosition >= 0) {
      this.moveCaretToCell({ ...position, cellPosition })
      return
    }
    if (cell.bufferStart === 0)
      return
    const previous = cell.bufferStart - 1
    if (!this.formatter.isValidPosition(previous))
      return
    if (this.caret.activeColumn === 'values') {
      const previousCell = cellAt(this.line(previous).valueCells, previous)
      this.moveCaretToCell({ column: 'values', position: previous, cellPosition: previousCell ? previousCell.cellSpan.end - previousCell.cellSpan.start - 1 : 0 })
    }
    else
      this.moveCaretToCell({ column: 'ascii', position: previous, cellPosition: 0 })
  }

  // ---- The selection ------------------------------------------------------------------------------------

  /** `HexSelection.Select`, with dnSpy's alignment of the points to whole value cells. */
  select(anchorPoint: number, activePoint: number, alignPoints: boolean): void {
    if (anchorPoint === activePoint) {
      this.clearSelection()
      return
    }
    let anchor = anchorPoint
    let active = activePoint
    if (alignPoints && this.caret.activeColumn === 'values' && this.formatter.bytesPerValue !== 1) {
      const cellOf = (position: number): HexCell | undefined => {
        const line = this.line(position)
        let cell = cellAt(line.valueCells, position)
        if (!cell && position === line.bufferEnd && position > line.bufferStart)
          cell = cellAt(line.valueCells, position - 1)
        return cell
      }
      if (anchor < active) {
        const anchorCell = cellOf(anchor)
        const activeCell = cellOf(active - 1)
        if (anchorCell && activeCell) {
          anchor = anchorCell.bufferStart
          active = activeCell.bufferEnd
        }
      }
      else {
        const activeCell = cellOf(active)
        const anchorCell = cellOf(anchor - 1)
        if (anchorCell && activeCell) {
          active = activeCell.bufferStart
          anchor = anchorCell.bufferEnd
        }
      }
    }
    this.anchorPoint = anchor
    this.activePoint = active
    this.changed()
  }

  clearSelection(): void {
    if (this.anchorPoint === this.activePoint)
      return
    this.anchorPoint = this.activePoint
    this.changed()
  }

  /** `GetSelectionOrCaretIfNoSelection`'s anchor: where an extended selection starts from. */
  private anchorPositionOrCaret(): number {
    if (!this.isSelectionEmpty)
      return this.anchorPoint > this.activePoint ? this.anchorPoint - 1 : this.anchorPoint
    return this.caretPosition
  }

  private tryInc(position: number): number {
    return position === this.bufferEnd ? position : position + 1
  }

  /** `SelectToCaret`. */
  private selectToCaret(anchorPoint: number): void {
    const caret = this.caretPosition
    if (caret < anchorPoint)
      this.select(this.tryInc(anchorPoint), caret, true)
    else
      this.select(anchorPoint, this.tryInc(caret), true)
  }

  private afterMove(anchorPoint: number, extendSelection: boolean): void {
    this.ensureCaretVisible()
    if (extendSelection)
      this.selectToCaret(anchorPoint)
    else
      this.clearSelection()
    this.changed()
  }

  /** `MoveCaretToSelection`. */
  private moveCaretToSelection(anchorPoint: number, activePoint: number): void {
    this.moveCaretToPosition(activePoint <= anchorPoint ? activePoint : activePoint - 1)
  }

  // ---- HexEditorOperations ------------------------------------------------------------------------------

  moveToNextCharacter(extendSelection: boolean): void {
    if (!extendSelection && !this.isSelectionEmpty) {
      const end = this.selectionEnd - 1
      if (this.caretPosition !== end)
        this.moveCaretToPosition(end)
      this.ensureCaretVisible()
      this.clearSelection()
      return
    }
    const anchor = this.anchorPositionOrCaret()
    this.moveToNextCaretPosition()
    this.afterMove(anchor, extendSelection)
  }

  moveToPreviousCharacter(extendSelection: boolean): void {
    if (!extendSelection && !this.isSelectionEmpty) {
      if (this.caretPosition !== this.selectionStart)
        this.moveCaretToPosition(this.selectionStart)
      this.ensureCaretVisible()
      this.clearSelection()
      return
    }
    const anchor = this.anchorPositionOrCaret()
    this.moveToPreviousCaretPosition()
    this.afterMove(anchor, extendSelection)
  }

  moveToNextWord(extendSelection: boolean): void {
    if (this.caret.activeColumn === 'ascii') {
      this.moveToNextCharacter(extendSelection)
      return
    }
    const position = this.formatter.filterAndVerify(this.caretPosition)
    const cell = cellAt(this.line(position).valueCells, position)
    if (!cell)
      return
    const anchor = this.anchorPositionOrCaret()
    if (cell.bufferEnd >= this.bufferEnd)
      return
    this.moveCaretToPosition(cell.bufferEnd)
    this.afterMove(anchor, extendSelection)
  }

  moveToPreviousWord(extendSelection: boolean): void {
    if (this.caret.activeColumn === 'ascii') {
      this.moveToPreviousCharacter(extendSelection)
      return
    }
    const anchor = this.anchorPositionOrCaret()
    if (this.activePosition.cellPosition !== 0)
      this.moveCaretToPosition(this.caretPosition)
    else {
      const position = this.formatter.filterAndVerify(this.caretPosition)
      const cell = cellAt(this.line(position).valueCells, position)
      if (!cell)
        return
      if (cell.bufferStart <= this.bufferStart)
        return
      this.moveCaretToPosition(cell.bufferStart - 1)
    }
    this.afterMove(anchor, extendSelection)
  }

  moveLineUp(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const line = extendSelection || this.isSelectionEmpty ? this.caretLine : this.formatter.getLineNumber(this.selectionStart)
    this.moveCaretToLine(line <= 0 ? line : line - 1)
    this.afterMove(anchor, extendSelection)
  }

  moveLineDown(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const line = extendSelection || this.isSelectionEmpty ? this.caretLine : this.formatter.getLineNumber(this.selectionEnd)
    this.moveCaretToLine(line >= this.lineCount - 1 ? line : line + 1)
    this.afterMove(anchor, extendSelection)
  }

  pageUp(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const caretVisible = this.isLineVisible(this.caretLine)
    if (this.topLine > 0) {
      this.setTopLine(this.topLine - this.viewportLines)
      if (this.topLine === 0 && this.isLineVisible(this.caretLine) === caretVisible)
        this.moveCaretToLine(0)
      else
        this.moveCaretToPreferredCoordinates()
    }
    else
      this.moveCaretToLine(this.topLine)
    this.afterMove(anchor, extendSelection)
  }

  pageDown(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const lastVisible = Math.min(this.lineCount - 1, this.topLine + this.viewportLines - 1)
    const lastIsLastDocumentLine = lastVisible === this.lineCount - 1
    if (!lastIsLastDocumentLine) {
      this.setTopLine(this.topLine + this.viewportLines)
      this.moveCaretToPreferredCoordinates()
    }
    else
      this.moveCaretToLine(lastVisible)
    this.afterMove(anchor, extendSelection)
  }

  moveToEndOfLine(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const line = this.line(this.caretPosition)
    if (line.bufferEnd > line.bufferStart)
      this.moveCaretToPosition(line.bufferEnd - 1)
    this.afterMove(anchor, extendSelection)
  }

  moveToStartOfLine(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.moveCaretToPosition(this.line(this.caretPosition).bufferStart)
    this.afterMove(anchor, extendSelection)
  }

  moveToStartOfDocument(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.displayLineContaining(this.bufferStart, 'top')
    this.moveCaretToPosition(this.bufferStart)
    this.afterMove(anchor, extendSelection)
  }

  moveToEndOfDocument(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    const end = this.bufferEnd
    if (!this.isLineVisible(this.formatter.getLineNumber(end)))
      this.displayLineContaining(end, 'bottom')
    this.moveCaretToPosition(end)
    this.afterMove(anchor, extendSelection)
  }

  moveToTopOfView(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.moveCaretToLine(this.topLine)
    this.afterMove(anchor, extendSelection)
  }

  moveToBottomOfView(extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.moveCaretToLine(Math.min(this.lineCount - 1, this.topLine + this.viewportLines - 1))
    this.afterMove(anchor, extendSelection)
  }

  moveCurrentLineToTop(): void { this.displayLineContaining(this.caretPosition, 'top') }
  moveCurrentLineToBottom(): void { this.displayLineContaining(this.caretPosition, 'bottom') }

  scrollLineCenter(): void {
    this.ensureCaretVisible()
    this.setTopLine(this.caretLine - Math.floor((this.viewportLines - 1) / 2))
  }

  /** `ScrollUpAndMoveCaretIfNecessary` / `ScrollDownAndMoveCaretIfNecessary`: Ctrl+Up and Ctrl+Down. */
  scrollByLineAndMoveCaret(direction: 'up' | 'down'): void {
    const before = this.caretPosition
    const caretLine = this.caretLine
    this.setTopLine(this.topLine + (direction === 'up' ? -1 : 1))
    if (!this.isLineVisible(caretLine)) {
      if (direction === 'up') {
        let line = Math.min(this.lineCount - 1, this.topLine + this.viewportLines - 1)
        if (line === caretLine && line > 0)
          line--
        this.moveCaretToLine(line)
      }
      else {
        let line = this.topLine
        if (line === caretLine && line < this.lineCount - 1)
          line++
        this.moveCaretToLine(line)
      }
    }
    this.ensureCaretVisible()
    if (this.caretPosition !== before)
      this.clearSelection()
    this.changed()
  }

  scrollPage(direction: 'up' | 'down'): void {
    this.setTopLine(this.topLine + (direction === 'up' ? -this.viewportLines : this.viewportLines))
  }

  swapCaretAndAnchor(): void {
    const anchor = this.anchorPoint
    this.anchorPoint = this.activePoint
    this.activePoint = anchor
    this.moveCaretToSelection(this.anchorPoint, this.activePoint)
    this.ensureCaretVisible()
    this.changed()
  }

  /** `SelectAndMove`: select a span and put the caret on its last byte. */
  selectAndMove(start: number, end: number, alignPoints = false): void {
    this.select(start, end, alignPoints)
    this.moveCaretToSelection(start, end)
    this.ensureCaretVisible()
    this.changed()
  }

  selectCurrentWord(): void {
    if (this.bufferEnd === this.bufferStart)
      return
    const position = this.formatter.filterAndVerify(this.caretPosition)
    if (this.caret.activeColumn === 'values') {
      const cell = cellAt(this.line(position).valueCells, position)
      if (!cell)
        return
      this.selectAndMove(cell.bufferStart, cell.bufferEnd)
    }
    else
      this.selectAndMove(position, position + 1)
  }

  selectAll(): void {
    this.selectAndMove(this.bufferStart, this.bufferEnd)
  }

  /** `SelectLine`: the whole line, extended from the line the selection started on. */
  selectLine(lineNumber: number, extendSelection: boolean): void {
    const line = this.line(this.formatter.getLineStart(lineNumber))
    let anchor: number
    let active: number
    if (this.isSelectionEmpty || !extendSelection) {
      anchor = line.bufferStart
      active = line.bufferEnd
    }
    else {
      // SelectionUtilities.GetLineAnchorSpan: the line the anchor point is on.
      const anchorLine = this.line(this.isSelectionReversed ? Math.max(this.bufferStart, this.anchorPoint - 1) : this.anchorPoint)
      if (anchorLine.bufferStart <= line.bufferStart) {
        anchor = anchorLine.bufferStart
        active = line.bufferEnd
      }
      else {
        anchor = anchorLine.bufferEnd
        active = line.bufferStart
      }
    }
    this.select(anchor, active, true)
    this.moveCaretToPosition(Math.min(this.formatter.filterAndVerify(active), active))
    this.ensureCaretVisible()
    this.changed()
  }

  /** `SelectAndMoveCaret`: a span selected with the caret at its active end, scrolled into view. */
  selectAndMoveCaret(anchorPoint: number, activePoint: number, alignPoints = false): void {
    if (anchorPoint === activePoint)
      this.clearSelection()
    else
      this.select(anchorPoint, activePoint, alignPoints)
    this.moveCaretToSelection(anchorPoint, activePoint)
    if (activePoint > anchorPoint)
      this.ensureSpanVisible(anchorPoint, activePoint, false, this.isSelectionReversed)
    else
      this.ensureSpanVisible(activePoint, anchorPoint, true, this.isSelectionReversed)
    this.changed()
  }

  /** `MoveCaret(HexViewLine, x, extendSelection)`: a click, Shift extending the selection. */
  moveCaretByMouse(lineNumber: number, x: number, extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.moveCaretToLinePosition(lineNumber, x, true)
    if (extendSelection)
      this.selectToCaret(anchor)
    else
      this.clearSelection()
    this.changed()
  }

  /** `MoveToValidStartEnd`: the caret to a position the view's range is clipped to, the selection extended or cleared. */
  moveToValidStartEnd(position: number, extendSelection: boolean): void {
    const anchor = this.anchorPositionOrCaret()
    this.moveCaretToPosition(Math.max(this.bufferStart, Math.min(this.bufferEnd, position)))
    this.afterMove(anchor, extendSelection)
  }

  /** `SelectCore`: a span selected and the caret on its last byte, clipped to the visible bytes. */
  selectSpan(start: number, end: number): void {
    const lo = Math.max(this.bufferStart, start)
    const hi = Math.min(this.bufferEnd, end)
    this.select(lo, Math.max(lo, hi), false)
    this.moveCaretToPosition(hi - lo === 0 ? lo : hi - 1)
    this.ensureCaretVisible()
    this.changed()
  }

  /** Where a caret moved by an edit lands: after the bytes written, on the last byte at most. */
  moveCaretAfterWrite(position: number, length: number): void {
    const next = Math.min(this.bufferEnd, position + length)
    this.moveCaretToPosition(next)
    this.ensureCaretVisible()
    this.clearSelection()
    this.changed()
  }

  toggleOverwriteMode(): void {
    this.overwriteMode = !this.overwriteMode
    this.changed()
  }

  /** The selection, or the cell the caret is on — `GetSelectedSpanOrCell`. */
  selectedSpanOrCell(): { start: number; end: number } | undefined {
    if (!this.isSelectionEmpty)
      return { start: this.selectionStart, end: this.selectionEnd }
    const line = this.line(this.caretPosition)
    const cell = cellAt(this.caret.activeColumn === 'values' ? line.valueCells : line.asciiCells, this.caretPosition)
    return cell ? { start: cell.bufferStart, end: cell.bufferEnd } : undefined
  }
}
