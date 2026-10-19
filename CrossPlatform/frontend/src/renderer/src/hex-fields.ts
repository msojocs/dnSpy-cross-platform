import type { HexBitField, HexField } from '../../shared/protocol'

/**
 * dnSpy's HexField boxes: how a field of a PE header or a metadata row is written, read back from what was
 * typed into it, and turned into the bytes a patch writes. Numbers are BigInts throughout, since a 64-bit field
 * does not fit a double.
 */

const SIGNED: Partial<Record<HexField['kind'], boolean>> = { int16: true, int32: true }

/** SimpleTypeConverter.ToString(value, useDecimal: false): a digit is written as one, anything else in hex. */
export const formatHexFieldValue = (value: bigint): string =>
  value >= 0n && value <= 9n ? value.toString() : `${value < 0n ? '-' : ''}0x${(value < 0n ? -value : value).toString(16).toUpperCase()}`

/** A field's current value as an unsigned number of its size — what its bits are read from. */
export const hexFieldValue = (field: HexField): bigint => {
  if (field.kind === 'string')
    return 0n
  const parsed = parseInteger(field.text)
  const value = typeof parsed === 'bigint' ? parsed : BigInt(field.value)
  const bits = BigInt(field.size * 8)
  return BigInt.asUintN(Number(bits), value)
}

/** What a bit field of a flags field holds. */
export const bitFieldValue = (value: bigint, bit: HexBitField): bigint =>
  (value >> BigInt(bit.bit)) & ((1n << BigInt(bit.count)) - 1n)

/** A flags value with one bit field replaced. */
export const withBitField = (value: bigint, bit: HexBitField, bits: bigint): bigint => {
  const mask = ((1n << BigInt(bit.count)) - 1n) << BigInt(bit.bit)
  return (value & ~mask) | ((bits << BigInt(bit.bit)) & mask)
}

/** dnSpy's integer forms — decimal, `0x`/`&H` hex, a leading minus — or a message saying why the text is none. */
const parseInteger = (text: string): bigint | string => {
  let trimmed = text.trim().replaceAll('_', '')
  const negative = trimmed.startsWith('-')
  if (negative)
    trimmed = trimmed.slice(1)
  const hexadecimal = /^(0x|&h)/i.test(trimmed)
  const digits = hexadecimal ? trimmed.slice(2) : trimmed
  if (digits.length === 0 || !(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits))
    return 'The value is not a hexadecimal or decimal integer'
  const value = BigInt(hexadecimal ? `0x${digits}` : digits)
  return negative ? -value : value
}

const SIMPLE_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '0': '\0', '"': '"', "'": "'" }

/**
 * SimpleTypeConverter.ParseString: the C# literal dnSpy writes a string field as — double quotes round it, with the
 * escapes `\0`, `\n`, `\"` and the rest, and `\x`, `\u` and `\U` code points. Nothing when the text is no literal.
 */
export const parseStringLiteral = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"'))
    return undefined
  let result = ''
  for (let index = 1; index < trimmed.length - 1; index++) {
    const character = trimmed[index]
    if (character === '"')
      return undefined
    if (character !== '\\') {
      result += character
      continue
    }
    const escape = trimmed[++index]
    if (escape === undefined || index >= trimmed.length - 1)
      return undefined
    if (escape in SIMPLE_ESCAPES) {
      result += SIMPLE_ESCAPES[escape]
      continue
    }
    const digits = escape === 'x' ? /^[0-9a-f]{1,4}/i : escape === 'u' ? /^[0-9a-f]{4}/i : escape === 'U' ? /^[0-9a-f]{8}/i : undefined
    const match = digits?.exec(trimmed.slice(index + 1, trimmed.length - 1))
    if (!match)
      return undefined
    result += String.fromCodePoint(parseInt(match[0], 16))
    index += match[0].length
  }
  return result
}

export interface HexFieldError {
  template: string
  args?: Record<string, string>
}

/** The range a field of this kind and size takes, as dnSpy's DataFieldVM sets Min and Max. */
const rangeOf = (field: HexField): { min: bigint; max: bigint } => {
  const bits = BigInt(field.size * 8)
  return SIGNED[field.kind]
    ? { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n }
    : { min: 0n, max: (1n << bits) - 1n }
}

/**
 * The bytes a field's text stands for, little endian and exactly the field's size, or why it cannot be written:
 * dnSpy's SimpleTypeConverter messages for a number, and for a string the bytes it is written as, cut to the
 * field and padded with zeros.
 */
export const encodeHexFieldText = (field: HexField, text: string): Uint8Array | HexFieldError => {
  if (field.kind === 'string') {
    const value = parseStringLiteral(text)
    if (value === undefined)
      return { template: 'A string must be enclosed in double quotes (")' }
    const encoded = new TextEncoder().encode(value)
    const bytes = new Uint8Array(field.size)
    bytes.set(encoded.subarray(0, field.size))
    return bytes
  }
  const parsed = parseInteger(text)
  if (typeof parsed === 'string')
    return { template: parsed }
  const { min, max } = rangeOf(field)
  if (parsed < min || parsed > max) {
    return min === 0n
      ? { template: 'Value must be between {min} and {max} (0x{maxHex}) inclusive', args: { min: '0', max: max.toString(), maxHex: max.toString(16).toUpperCase() } }
      : { template: 'Value must be between {min} ({sign}0x{minHex}) and {max} (0x{maxHex}) inclusive', args: { min: min.toString(), sign: '-', minHex: (-min).toString(16).toUpperCase(), max: max.toString(), maxHex: max.toString(16).toUpperCase() } }
  }
  return encodeLittleEndian(parsed, field.size)
}

export const encodeLittleEndian = (value: bigint, size: number): Uint8Array => {
  const bytes = new Uint8Array(size)
  let rest = BigInt.asUintN(size * 8, value)
  for (let index = 0; index < size; index++) {
    bytes[index] = Number(rest & 0xFFn)
    rest >>= 8n
  }
  return bytes
}

export const isHexFieldError = (value: Uint8Array | HexFieldError): value is HexFieldError => !(value instanceof Uint8Array)

/** HexField.OffsetString. */
export const formatHexOffset = (offset: number): string => `0x${offset.toString(16).toUpperCase().padStart(8, '0')}`
