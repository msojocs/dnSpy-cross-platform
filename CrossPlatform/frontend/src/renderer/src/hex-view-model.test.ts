import { describe, expect, it } from 'vitest'
import { HexLineFormatter } from './hex-line'
import { HexViewModel } from './hex-view-model'

const model = (endPosition = 0x100, valuesFormat: 'hexByte' | 'hexUInt16' = 'hexByte'): HexViewModel => {
  const formatter = new HexLineFormatter({
    charsPerLine: 80, bytesPerLine: 16, groupSizeInBytes: 8, showOffset: true, showValues: true, showAscii: true,
    offsetFormat: 'hex', startPosition: 0, endPosition, basePosition: 0, useRelativePositions: false,
    offsetLowerCaseHex: false, valuesLowerCaseHex: false, offsetBitSize: 0, valuesFormat,
  })
  const result = new HexViewModel(formatter)
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
})
