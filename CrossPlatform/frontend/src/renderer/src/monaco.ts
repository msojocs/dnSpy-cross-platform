import { loader } from '@monaco-editor/react'
import * as monacoApi from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
// The editor contributions dnSpy's text views have and the bare editor API leaves out: the find widget (Ctrl+F,
// F3), the hover that shows Quick Info, and brace matching. They have to be loaded before any editor is
// created, which is why they come with the shared Monaco module rather than with a particular view. Folding,
// Monaco's word highlighter, its font zoom and its Go to Line palette stay out: dnSpy's viewer has no folding,
// highlights references rather than words, and zooms and goes to a line its own way (document-viewer.ts).
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
// The Roslyn code editor's contributions (the suggest widget, parameter hints, on-type formatting): the suggest
// widget's services are registered when its module loads, and Monaco takes no services after its first editor,
// so they come here too. The other editors keep what they had: their models are no Roslyn documents, so the
// providers answer nothing for them, and the decompiled documents are read-only, where nothing suggests.
import './roslyn-editor-contribs'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/vb/register'
import 'monaco-editor/languages/definitions/xml/register'
import { ilLanguage, ilLanguageConfiguration } from './il-language'
import { registerDocumentEditorProviders } from './document-editor'
import { monacoThemeData } from './monaco-theme'
import { resolveTheme } from './theme-service'

// A plain object over the module namespace, whose exports are read-only, for the loader to be handed.
const monaco = { ...monacoApi, editor: { ...monacoApi.editor } }

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

if (!monaco.languages.getLanguages().some((language) => language.id === 'il'))
  monaco.languages.register({ id: 'il', extensions: ['.il'], aliases: ['IL', 'MSIL', 'CIL'] })
monaco.languages.setMonarchTokensProvider('il', ilLanguage)
monaco.languages.setLanguageConfiguration('il', ilLanguageConfiguration)

const definedThemes = new Set<string>()

/**
 * The Monaco theme for the dnSpy theme the options name (see theme-service.ts), defined the first time it is
 * asked for. With the Background Image window showing a picture the editor goes without a background of its
 * own, so the picture is what the code is read against, the way dnSpy's own text views show it.
 */
export const monacoThemeName = (theme: string, transparentBackground = false): string => {
  const dsTheme = resolveTheme(theme)
  const name = `dnspy-${dsTheme.guid.toLowerCase()}${transparentBackground ? '-transparent' : ''}`
  if (!definedThemes.has(name)) {
    monaco.editor.defineTheme(name, monacoThemeData(dsTheme, transparentBackground))
    definedThemes.add(name)
  }
  return name
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
      // The decompiled documents' Quick Info comes from the data each view records for its model.
      registerDocumentEditorProviders(monaco, { languages: ['csharp', 'vb', 'il', 'plaintext', 'xml'] })
      loader.config({ monaco })
    })
}
