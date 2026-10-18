import { describe, expect, it } from 'vitest'
import {
  bytesPerLineForWidth,
  compressedUIntPrefix,
  csharpArrayText,
  defaultHexLineFormat,
  formatHexOffset,
  formatHexValue,
  hexNumberText,
  hexText,
  lineOf,
  offsetBitSizeFor,
  offsetTextLength,
  parseHexBytes,
  resolveBytesPerLine,
  resolveGroupSize,
  selectionBetween,
  sevenBitLengthPrefix,
  visualBasicArrayText,
} from './hex-model'

describe('offset formatting', () => {
  it('narrows the column to the file the way dnSpy calculates the bit size', () => {
    // The width follows the last address, which is one less than the length.
    expect(offsetBitSizeFor(0x10)).toBe(8)
    expect(offsetBitSizeFor(0x101)).toBe(16)
    expect(offsetBitSizeFor(0x1_0001)).toBe(24)
    expect(offsetBitSizeFor(0x1_000_001)).toBe(32)
    expect(offsetBitSizeFor(0x1_0000_0001)).toBe(40)
  })

  it('writes every offset format dnSpy offers, upper or lower case', () => {
    expect(formatHexOffset(0x1A2B, 16, 'hex', false)).toBe('1A2B')
    expect(formatHexOffset(0x1A2B, 16, 'cSharp', false)).toBe('0x1A2B')
    expect(formatHexOffset(0x1A2B, 16, 'vb', false)).toBe('&H1A2B')
    expect(formatHexOffset(0x1A2B, 16, 'masm', false)).toBe('1A2Bh')
    expect(formatHexOffset(0x1a, 8, 'hex', true)).toBe('1a')
    expect(offsetTextLength(16, 'cSharp')).toBe(6)
    expect(offsetTextLength(16, 'masm')).toBe(5)
  })
})

describe('line layout', () => {
  it('fits bytes to the width the way CalculateBytesPerLine does', () => {
    const options = defaultHexLineFormat()
    // Offset(4) + values(2 chars + 1 separator each) + ascii(1 each), with two separators between columns.
    // 68 chars: 4 offset + 1 separator + 47 values + 1 separator + 16 ASCII leaves (68 - 6 + 1) / 4 = 15.
    expect(bytesPerLineForWidth(68, options, 16)).toBe(15)
    // 20 chars leave 14 after the 4-digit offset and the separators; the values and ASCII share them —
    // (14 + 1) / (2 + 1 + 1) = 3 cells — so three bytes is the most that fits.
    expect(bytesPerLineForWidth(20, options, 16)).toBe(3)
  })

  it('rounds the line and the group to the value format', () => {
    const options = { ...defaultHexLineFormat(), bytesPerLine: 10, groupSize: 3, valuesFormat: 'hexUInt32' as const }
    expect(resolveBytesPerLine(options, 32, 80)).toBe(12)
    expect(resolveGroupSize(options, 12)).toBe(4)
    // Fit-to-width keeps the value cell whole.
    expect(resolveBytesPerLine({ ...options, bytesPerLine: 0 }, 32, 40)).toBe(8)
  })

  it('draws a line of address, bytes and ASCII', () => {
    const bytes = Uint8Array.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x41, 0x42])
    const line = lineOf(bytes, 0, 0, 10, { ...defaultHexLineFormat(), offsetBitSize: 16 }, 16)
    expect(line.address).toBe('0000')
    expect(line.values.map((cell) => cell.text)).toEqual(['4D', '5A', '90', '00', '03', '00', '00', '00', '41', '42'])
    expect(line.ascii.map((cell) => cell.text).join('')).toBe('MZ......AB')
    // The second group of eight is the alternating one.
    expect(line.values[7].group).toBe(0)
    expect(line.values[8].group).toBe(1)
  })

  it('shows unreadable bytes as dnSpy’s question marks', () => {
    const line = lineOf(new Uint8Array(0), 0, 0, 16, { ...defaultHexLineFormat(), offsetBitSize: 16 }, 16)
    expect(line.values.every((cell) => cell.text === '??')).toBe(true)
    expect(line.ascii.every((cell) => cell.text === ' ')).toBe(true)
  })
})

describe('value formats', () => {
  it('writes hex and decimal cells of the width dnSpy gives them', () => {
    const bytes = Uint8Array.from([0xFF])
    expect(formatHexValue(bytes, 0, 'hexByte', false)).toBe('FF')
    expect(formatHexValue(bytes, 0, 'hexByte', true)).toBe('ff')
    expect(formatHexValue(bytes, 0, 'decimalByte', false)).toBe('255'.padStart(21, ' '))
    expect(formatHexValue(bytes, 0, 'hexSByte', false)).toBe('-01')
    expect(formatHexValue(bytes, 0, 'bit8', false)).toBe('11111111')
  })

  it('reads multi-byte values in both byte orders', () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04])
    expect(formatHexValue(bytes, 0, 'hexUInt32', false)).toBe('04030201')
    expect(formatHexValue(bytes, 0, 'hexUInt32Be', false)).toBe('01020304')
    expect(formatHexValue(bytes, 0, 'decimalUInt16', false)).toBe('513'.padStart(21, ' '))
    expect(formatHexValue(bytes, 0, 'decimalUInt16Be', false)).toBe('258'.padStart(21, ' '))
  })

  it('writes a single as dnSpy’s G6 and an unreadable cell when the bytes are missing', () => {
    const bytes = Uint8Array.from([0x00, 0x00, 0x80, 0x3F])
    // dnSpy writes a Single with .NET's G7, which drops the trailing zeros.
    expect(formatHexValue(bytes, 0, 'single', false).trim()).toBe('1')
    expect(formatHexValue(new Uint8Array(0), 0, 'hexUInt32', false)).toBe('????????')
  })
})

describe('copy and paste', () => {
  it('writes dnSpy’s clipboard hex', () => {
    expect(hexText(Uint8Array.from([0x4D, 0x5A, 0x9E]), true)).toBe('4D5A9E')
    expect(hexText(Uint8Array.from([0x4D, 0x5A, 0x9E]), false)).toBe('4d5a9e')
    expect(hexNumberText(0x2A)).toBe('0x2A')
  })

  it('writes C# and Visual Basic arrays row by row', () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, index) => index)
    expect(csharpArrayText(bytes, true)).toBe(
      'new byte[] {\n\t0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,\n\t0x10\n};\n',
    )
    expect(visualBasicArrayText(Uint8Array.from([1, 2]), true)).toBe('New Byte() { _\n\t&H01, &H02, _\n}\n')
  })

  it('reads hex bytes with any spacing and refuses what is not hex', () => {
    expect(parseHexBytes('4D5A')).toEqual(Uint8Array.from([0x4D, 0x5A]))
    expect(parseHexBytes('4d 5a')).toEqual(Uint8Array.from([0x4D, 0x5A]))
    // '?' is a zero nibble, as in dnSpy's own parser.
    expect(parseHexBytes('?F')).toEqual(Uint8Array.from([0x0F]))
    expect(parseHexBytes('4D5')).toBeUndefined()
    expect(parseHexBytes('ZZ')).toBeUndefined()
    expect(parseHexBytes('')).toBeUndefined()
  })

  it('writes the length prefixes the special pastes use', () => {
    expect(Array.from(sevenBitLengthPrefix(0x7F))).toEqual([0x7F])
    expect(Array.from(sevenBitLengthPrefix(0x80))).toEqual([0x80, 0x01])
    expect(Array.from(compressedUIntPrefix(0x7F))).toEqual([0x7F])
    expect(Array.from(compressedUIntPrefix(0x80))).toEqual([0x80, 0x80])
    expect(Array.from(compressedUIntPrefix(0x4000))).toEqual([0xC0, 0x00, 0x40, 0x00])
  })
})

describe('selection', () => {
  it('covers the bytes between the anchor and the caret, either way round', () => {
    expect(selectionBetween(3, 5)).toEqual({ start: 3, end: 6 })
    expect(selectionBetween(5, 3)).toEqual({ start: 3, end: 6 })
    expect(selectionBetween(4, 4)).toEqual({ start: 4, end: 5 })
  })
})
