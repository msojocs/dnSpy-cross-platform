import { useMemo, useState } from 'react'
import { useLanguage } from '../localization'
import { DEFAULT_FONT_SIZE, FONT_CATEGORIES, filterFontSize, pixelsToPoints, pointsToPixels, resolveDefaultFamily, useSystemFonts, type FontCategory } from '../fonts'
import { resolveTheme } from '../theme-service'
import type { AppOptions, EnvironmentFontSettings, FontOption } from './app-options'

/** FontAppSettingsPageOptions.SelectedIndex: the category the page showed last, for as long as the app runs. */
let lastCategory: FontCategory | undefined

/** The size box's list, in points, as dnSpy's template writes it. */
const SIZES = Array.from({ length: 19 }, (_, index) => index + 6)

/**
 * dnSpy's Environment › Font page (FontAppSettingsPage): a box of the text appearance categories, sorted by
 * their names and starting on the text editor; the family box under it, every installed font for a category
 * that takes any and only the monospaced ones for the hex editor, monospaced families in bold; and an editable
 * size box in points beside it. What is chosen is the font of the category in the theme the options name.
 */
export const FontOptions = ({ options, onChange }: { options: AppOptions; onChange(value: EnvironmentFontSettings['byTheme']): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const fonts = useSystemFonts()
  const categories = useMemo(() => [...FONT_CATEGORIES].sort((a, b) => t(a.labelKey).localeCompare(t(b.labelKey), undefined, { sensitivity: 'base' })), [t])
  const [categoryId, setCategoryId] = useState<FontCategory>(() => lastCategory ?? 'textEditor')
  const category = categories.find((info) => info.id === categoryId) ?? categories[0]
  const themeGuid = resolveTheme(options.environmentGeneral.theme).guid
  const saved = options.environmentFont.byTheme[themeGuid]?.[category.id]
  const size = filterFontSize(saved?.fontSize ?? DEFAULT_FONT_SIZE)
  const families = fonts?.filter((font) => category.fontType !== 'hexEditor' || font.monospaced)
  const family = saved?.fontFamily ?? (fonts ? resolveDefaultFamily(fonts, category.fontType) : '')
  const [sizeText, setSizeText] = useState<string>()

  const update = (change: Partial<FontOption>): void => {
    const current: FontOption = { fontFamily: saved?.fontFamily, fontSize: size }
    const next = { ...current, ...change }
    onChange({ ...options.environmentFont.byTheme, [themeGuid]: { ...options.environmentFont.byTheme[themeGuid], [category.id]: next } })
  }

  const selectCategory = (id: FontCategory): void => {
    lastCategory = id
    setCategoryId(id)
    setSizeText(undefined)
  }

  // FontSizeConverter.ConvertBack: what is typed is points, and anything that is no number is the default size.
  const commitSize = (text: string): void => {
    const points = Number(text.trim())
    update({ fontSize: filterFontSize(Number.isFinite(points) && text.trim() !== '' ? pointsToPixels(points) : DEFAULT_FONT_SIZE) })
  }

  return (
    <div className="font-options">
      <select className="font-options-category" aria-label={t('Font')} value={category.id} onChange={(event) => selectCategory(event.target.value as FontCategory)}>
        {categories.map((info) => <option key={info.id} value={info.id}>{t(info.labelKey)}</option>)}
      </select>
      <div className="font-options-row">
        <select
          className="font-options-family"
          aria-label={t('Font Family')}
          value={family}
          disabled={!families}
          onChange={(event) => update({ fontFamily: event.target.value })}
        >
          {/* A family that is not installed — or, while the list loads, the one in use — still shows as chosen. */}
          {family && !families?.some((font) => font.family === family) && <option value={family}>{family}</option>}
          {families?.map((font) => (
            <option key={font.family} value={font.family} className={font.monospaced ? 'font-options-monospaced' : undefined} style={{ fontWeight: font.monospaced ? 'bold' : undefined }}>
              {font.family}
            </option>
          ))}
        </select>
        <input
          className="font-options-size"
          aria-label={t('Font Size')}
          list="font-options-sizes"
          value={sizeText ?? String(pixelsToPoints(size))}
          onChange={(event) => setSizeText(event.target.value)}
          onBlur={(event) => { commitSize(event.target.value); setSizeText(undefined) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitSize(event.currentTarget.value)
              setSizeText(undefined)
            }
          }}
        />
        <datalist id="font-options-sizes">
          {SIZES.map((points) => <option key={points} value={points} />)}
        </datalist>
      </div>
    </div>
  )
}
