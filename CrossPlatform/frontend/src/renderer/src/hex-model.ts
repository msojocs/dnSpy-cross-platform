/**
 * The pure half of the hex editor: how a line is laid out, how an offset and a value are written, what a
 * copy puts on the clipboard, and what a pasted or searched text means. Everything here is ported from
 * dnSpy's own hex editor — `HexBufferLineFormatterImpl`, `HexOffsetFormatter`, `HexValueFormatter`,
 * `HexEditorOperationsImpl` and `SettingsConstants` — and kept free of React so it can be tested on its own.
 */

/** dnSpy's `HexValuesDisplayFormat`, in the order `SettingsConstants.ValueFormatList` lists it. */
export type HexValuesFormat =
  | 'hexByte' | 'decimalByte'
  | 'hexUInt16' | 'decimalUInt16' | 'hexUInt16Be' | 'decimalUInt16Be'
  | 'hexUInt32' | 'decimalUInt32' | 'hexUInt32Be' | 'decimalUInt32Be'
  | 'hexUInt64' | 'decimalUInt64' | 'hexUInt64Be' | 'decimalUInt64Be'
  | 'hexSByte' | 'decimalSByte'
  | 'hexInt16' | 'decimalInt16' | 'hexInt16Be' | 'decimalInt16Be'
  | 'hexInt32' | 'decimalInt32' | 'hexInt32Be' | 'decimalInt32Be'
  | 'hexInt64' | 'decimalInt64' | 'hexInt64Be' | 'decimalInt64Be'
  | 'single' | 'singleBe' | 'double' | 'doubleBe'
  | 'bit8'

/** dnSpy's `HexOffsetFormat`. */
export type HexOffsetFormatKind = 'hex' | 'cSharp' | 'vb' | 'masm'

/** One entry of dnSpy's value-format submenu: its caption, the bytes a cell covers and its char width. */
export interface HexValueFormatInfo {
  format: HexValuesFormat
  /** The caption `SettingsConstants.ValueFormatList` gives it. */
  label: string
  byteCount: number
  /** Chars one formatted value takes, padding included. */
  formattedLength: number
}

/**
 * The format list with the widths dnSpy's formatters use. `"FF"`, `"FFFF"` and `"-80"` set the hex widths;
 * a decimal cell is as wide as the widest value of its type (`MAX_LENGTH`: `byte.MaxValue`, `int.MinValue`…),
 * a Single and a Double as wide as sign, digits, separator and exponent (`MaxSingleFormattedLength`,
 * `MaxDoubleFormattedLength`).
 */
export const HEX_VALUE_FORMATS: readonly HexValueFormatInfo[] = [
  { format: 'hexByte', label: 'Byte (hex)', byteCount: 1, formattedLength: 2 },
  { format: 'decimalByte', label: 'Byte (decimal)', byteCount: 1, formattedLength: 3 },
  { format: 'hexUInt16', label: 'UInt16 (hex)', byteCount: 2, formattedLength: 4 },
  { format: 'decimalUInt16', label: 'UInt16 (decimal)', byteCount: 2, formattedLength: 5 },
  { format: 'hexUInt16Be', label: 'UInt16 (hex, big endian)', byteCount: 2, formattedLength: 4 },
  { format: 'decimalUInt16Be', label: 'UInt16 (decimal, big endian)', byteCount: 2, formattedLength: 5 },
  { format: 'hexUInt32', label: 'UInt32 (hex)', byteCount: 4, formattedLength: 8 },
  { format: 'decimalUInt32', label: 'UInt32 (decimal)', byteCount: 4, formattedLength: 10 },
  { format: 'hexUInt32Be', label: 'UInt32 (hex, big endian)', byteCount: 4, formattedLength: 8 },
  { format: 'decimalUInt32Be', label: 'UInt32 (decimal, big endian)', byteCount: 4, formattedLength: 10 },
  { format: 'hexUInt64', label: 'UInt64 (hex)', byteCount: 8, formattedLength: 16 },
  { format: 'decimalUInt64', label: 'UInt64 (decimal)', byteCount: 8, formattedLength: 20 },
  { format: 'hexUInt64Be', label: 'UInt64 (hex, big endian)', byteCount: 8, formattedLength: 16 },
  { format: 'decimalUInt64Be', label: 'UInt64 (decimal, big endian)', byteCount: 8, formattedLength: 20 },
  { format: 'hexSByte', label: 'SByte (hex)', byteCount: 1, formattedLength: 3 },
  { format: 'decimalSByte', label: 'SByte (decimal)', byteCount: 1, formattedLength: 4 },
  { format: 'hexInt16', label: 'Int16 (hex)', byteCount: 2, formattedLength: 5 },
  { format: 'decimalInt16', label: 'Int16 (decimal)', byteCount: 2, formattedLength: 6 },
  { format: 'hexInt16Be', label: 'Int16 (hex, big endian)', byteCount: 2, formattedLength: 5 },
  { format: 'decimalInt16Be', label: 'Int16 (decimal, big endian)', byteCount: 2, formattedLength: 6 },
  { format: 'hexInt32', label: 'Int32 (hex)', byteCount: 4, formattedLength: 9 },
  { format: 'decimalInt32', label: 'Int32 (decimal)', byteCount: 4, formattedLength: 11 },
  { format: 'hexInt32Be', label: 'Int32 (hex, big endian)', byteCount: 4, formattedLength: 9 },
  { format: 'decimalInt32Be', label: 'Int32 (decimal, big endian)', byteCount: 4, formattedLength: 11 },
  { format: 'hexInt64', label: 'Int64 (hex)', byteCount: 8, formattedLength: 17 },
  { format: 'decimalInt64', label: 'Int64 (decimal)', byteCount: 8, formattedLength: 20 },
  { format: 'hexInt64Be', label: 'Int64 (hex, big endian)', byteCount: 8, formattedLength: 17 },
  { format: 'decimalInt64Be', label: 'Int64 (decimal, big endian)', byteCount: 8, formattedLength: 20 },
  { format: 'single', label: 'Single', byteCount: 4, formattedLength: 13 },
  { format: 'singleBe', label: 'Single (big endian)', byteCount: 4, formattedLength: 13 },
  { format: 'double', label: 'Double', byteCount: 8, formattedLength: 22 },
  { format: 'doubleBe', label: 'Double (big endian)', byteCount: 8, formattedLength: 22 },
  { format: 'bit8', label: '8 Bits', byteCount: 1, formattedLength: 8 },
]

const valueFormatByFormat = new Map(HEX_VALUE_FORMATS.map((info) => [info.format, info]))

export const hexValueFormatInfo = (format: HexValuesFormat): HexValueFormatInfo =>
  valueFormatByFormat.get(format) ?? HEX_VALUE_FORMATS[0]

/** dnSpy's `HexBufferLineFormatterOptions` limits: 0 means fit-to-width, 1024 the most bytes a line takes. */
export const MAX_BYTES_PER_LINE = 1024
export const MAX_OFFSET_BIT_SIZE = 64

const offsetAffixes = (format: HexOffsetFormatKind): { prefix: string, suffix: string } => {
  switch (format) {
    case 'cSharp': return { prefix: '0x', suffix: '' }
    case 'vb': return { prefix: '&H', suffix: '' }
    case 'masm': return { prefix: '', suffix: 'h' }
    case 'hex':
    default: return { prefix: '', suffix: '' }
  }
}

/** An offset the way dnSpy's `HexOffsetFormatter` writes it — hex digits between its affixes. */
export function formatHexOffset(offset: number, bitSize: number, format: HexOffsetFormatKind, lowerCase: boolean): string {
  const digits = Math.max(1, Math.ceil(bitSize / 4))
  // Offsets past 4 GiB are plain numbers here, so they are written without a 32-bit cast.
  const text = Math.max(0, Math.floor(offset)).toString(16).padStart(digits, '0').slice(-digits)
  const { prefix, suffix } = offsetAffixes(format)
  return prefix + (lowerCase ? text.toLowerCase() : text.toUpperCase()) + suffix
}

/** The width of an offset column, which the layout needs before it can fit the bytes. */
export function offsetTextLength(bitSize: number, format: HexOffsetFormatKind): number {
  const { prefix, suffix } = offsetAffixes(format)
  return prefix.length + Math.max(1, Math.ceil(bitSize / 4)) + suffix.length
}

/** The little- or big-endian unsigned value of a cell, or undefined when the bytes are not all there. */
const readUnsigned = (bytes: Uint8Array, index: number, byteCount: number, bigEndian: boolean): bigint | undefined => {
  if (index < 0 || index + byteCount > bytes.length)
    return undefined
  let value = BigInt(0)
  for (let i = 0; i < byteCount; i++) {
    const byte = bytes[bigEndian ? index + i : index + byteCount - 1 - i]
    value = (value << BigInt(8)) | BigInt(byte)
  }
  return value
}

const hexOf = (value: bigint, digits: number, lowerCase: boolean): string => {
  const text = value.toString(16).padStart(digits, '0').slice(-digits)
  return lowerCase ? text.toLowerCase() : text.toUpperCase()
}

/** dnSpy pads an unreadable cell with `?` across its whole width. */
const invalidValue = (width: number): string => '?'.repeat(width)

/**
 * .NET's "G" format: up to `precision` significant digits with the trailing zeros of a decimal written
 * plain removed ("1.00000" is "1"), coefficients of an exponent trimmed the same way ("1E+20").
 */
export function formatGeneral(value: number, precision: number): string {
  // .NET Core keeps the sign of a negative zero.
  if (value === 0)
    return Object.is(value, -0) ? '-0' : '0'
  // Plain notation only for an exponent from -5 up to the precision; JavaScript goes on to -7 before it switches.
  let text = value.toPrecision(precision)
  if (!text.includes('e') && Number(Number(text).toExponential().split('e')[1]) < -4)
    text = value.toExponential(precision - 1)
  const exponent = text.indexOf('e')
  const coefficient = exponent < 0 ? text : text.slice(0, exponent)
  const trimmed = coefficient.includes('.') ? coefficient.replace(/\.?0+$/, '') : coefficient
  if (exponent < 0)
    return trimmed
  const power = Number(text.slice(exponent + 1))
  return `${trimmed}E${power < 0 ? '-' : '+'}${Math.abs(power).toString().padStart(2, '0')}`
}

/** dnSpy's decimal cells are right-aligned in a column as wide as the type's widest value (`MAX_LENGTH`). */
const decimalOf = (value: bigint | undefined, width: number): string =>
  value === undefined ? invalidValue(width) : value.toString(10).padStart(width, ' ')

/**
 * One value cell exactly as dnSpy's `HexValueFormatter` writes it, padding included. `bytes` starts at the
 * cell, so a cell the chunk only partly covers formats as the unreadable cell dnSpy shows.
 */
export function formatHexValue(bytes: Uint8Array, index: number, format: HexValuesFormat, lowerCase: boolean): string {
  const info = hexValueFormatInfo(format)
  const unsigned = (bigEndian = false): bigint | undefined => readUnsigned(bytes, index, info.byteCount, bigEndian)
  const signed = (bigEndian = false): bigint | undefined => {
    const value = unsigned(bigEndian)
    if (value === undefined)
      return undefined
    const bits = BigInt(info.byteCount * 8)
    const signBit = BigInt(1) << (bits - BigInt(1))
    return (value & signBit) !== BigInt(0) ? value - (BigInt(1) << bits) : value
  }
  const hex = (bigEndian = false): string => {
    const value = unsigned(bigEndian)
    return value === undefined ? invalidValue(info.formattedLength) : hexOf(value, info.formattedLength, lowerCase)
  }
  const signedHex = (bigEndian = false): string => {
    const value = signed(bigEndian)
    if (value === undefined)
      return invalidValue(info.formattedLength)
    return (value < BigInt(0) ? '-' : ' ') + hexOf(value < BigInt(0) ? -value : value, info.formattedLength - 1, lowerCase)
  }
  const floating = (byteCount: number, bigEndian: boolean): string => {
    if (index < 0 || index + byteCount > bytes.length)
      return invalidValue(info.formattedLength)
    const view = new DataView(new ArrayBuffer(byteCount))
    for (let i = 0; i < byteCount; i++)
      view.setUint8(i, bytes[index + (bigEndian ? i : byteCount - 1 - i)])
    const value = byteCount === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false)
    const text = Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Inf' : value === -Infinity ? '-Inf' : formatGeneral(value, byteCount === 4 ? 7 : 15)
    return text.length > info.formattedLength ? text.slice(0, info.formattedLength - 1) + '?' : text.padStart(info.formattedLength, ' ')
  }
  const width = info.formattedLength
  switch (format) {
    case 'hexByte': return hex()
    case 'decimalByte': return decimalOf(unsigned(), width)
    case 'hexUInt16': return hex()
    case 'decimalUInt16': return decimalOf(unsigned(), width)
    case 'hexUInt16Be': return hex(true)
    case 'decimalUInt16Be': return decimalOf(unsigned(true), width)
    case 'hexUInt32': return hex()
    case 'decimalUInt32': return decimalOf(unsigned(), width)
    case 'hexUInt32Be': return hex(true)
    case 'decimalUInt32Be': return decimalOf(unsigned(true), width)
    case 'hexUInt64': return hex()
    case 'decimalUInt64': return decimalOf(unsigned(), width)
    case 'hexUInt64Be': return hex(true)
    case 'decimalUInt64Be': return decimalOf(unsigned(true), width)
    case 'hexSByte': return signedHex()
    case 'decimalSByte': return decimalOf(signed(), width)
    case 'hexInt16': return signedHex()
    case 'decimalInt16': return decimalOf(signed(), width)
    case 'hexInt16Be': return signedHex(true)
    case 'decimalInt16Be': return decimalOf(signed(true), width)
    case 'hexInt32': return signedHex()
    case 'decimalInt32': return decimalOf(signed(), width)
    case 'hexInt32Be': return signedHex(true)
    case 'decimalInt32Be': return decimalOf(signed(true), width)
    case 'hexInt64': return signedHex()
    case 'decimalInt64': return decimalOf(signed(), width)
    case 'hexInt64Be': return signedHex(true)
    case 'decimalInt64Be': return decimalOf(signed(true), width)
    case 'single': return floating(4, false)
    case 'singleBe': return floating(4, true)
    case 'double': return floating(8, false)
    case 'doubleBe': return floating(8, true)
    case 'bit8': {
      const value = unsigned()
      return value === undefined ? invalidValue(8) : value.toString(2).padStart(8, '0')
    }
    default: return hex()
  }
}

/** The ASCII column's character for a byte: what it stands for when printable, '.' when it is not. */
export const asciiOf = (byte: number): string => byte >= 0x20 && byte <= 0x7E ? String.fromCharCode(byte) : '.'

/** The edits dnSpy's value formatters take: the hex and bit formats can be typed over, the decimal and floating
 * point ones cannot (`HexValueFormatter.CanEdit`). */
export const canEditValues = (format: HexValuesFormat): boolean =>
  format.startsWith('hex') || format === 'bit8'

const isBigEndianFormat = (format: HexValuesFormat): boolean => format.endsWith('Be')
const isSignedHexFormat = (format: HexValuesFormat): boolean => /^hex(SByte|Int)/.test(format)

/**
 * `HexValueFormatter.GetBufferSpan`: the byte a character of a cell stands for, relative to the cell's first byte.
 * The unsigned hex formats map each pair of digits to its own byte — the last one first in little endian order —
 * and every other format answers the cell's first byte.
 */
export function valueByteIndex(format: HexValuesFormat, cellPosition: number): number {
  const info = hexValueFormatInfo(format)
  if (info.byteCount === 1 || !/^hexUInt/.test(format) || cellPosition < 0 || cellPosition >= info.byteCount * 2)
    return 0
  return isBigEndianFormat(format) ? Math.floor(cellPosition / 2) : (info.byteCount - Math.floor(cellPosition / 2) - 1) % info.byteCount
}

const hexDigit = (character: string): number => {
  if (character.length !== 1)
    return -1
  const code = character.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10
  return -1
}

/**
 * `HexValueFormatter.Edit`: what typing `character` at `cellPosition` of a cell writes, given the cell's bytes as
 * they are now. Answers the bytes to write, relative to the cell's first byte, or undefined when the character
 * cannot go there.
 */
export function editValueCell(format: HexValuesFormat, cellBytes: Uint8Array, cellPosition: number, character: string): { offset: number; data: Uint8Array } | undefined {
  const info = hexValueFormatInfo(format)
  if (!canEditValues(format) || cellPosition < 0 || cellPosition >= info.formattedLength)
    return undefined
  if (format === 'bit8') {
    // EditBit: the eight characters are the bits from the highest down.
    if (character !== '0' && character !== '1')
      return undefined
    if (cellBytes.length < 1)
      return undefined
    const bit = (8 - (cellPosition & 7) - 1) & 7
    const value = (cellBytes[0] & ~(1 << bit)) | (Number(character) << bit)
    return { offset: Math.floor(cellPosition / 8), data: Uint8Array.of(value & 0xFF) }
  }
  if (isSignedHexFormat(format)) {
    // EditSignedHex: the sign and the digits are edited as text and read back as a number that saturates.
    if (cellBytes.length < info.byteCount)
      return undefined
    if (cellPosition === 0 ? !['+', ' ', '-'].includes(character) : hexDigit(character) < 0)
      return undefined
    const text = formatHexValue(cellBytes, 0, format, false)
    const edited = text.slice(0, cellPosition) + character + text.slice(cellPosition + 1)
    const negative = edited[0] === '-'
    let magnitude = BigInt(0)
    for (let i = 1; i < edited.length; i++)
      magnitude = (magnitude << BigInt(4)) | BigInt(hexDigit(edited[i]))
    const bits = BigInt(info.byteCount * 8)
    const max = (BigInt(1) << (bits - BigInt(1))) - BigInt(1)
    let value: bigint
    if (negative)
      value = magnitude > max + BigInt(1) ? -(max + BigInt(1)) : -magnitude
    else
      value = magnitude > max ? max : magnitude
    const unsignedValue = BigInt.asUintN(info.byteCount * 8, value)
    const data = new Uint8Array(info.byteCount)
    for (let i = 0; i < info.byteCount; i++) {
      const byte = Number((unsignedValue >> BigInt(8 * i)) & BigInt(0xFF))
      data[isBigEndianFormat(format) ? info.byteCount - 1 - i : i] = byte
    }
    return { offset: 0, data }
  }
  // EditUnsignedHexLittleEndian / EditUnsignedHexBigEndian: one nibble of one byte.
  const digit = hexDigit(character)
  if (digit < 0)
    return undefined
  const index = isBigEndianFormat(format) ? Math.floor(cellPosition / 2) : (info.byteCount - Math.floor(cellPosition / 2) - 1) % info.byteCount
  if (index >= cellBytes.length)
    return undefined
  const old = cellBytes[index]
  const value = (cellPosition & 1) === 0 ? (old & 0x0F) | (digit << 4) : (old & 0xF0) | digit
  return { offset: index, data: Uint8Array.of(value) }
}

/** dnSpy's hexadecimal clipboard text: two digits per byte and nothing in between. */
export const hexText = (bytes: Uint8Array, upper: boolean): string => {
  const text = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return upper ? text.toUpperCase() : text.toLowerCase()
}

/** dnSpy's `HexEditorOperationsImpl.CopyCSharpArray`. */
export function csharpArrayText(bytes: ArrayLike<number>, upper: boolean): string {
  return arrayText(bytes, upper, '0x', 'new byte[] {', '};', '')
}

/** dnSpy's `HexEditorOperationsImpl.CopyVisualBasicArray`: every row but the last ends in a comma, and every
 * row — the last one too — in the line continuation. */
export function visualBasicArrayText(bytes: ArrayLike<number>, upper: boolean): string {
  return arrayText(bytes, upper, '&H', 'New Byte() {', '}', ' _')
}

/** `CopyArray`: 16 bytes a row, a byte that cannot be read (a negative value) written `??`. */
function arrayText(bytes: ArrayLike<number>, upper: boolean, prefix: string, start: string, end: string, eol: string): string {
  const byteText = (value: number): string => value < 0 ? '??' : hexText(Uint8Array.of(value), upper)
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 16)
    rows.push('\t' + Array.from(Array.prototype.slice.call(bytes, i, i + 16) as number[], (value) => prefix + byteText(value)).join(', '))
  return `${start}${eol}\n${rows.join(`,${eol}\n`)}${eol}\n${end}\n`
}

/** A `0x` number of the width its bytes hold, as every Copy Special number is written. */
export function hexNumberText(value: number | bigint, digits?: number): string {
  const text = (typeof value === 'bigint' ? value.toString(16) : value.toString(16)).toUpperCase()
  return '0x' + (digits === undefined ? text : text.padStart(digits, '0'))
}

/**
 * dnSpy's `ClipboardUtils.HexStringToByteArray`: pairs of hexadecimal digits with nothing in between, `?`
 * meaning a zero nibble; anything else — an odd length, a space — is not bytes. An empty text is no bytes,
 * which only the blob paste accepts.
 */
export function parseHexBytes(text: string): Uint8Array | undefined {
  if (text.length % 2 !== 0)
    return undefined
  const bytes = new Uint8Array(text.length / 2)
  for (let i = 0; i < text.length; i += 2) {
    const high = nibbleOf(text[i])
    const low = nibbleOf(text[i + 1])
    if (high < 0 || low < 0)
      return undefined
    bytes[i / 2] = (high << 4) | low
  }
  return bytes
}

const nibbleOf = (character: string): number => character === '?' ? 0 : hexDigit(character)

/** The 7-bit encoded length a string's bytes are prefixed with, which "Paste UTF8 String" writes. */
export function sevenBitLengthPrefix(length: number): Uint8Array {
  const bytes: number[] = []
  let value = length
  while (value >= 0x80) {
    bytes.push((value & 0x7F) | 0x80)
    value >>>= 7
  }
  bytes.push(value)
  return Uint8Array.from(bytes)
}

/** The compressed unsigned integer a metadata blob's bytes are prefixed with. */
export function compressedUIntPrefix(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  if (length < 0x4000) return Uint8Array.of((length >> 8) | 0x80, length & 0xFF)
  return Uint8Array.of((length >> 24) | 0xC0, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF)
}

/** Concatenates the parts a paste writes. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let position = 0
  for (const part of parts) {
    result.set(part, position)
    position += part.length
  }
  return result
}
