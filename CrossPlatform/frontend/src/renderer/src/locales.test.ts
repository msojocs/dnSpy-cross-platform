import { describe, expect, it } from 'vitest'
import { UI_LOCALES } from '../../shared/ui-locales'
import { generatedLocales } from './locales.generated'
import { zhCN } from './locales/zh-CN'

// locales.generated.ts is dnSpy's resx translations of the strings locales/zh-CN.ts lists, written by
// scripts/generate-locales.mjs and checked in; src/main/generated-locales.test.ts checks that it is current.

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

describe('the generated languages', () => {
  it('has a table for every language but English and Simplified Chinese', () => {
    expect(Object.keys(generatedLocales).sort()).toEqual(UI_LOCALES.filter((locale) => locale !== 'en' && locale !== 'zh-CN').sort())
  })

  it.each(Object.entries(generatedLocales))('%s translates only strings the port has, with the same placeholders', (_locale, table) => {
    for (const [english, translation] of Object.entries(table)) {
      expect(zhCN, english).toHaveProperty([english])
      expect(placeholders(translation), english).toEqual(placeholders(english))
      // A .NET format item with an alignment or a format would be left for translate() to print as it is.
      expect(translation, english).not.toMatch(/\{\d+[,:][^}]*\}/)
    }
  })
})
