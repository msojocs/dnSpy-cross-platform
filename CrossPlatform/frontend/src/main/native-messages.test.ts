import { describe, expect, it } from 'vitest'
import { UI_LOCALES } from '../shared/ui-locales'
import { nativeMessagesFor } from './native-messages'

describe('nativeMessagesFor', () => {
  it('gives dnSpy\'s translation where it has a resource, and English where it has none', () => {
    const german = nativeMessagesFor('de')
    expect(german.yes).toBe('Ja')
    expect(german.cancel).toBe('Abbrechen')
    expect(german.selectDebugHost).toBe('Select Host Executable')
  })

  it.each(UI_LOCALES)('has every string in %s', (locale) => {
    const english = nativeMessagesFor('en')
    const messages = nativeMessagesFor(locale)
    expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort())
    for (const text of Object.values(messages))
      expect(text).toBeTruthy()
  })
})
