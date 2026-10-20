import { describe, expect, it } from 'vitest'
import { HexLineFormatter, closestCellPosition, columnSpansOf, lineTextWithin, linePositionInfo, type HexLineFormatterOptions } from './hex-line'

const options = (overrides: Partial<HexLineFormatterOptions> = {}): HexLineFormatterOptions => ({
  charsPerLine: 80,
  bytesPerLine: 16,
  groupSizeInBytes: 8,
  showOffset: true,
  showValues: true,
  showAscii: true,
  offsetFormat: 'hex',
  startPosition: 0,
  endPosition: 0x30,
  basePosition: 0,
  useRelativePositions: false,
  offsetLowerCaseHex: false,
  valuesLowerCaseHex: false,
  offsetBitSize: 0,
  valuesFormat: 'hexByte',
  ...overrides,
})

const bytes = (position: number): number => position & 0xFF

describe('HexLineFormatter', () => {
  it('lays a line out the way HexBufferLineFormatterImpl writes it', () => {
    const formatter = new HexLineFormatter(options())
    // 8-bit offset (the last byte is 0x2F), one space, 16 cells of two, one space, 16 ASCII characters.
    expect(formatter.offsetSpan).toEqual({ start: 0, end: 2 })
    expect(formatter.valuesSpan).toEqual({ start: 3, end: 3 + 16 * 2 + 15 })
    expect(formatter.asciiSpan.end).toBe(formatter.charsPerLine)
    const line = formatter.getLine(0x10, bytes)
    expect(line.text.startsWith('10 10 11 12')).toBe(true)
    expect(line.valueCells[8].groupIndex).toBe(1)
    expect(formatter.lineCount).toBe(3)
  })

  it('fits the bytes to the width the way CalculateBytesPerLine does', () => {
    // 2 offset + 2 separators leave 62; (62 + 1) / (2 + 1 + 1) = 15 cells.
    expect(new HexLineFormatter(options({ bytesPerLine: 0, charsPerLine: 66 })).bytesPerLine).toBe(15)
    // A value format rounds the line up to whole cells and the group to whole values.
    const formatter = new HexLineFormatter(options({ bytesPerLine: 10, groupSizeInBytes: 3, valuesFormat: 'hexUInt32' }))
    expect(formatter.bytesPerLine).toBe(12)
    expect(formatter.groupSizeInBytes).toBe(4)
  })

  it('blanks the cells past the end of the last line', () => {
    const formatter = new HexLineFormatter(options({ endPosition: 0x12 }))
    const line = formatter.getLine(0x10, bytes)
    expect(line.valueCells[1].hasData).toBe(true)
    expect(line.valueCells[2].hasData).toBe(false)
    expect(line.text.slice(formatter.asciiSpan.start, formatter.asciiSpan.start + 3)).toBe('.. ')
  })

  it('writes unreadable bytes as dnSpy’s question marks', () => {
    const formatter = new HexLineFormatter(options())
    const line = formatter.getLine(0, () => -1)
    expect(line.text.slice(3, 5)).toBe('??')
    expect(line.text.slice(formatter.asciiSpan.start, formatter.asciiSpan.start + 1)).toBe('?')
  })

  it('reads positions logically with a base and relative positions', () => {
    const formatter = new HexLineFormatter(options({ startPosition: 0x10, basePosition: 0x1000, useRelativePositions: true }))
    expect(formatter.toLogicalPosition(0x10)).toBe(0x1000)
    expect(formatter.toPhysicalPosition(0x1001)).toBe(0x11)
    expect(formatter.getLine(0x10, bytes).text.startsWith('1000')).toBe(true)
  })

  it('finds the cell under a character, and the closest one off the cells', () => {
    const formatter = new HexLineFormatter(options())
    const line = formatter.getLine(0, bytes)
    const info = linePositionInfo(formatter, line, 4)
    expect(info.type).toBe('valueCell')
    expect(closestCellPosition(formatter, line, info, true)).toEqual({ column: 'values', position: 0, cellPosition: 1 })
    expect(linePositionInfo(formatter, line, 5).type).toBe('valueCellSeparator')
    // A click on the offset goes to the nearest cell.
    expect(closestCellPosition(formatter, line, linePositionInfo(formatter, line, 0), true)).toEqual({ column: 'values', position: 0, cellPosition: 0 })
  })

  it('covers a selection from its first cell to its last in both columns', () => {
    const formatter = new HexLineFormatter(options())
    const line = formatter.getLine(0, bytes)
    expect(columnSpansOf(line, 1, 3, { values: true, ascii: true })).toEqual([
      { column: 'values', span: { start: 6, end: 11 } },
      { column: 'ascii', span: { start: formatter.asciiSpan.start + 1, end: formatter.asciiSpan.start + 3 } },
    ])
    expect(lineTextWithin(line, 0, 1).slice(3, 8)).toBe('00   ')
  })
})
