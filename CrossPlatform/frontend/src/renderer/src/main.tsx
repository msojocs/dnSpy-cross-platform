import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'flexlayout-react/style/light.css'
import './styles.css'
import { App, migrateLegacyTheme } from './App'
import { LanguageProvider } from './localization'
import { loadAppOptions } from './components/app-options'
import { applyTheme, loadThemes, resolveTheme, setSystemHighContrast } from './theme-service'

// A theme an older build kept in a key of its own is moved into the options before anything reads them.
migrateLegacyTheme()

// dnSpy's ThemeService loads every theme and puts the saved one on before its window shows; the user's theme
// files come with the preload, so the first paint is already in the right colours. The system's high-contrast
// mode is what SystemParameters.HighContrast tells dnSpy, and it is followed while the app runs.
loadThemes(window.dnSpy?.themeFiles ?? [])
const highContrastQuery = window.matchMedia?.('(forced-colors: active)')
setSystemHighContrast(highContrastQuery?.matches === true)
highContrastQuery?.addEventListener?.('change', (event) => setSystemHighContrast(event.matches))
applyTheme(resolveTheme(loadAppOptions().environmentGeneral.theme))

// MetroWindow draws its caption in the active or the inactive colours as the window gains and loses focus.
const markWindowActive = (): void => { document.documentElement.dataset.windowActive = String(document.hasFocus()) }
window.addEventListener('focus', markWindowActive)
window.addEventListener('blur', markWindowActive)
markWindowActive()

const root = document.getElementById('root')
if (!root)
  throw new Error('The application root element is missing.')

createRoot(root).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>,
)
