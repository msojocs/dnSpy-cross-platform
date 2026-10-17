import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LanguageProvider, useLanguage } from './localization'

const LanguageProbe = (): React.JSX.Element => {
  const { locale, setLanguage, t } = useLanguage()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span>{t('Opened {count} module(s).', { count: 2 })}</span>
      <span data-testid="file">{t('File')}</span>
      <span data-testid="remove">{t('Remove {name}', { name: 'Program' })}</span>
      <button onClick={() => setLanguage('en')}>English</button>
    </div>
  )
}

/** Makes the browser report these languages as the user's preferences, the way Chromium hands the system's on. */
const preferLanguages = (languages: string[]): void => {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (navigator as { languages?: readonly string[] }).languages
})

describe('localization', () => {
  it('renders Simplified Chinese and switches languages immediately', async () => {
    const setLocale = vi.fn(async () => undefined)
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, setLocale } })

    render(<LanguageProvider initialLanguage="zh-CN"><LanguageProbe /></LanguageProvider>)

    expect(screen.getByText('已打开 2 个模块。')).toBeVisible()
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN')
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(screen.getByText('Opened 2 module(s).')).toBeVisible()
    await waitFor(() => expect(setLocale).toHaveBeenLastCalledWith('en'))
  })

  it('loads and persists the selected language', async () => {
    localStorage.setItem('dnspy.language', 'zh-CN')
    render(<LanguageProvider><LanguageProbe /></LanguageProvider>)

    expect(screen.getByText('zh-CN')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    await waitFor(() => expect(localStorage.getItem('dnspy.language')).toBe('en'))
  })

  it('renders dnSpy\'s German, with the placeholders named, and English where dnSpy has no resource', () => {
    render(<LanguageProvider initialLanguage="de"><LanguageProbe /></LanguageProvider>)

    expect(screen.getByTestId('file')).toHaveTextContent('Datei')
    // dnSpy's "{0} entfernen", its format item renamed after the port's placeholder.
    expect(screen.getByTestId('remove')).toHaveTextContent('Program entfernen')
    // A message only the port writes has no German resource, and so reads in English.
    expect(screen.getByText('Opened 2 module(s).')).toBeVisible()
    expect(document.documentElement).toHaveAttribute('lang', 'de')
  })

  it('keeps the left-to-right layout for Persian, the way dnSpy does', () => {
    render(<LanguageProvider initialLanguage="fa"><LanguageProbe /></LanguageProvider>)

    expect(screen.getByTestId('file')).toHaveTextContent('فایل')
    expect(document.documentElement).toHaveAttribute('lang', 'fa')
    expect(document.documentElement).not.toHaveAttribute('dir')
  })

  it.each([
    [['de-AT', 'en-US'], 'de'],
    [['en-GB', 'de'], 'en'],
    [['ja-JP', 'pt'], 'pt-BR'],
    [['pt-AO'], 'pt-PT'],
    [['es-MX'], 'es-ES'],
    [['zh-TW'], 'zh-CN'],
    [['ja-JP', 'ko'], 'en'],
  ])('resolves the system languages %j to %s', (languages, expected) => {
    preferLanguages(languages)
    render(<LanguageProvider initialLanguage="system"><LanguageProbe /></LanguageProvider>)

    expect(screen.getByTestId('locale').textContent).toBe(expected)
  })

  it('loads a saved language of any of dnSpy\'s cultures, and passes over one it does not know', () => {
    localStorage.setItem('dnspy.language', 'pt-PT')
    const { unmount } = render(<LanguageProvider><LanguageProbe /></LanguageProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('pt-PT')
    expect(screen.getByTestId('file')).toHaveTextContent('Ficheiro')
    unmount()

    preferLanguages(['en-US'])
    localStorage.setItem('dnspy.language', 'klingon')
    render(<LanguageProvider><LanguageProbe /></LanguageProvider>)
    expect(screen.getByTestId('locale').textContent).toBe('en')
  })
})
