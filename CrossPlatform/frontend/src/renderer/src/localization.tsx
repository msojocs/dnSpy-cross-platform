import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { UiLocale } from '../../shared/protocol'
import { UI_LOCALES, isUiLocale, matchUiLocale } from '../../shared/ui-locales'
import { generatedLocales } from './locales.generated'
import { zhCN } from './locales/zh-CN'

export type LanguagePreference = 'system' | UiLocale

export type TranslationValues = Record<string, string | number>

// Every language but English, by the English text. Simplified Chinese is the hand-kept table; the others are
// dnSpy's own resx translations, looked up from it by scripts/generate-locales.mjs. A string a language has
// no translation for is shown in English, the way .NET falls back to the neutral resource.
const translations: Readonly<Partial<Record<UiLocale, Readonly<Record<string, string>>>>> = { ...generatedLocales, 'zh-CN': zhCN }

/** "System": the first language the user's preferences name that there is a user interface for, else English. */
function resolveSystemLocale(): UiLocale {
  const locales = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  return matchUiLocale(locales.filter((locale): locale is string => typeof locale === 'string')) ?? 'en'
}

let activeLocale: UiLocale = resolveSystemLocale()

const resolveLocale = (language: LanguagePreference): UiLocale => language === 'system' ? resolveSystemLocale() : language

export const translate = (message: string, values: TranslationValues = {}): string => {
  const table = translations[activeLocale]
  const template = table !== undefined && Object.hasOwn(table, message) ? table[message] : message
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values[name] ?? placeholder))
}

export const getActiveLocale = (): UiLocale => activeLocale

/** dnSpy's LanguageInfo.UIName for a culture, its CultureInfo.NativeName: the language as it names itself. */
export const nativeLanguageName = (locale: UiLocale): string => {
  try {
    return new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' }).of(locale) ?? locale
  }
  catch {
    return locale
  }
}

/**
 * dnSpy's View → Language submenu (ShowSupportedLanguagesCommand): the operating system's language first, then
 * every language by its native name, sorted the way LanguageInfoComparer sorts them — case-insensitively, by
 * the rules of the language the window is in.
 */
export const languageChoices = (): { value: LanguagePreference; label: string }[] => {
  const collator = new Intl.Collator(activeLocale, { sensitivity: 'accent' })
  const languages = UI_LOCALES.map((locale) => ({ value: locale as LanguagePreference, label: nativeLanguageName(locale) }))
    .sort((left, right) => collator.compare(left.label, right.label))
  return [{ value: 'system', label: translate('System') }, ...languages]
}

const loadLanguage = (): LanguagePreference => {
  const saved = localStorage.getItem('dnspy.language')
  return saved === 'system' || isUiLocale(saved) ? saved : 'system'
}

interface LanguageContextValue {
  language: LanguagePreference
  locale: UiLocale
  setLanguage(language: LanguagePreference): void
  t: typeof translate
}

const LanguageContext = createContext<LanguageContextValue>({
  language: 'system',
  locale: activeLocale,
  setLanguage: () => undefined,
  t: translate,
})

export const LanguageProvider = ({ children, initialLanguage }: React.PropsWithChildren<{ initialLanguage?: LanguagePreference }>): React.JSX.Element => {
  const [language, setLanguageState] = useState<LanguagePreference>(() => initialLanguage ?? loadLanguage())
  const locale = resolveLocale(language)
  activeLocale = locale

  useEffect(() => {
    // Only the language is set, never the direction: dnSpy leaves FlowDirection alone for Persian as well, so
    // its window keeps the left-to-right layout and only the Persian text itself runs right to left.
    document.documentElement.lang = locale
    document.documentElement.dataset.locale = locale
    if (initialLanguage === undefined)
      localStorage.setItem('dnspy.language', language)
    void window.dnSpy?.setLocale?.(locale)
  }, [initialLanguage, language, locale])

  const setLanguage = useCallback((nextLanguage: LanguagePreference) => setLanguageState(nextLanguage), [])
  const context = useMemo<LanguageContextValue>(() => ({ language, locale, setLanguage, t: translate }), [language, locale, setLanguage])
  return <LanguageContext.Provider value={context}>{children}</LanguageContext.Provider>
}

export const useLanguage = (): LanguageContextValue => useContext(LanguageContext)
