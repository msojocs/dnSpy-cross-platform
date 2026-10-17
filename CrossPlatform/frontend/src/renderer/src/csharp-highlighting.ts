import csharp from '@shikijs/langs/csharp'
import type * as Monaco from 'monaco-editor/editor/editor.api'
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { csharpTokenForScopes } from './monaco-theme'

/** One line's TextMate state, which Monaco keeps between lines so a comment or a string can run on. */
class TokenizerState implements Monaco.languages.IState {
  constructor(readonly ruleStack: unknown) {}
  clone(): TokenizerState { return this }
  equals(other: Monaco.languages.IState): boolean { return other instanceof TokenizerState && other.ruleStack === this.ruleStack }
}

const MAX_LINE_LENGTH = 20000
const TIME_LIMIT = 100

/**
 * C# in the code views, by the TextMate grammar: each run of text is named after the dnSpy colour its scopes
 * stand for (monaco-theme.ts), so the colours come from the theme in use — any `.dntheme` the theme service
 * loaded — rather than from a TextMate theme of their own.
 */
export async function installCSharpHighlighting(monaco: typeof Monaco) {
  // Only the C# grammar is needed; the embedded WASM also works offline in Electron.
  const highlighter = await createHighlighterCore({
    langs: [csharp],
    themes: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  const grammar = highlighter.getLanguage('csharp')
  monaco.languages.setTokensProvider('csharp', {
    getInitialState: () => new TokenizerState(null),
    tokenize(line, state) {
      const previous = (state as TokenizerState).ruleStack as Parameters<typeof grammar.tokenizeLine>[1]
      if (line.length >= MAX_LINE_LENGTH)
        return { endState: state, tokens: [{ startIndex: 0, scopes: '' }] }
      const result = grammar.tokenizeLine(line, previous, TIME_LIMIT)
      if (result.stoppedEarly)
        console.warn(`Time limit reached when tokenizing line: ${line.substring(0, 100)}`)
      return {
        endState: new TokenizerState(result.ruleStack),
        tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: csharpTokenForScopes(token.scopes) })),
      }
    },
  })
  return highlighter
}
