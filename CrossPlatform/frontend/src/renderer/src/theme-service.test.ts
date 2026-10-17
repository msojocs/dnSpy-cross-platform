import { afterEach, describe, expect, it } from 'vitest'
import { monacoThemeData } from './monaco-theme'
import {
  THEME_BLUE_GUID,
  THEME_DARK_GUID,
  THEME_HIGHCONTRAST_GUID,
  applyTheme,
  colorClassName,
  findTheme,
  loadThemes,
  parseTheme,
  resolveTheme,
  setSystemHighContrast,
  themeColor,
  themeKind,
  themeMenuName,
  themeTextColor,
  themeVariables,
  toCssColor,
  visibleThemes,
} from './theme-service'

const customTheme = (body = '', attributes = 'guid="0E4F0D26-4C3A-4E5B-8D2E-2D1C9A6E5F01" name="night" menu-name="_Night__Owl" order="250" is-dark="true"'): string =>
  `<theme ${attributes}><colors>${body}</colors></theme>`

afterEach(() => {
  setSystemHighContrast(false)
  loadThemes()
})

describe('theme service', () => {
  it('reads WPF colours the way ColorConverter does', () => {
    expect(toCssColor('#FF3399FF')).toBe('#3399ff')
    expect(toCssColor('#803399FF')).toBe('#3399ff80')
    expect(toCssColor('#abc')).toBe('#aabbcc')
    expect(toCssColor('White')).toBe('white')
    expect(toCssColor('#12345')).toBeUndefined()
  })

  it('loads dnSpy\'s four themes in their order, and only shows high contrast when the system asks for it', () => {
    loadThemes()
    expect(visibleThemes().map((theme) => theme.name)).toEqual(['blue', 'dark', 'light'])
    setSystemHighContrast(true)
    expect(visibleThemes().map((theme) => theme.name)).toEqual(['blue', 'dark', 'light', 'hc'])
  })

  it('takes what a theme file names, and the colour tree\'s inheritance and defaults for the rest', () => {
    const dark = findTheme('dark')!
    expect(themeColor(dark, 'DefaultText')).toMatchObject({ fg: '#dcdcdc', bg: '#1e1e1e' })
    expect(themeTextColor(dark, 'Keyword').fg).toBe('#569cd6')
    expect(themeTextColor(dark, 'ExtensionMethod').italic).toBe(true)
    // The light theme leaves most colours to ColorInfos' defaults, which are the light colours.
    const light = findTheme('light')!
    expect(themeColor(light, 'TreeViewItemSelected').bg).toBeDefined()
    // Text a theme gives no colour of its own keeps the colour of what it sits in.
    expect(themeTextColor(dark, 'Text').fg).toBeUndefined()
    expect(themeColor(dark, 'Text').fg).toBe('#dcdcdc')
  })

  it('writes every resource key dnSpy\'s templates read, gradients as CSS gradients', () => {
    const variables = themeVariables(findTheme('blue')!)
    expect(variables['--wpf-EnvironmentToolWindowTabText']).toBe('#ffffff')
    expect(variables['--wpf-TabItem-Selected-Background']).toBeDefined()
    expect(variables['--wpf-EnvironmentBackground']).toMatch(/^linear-gradient\(180deg, #293955 0%, #35496a 40%, #35496a 60%, #293955 100%\)$/)
    expect(variables['--tc-keyword']).toBeDefined()
  })

  it('names colour classes the way the backend writes TextColor', () => {
    expect(colorClassName('StaticType')).toBe('staticType')
    expect(colorClassName('ILDirective')).toBe('ilDirective')
    expect(colorClassName('OpCode')).toBe('opCode')
    expect(colorClassName('XmlDocCommentName')).toBe('xmlDocCommentName')
  })

  it('reads a user\'s theme and gives it the name its file gives it', () => {
    loadThemes([{ path: '/themes/night.dntheme', text: customTheme('<color name="defaulttext" fg="#C0C0C0" bg="#101010" /><color name="KEYWORD" fg="#FF00FF00" bold="true" />') }])
    const theme = findTheme('night')!
    expect(themeMenuName(theme)).toBe('Night_Owl')
    expect(themeKind(theme)).toBe('dark')
    expect(themeTextColor(theme, 'Keyword')).toMatchObject({ fg: '#00ff00', bold: true })
    expect(visibleThemes().map((item) => item.name)).toEqual(['blue', 'dark', 'night', 'light'])
    expect(findTheme('0e4f0d26-4c3a-4e5b-8d2e-2d1c9a6e5f01')).toBe(theme)
  })

  it('skips a file dnSpy would not load', () => {
    expect(parseTheme('<theme name="x" menu-name="X"></theme>')).toBeUndefined()
    expect(parseTheme(customTheme('', 'guid="0E4F0D26-4C3A-4E5B-8D2E-2D1C9A6E5F01"'))).toBeUndefined()
    expect(parseTheme('not xml')).toBeUndefined()
  })

  it('falls back to the dark theme, and follows high contrast the way ThemeService does', () => {
    expect(resolveTheme('missing').guid).toBe(THEME_DARK_GUID)
    expect(resolveTheme('blue').guid).toBe(THEME_BLUE_GUID)
    setSystemHighContrast(true)
    expect(resolveTheme('blue').guid).toBe(THEME_HIGHCONTRAST_GUID)
    setSystemHighContrast(false)
    expect(resolveTheme('hc').guid).toBe(THEME_DARK_GUID)
  })

  it('puts the theme on the page: its sheet, its name and its kind', () => {
    applyTheme(findTheme('light')!)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.themeKind).toBe('light')
    const sheet = document.querySelector('style[data-ds-theme]')!
    expect(sheet.textContent).toContain('--wpf-TreeViewBackground:')
    expect(sheet.textContent).toMatch(/\.tc-keyword\{color:var\(--tc-keyword\)\}/)
  })

  it('builds the code views\' Monaco theme out of the text view\'s colours', () => {
    const data = monacoThemeData(findTheme('dark')!)
    expect(data.base).toBe('vs-dark')
    expect(data.colors['editor.background']).toBe('#1e1e1e')
    expect(data.rules).toContainEqual(expect.objectContaining({ token: 'keyword.cs', foreground: '569cd6' }))
    expect(data.rules).toContainEqual(expect.objectContaining({ token: 'keyword.opcode.il' }))
    expect(monacoThemeData(findTheme('blue')!).colors['editor.background']).toBe('#ffffff')
    expect(monacoThemeData(findTheme('dark')!, true).colors['editor.background']).toBe('#00000000')
  })
})
