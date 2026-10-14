import { describe, expect, it, vi } from 'vitest'
import { dsImageClass, dsImageUrl, ensureDsImage, hasDsImage, parseCssColor, themedColor } from './ds-image'

const luminosity = ([r, g, b]: [number, number, number]): number => (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255

describe('dnSpy images in the theme\'s colours', () => {
  it('keeps a light theme\'s image close to how it is drawn', () => {
    // On white, ThemedImageCreator only stretches luminosity by 1/0.9647: the dark outline stays dark.
    const outline = themedColor([0x21, 0x21, 0x21], [255, 255, 255], false)
    expect(luminosity(outline)).toBeLessThan(0.2)
  })

  it('turns a dark outline light on a dark background, and keeps a colour\'s hue', () => {
    const background: [number, number, number] = [0x25, 0x28, 0x2b]
    expect(luminosity(themedColor([0x21, 0x21, 0x21], background, false))).toBeGreaterThan(0.7)
    // The class image's gold stays gold rather than turning grey.
    const [r, g, b] = themedColor([0x99, 0x6f, 0x00], background, false)
    expect(r).toBeGreaterThan(b)
    expect(g).toBeGreaterThan(b)
  })

  it('writes the themed colours into the image and caches the result', () => {
    expect(hasDsImage('ClassPublic')).toBe(true)
    expect(hasDsImage('NoSuchImage')).toBe(false)
    const dark = dsImageUrl('ClassPublic', [0x25, 0x28, 0x2b], false)
    const light = dsImageUrl('ClassPublic', [255, 255, 255], false)
    expect(dark).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
    expect(dark).not.toBe(light)
    expect(dsImageUrl('ClassPublic', [0x25, 0x28, 0x2b], false)).toBe(dark)
  })

  it('reads the colours a computed style writes', () => {
    expect(parseCssColor('rgb(37, 40, 43)')).toEqual([37, 40, 43])
    expect(parseCssColor(' #25282b ')).toEqual([0x25, 0x28, 0x2b])
    expect(parseCssColor('transparent')).toBeUndefined()
  })
})

describe('the image stylesheet', () => {
  it('holds a rule per image in use, and rewrites them when the theme changes', async () => {
    ensureDsImage('MethodPrivate')
    ensureDsImage('MethodPrivate')
    const sheet = document.head.querySelector('style[data-ds-images]')!
    const light = sheet.textContent ?? ''
    expect(light.match(/\.dsi-MethodPrivate\{/g)).toHaveLength(1)
    expect(dsImageClass('MethodPrivate')).toBe('dsi-MethodPrivate')

    document.documentElement.style.setProperty('--surface', '#25282b')
    document.documentElement.dataset.theme = 'dark'
    // The rules are rewritten a task after the theme changed, once the code view has switched its own.
    await vi.waitFor(() => expect(sheet.textContent).not.toBe(light))
    expect(sheet.textContent).toContain('.dsi-MethodPrivate{')
    document.documentElement.style.removeProperty('--surface')
    delete document.documentElement.dataset.theme
  })
})
