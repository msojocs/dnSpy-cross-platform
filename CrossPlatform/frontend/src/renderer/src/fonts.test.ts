import { describe, expect, it } from 'vitest'
import { formatDateTime } from './dotnet-date-format'
import { DEFAULT_FONT_SIZE, cssFontFamily, defaultFontFamilies, filterFontSize, fontSettingFor, pixelsToPoints, pointsToPixels, resolveDefaultFamily } from './fonts'
import { defaultAppOptions } from './components/app-options'

describe('fonts', () => {
  it('tries dnSpy\'s default families in its order, a language\'s own first', () => {
    expect(defaultFontFamilies('en')).toEqual(['Consolas', 'Lucida Console', 'Courier New', 'Courier', 'Liberation Mono'])
    expect(defaultFontFamilies('zh-CN')[0]).toBe('NSimSun')
    expect(defaultFontFamilies('ko', true)[0]).toBe('Consolas')
    expect(defaultFontFamilies('ko', false)[0]).toBe('DotumChe')
  })

  it('writes a chosen family in front of the defaults', () => {
    expect(cssFontFamily({ fontFamily: 'Fira Code', fontSize: 12 }, 'textEditor')).toMatch(/^"Fira Code", Consolas, "Lucida Console"/)
    expect(cssFontFamily({ fontSize: 12 }, 'hexEditor')).toMatch(/monospace$/)
  })

  it('sizes in points on the page and pixels in the options, within FilterFontSize\'s bounds', () => {
    expect(pixelsToPoints(DEFAULT_FONT_SIZE)).toBe(10)
    expect(pointsToPixels(12)).toBe(16)
    expect(filterFontSize(0)).toBe(1)
    expect(filterFontSize(500)).toBe(200)
  })

  it('keeps a font per category and theme, and dnSpy\'s default otherwise', () => {
    const options = { ...defaultAppOptions, environmentFont: { byTheme: { G: { hexEditor: { fontFamily: 'Mono X', fontSize: 20 } } } } }
    expect(fontSettingFor(options, 'G', 'hexEditor')).toEqual({ fontFamily: 'Mono X', fontSize: 20 })
    expect(fontSettingFor(options, 'G', 'textEditor')).toEqual({ fontSize: DEFAULT_FONT_SIZE })
    expect(fontSettingFor(options, 'other', 'hexEditor')).toEqual({ fontSize: DEFAULT_FONT_SIZE })
  })

  it('names the default family as the first one installed, Courier New when none is', () => {
    expect(resolveDefaultFamily([{ family: 'liberation mono', monospaced: true }, { family: 'Arial', monospaced: false }], 'textEditor')).toBe('liberation mono')
    expect(resolveDefaultFamily([], 'hexEditor')).toBe('Courier New')
  })
})

describe('formatDateTime', () => {
  const date = new Date(2026, 9, 7, 15, 4, 5, 67)

  it('writes .NET\'s custom specifiers', () => {
    expect(formatDateTime(date, 'HH:mm:ss.fff')).toBe('15:04:05.067')
    expect(formatDateTime(date, 'h:m:s')).toBe('3:4:5')
    expect(formatDateTime(date, 'yyyy-MM-dd')).toBe('2026-10-07')
    expect(formatDateTime(date, 'FFF')).toBe('067')
    expect(formatDateTime(new Date(2026, 0, 1, 0, 0, 0, 500), 'ss.FFF')).toBe('00.5')
  })

  it('copies quoted and escaped text as it is', () => {
    expect(formatDateTime(date, "'at' HH\\h")).toBe('at 15h')
    expect(formatDateTime(date, '%H')).toBe('15')
  })
})
