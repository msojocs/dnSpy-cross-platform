import { useSyncExternalStore } from 'react'
import { BUILT_IN_THEMES, COLOR_INFOS } from './themes.generated'
import type { ThemeFile } from '../../shared/protocol'

/**
 * dnSpy's theme service (dnSpy/dnSpy/Themes): a theme is a `.dntheme` file that names the colours it changes,
 * and every other colour comes from ColorInfos — inherited from the colour above it in that tree, or the
 * colour's own default. dnSpy hands the result to WPF as resources its templates read by key; this port writes
 * the same keys as CSS custom properties (`--wpf-<key>`), which the stylesheet reads the way the templates do,
 * and the text colours as `--tc-<colour>` with a rule per colour class.
 */

/** One colour of a theme once inheritance has run: dnSpy's ThemeColor, its brushes as CSS colours. */
export interface ThemeColor {
  fg?: string
  bg?: string
  c3?: string
  c4?: string
  bold?: boolean
  italic?: boolean
}

export interface DsTheme {
  /** Upper case, the way dnSpy's constants write the built-in ones. */
  guid: string
  name: string
  menuName: string
  order: number
  isDark: boolean
  isLight: boolean
  isHighContrast: boolean
  /** Theme.GetColor: inherits up to and including the default text colour, by ColorInfo index. */
  colors: ThemeColor[]
  /** Theme.GetTextColor: the same, but stopping short of the default text colour. */
  textColors: ThemeColor[]
}

export const THEME_HIGHCONTRAST_GUID = 'D0EA082A-BF0D-439F-B396-547C29D97E37'
export const THEME_BLUE_GUID = '61AA341E-281D-4154-985F-C81E9269034B'
export const THEME_DARK_GUID = '64EFBB2C-0ACA-467C-8389-9FA350376F3F'
export const THEME_LIGHT_GUID = 'B3D71E74-C353-4206-9AD1-05847BE95CBE'

const colorIndex = new Map(COLOR_INFOS.map((info, index) => [info.name.toLowerCase(), index]))
const DEFAULT_TEXT = colorIndex.get('defaulttext')!

/** The index of a colour by its ColorType name, which a theme file writes in any case. */
export const colorTypeIndex = (name: string): number | undefined => colorIndex.get(name.toLowerCase())

/**
 * A colour as WPF's ColorConverter reads it — `#RGB`, `#ARGB`, `#RRGGBB`, `#AARRGGBB` or a colour name — written
 * the way CSS reads it. Names are the same in both: WPF's Colors are the X11 set CSS also has.
 */
export const toCssColor = (value: string): string | undefined => {
  const text = value.trim()
  if (text.startsWith('#')) {
    let hex = text.slice(1)
    if (!/^[0-9a-f]+$/i.test(hex))
      return undefined
    if (hex.length === 3 || hex.length === 4)
      hex = [...hex].map((digit) => digit + digit).join('')
    if (hex.length === 6)
      return `#${hex.toLowerCase()}`
    if (hex.length === 8) {
      const alpha = Number.parseInt(hex.slice(0, 2), 16)
      return alpha === 255 ? `#${hex.slice(2).toLowerCase()}` : `#${hex.slice(2).toLowerCase()}${hex.slice(0, 2).toLowerCase()}`
    }
    return undefined
  }
  return /^[a-z]+$/i.test(text) ? text.toLowerCase() : undefined
}

const readBool = (value: string | null): boolean | undefined => {
  if (value === null)
    return undefined
  const text = value.trim().toLowerCase()
  return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : undefined
}

const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i

/** A GUID written the way dnSpy's constants write one, or undefined for text that is none. */
export const normalizeGuid = (value: string): string | undefined => GUID.exec(value.trim())?.[1].toUpperCase()

const brushOf = (value: string | null | undefined): string | undefined => value === null || value === undefined ? undefined : toCssColor(value)

/** dnSpy's Theme constructor: reads a `.dntheme` file, or gives undefined for one dnSpy would not load. */
export const parseTheme = (xml: string): DsTheme | undefined => {
  let document: Document
  try {
    document = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return undefined
  }
  const root = document.documentElement
  if (!root || root.nodeName !== 'theme' || document.getElementsByTagName('parsererror').length > 0)
    return undefined
  const guid = normalizeGuid(root.getAttribute('guid') ?? '')
  const menuName = root.getAttribute('menu-name') ?? ''
  if (!guid || !menuName)
    return undefined
  const order = Number.parseFloat(root.getAttribute('order') ?? '')

  // Every colour starts as its ColorInfo's defaults; the ones the file names take the file's values, with the
  // defaults still standing in for the attributes it leaves out (Theme.ReadColor).
  const original: ThemeColor[] = COLOR_INFOS.map((info) => ({ fg: brushOf(info.fg), bg: brushOf(info.bg), c3: brushOf(info.c3), c4: brushOf(info.c4) }))
  const colorsElement = [...root.children].find((child) => child.nodeName === 'colors')
  for (const element of colorsElement ? [...colorsElement.children] : []) {
    if (element.nodeName !== 'color')
      continue
    const index = colorTypeIndex(element.getAttribute('name') ?? '')
    if (index === undefined)
      continue
    const info = COLOR_INFOS[index]
    original[index] = {
      fg: brushOf(element.getAttribute('fg') ?? info.fg),
      bg: brushOf(element.getAttribute('bg') ?? info.bg),
      c3: brushOf(element.getAttribute('color3') ?? info.c3),
      c4: brushOf(element.getAttribute('color4') ?? info.c4),
      italic: readBool(element.getAttribute('italics') ?? element.getAttribute('italic')),
      bold: readBool(element.getAttribute('bold')),
    }
  }

  // Theme.RecalculateInheritedColorProperties: each part of a colour is the first one found walking up the
  // tree, the text colour stopping before the default text colour so that text a theme gives no colour keeps
  // whatever it is drawn over.
  const inherit = (index: number, includeDefault: boolean): ThemeColor => {
    const result: ThemeColor = {}
    for (const key of ['fg', 'bg', 'c3', 'c4', 'bold', 'italic'] as const) {
      for (let current: number | undefined = index; current !== undefined; current = COLOR_INFOS[current].parent) {
        if (!includeDefault && current === DEFAULT_TEXT)
          break
        const value = original[current][key]
        if (value !== undefined) {
          (result as Record<string, unknown>)[key] = value
          break
        }
      }
    }
    return result
  }
  const colors = COLOR_INFOS.map((_, index) => index === DEFAULT_TEXT ? original[index] : inherit(index, true))
  const textColors = COLOR_INFOS.map((_, index) => index === DEFAULT_TEXT ? original[index] : inherit(index, false))

  return {
    guid,
    name: root.getAttribute('name') ?? '',
    menuName,
    order: Number.isFinite(order) ? order : 1,
    isDark: readBool(root.getAttribute('is-dark')) ?? false,
    isLight: readBool(root.getAttribute('is-light')) ?? false,
    isHighContrast: readBool(root.getAttribute('is-high-contrast')) ?? false,
    colors,
    textColors,
  }
}

/** Theme.GetColor by ColorType name. */
export const themeColor = (theme: DsTheme, name: string): ThemeColor => theme.colors[colorTypeIndex(name) ?? DEFAULT_TEXT]

/** Theme.GetTextColor by ColorType name. */
export const themeTextColor = (theme: DsTheme, name: string): ThemeColor => theme.textColors[colorTypeIndex(name) ?? DEFAULT_TEXT]

/** The name a resource key is written under: CSS custom property names have no dots. */
export const resourceVariable = (key: string): string => `--wpf-${key.replace(/\./g, '-')}`

/** The brush a LinearGradientColorInfo makes, as a CSS gradient: its stops are the colour's four brushes in turn. */
const gradientOf = (gradient: NonNullable<(typeof COLOR_INFOS)[number]['gradient']>, color: ThemeColor): string => {
  const brushes = [color.fg, color.bg, color.c3, color.c4]
  const [x1, y1] = gradient.start
  const [x2, y2] = gradient.end
  // WPF's angle runs from the start point to the end point in the unit box; CSS measures from "to top".
  const angle = Math.round(Math.atan2(x2 - x1, -(y2 - y1)) * 180 / Math.PI)
  const stops = gradient.offsets.map((offset, index) => `${brushes[index] ?? 'transparent'} ${Math.round(offset * 1000) / 10}%`)
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`
}

/** The camel-case class name the backend gives a colour (TextColor.StaticType is `staticType`, ILDirective `ilDirective`). */
export const colorClassName = (name: string): string => {
  const leading = /^[A-Z]+/.exec(name)?.[0] ?? ''
  if (leading.length <= 1)
    return name.charAt(0).toLowerCase() + name.slice(1)
  const lowered = leading.length === name.length ? leading : leading.slice(0, -1)
  return lowered.toLowerCase() + name.slice(lowered.length)
}

/** What a theme writes on the page: every resource key dnSpy's templates read, and the text colours. */
export const themeVariables = (theme: DsTheme): Record<string, string> => {
  const variables: Record<string, string> = {}
  COLOR_INFOS.forEach((info, index) => {
    const color = theme.colors[index]
    if (info.fgKey)
      variables[resourceVariable(info.fgKey)] = color.fg ?? 'transparent'
    if (info.bgKey)
      variables[resourceVariable(info.bgKey)] = color.bg ?? 'transparent'
    if (info.key && info.gradient) {
      variables[resourceVariable(info.key)] = gradientOf(info.gradient, color)
      // The gradient's first stop, for the places that need a colour rather than a brush.
      variables[`${resourceVariable(info.key)}-color`] = color.fg ?? color.bg ?? 'transparent'
    }
    const text = theme.textColors[index]
    if (text.fg)
      variables[`--tc-${info.name.toLowerCase()}`] = text.fg
    // A text marker's own colours — dnSpy's GlyphTextMarker draws its background and, in the foreground colour,
    // its outline — as the theme names them.
    if (color.fg)
      variables[`--tcfg-${info.name.toLowerCase()}`] = color.fg
    // A text view's own background — the Output window's, the hex editor's — is its colour's background.
    if (color.bg)
      variables[`--tcbg-${info.name.toLowerCase()}`] = color.bg
  })
  const defaultText = theme.colors[DEFAULT_TEXT]
  variables['--tc-defaulttext'] = defaultText.fg ?? 'inherit'
  variables['--tc-defaulttext-background'] = defaultText.bg ?? 'transparent'
  return variables
}

/** The colour classes the backend and Roslyn's classifier put on text, one rule each with the theme's colour,
 *  weight and slant; a colour the theme leaves to the text it sits in gets none. */
export const themeTextRules = (theme: DsTheme): string[] => {
  const rules: string[] = []
  COLOR_INFOS.forEach((info, index) => {
    if (index === DEFAULT_TEXT)
      return
    const text = theme.textColors[index]
    const declarations: string[] = []
    if (text.fg)
      declarations.push(`color:var(--tc-${info.name.toLowerCase()})`)
    if (text.bold !== undefined)
      declarations.push(`font-weight:${text.bold ? 'bold' : 'normal'}`)
    if (text.italic !== undefined)
      declarations.push(`font-style:${text.italic ? 'italic' : 'normal'}`)
    if (declarations.length > 0)
      rules.push(`.tc-${colorClassName(info.name)}{${declarations.join(';')}}`)
  })
  return rules
}

/** What a theme is for the parts that only know dark from light: high contrast first, as dnSpy checks it. */
export type ThemeKind = 'dark' | 'light' | 'hc'

const luminance = (color: string | undefined): number => {
  const hex = color && /^#([0-9a-f]{6})/i.exec(color)?.[1]
  if (!hex)
    return color === 'black' ? 0 : 1
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const themeKind = (theme: DsTheme): ThemeKind => {
  if (theme.isHighContrast)
    return 'hc'
  // A theme of the user's that says neither is read off its text background, which is what decides whether
  // the editor's own chrome — scroll bars, the find widget — has to be the dark or the light one.
  if (theme.isDark !== theme.isLight)
    return theme.isDark ? 'dark' : 'light'
  return luminance(theme.colors[DEFAULT_TEXT].bg) < 0.5 ? 'dark' : 'light'
}

/** ThemeHelpers.GetMenuName: the built-in themes take their names from the resources, so they are translated. */
export const themeMenuName = (theme: DsTheme, translate: (text: string) => string = (text) => text): string => {
  switch (theme.guid) {
    case THEME_HIGHCONTRAST_GUID: return translate('High Contrast')
    case THEME_BLUE_GUID: return translate('Blue')
    case THEME_DARK_GUID: return translate('Dark')
    case THEME_LIGHT_GUID: return translate('Light')
  }
  return stripMnemonic(theme.menuName.trim() || theme.name.trim() || theme.guid)
}

/** ThemeHelpers.GetName drops the access key marker; a doubled one is a literal underscore. */
const stripMnemonic = (text: string): string => text.replace(/__|_/g, (marker) => marker === '__' ? '_' : '')

// The theme service's state: every theme it loaded, the one in use, and whether the system asks for high
// contrast. dnSpy loads the themes once, at startup, from the Themes directories; so does this port.
let themes: DsTheme[] = []
let systemHighContrast = false
const listeners = new Set<() => void>()
let snapshot: { themes: readonly DsTheme[]; visible: readonly DsTheme[]; highContrast: boolean } = { themes: [], visible: [], highContrast: false }

const refreshSnapshot = (): void => {
  snapshot = { themes, visible: themes.filter((theme) => systemHighContrast || !theme.isHighContrast), highContrast: systemHighContrast }
}

const notify = (): void => {
  refreshSnapshot()
  for (const listener of listeners)
    listener()
}

const readThemes = (files: readonly ThemeFile[]): DsTheme[] => {
  const byGuid = new Map<string, DsTheme>()
  for (const text of [...Object.values(BUILT_IN_THEMES), ...files.map((file) => file.text)]) {
    const theme = parseTheme(text)
    if (theme)
      byGuid.set(theme.guid, theme)
  }
  // AllThemes orders by Order; a stable sort keeps the load order between themes of the same order.
  return [...byGuid.values()].sort((a, b) => a.order - b.order)
}

/** The shipped themes, read the first time anything asks for one when nothing has loaded the user's yet. */
const ensureThemes = (): void => {
  if (themes.length > 0)
    return
  themes = readThemes([])
  refreshSnapshot()
}

/**
 * ThemeService.Load: the shipped themes, then the files of the Themes directories, a later file with the same
 * GUID replacing an earlier one. A file that is no theme is skipped the way dnSpy skips it.
 */
export const loadThemes = (files: readonly ThemeFile[] = []): void => {
  themes = readThemes(files)
  notify()
}

/** ThemeService.AllThemes. */
export const allThemes = (): readonly DsTheme[] => {
  ensureThemes()
  return themes
}

/** ThemeService.VisibleThemes: the high-contrast themes only while the system is in high contrast. */
export const visibleThemes = (): readonly DsTheme[] => allThemes().filter((theme) => systemHighContrast || !theme.isHighContrast)

export const isSystemHighContrast = (): boolean => systemHighContrast

export const setSystemHighContrast = (value: boolean): void => {
  if (systemHighContrast === value)
    return
  systemHighContrast = value
  notify()
}

/** GetThemeOrDefault, by the name the options keep or a GUID: the dark theme when nothing matches. */
export const findTheme = (nameOrGuid: string | undefined): DsTheme | undefined => {
  if (!nameOrGuid)
    return undefined
  const guid = normalizeGuid(nameOrGuid)
  // AppCommandLineArgsHandler: a GUID names a theme by its GUID, anything else by its name, case and all.
  return allThemes().find((theme) => guid ? theme.guid === guid : theme.name !== '' && theme.name === nameOrGuid)
}

const themeOrDefault = (nameOrGuid: string | undefined): DsTheme =>
  findTheme(nameOrGuid) ?? findTheme(THEME_DARK_GUID) ?? allThemes()[0]

/**
 * ThemeService.Initialize and SwitchThemeIfNecessary: the theme to show for the one the settings name. A
 * high-contrast theme is only kept while the system is in high contrast, and a normal one gives way to the
 * high-contrast theme when it is.
 */
export const resolveTheme = (nameOrGuid: string | undefined): DsTheme => {
  const theme = themeOrDefault(nameOrGuid)
  if (theme.isHighContrast === systemHighContrast)
    return theme
  return themeOrDefault(systemHighContrast ? THEME_HIGHCONTRAST_GUID : THEME_DARK_GUID)
}

/** The name the option store keeps a theme under: its name, or its GUID for a theme that has none. */
export const themeKey = (theme: DsTheme): string => theme.name || theme.guid

let sheet: HTMLStyleElement | undefined
let appliedGuid: string | undefined

/**
 * Puts a theme on the page — ThemeService.InitializeResources: its resources and text colours in a style sheet
 * of their own, and its name and kind on the root element for the few rules that only care which kind it is.
 */
export const applyTheme = (theme: DsTheme): void => {
  if (typeof document === 'undefined')
    return
  const root = document.documentElement
  if (appliedGuid !== theme.guid || !sheet?.isConnected) {
    sheet ??= document.createElement('style')
    sheet.dataset.dsTheme = ''
    if (!sheet.isConnected)
      document.head.prepend(sheet)
    const variables = Object.entries(themeVariables(theme)).map(([name, value]) => `${name}:${value}`).join(';')
    sheet.textContent = [`:root{${variables}}`, ...themeTextRules(theme)].join('\n')
    appliedGuid = theme.guid
  }
  root.dataset.themeKind = themeKind(theme)
  root.dataset.theme = themeKey(theme)
}

/** The service's themes for a component: all of them, the ones the menus list, and the high-contrast state. */
export const useThemes = (): typeof snapshot => useSyncExternalStore(
  (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  () => {
    ensureThemes()
    return snapshot
  },
)
