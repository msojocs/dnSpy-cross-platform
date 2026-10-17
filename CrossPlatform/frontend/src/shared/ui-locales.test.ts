import { describe, expect, it } from 'vitest'
import { matchUiLocale, resolveCultureArgument } from './ui-locales'

describe('matchUiLocale', () => {
  it.each([
    ['de', 'de'],
    ['de-DE', 'de'],
    ['de_DE.UTF-8', 'de'],
    ['ZH-cn', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh-Hant-TW', 'zh-CN'],
    ['pt', 'pt-BR'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['pt-MZ', 'pt-PT'],
    ['es', 'es-ES'],
    ['es-419', 'es-ES'],
    ['fa-IR', 'fa'],
    ['en-US', 'en'],
  ])('reads %s as %s', (name, expected) => {
    expect(matchUiLocale([name])).toBe(expected)
  })

  it('takes the first preference there is a language for', () => {
    expect(matchUiLocale(['ja-JP', 'uk-UA', 'ru'])).toBe('uk')
    expect(matchUiLocale(['ja-JP', 'ko'])).toBeUndefined()
    expect(matchUiLocale([])).toBeUndefined()
  })
})

describe('resolveCultureArgument', () => {
  it('chooses the language a culture name has, English for a culture dnSpy has none for', () => {
    expect(resolveCultureArgument('de-AT')).toBe('de')
    expect(resolveCultureArgument('zh')).toBe('zh-CN')
    expect(resolveCultureArgument('ja-JP')).toBe('en')
  })

  it('passes over a name that is no culture at all, the way CultureService does', () => {
    expect(resolveCultureArgument(undefined)).toBeUndefined()
    expect(resolveCultureArgument('')).toBeUndefined()
    expect(resolveCultureArgument('not a culture')).toBeUndefined()
  })
})
