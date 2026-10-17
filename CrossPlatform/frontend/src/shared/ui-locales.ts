import type { UiLocale } from './protocol'

/**
 * Every user interface language, the way dnSpy finds its own: English, which is the neutral resource, and
 * each culture there is a `*.Resources.<culture>.resx` for under dnSpy/ and Extensions/ (CultureService looks
 * for the satellite assemblies those files are built into).
 */
export const UI_LOCALES = [
  'cs', 'de', 'en', 'es-ES', 'fa', 'fr', 'hu', 'it', 'pt-BR', 'pt-PT', 'ru', 'tr', 'uk', 'vi', 'zh-CN',
] as const satisfies readonly UiLocale[]

// Fails to compile when UiLocale names a language the list above leaves out.
const everyLocaleListed: Exclude<UiLocale, (typeof UI_LOCALES)[number]> extends never ? true : never = true
void everyLocaleListed

export const isUiLocale = (value: unknown): value is UiLocale => (UI_LOCALES as readonly unknown[]).includes(value)

/** A culture name as Intl reads it: `de_DE.UTF-8` (a POSIX locale) becomes `de-DE`; a name that is no culture
 * name at all is undefined, the way `new CultureInfo` throws for one. */
const parseLocale = (name: string): Intl.Locale | undefined => {
  const cleaned = name.trim().replace(/[.@].*$/, '').replace(/_/g, '-')
  if (!cleaned)
    return undefined
  try {
    return new Intl.Locale(cleaned)
  }
  catch {
    return undefined
  }
}

/**
 * The language a culture name is shown in. .NET looks a resource up by the culture, then by its parents, and
 * falls back to the neutral (English) resource; dnSpy's languages are mostly neutral cultures, so `de-AT`
 * finds `de` that way. Where dnSpy ships a language only for one country — es-ES, zh-CN and the two
 * Portuguese ones — another country's culture is shown in it as well rather than in English, the way a browser
 * reads a language preference: Portuguese follows CLDR, where `pt` is Brazilian and every other country's
 * Portuguese is the European one.
 */
const matchOne = (name: string): UiLocale | undefined => {
  const locale = parseLocale(name)
  if (!locale)
    return undefined
  const exact = UI_LOCALES.find((candidate) => candidate.toLowerCase() === locale.baseName.toLowerCase())
  if (exact)
    return exact
  switch (locale.language) {
    case 'pt': return locale.region === undefined || locale.region === 'BR' ? 'pt-BR' : 'pt-PT'
    case 'es': return 'es-ES'
    case 'zh': return 'zh-CN'
    default: return UI_LOCALES.find((candidate) => candidate === locale.language)
  }
}

/** The first of the user's preferred cultures, in order, that has a language here; undefined when none has. */
export const matchUiLocale = (names: readonly string[]): UiLocale | undefined => {
  for (const name of names) {
    const match = matchOne(name)
    if (match)
      return match
  }
  return undefined
}

/**
 * `--culture`: dnSpy's CultureService.TryCreateCultureInfo, which passes over a name that is not a culture and
 * otherwise makes it the user interface culture — so a culture dnSpy has no language for is shown in English.
 */
export const resolveCultureArgument = (name: string | undefined): UiLocale | undefined =>
  name === undefined || parseLocale(name) === undefined ? undefined : matchOne(name) ?? 'en'
