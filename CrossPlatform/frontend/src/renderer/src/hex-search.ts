/**
 * dnSpy's hex search: the data kinds the search control offers (`HexDataKind`), how the text the user typed
 * becomes bytes (`DataParser`, `HexSearchServiceProvider`), and the matching itself (`ByteHexSearchService`,
 * `StringHexSearchService`) for the bytes the view reads itself — a process's memory. A module's file is
 * searched by the backend with the same pattern (`hex/search`).
 */

export type HexDataKind =
  | 'bytes' | 'utf8String' | 'utf16String'
  | 'byte' | 'sByte' | 'int16' | 'uInt16' | 'int32' | 'uInt32' | 'int64' | 'uInt64' | 'single' | 'double'

/** `HexViewSearchServiceImpl.dataKindVMList`: the data kind box, with the Alt shortcuts of the first three. */
export const HEX_DATA_KINDS: readonly { kind: HexDataKind; label: string; shortcut?: string }[] = [
  { kind: 'bytes', label: 'Hex', shortcut: 'Alt+H' },
  { kind: 'utf8String', label: 'String (UTF-8)', shortcut: 'Alt+8' },
  { kind: 'utf16String', label: 'String (Unicode)', shortcut: 'Alt+U' },
  { kind: 'byte', label: 'Byte' },
  { kind: 'sByte', label: 'SByte' },
  { kind: 'int16', label: 'Int16' },
  { kind: 'uInt16', label: 'UInt16' },
  { kind: 'int32', label: 'Int32' },
  { kind: 'uInt32', label: 'UInt32' },
  { kind: 'int64', label: 'Int64' },
  { kind: 'uInt64', label: 'UInt64' },
  { kind: 'single', label: 'Single' },
  { kind: 'double', label: 'Double' },
]

/**
 * What a search looks for. Bytes match when `(data & mask) == (pattern & mask)`; a case-insensitive string has
 * the lower case encoding in `pattern`, the upper case one in `alternate`, and each character's byte length in
 * `charLengths` — a character matches when its bytes equal either of its two encodings.
 */
export interface HexSearchPattern {
  pattern: Uint8Array
  mask?: Uint8Array
  alternate?: Uint8Array
  charLengths?: number[]
}

const hexDigit = (character: string): number => {
  const code = character.charCodeAt(0)
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  return -1
}

const isWhiteSpace = (character: string): boolean => /\s/.test(character)

/** `NumberParser.TryParseUnsigned`: decimal, or hexadecimal after `0x`/`&H`, inside `min..max`. */
function tryParseUnsigned(text: string, min: bigint, max: bigint): bigint | undefined {
  const value = text.trim()
  let parsed: bigint
  if (/^(0x|&H)/i.test(value)) {
    const digits = value.slice(2)
    if (digits.trim() !== digits || !/^[0-9a-f]+$/i.test(digits))
      return undefined
    parsed = BigInt(`0x${digits}`)
  }
  else {
    if (!/^\+?\d+$/.test(value))
      return undefined
    parsed = BigInt(value.replace('+', ''))
  }
  return parsed < min || parsed > max ? undefined : parsed
}

/** `NumberParser.TryParseSigned`: an optional `-`, then what `TryParseUnsigned` reads. */
function tryParseSigned(text: string, min: bigint, max: bigint): bigint | undefined {
  let value = text.trim()
  const negative = value.startsWith('-')
  if (negative)
    value = value.slice(1)
  if (value.trim() !== value)
    return undefined
  let magnitude: bigint
  if (/^(0x|&H)/i.test(value)) {
    const digits = value.slice(2)
    if (digits.trim() !== digits || !/^[0-9a-f]+$/i.test(digits))
      return undefined
    magnitude = BigInt(`0x${digits}`)
  }
  else {
    if (!/^\+?\d+$/.test(value))
      return undefined
    magnitude = BigInt(value.replace('+', ''))
  }
  const result = negative ? -magnitude : magnitude
  return result < min || result > max ? undefined : result
}

/** `NumberParser.TryParseByteArray`: hex digits, two to a byte, whitespace anywhere; an odd digit is a high nibble. */
function tryParseByteArray(text: string): Uint8Array | undefined {
  const digits: number[] = []
  for (const character of text) {
    if (isWhiteSpace(character))
      continue
    const value = hexDigit(character)
    if (value < 0)
      return undefined
    digits.push(value)
  }
  const bytes = new Uint8Array(Math.ceil(digits.length / 2))
  for (let i = 0; i < digits.length; i += 2)
    bytes[i / 2] = (digits[i] << 4) | (i + 1 < digits.length ? digits[i + 1] : 0)
  return bytes
}

const integerBytes = (value: bigint, byteCount: number, bigEndian: boolean): Uint8Array => {
  const unsigned = BigInt.asUintN(byteCount * 8, value)
  const bytes = new Uint8Array(byteCount)
  for (let i = 0; i < byteCount; i++) {
    const byte = Number((unsigned >> BigInt(8 * i)) & BigInt(0xFF))
    bytes[bigEndian ? byteCount - 1 - i : i] = byte
  }
  return bytes
}

const encodeUtf16 = (text: string, bigEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes[i * 2 + (bigEndian ? 1 : 0)] = code & 0xFF
    bytes[i * 2 + (bigEndian ? 0 : 1)] = code >> 8
  }
  return bytes
}

const floatBytes = (value: number, byteCount: 4 | 8, bigEndian: boolean): Uint8Array => {
  const view = new DataView(new ArrayBuffer(byteCount))
  if (byteCount === 4)
    view.setFloat32(0, value, !bigEndian)
  else
    view.setFloat64(0, value, !bigEndian)
  return new Uint8Array(view.buffer)
}

/** .NET's `float.TryParse`/`double.TryParse` with the invariant culture's number styles. */
const tryParseFloat = (text: string): number | undefined => {
  const value = text.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value))
    return Number(value)
  if (/^[+-]?(Infinity|∞)$/i.test(value))
    return value.startsWith('-') ? -Infinity : Infinity
  if (/^NaN$/i.test(value))
    return Number.NaN
  return undefined
}

/** `DataParser.TryParseData`: the bytes a value of a data kind stands for — what Replace writes. */
export function tryParseData(text: string, kind: HexDataKind, bigEndian: boolean): Uint8Array | undefined {
  switch (kind) {
    case 'bytes': return tryParseByteArray(text)
    case 'utf8String': return new TextEncoder().encode(text)
    case 'utf16String': return encodeUtf16(text, bigEndian)
    case 'byte': { const value = tryParseUnsigned(text, BigInt(0), BigInt(0xFF)); return value === undefined ? undefined : integerBytes(value, 1, false) }
    case 'sByte': { const value = tryParseSigned(text, BigInt(-0x80), BigInt(0x7F)); return value === undefined ? undefined : integerBytes(value, 1, false) }
    case 'int16': { const value = tryParseSigned(text, BigInt(-0x8000), BigInt(0x7FFF)); return value === undefined ? undefined : integerBytes(value, 2, bigEndian) }
    case 'uInt16': { const value = tryParseUnsigned(text, BigInt(0), BigInt(0xFFFF)); return value === undefined ? undefined : integerBytes(value, 2, bigEndian) }
    case 'int32': { const value = tryParseSigned(text, BigInt(-0x80000000), BigInt(0x7FFFFFFF)); return value === undefined ? undefined : integerBytes(value, 4, bigEndian) }
    case 'uInt32': { const value = tryParseUnsigned(text, BigInt(0), BigInt(0xFFFFFFFF)); return value === undefined ? undefined : integerBytes(value, 4, bigEndian) }
    case 'int64': { const value = tryParseSigned(text, -(BigInt(1) << BigInt(63)), (BigInt(1) << BigInt(63)) - BigInt(1)); return value === undefined ? undefined : integerBytes(value, 8, bigEndian) }
    case 'uInt64': { const value = tryParseUnsigned(text, BigInt(0), (BigInt(1) << BigInt(64)) - BigInt(1)); return value === undefined ? undefined : integerBytes(value, 8, bigEndian) }
    case 'single': { const value = tryParseFloat(text); return value === undefined ? undefined : floatBytes(value, 4, bigEndian) }
    case 'double': { const value = tryParseFloat(text); return value === undefined ? undefined : floatBytes(value, 8, bigEndian) }
    default: return undefined
  }
}

/** `HexSearchServiceProvider.IsValidByteSearchString`: hex digits, `?` and whitespace, at least one non-space. */
export function isValidByteSearchString(text: string): boolean {
  let any = false
  for (const character of text) {
    if (isWhiteSpace(character))
      continue
    if (character !== '?' && hexDigit(character) < 0)
      return false
    any = true
  }
  return any
}

/** `HexSearchServiceProvider.CreateByteSearchService(string)`: `?` is a nibble that matches anything. */
function byteSearchPattern(text: string): HexSearchPattern {
  const nibbles: string[] = []
  for (const character of text) {
    if (!isWhiteSpace(character))
      nibbles.push(character)
  }
  const length = Math.ceil(nibbles.length / 2)
  const pattern = new Uint8Array(length)
  const mask = new Uint8Array(length)
  for (let i = 0; i < nibbles.length; i += 2) {
    let value = 0
    let bits = 0
    if (nibbles[i] !== '?') {
      bits |= 0xF0
      value |= hexDigit(nibbles[i]) << 4
    }
    if (i + 1 < nibbles.length && nibbles[i + 1] !== '?') {
      bits |= 0x0F
      value |= hexDigit(nibbles[i + 1])
    }
    pattern[i / 2] = value
    mask[i / 2] = bits
  }
  return { pattern, mask }
}

/** The bytes and byte length of every character of a text in an encoding, a surrogate pair being one. */
const encodeByCharacter = (text: string, encode: (part: string) => Uint8Array): { bytes: Uint8Array; lengths: number[] } => {
  const parts = Array.from(text, (character) => encode(character))
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let position = 0
  for (const part of parts) {
    bytes.set(part, position)
    position += part.length
  }
  return { bytes, lengths: parts.map((part) => part.length) }
}

/** `StringHexSearchService.Initialize`: a case-insensitive string, or undefined when its lower and upper case
 * forms do not encode to bytes of the same shape — the search then finds nothing, as dnSpy's does. */
function caseInsensitivePattern(text: string, encode: (part: string) => Uint8Array): HexSearchPattern | undefined {
  const lower = text.toLowerCase()
  const upper = text.toUpperCase()
  if (lower.length !== upper.length)
    return undefined
  const lowerBytes = encodeByCharacter(lower, encode)
  const upperBytes = encodeByCharacter(upper, encode)
  if (lowerBytes.bytes.length !== upperBytes.bytes.length || lowerBytes.lengths.length !== upperBytes.lengths.length)
    return undefined
  if (lowerBytes.lengths.some((length, index) => length !== upperBytes.lengths[index]))
    return undefined
  return { pattern: lowerBytes.bytes, alternate: upperBytes.bytes, charLengths: lowerBytes.lengths }
}

/** `HexSearchServiceFactory.IsSearchDataValid`. */
export function isSearchDataValid(kind: HexDataKind, text: string, bigEndian: boolean): boolean {
  if (text === '')
    return false
  if (kind === 'bytes')
    return isValidByteSearchString(text)
  if (kind === 'utf8String' || kind === 'utf16String')
    return true
  return tryParseData(text, kind, bigEndian) !== undefined
}

/**
 * `HexSearchServiceFactory.TryCreateHexSearchService`: the pattern a search looks for, or undefined when the text
 * is not valid for its data kind. A case-sensitive Unicode string is looked for little endian whatever the big
 * endian box says — dnSpy's `CreateUtf16StringSearchService` does the same. A pattern with no bytes finds nothing.
 */
export function createSearchPattern(kind: HexDataKind, text: string, matchCase: boolean, bigEndian: boolean): HexSearchPattern | undefined | null {
  if (text === '')
    return undefined
  switch (kind) {
    case 'bytes':
      return isValidByteSearchString(text) ? byteSearchPattern(text) : undefined
    case 'utf8String':
      return matchCase ? { pattern: new TextEncoder().encode(text) } : caseInsensitivePattern(text, (part) => new TextEncoder().encode(part)) ?? null
    case 'utf16String':
      return matchCase ? { pattern: encodeUtf16(text, false) } : caseInsensitivePattern(text, (part) => encodeUtf16(part, bigEndian)) ?? null
    default: {
      const data = tryParseData(text, kind, bigEndian)
      return data === undefined ? undefined : { pattern: data }
    }
  }
}

/** Whether the pattern matches the bytes at `index` of `data`. */
export function matchesAt(search: HexSearchPattern, data: Uint8Array, index: number): boolean {
  const { pattern, mask, alternate, charLengths } = search
  if (index < 0 || index + pattern.length > data.length)
    return false
  if (alternate && charLengths) {
    let offset = 0
    for (const length of charLengths) {
      let lower = true
      let upper = true
      for (let i = 0; i < length; i++) {
        const byte = data[index + offset + i]
        if (byte !== pattern[offset + i]) lower = false
        if (byte !== alternate[offset + i]) upper = false
      }
      if (!lower && !upper)
        return false
      offset += length
    }
    return true
  }
  for (let i = 0; i < pattern.length; i++) {
    const bits = mask ? mask[i] : 0xFF
    if ((data[index + i] & bits) !== (pattern[i] & bits))
      return false
  }
  return true
}

/**
 * `FindAll` over bytes held in memory, in dnSpy's order: forward from `start` to the range end and then — with
 * `wrap` — the matches before it; backward, `start` being the last byte a match may end on, and then the ones
 * after it. `data` holds the range, `rangeStart` is the offset its first byte stands for.
 */
export function findAllInBytes(search: HexSearchPattern, data: Uint8Array, rangeStart: number, start: number, options: { reverse?: boolean; wrap?: boolean; noOverlaps?: boolean; maxResults?: number }): number[] {
  const results: number[] = []
  const length = search.pattern.length
  const rangeEnd = rangeStart + data.length
  const max = options.maxResults ?? Number.MAX_SAFE_INTEGER
  if (length === 0 || data.length === 0)
    return results
  const at = (position: number): boolean => matchesAt(search, data, position - rangeStart)
  const forwardBlock = (from: number, upperBounds: number): number[] => {
    const found: number[] = []
    let position = from
    while (position + length <= upperBounds && results.length + found.length < max) {
      if (at(position)) {
        found.push(position)
        position += options.noOverlaps ? length : 1
      }
      else
        position++
    }
    return found
  }
  // The last byte a match may end on, walking down to `lowerBounds`.
  const reverseBlock = (lastByte: number, lowerBounds: number): number[] => {
    const found: number[] = []
    let end = lastByte
    while (end - (length - 1) >= lowerBounds && results.length + found.length < max) {
      const position = end - (length - 1)
      if (at(position)) {
        found.push(position)
        end = options.noOverlaps ? position - 1 : position + length - 2
      }
      else
        end--
    }
    return found
  }
  if (!options.reverse) {
    const first = forwardBlock(start, rangeEnd)
    results.push(...first)
    if (options.wrap) {
      let upperBounds = Math.min(rangeEnd, start + length - 1)
      if (options.noOverlaps && first.length > 0 && upperBounds > first[0])
        upperBounds = first[0]
      results.push(...forwardBlock(rangeStart, upperBounds))
    }
  }
  else {
    const first = reverseBlock(Math.min(start, rangeEnd - 1), rangeStart)
    results.push(...first)
    if (options.wrap) {
      let lowerBounds = Math.max(rangeStart, start - (length - 1))
      if (options.noOverlaps && first.length > 0 && lowerBounds < first[0] + length)
        lowerBounds = first[0] + length
      results.push(...reverseBlock(rangeEnd - 1, lowerBounds))
    }
  }
  return results.slice(0, max)
}
