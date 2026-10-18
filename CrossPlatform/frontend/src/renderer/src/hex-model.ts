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
 * the decimal ones share `MAX_LENGTH` (21, the widest Int64), which is why every decimal cell is equally wide.
 */
export const HEX_VALUE_FORMATS: readonly HexValueFormatInfo[] = [
  { format: 'hexByte', label: 'Byte (hex)', byteCount: 1, formattedLength: 2 },
  { format: 'decimalByte', label: 'Byte (decimal)', byteCount: 1, formattedLength: 21 },
  { format: 'hexUInt16', label: 'UInt16 (hex)', byteCount: 2, formattedLength: 4 },
  { format: 'decimalUInt16', label: 'UInt16 (decimal)', byteCount: 2, formattedLength: 21 },
  { format: 'hexUInt16Be', label: 'UInt16 (hex, big endian)', byteCount: 2, formattedLength: 4 },
  { format: 'decimalUInt16Be', label: 'UInt16 (decimal, big endian)', byteCount: 2, formattedLength: 21 },
  { format: 'hexUInt32', label: 'UInt32 (hex)', byteCount: 4, formattedLength: 8 },
  { format: 'decimalUInt32', label: 'UInt32 (decimal)', byteCount: 4, formattedLength: 21 },
  { format: 'hexUInt32Be', label: 'UInt32 (hex, big endian)', byteCount: 4, formattedLength: 8 },
  { format: 'decimalUInt32Be', label: 'UInt32 (decimal, big endian)', byteCount: 4, formattedLength: 21 },
  { format: 'hexUInt64', label: 'UInt64 (hex)', byteCount: 8, formattedLength: 16 },
  { format: 'decimalUInt64', label: 'UInt64 (decimal)', byteCount: 8, formattedLength: 21 },
  { format: 'hexUInt64Be', label: 'UInt64 (hex, big endian)', byteCount: 8, formattedLength: 16 },
  { format: 'decimalUInt64Be', label: 'UInt64 (decimal, big endian)', byteCount: 8, formattedLength: 21 },
  { format: 'hexSByte', label: 'SByte (hex)', byteCount: 1, formattedLength: 3 },
  { format: 'decimalSByte', label: 'SByte (decimal)', byteCount: 1, formattedLength: 21 },
  { format: 'hexInt16', label: 'Int16 (hex)', byteCount: 2, formattedLength: 5 },
  { format: 'decimalInt16', label: 'Int16 (decimal)', byteCount: 2, formattedLength: 21 },
  { format: 'hexInt16Be', label: 'Int16 (hex, big endian)', byteCount: 2, formattedLength: 5 },
  { format: 'decimalInt16Be', label: 'Int16 (decimal, big endian)', byteCount: 2, formattedLength: 21 },
  { format: 'hexInt32', label: 'Int32 (hex)', byteCount: 4, formattedLength: 9 },
  { format: 'decimalInt32', label: 'Int32 (decimal)', byteCount: 4, formattedLength: 21 },
  { format: 'hexInt32Be', label: 'Int32 (hex, big endian)', byteCount: 4, formattedLength: 9 },
  { format: 'decimalInt32Be', label: 'Int32 (decimal, big endian)', byteCount: 4, formattedLength: 21 },
  { format: 'hexInt64', label: 'Int64 (hex)', byteCount: 8, formattedLength: 17 },
  { format: 'decimalInt64', label: 'Int64 (decimal)', byteCount: 8, formattedLength: 21 },
  { format: 'hexInt64Be', label: 'Int64 (hex, big endian)', byteCount: 8, formattedLength: 17 },
  { format: 'decimalInt64Be', label: 'Int64 (decimal, big endian)', byteCount: 8, formattedLength: 21 },
  { format: 'single', label: 'Single', byteCount: 4, formattedLength: 13 },
  { format: 'singleBe', label: 'Single (big endian)', byteCount: 4, formattedLength: 13 },
  { format: 'double', label: 'Double', byteCount: 8, formattedLength: 23 },
  { format: 'doubleBe', label: 'Double (big endian)', byteCount: 8, formattedLength: 23 },
  { format: 'bit8', label: '8 Bits', byteCount: 1, formattedLength: 8 },
]

const valueFormatByFormat = new Map(HEX_VALUE_FORMATS.map((info) => [info.format, info]))

export const hexValueFormatInfo = (format: HexValuesFormat): HexValueFormatInfo =>
  valueFormatByFormat.get(format) ?? HEX_VALUE_FORMATS[0]

/** Everything about how the lines are drawn, gathered the way dnSpy's `HexBufferLineFormatterOptions` is. */
export interface HexLineFormatOptions {
  /** Bytes one line holds; 0 asks for "fit to width", which the view works out from its own width. */
  bytesPerLine: number
  /** Bytes in a group; 0 means dnSpy's default of 8. */
  groupSize: number
  showOffset: boolean
  showValues: boolean
  showAscii: boolean
  offsetFormat: HexOffsetFormatKind
  /** Bits the offset is written in; 0 picks the narrowest width that holds the last offset. */
  offsetBitSize: number
  valuesLowerCaseHex: boolean
  offsetLowerCaseHex: boolean
  valuesFormat: HexValuesFormat
}

export const defaultHexLineFormat = (): HexLineFormatOptions => ({
  bytesPerLine: 16,
  groupSize: 8,
  showOffset: true,
  showValues: true,
  showAscii: true,
  offsetFormat: 'hex',
  offsetBitSize: 0,
  valuesLowerCaseHex: false,
  offsetLowerCaseHex: false,
  valuesFormat: 'hexByte',
})

/** dnSpy's `HexBufferLineFormatterOptions` limits: 0 means fit-to-width, 1024 the most bytes a line takes. */
export const MAX_BYTES_PER_LINE = 1024
export const MAX_OFFSET_BIT_SIZE = 64

/** The narrowest offset width that holds the last address, in dnSpy's 8, 16, 24 … 64 steps. */
export function offsetBitSizeFor(length: number): number {
  const last = Math.max(0, length - 1)
  if (last <= 0xFF) return 8
  if (last <= 0xFFFF) return 16
  if (last <= 0xFFFFFF) return 24
  if (last <= 0xFFFFFFFF) return 32
  if (last <= 0xFF_FFFFFFFF) return 40
  if (last <= 0xFFFF_FFFFFFFF) return 48
  if (last <= 0xFFFFFF_FFFFFFFF) return 56
  return 64
}

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
  const text = (offset >>> 0).toString(16).padStart(digits, '0').slice(-digits)
  const { prefix, suffix } = offsetAffixes(format)
  return prefix + (lowerCase ? text.toLowerCase() : text.toUpperCase()) + suffix
}

/** The width of an offset column, which the layout needs before it can fit the bytes. */
export function offsetTextLength(bitSize: number, format: HexOffsetFormatKind): number {
  const { prefix, suffix } = offsetAffixes(format)
  return prefix.length + Math.max(1, Math.ceil(bitSize / 4)) + suffix.length
}

/**
 * dnSpy's `CalculateBytesPerLine`: how many bytes fit in `charsPerLine` characters once the offset column
 * and the separators between columns are paid for. With both the values and the ASCII column shown the two
 * share what is left — `VC * VL + (VC - 1)` for the values plus `VC * VB` for the ASCII — and the answer is
 * a whole number of value cells.
 */
export function bytesPerLineForWidth(charsPerLine: number, options: HexLineFormatOptions, bitSize: number): number {
  const info = hexValueFormatInfo(options.valuesFormat)
  const columnCount = (options.showOffset ? 1 : 0) + (options.showValues ? 1 : 0) + (options.showAscii ? 1 : 0)
  if (columnCount === 0)
    return 1
  let fixedLength = columnCount - 1
  if (options.showOffset)
    fixedLength += offsetTextLength(bitSize, options.offsetFormat)
  if (fixedLength >= charsPerLine)
    return options.showValues ? info.byteCount : 1
  const remaining = charsPerLine - fixedLength
  if (options.showValues && options.showAscii) {
    const cells = Math.floor((remaining + 1) / (info.formattedLength + 1 + info.byteCount))
    return Math.max(1, cells) * info.byteCount
  }
  if (options.showValues) {
    const cells = Math.floor((remaining + 1) / (info.formattedLength + 1))
    return Math.max(1, cells) * info.byteCount
  }
  return Math.max(1, remaining)
}

/** The bytes a line holds once the value format's cell width and dnSpy's limits have been applied. */
export function resolveBytesPerLine(options: HexLineFormatOptions, bitSize: number, charsPerLine: number): number {
  const info = hexValueFormatInfo(options.valuesFormat)
  let bytes = options.bytesPerLine
  if (bytes === 0)
    bytes = bytesPerLineForWidth(charsPerLine, options, bitSize)
  if (bytes % info.byteCount !== 0)
    bytes = bytes - bytes % info.byteCount + info.byteCount
  if (bytes > MAX_BYTES_PER_LINE)
    bytes = Math.floor(MAX_BYTES_PER_LINE / info.byteCount) * info.byteCount
  return Math.max(info.byteCount, bytes)
}

/** The group size dnSpy settles on: 8 when none was asked for, never more than a line, a value multiple. */
export function resolveGroupSize(options: HexLineFormatOptions, bytesPerLine: number): number {
  const info = hexValueFormatInfo(options.valuesFormat)
  let group = options.groupSize === 0 ? 8 : options.groupSize
  if (group > bytesPerLine)
    group = bytesPerLine
  group = Math.ceil(group / info.byteCount) * info.byteCount
  return group > 0 ? group : bytesPerLine
}

/** The index a cell's group alternates between, which is what colors every other group. */
export const groupIndexOf = (byteOffsetInLine: number, groupSize: number): number =>
  Math.floor(byteOffsetInLine / groupSize) & 1

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
  const text = value.toPrecision(precision)
  const exponent = text.indexOf('e')
  const coefficient = exponent < 0 ? text : text.slice(0, exponent)
  const trimmed = coefficient.includes('.') ? coefficient.replace(/\.?0+$/, '') : coefficient
  if (exponent < 0)
    return trimmed
  const power = Number(text.slice(exponent + 1))
  return `${trimmed}E${power < 0 ? '-' : '+'}${Math.abs(power).toString().padStart(2, '0')}`
}

/** dnSpy's decimal cells are right-aligned in a 21-character column (`MAX_LENGTH`). */
const decimalOf = (value: bigint | undefined): string =>
  value === undefined ? invalidValue(21) : value.toString(10).padStart(21, ' ')

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
  switch (format) {
    case 'hexByte': return hex()
    case 'decimalByte': return decimalOf(unsigned())
    case 'hexUInt16': return hex()
    case 'decimalUInt16': return decimalOf(unsigned())
    case 'hexUInt16Be': return hex(true)
    case 'decimalUInt16Be': return decimalOf(unsigned(true))
    case 'hexUInt32': return hex()
    case 'decimalUInt32': return decimalOf(unsigned())
    case 'hexUInt32Be': return hex(true)
    case 'decimalUInt32Be': return decimalOf(unsigned(true))
    case 'hexUInt64': return hex()
    case 'decimalUInt64': return decimalOf(unsigned())
    case 'hexUInt64Be': return hex(true)
    case 'decimalUInt64Be': return decimalOf(unsigned(true))
    case 'hexSByte': return signedHex()
    case 'decimalSByte': return decimalOf(signed())
    case 'hexInt16': return signedHex()
    case 'decimalInt16': return decimalOf(signed())
    case 'hexInt16Be': return signedHex(true)
    case 'decimalInt16Be': return decimalOf(signed(true))
    case 'hexInt32': return signedHex()
    case 'decimalInt32': return decimalOf(signed())
    case 'hexInt32Be': return signedHex(true)
    case 'decimalInt32Be': return decimalOf(signed(true))
    case 'hexInt64': return signedHex()
    case 'decimalInt64': return decimalOf(signed())
    case 'hexInt64Be': return signedHex(true)
    case 'decimalInt64Be': return decimalOf(signed(true))
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

/** The byte at `offset`, read out of the chunk that starts at `chunkStart`; undefined outside the chunk. */
export const byteAt = (bytes: Uint8Array, chunkStart: number, offset: number): number | undefined => {
  const index = offset - chunkStart
  return index >= 0 && index < bytes.length ? bytes[index] : undefined
}

/** A selection, as the first byte covered and one past the last one — possibly empty. */
export interface HexSelection {
  start: number
  end: number
}

/** The selection the caret and the anchor name, whichever way round they are. */
export const selectionBetween = (anchor: number, caret: number): HexSelection =>
  anchor <= caret ? { start: anchor, end: caret + 1 } : { start: caret, end: anchor + 1 }

/** A cell of the dump: its text, which group it belongs to, and the byte it starts at. */
export interface HexCellVm {
  text: string
  group: number
  byteOffset: number
}

/** A row of the dump, ready to render: the address and the cells of the columns that are shown. */
export interface HexLineVm {
  offset: number
  address: string
  values: HexCellVm[]
  ascii: HexCellVm[]
}

/**
 * One line of the dump. `bytes` is the chunk the line was read from, so a line the chunk only partly covers
 * still gets its address and the cells the chunk holds; the rest read as dnSpy's unreadable cells.
 */
export function lineOf(
  bytes: Uint8Array,
  chunkStart: number,
  offset: number,
  fileLength: number,
  lineFormat: HexLineFormatOptions,
  bytesPerLine: number,
): HexLineVm {
  const info = hexValueFormatInfo(lineFormat.valuesFormat)
  const groupSize = resolveGroupSize(lineFormat, bytesPerLine)
  const count = Math.min(bytesPerLine, Math.max(0, fileLength - offset))
  const values: HexCellVm[] = []
  if (lineFormat.showValues) {
    for (let i = 0; i < count; i += info.byteCount) {
      const index = offset + i - chunkStart
      const cellBytes = index >= 0 && index < bytes.length
        ? bytes.subarray(index, Math.min(bytes.length, index + info.byteCount))
        : new Uint8Array(0)
      values.push({ text: formatHexValue(cellBytes, 0, lineFormat.valuesFormat, lineFormat.valuesLowerCaseHex), group: groupIndexOf(i, groupSize), byteOffset: i })
    }
  }
  const ascii: HexCellVm[] = []
  if (lineFormat.showAscii) {
    for (let i = 0; i < count; i++) {
      const byte = byteAt(bytes, chunkStart, offset + i)
      ascii.push({ text: byte === undefined ? ' ' : asciiOf(byte), group: groupIndexOf(i, groupSize), byteOffset: i })
    }
  }
  return {
    offset,
    address: lineFormat.showOffset ? formatHexOffset(offset, lineFormat.offsetBitSize, lineFormat.offsetFormat, lineFormat.offsetLowerCaseHex) : '',
    values,
    ascii,
  }
}

/** dnSpy's hexadecimal clipboard text: two digits per byte and nothing in between. */
export const hexText = (bytes: Uint8Array, upper: boolean): string => {
  const text = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return upper ? text.toUpperCase() : text.toLowerCase()
}

/** dnSpy's `HexEditorOperationsImpl.CopyCSharpArray`. */
export function csharpArrayText(bytes: Uint8Array, upper: boolean): string {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 16)
    rows.push('\t' + Array.from(bytes.subarray(i, i + 16), (value) => '0x' + hexText(Uint8Array.of(value), upper)).join(', '))
  // dnSpy numbers each row's entries with a comma after every one but the span's last byte.
  return `new byte[] {\n${rows.join(',\n')}\n};\n`
}

/** dnSpy's `HexEditorOperationsImpl.CopyVisualBasicArray`. */
export function visualBasicArrayText(bytes: Uint8Array, upper: boolean): string {
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 16)
    rows.push('\t' + Array.from(bytes.subarray(i, i + 16), (value) => '&H' + hexText(Uint8Array.of(value), upper)).join(', '))
  return `New Byte() { _\n${rows.join(', _\n')}, _\n}\n`
}

/** A `0x` number of the width its bytes hold, as every Copy Special number is written. */
export function hexNumberText(value: number | bigint, digits?: number): string {
  const text = (typeof value === 'bigint' ? value.toString(16) : value.toString(16)).toUpperCase()
  return '0x' + (digits === undefined ? text : text.padStart(digits, '0'))
}

/**
 * Parses what dnSpy accepts as hexadecimal bytes — `4D5A`, `4D 5A`, `4d 5a`, with `?` meaning a zero
 * nibble — and answers undefined for anything that is not one. Whitespace may sit between any two digits.
 */
export function parseHexBytes(text: string): Uint8Array | undefined {
  const digits = text.replace(/\s+/g, '')
  if (digits.length === 0 || digits.length % 2 !== 0)
    return undefined
  const bytes = new Uint8Array(digits.length / 2)
  for (let i = 0; i < digits.length; i += 2) {
    const high = nibbleOf(digits[i])
    const low = nibbleOf(digits[i + 1])
    if (high < 0 || low < 0)
      return undefined
    bytes[i / 2] = (high << 4) | low
  }
  return bytes
}

const nibbleOf = (character: string): number => {
  if (character === '?')
    return 0
  const value = Number.parseInt(character, 16)
  return Number.isFinite(value) && value >= 0 && value <= 15 ? value : -1
}

/** A Find pattern: hexadecimal bytes when they parse as such, the text's bytes otherwise. */
export function findPatternBytes(text: string): Uint8Array | undefined {
  if (text.trim() === '')
    return undefined
  return parseHexBytes(text) ?? new TextEncoder().encode(text)
}

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
