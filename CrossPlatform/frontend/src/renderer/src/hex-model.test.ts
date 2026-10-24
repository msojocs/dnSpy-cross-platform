import { describe, expect, it } from 'vitest'
import {
  compressedUIntPrefix,
  csharpArrayText,
  formatGeneral,
  editValueCell,
  formatHexOffset,
  formatHexValue,
  hexNumberText,
  hexText,
  offsetTextLength,
  parseHexBytes,
  sevenBitLengthPrefix,
  valueByteIndex,
  visualBasicArrayText,
} from './hex-model'

describe('offset formatting', () => {
  it('writes an offset past 4 GiB without losing its high digits', () => {
    expect(formatHexOffset(0x1_2345_6789, 40, 'hex', false)).toBe('0123456789')
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

describe('value formats', () => {
  it('writes hex and decimal cells of the width dnSpy gives them', () => {
    const bytes = Uint8Array.from([0xFF])
    expect(formatHexValue(bytes, 0, 'hexByte', false)).toBe('FF')
    expect(formatHexValue(bytes, 0, 'hexByte', true)).toBe('ff')
    expect(formatHexValue(bytes, 0, 'decimalByte', false)).toBe('255')
    expect(formatHexValue(Uint8Array.of(7), 0, 'decimalSByte', false)).toBe('   7')
    expect(formatHexValue(bytes, 0, 'hexSByte', false)).toBe('-01')
    expect(formatHexValue(bytes, 0, 'bit8', false)).toBe('11111111')
  })

  it('reads multi-byte values in both byte orders', () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0x04])
    expect(formatHexValue(bytes, 0, 'hexUInt32', false)).toBe('04030201')
    expect(formatHexValue(bytes, 0, 'hexUInt32Be', false)).toBe('01020304')
    expect(formatHexValue(bytes, 0, 'decimalUInt16', false)).toBe('  513')
    expect(formatHexValue(bytes, 0, 'decimalUInt16Be', false)).toBe('  258')
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
    expect(visualBasicArrayText(Uint8Array.from([1, 2]), true)).toBe('New Byte() { _\n\t&H01, &H02 _\n}\n')
  })

  it('reads hex bytes the way ClipboardUtils does and refuses what is not hex', () => {
    expect(parseHexBytes('4D5A')).toEqual(Uint8Array.from([0x4D, 0x5A]))
    expect(parseHexBytes('4d5a')).toEqual(Uint8Array.from([0x4D, 0x5A]))
    // No spacing: dnSpy reads the clipboard two characters at a time.
    expect(parseHexBytes('4d 5a')).toBeUndefined()
    // '?' is a zero nibble, as in dnSpy's own parser.
    expect(parseHexBytes('?F')).toEqual(Uint8Array.from([0x0F]))
    expect(parseHexBytes('4D5')).toBeUndefined()
    expect(parseHexBytes('ZZ')).toBeUndefined()
    expect(parseHexBytes('')).toEqual(new Uint8Array(0))
  })

  it('writes the length prefixes the special pastes use', () => {
    expect(Array.from(sevenBitLengthPrefix(0x7F))).toEqual([0x7F])
    expect(Array.from(sevenBitLengthPrefix(0x80))).toEqual([0x80, 0x01])
    expect(Array.from(compressedUIntPrefix(0x7F))).toEqual([0x7F])
    expect(Array.from(compressedUIntPrefix(0x80))).toEqual([0x80, 0x80])
    expect(Array.from(compressedUIntPrefix(0x4000))).toEqual([0xC0, 0x00, 0x40, 0x00])
  })
})

describe('editing a value cell', () => {
  it('types a nibble of the byte a digit stands for, little endian last byte first', () => {
    expect(valueByteIndex('hexUInt16', 0)).toBe(1)
    expect(valueByteIndex('hexUInt16', 3)).toBe(0)
    expect(valueByteIndex('hexUInt16Be', 3)).toBe(1)
    expect(editValueCell('hexByte', Uint8Array.of(0x12), 0, 'a')).toEqual({ offset: 0, data: Uint8Array.of(0xA2) })
    expect(editValueCell('hexUInt16', Uint8Array.of(0x34, 0x12), 1, 'F')).toEqual({ offset: 1, data: Uint8Array.of(0x1F) })
    expect(editValueCell('hexByte', Uint8Array.of(0x12), 0, 'g')).toBeUndefined()
  })

  it('edits a signed cell as text and saturates what it reads back', () => {
    // " 7F" with its sign typed over becomes -0x7F.
    expect(editValueCell('hexSByte', Uint8Array.of(0x7F), 0, '-')).toEqual({ offset: 0, data: Uint8Array.of(0x81) })
    expect(editValueCell('hexSByte', Uint8Array.of(0x7F), 1, 'F')).toEqual({ offset: 0, data: Uint8Array.of(0x7F) })
    expect(editValueCell('bit8', Uint8Array.of(0), 0, '1')).toEqual({ offset: 0, data: Uint8Array.of(0x80) })
    expect(editValueCell('decimalByte', Uint8Array.of(0), 0, '1')).toBeUndefined()
  })
})

describe('.NET formatting of copied and shown values', () => {
  it('switches to an exponent below 1E-04 and keeps the sign of negative zero', () => {
    expect(formatGeneral(1.5e-5, 7)).toBe('1.5E-05')
    expect(formatGeneral(0.0001, 7)).toBe('0.0001')
    expect(formatGeneral(-0.000015, 7)).toBe('-1.5E-05')
    expect(formatGeneral(-0, 7)).toBe('-0')
    expect(formatGeneral(123456789, 7)).toBe('1.234568E+08')
  })

  it('writes a byte that cannot be read as ?? in the copied arrays', () => {
    expect(csharpArrayText([0x12, -1], true)).toBe('new byte[] {\n\t0x12, 0x??\n};\n')
    expect(visualBasicArrayText([-1], true)).toBe('New Byte() { _\n\t&H?? _\n}\n')
  })
})
