import { describe, expect, it } from 'vitest'
import { isCompressedLine, visualWidthOf } from './editor-margins'

const options = { compressEmptyOrWhitespaceLines: true, compressNonLetterLines: true }
const layout = { wraps: true, contentWidth: 800, charWidth: 8, tabSize: 4 }

describe('isCompressedLine', () => {
  it('compresses blank and punctuation-only lines, but not lines with letters or digits', () => {
    expect(isCompressedLine('', options, layout)).toBe(true)
    expect(isCompressedLine('    ', options, layout)).toBe(true)
    expect(isCompressedLine('{}', options, layout)).toBe(true)
    expect(isCompressedLine('int x = 1;', options, layout)).toBe(false)
    expect(isCompressedLine('...', options, layout)).toBe(true)
  })

  it('leaves a line alone when its option is off', () => {
    expect(isCompressedLine('', { ...options, compressEmptyOrWhitespaceLines: false }, layout)).toBe(false)
    expect(isCompressedLine('{}', { ...options, compressNonLetterLines: false }, layout)).toBe(false)
  })

  it('leaves a line that wraps at full height', () => {
    expect(isCompressedLine('....', { ...options, compressEmptyOrWhitespaceLines: false }, { ...layout, contentWidth: 16 })).toBe(false)
    // With word wrap off nothing wraps, so the same line is compressed.
    expect(isCompressedLine('....', { ...options, compressEmptyOrWhitespaceLines: false }, { ...layout, wraps: false, contentWidth: 16 })).toBe(true)
  })

  it('counts a tab as the next tab stop', () => {
    expect(visualWidthOf('\tx', 4)).toBe(5)
    expect(visualWidthOf('ab\tc', 4)).toBe(5)
  })
})
