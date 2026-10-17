import { useEffect, useState } from 'react'
import { getActiveLocale } from './localization'
import { resolveTheme } from './theme-service'
import { useAppOptions, type AppOptions } from './components/app-options'

/**
 * dnSpy's Environment › Font page: one font per text appearance category the user may see
 * (TextAppearanceCategoryDefinitions — the text editor, the hex editor and the Output window), and like every
 * ThemeFontSettings, one per theme: switching the theme switches to the fonts chosen for that theme.
 */
export type FontCategory = 'textEditor' | 'hexEditor' | 'outputWindow'

/** dnSpy's FontType, which decides whether a category may use any font or only a monospaced one. */
export type FontType = 'textEditor' | 'hexEditor'

export interface FontCategoryInfo {
  id: FontCategory
  /** The display name dnSpy gives the category, which is also the key of its translation. */
  labelKey: string
  fontType: FontType
}

/** The categories in no particular order; the page sorts them by their translated names, as dnSpy does. */
export const FONT_CATEGORIES: readonly FontCategoryInfo[] = [
  { id: 'textEditor', labelKey: 'Text Editor', fontType: 'textEditor' },
  { id: 'hexEditor', labelKey: 'Hex Editor', fontType: 'hexEditor' },
  { id: 'outputWindow', labelKey: 'Output Window', fontType: 'textEditor' },
]

/** One category's font. A family left out is dnSpy's default for the category. */
export interface FontSetting {
  fontFamily?: string
  /** In device-independent pixels, as WPF keeps it; the page shows it in points. */
  fontSize: number
}

/** FontUtilities.DEFAULT_FONT_SIZE: 10 points at 96 dots per inch. */
export const DEFAULT_FONT_SIZE = 10 * 96 / 72
const MIN_FONT_SIZE = 1
const MAX_FONT_SIZE = 200

/** FontUtilities.FilterFontSize. */
export const filterFontSize = (size: number): number => Number.isFinite(size) ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) : DEFAULT_FONT_SIZE

/** FontSizeConverter: points shown, pixels kept. */
export const pixelsToPoints = (pixels: number): number => Math.round(pixels / (96 / 72))
export const pointsToPixels = (points: number): number => points * (96 / 72)

/**
 * FontUtilities.GetDefaultFontsToCheck: the families dnSpy tries in turn, the first one installed winning — a
 * language's own family first, then the monospaced ones it knows. A CSS font list is the same search, so the
 * default is written as one, with the generic family last where dnSpy settles for "Global Monospace".
 */
export const defaultFontFamilies = (locale: string = getActiveLocale(), onlyMonospaced = false): string[] => {
  const language = locale.toLowerCase()
  const languageFonts = language === 'zh-cn' || language === 'zh-hans' || language === 'zh-sg' ? ['NSimSun']
    : language.startsWith('zh') ? ['MingLiU', 'MingLiU-ExtB', 'MingLiU_HKSCS', 'MingLiU_HKSCS-ExtB']
      : language.startsWith('ja') ? ['MS Gothic']
        : language.startsWith('ko') ? (onlyMonospaced ? [] : ['DotumChe'])
          : ['Consolas']
  return [...new Set([...languageFonts, 'Consolas', 'Lucida Console', 'Courier New', 'Courier', 'Liberation Mono'])]
}

const quote = (family: string): string => /^[\w-]+$/.test(family) && !/^\d/.test(family) ? family : `"${family.replace(/["\\]/g, '\\$&')}"`

/** The CSS `font-family` for a category's font: the chosen family, then dnSpy's defaults behind it. */
export const cssFontFamily = (setting: FontSetting, fontType: FontType): string => {
  const defaults = defaultFontFamilies(getActiveLocale(), fontType === 'hexEditor')
  const families = setting.fontFamily ? [setting.fontFamily, ...defaults.filter((family) => family !== setting.fontFamily)] : defaults
  return [...families.map(quote), 'monospace'].join(', ')
}

const DEFAULT_SETTING: FontSetting = { fontSize: DEFAULT_FONT_SIZE }

/** The font a category uses in the theme with the given GUID (ThemeFontSettings.Active). */
export const fontSettingFor = (options: AppOptions, themeGuid: string, category: FontCategory): FontSetting => {
  const saved = options.environmentFont.byTheme[themeGuid]?.[category]
  return saved ? { fontFamily: saved.fontFamily || undefined, fontSize: filterFontSize(saved.fontSize) } : DEFAULT_SETTING
}

export const fontTypeOf = (category: FontCategory): FontType => FONT_CATEGORIES.find((info) => info.id === category)!.fontType

/** The font a category's views draw with, following the options and the theme they are for. */
export const useCategoryFont = (category: FontCategory): { fontFamily: string; fontSize: number } => {
  const options = useAppOptions()
  const theme = resolveTheme(options.environmentGeneral.theme)
  const setting = fontSettingFor(options, theme.guid, category)
  return { fontFamily: cssFontFamily(setting, fontTypeOf(category)), fontSize: setting.fontSize }
}

/** A family installed on the machine, and whether its glyphs all have one width (FontUtilities.IsMonospacedFont). */
export interface SystemFont {
  family: string
  monospaced: boolean
}

let canvasContext: CanvasRenderingContext2D | null | undefined

/** FontUtilities.IsMonospacedFont compares the widths of a narrow and a wide glyph; so does this, in a canvas. */
const isMonospaced = (family: string): boolean => {
  if (canvasContext === undefined)
    canvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext?.('2d') ?? null
  if (!canvasContext)
    return false
  canvasContext.font = `16px ${quote(family)}, serif`
  const narrow = canvasContext.measureText('iiiiiiiiii').width
  const wide = canvasContext.measureText('WWWWWWWWWW').width
  return narrow > 0 && Math.abs(narrow - wide) < 0.5
}

let systemFonts: Promise<SystemFont[]> | undefined

/**
 * Fonts.SystemFontFamilies without the symbol fonts, sorted by name: the browser's list of local fonts where
 * it gives one, the main process's otherwise (fontconfig on Linux).
 */
export const listSystemFonts = (): Promise<SystemFont[]> => systemFonts ??= (async () => {
  let families: string[] = []
  try {
    const query = (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    if (query)
      families = (await query()).map((font) => font.family)
  } catch {
    // Not allowed or not supported; the main process is asked instead.
  }
  if (families.length === 0) {
    try {
      families = await window.dnSpy?.listSystemFonts?.() ?? []
    } catch {
      families = []
    }
  }
  const unique = [...new Set(families.map((family) => family.trim()).filter(Boolean))]
    .filter((family) => !/symbol|wingdings|webdings|dingbats/i.test(family))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return unique.map((family) => ({ family, monospaced: isMonospaced(family) }))
})()

/** The system's fonts once they are known, which takes a moment — dnSpy fills its lists in the background too. */
export const useSystemFonts = (): SystemFont[] | undefined => {
  const [fonts, setFonts] = useState<SystemFont[]>()
  useEffect(() => {
    let live = true
    void listSystemFonts().then((list) => { if (live) setFonts(list) })
    return () => { live = false }
  }, [])
  return fonts
}

/** GetDefaultTextEditorFont / GetDefaultMonospacedFont among the fonts that are installed. */
export const resolveDefaultFamily = (fonts: readonly SystemFont[], fontType: FontType): string => {
  const installed = new Map(fonts.map((font) => [font.family.toLowerCase(), font.family]))
  for (const family of defaultFontFamilies(getActiveLocale(), fontType === 'hexEditor')) {
    const found = installed.get(family.toLowerCase())
    if (found)
      return found
  }
  return 'Courier New'
}
