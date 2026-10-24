import { describe, expect, it } from 'vitest'
import { createSearchPattern, findAllInBytes, isSearchDataValid, tryParseData } from './hex-search'

describe('hex search', () => {
  it('reads a byte pattern with ? as a nibble that matches anything', () => {
    const pattern = createSearchPattern('bytes', '4D ?A', true, false)!
    expect(pattern.pattern).toEqual(Uint8Array.of(0x4D, 0x0A))
    expect(pattern.mask).toEqual(Uint8Array.of(0xFF, 0x0F))
    expect(findAllInBytes(pattern, Uint8Array.of(0, 0x4D, 0x5A, 0x4D, 0x3A), 0, 0, {})).toEqual([1, 3])
  })

  it('parses numbers in both byte orders the way DataParser does', () => {
    expect(tryParseData('0x1234', 'uInt16', false)).toEqual(Uint8Array.of(0x34, 0x12))
    expect(tryParseData('-1', 'int16', true)).toEqual(Uint8Array.of(0xFF, 0xFF))
    expect(tryParseData('300', 'byte', false)).toBeUndefined()
    expect(isSearchDataValid('int32', 'abc', false)).toBe(false)
  })

  it('matches a string without case a character at a time', () => {
    const pattern = createSearchPattern('utf8String', 'mZ', false, false)!
    const data = new TextEncoder().encode('xMzmZ')
    expect(findAllInBytes(pattern, data, 0, 0, {})).toEqual([1, 3])
  })

  it('wraps and searches backwards in FindAll’s order', () => {
    const pattern = createSearchPattern('bytes', 'AA', true, false)!
    const data = Uint8Array.of(0xAA, 0, 0xAA, 0, 0xAA)
    expect(findAllInBytes(pattern, data, 0, 3, { wrap: true })).toEqual([4, 0, 2])
    // Backwards, the start is the last byte a match may end on.
    expect(findAllInBytes(pattern, data, 0, 2, { reverse: true, maxResults: 1 })).toEqual([2])
  })

  it('maps case a character to a character, as .NET does: ß matches itself', () => {
    const pattern = createSearchPattern('utf8String', 'straße', false, false)!
    expect(pattern).toBeTruthy()
    const data = new TextEncoder().encode('xSTRAßE')
    expect(findAllInBytes(pattern, data, 0, 0, {})).toEqual([1])
  })
})
