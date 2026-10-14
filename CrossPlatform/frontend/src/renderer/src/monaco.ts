import { loader } from '@monaco-editor/react'
import * as monacoApi from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/vb/register'
import 'monaco-editor/languages/definitions/xml/register'
import { ilLanguage, ilLanguageConfiguration, ilThemeRules } from './il-language'

// Shiki's adapter wraps create/setTheme; ESM module namespace exports are read-only.
const monaco = { ...monacoApi, editor: { ...monacoApi.editor } }

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

if (!monaco.languages.getLanguages().some((language) => language.id === 'il'))
  monaco.languages.register({ id: 'il', extensions: ['.il'], aliases: ['IL', 'MSIL', 'CIL'] })
monaco.languages.setMonarchTokensProvider('il', ilLanguage)
monaco.languages.setLanguageConfiguration('il', ilLanguageConfiguration)
monaco.editor.defineTheme('dnspy-light', { base: 'vs', inherit: true, rules: ilThemeRules.light, colors: {} })
monaco.editor.defineTheme('dnspy-dark', { base: 'vs-dark', inherit: true, rules: ilThemeRules.dark, colors: {} })
monaco.editor.defineTheme('dnspy-high-contrast', { base: 'hc-black', inherit: true, rules: ilThemeRules.highContrast, colors: {} })
// The same three with the editor's own background taken away, which is what shows the Background Image
// window's picture behind the code the way dnSpy's own text views show it. Nothing else of the theme moves.
monaco.editor.defineTheme('dnspy-light-transparent', { base: 'vs', inherit: true, rules: ilThemeRules.light, colors: { 'editor.background': '#00000000' } })
monaco.editor.defineTheme('dnspy-dark-transparent', { base: 'vs-dark', inherit: true, rules: ilThemeRules.dark, colors: { 'editor.background': '#00000000' } })
monaco.editor.defineTheme('dnspy-high-contrast-transparent', { base: 'hc-black', inherit: true, rules: ilThemeRules.highContrast, colors: { 'editor.background': '#00000000' } })

/**
 * The Monaco theme for one of the port's four themes. With the Background Image window showing a picture the
 * editor goes without a background of its own, so the picture is what the code is read against.
 */
export const monacoThemeName = (theme: string, transparentBackground = false): string => {
  const base = theme === 'light' ? 'dnspy-light' : theme === 'hc' ? 'dnspy-high-contrast' : 'dnspy-dark'
  return transparentBackground ? `${base}-transparent` : base
}

let initialization: Promise<void> | undefined

export function initializeMonaco(): Promise<void> {
  return initialization ??= import('./csharp-highlighting')
    .then(({ installCSharpHighlighting }) => installCSharpHighlighting(monaco))
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error('Unable to initialize C# highlighting; using Monaco highlighting.', error)
    })
    .then(() => {
      loader.config({ monaco })
    })
}
