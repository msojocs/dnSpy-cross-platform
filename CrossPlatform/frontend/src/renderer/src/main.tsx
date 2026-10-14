import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'flexlayout-react/style/light.css'
import './styles.css'
import { App, migrateLegacyTheme } from './App'
import { LanguageProvider } from './localization'

// A theme an older build kept in a key of its own is moved into the options before anything reads them.
migrateLegacyTheme()

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
