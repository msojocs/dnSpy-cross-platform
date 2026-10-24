import { describe, expect, it } from 'vitest'
import { HexLineFormatter } from './hex-line'
import { HexViewModel } from './hex-view-model'

const formatterOf = (endPosition = 0x100, valuesFormat: 'hexByte' | 'hexUInt16' = 'hexByte', showValues = true): HexLineFormatter =>
  new HexLineFormatter({
    charsPerLine: 80, bytesPerLine: 16, groupSizeInBytes: 8, showOffset: true, showValues, showAscii: true,
    offsetFormat: 'hex', startPosition: 0, endPosition, basePosition: 0, useRelativePositions: false,
    offsetLowerCaseHex: false, valuesLowerCaseHex: false, offsetBitSize: 0, valuesFormat,
  })

const model = (endPosition = 0x100, valuesFormat: 'hexByte' | 'hexUInt16' = 'hexByte'): HexViewModel => {
  const result = new HexViewModel(formatterOf(endPosition, valuesFormat))
  result.setViewportLines(4)
  return result
}

describe('HexViewModel', () => {
  it('steps a nibble at a time in the values column and a byte at a time in the ASCII one', () => {
    const view = model()
    view.moveToNextCharacter(false)
    expect(view.activePosition).toEqual({ column: 'values', position: 0, cellPosition: 1 })
    view.moveToNextCharacter(false)
    expect(view.caretPosition).toBe(1)
    view.toggleColumn()
    view.moveToNextCharacter(false)
    expect(view.caretPosition).toBe(2)
  })

  it('extends the selection with Shift, the end exclusive, and collapses it to its end with Right', () => {
    const view = model()
    view.moveLineDown(true)
    expect([view.selectionStart, view.selectionEnd]).toEqual([0, 17])
    view.moveToNextCharacter(false)
    expect(view.isSelectionEmpty).toBe(true)
    expect(view.caretPosition).toBe(16)
  })

  it('aligns a selection to whole values in a multi-byte format', () => {
    const view = model(0x100, 'hexUInt16')
    view.select(1, 3, true)
    expect([view.anchorPoint, view.activePoint]).toEqual([0, 4])
  })

  it('pages by the viewport and keeps the caret in view', () => {
    const view = model()
    view.pageDown(false)
    expect(view.topLine).toBe(4)
    expect(view.caretLine).toBe(4)
    view.moveToEndOfDocument(false)
    expect(view.caretPosition).toBe(0xFF)
    expect(view.isLineVisible(view.caretLine)).toBe(true)
  })

  it('selects a word (a value cell), a line and everything', () => {
    const view = model(0x100, 'hexUInt16')
    view.moveCaretTo(5)
    view.selectCurrentWord()
    expect([view.selectionStart, view.selectionEnd]).toEqual([4, 6])
    view.selectLine(1, false)
    expect([view.selectionStart, view.selectionEnd]).toEqual([16, 32])
    view.selectAll()
    expect([view.selectionStart, view.selectionEnd]).toEqual([0, 0x100])
  })

  it('swaps the caret and the anchor', () => {
    const view = model()
    view.selectAndMoveCaret(4, 8)
    expect(view.caretPosition).toBe(7)
    view.swapCaretAndAnchor()
    expect(view.caretPosition).toBe(4)
  })

  it('moves the caret to the ASCII column when the values column is hidden (GetUpdatedCaretPosition)', () => {
    const view = model()
    view.moveCaretTo(0x13, 'values')
    view.setFormatter(formatterOf(0x100, 'hexByte', false))
    expect(view.caret.activeColumn).toBe('ascii')
    expect(view.caretPosition).toBe(0x13)
    view.moveToNextCharacter(false)
    expect(view.caretPosition).toBe(0x14)
  })

  it('keeps the character in the cell when new line options still hold the caret\'s byte', () => {
    const view = model()
    view.moveCaretTo(0x13, 'values')
    view.moveToNextCharacter(false)
    expect(view.activePosition.cellPosition).toBe(1)
    view.setFormatter(formatterOf(0x200))
    expect(view.activePosition).toEqual({ column: 'values', position: 0x13, cellPosition: 1 })
  })

  it('puts a click on the space between two values on the nearer one', () => {
    const view = model()
    const line = view.line(0)
    const separator = line.valueCells[0].separatorSpan.start
    view.moveCaretToLinePosition(0, separator + 0.25, true)
    expect(view.activePosition).toEqual({ column: 'values', position: 0, cellPosition: 1 })
    view.moveCaretToLinePosition(0, separator + 0.75, true)
    expect(view.activePosition).toEqual({ column: 'values', position: 1, cellPosition: 0 })
  })

  it('keeps the caret\'s row in the viewport through a Page Down that the end of the bytes cuts short', () => {
    const view = model(0x60)
    // Six lines, four in view: the caret on the second row.
    view.moveLineDown(false)
    view.pageDown(false)
    view.pageDown(false)
    view.pageUp(false)
    expect(view.caretLine - view.topLine).toBe(1)
  })

  it('moves to a valid start or end clipped to the view, extending the selection with Shift', () => {
    const view = model()
    view.moveToValidStartEnd(0x40, true)
    expect([view.selectionStart, view.selectionEnd]).toEqual([0, 0x41])
    view.moveToValidStartEnd(0x1000, false)
    expect(view.caretPosition).toBe(0xFF)
    expect(view.isSelectionEmpty).toBe(true)
  })
})
