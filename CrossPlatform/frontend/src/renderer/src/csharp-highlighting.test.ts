import * as monacoApi from 'monaco-editor/editor/editor.api'
import 'monaco-editor/languages/definitions/csharp/register'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installCSharpHighlighting } from './csharp-highlighting'
import { ilLanguage } from './il-language'
import { monacoThemeData } from './monaco-theme'
import { resolveTheme } from './theme-service'

const monaco = { ...monacoApi, editor: { ...monacoApi.editor } }
// dnSpy's four themes by the names their .dntheme files give them.
const THEMES = ['light', 'dark', 'blue', 'hc']
let highlighter: Awaited<ReturnType<typeof installCSharpHighlighting>>

beforeAll(async () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
  highlighter = await installCSharpHighlighting(monaco)
  for (const name of THEMES)
    monaco.editor.defineTheme(name, monacoThemeData(resolveTheme(name)))
})
afterAll(() => highlighter?.dispose())

const tokenAt = (line: string, needle: string): string => {
  const [tokens] = monaco.editor.tokenize(line, 'csharp')
  const offset = line.indexOf(needle)
  return tokens.find((token, index) => token.offset <= offset
    && (tokens[index + 1]?.offset ?? line.length) > offset)!.type
}

describe('C# TextMate highlighting', () => {
  it.each(THEMES)('distinguishes types, methods and keywords in %s', (theme) => {
    monaco.editor.setTheme(theme)
    const declaration = 'public class Example { public string Format(int value) => $"Value: {value}"; }'
    expect(tokenAt(declaration, 'Example')).not.toBe(tokenAt(declaration, 'class'))
    expect(tokenAt(declaration, 'Format')).not.toBe(tokenAt(declaration, 'string'))
    expect(tokenAt(declaration, 'Value:')).not.toBe(tokenAt(declaration, 'value}"'))
    expect(tokenAt(declaration, 'Format')).not.toBe('')
  })

  it('keeps comment and verbatim string state across lines, then resumes code', () => {
    monaco.editor.setTheme('dark')
    const code = '/* comment\nclass Fake {}\n*/\nvar text = @"first\nsecond ""quoted""\nlast";\npublic class Real {}'
    const tokens = monaco.editor.tokenize(code, 'csharp')
    expect(tokens[1].every((token) => token.type === tokenAt('// comment', 'comment'))).toBe(true)
    expect(tokens[4][0].type).toBe(tokenAt('var s = "second";', 'second'))
    expect(tokens[6].some((token) => token.type === tokenAt('public class Real {}', 'Real'))).toBe(true)
    expect(tokens[6][0].type).not.toBe(tokens[1][0].type)
  })

  it('supports raw strings and recognizes code after their closing delimiter', () => {
    monaco.editor.setTheme('dark')
    const tokens = monaco.editor.tokenize('var json = """\n{"key": "value"}\n""";\npublic class Real {}', 'csharp')
    expect(tokens[1].every((token) => token.type === tokenAt('var s = "value";', 'value'))).toBe(true)
    expect(tokens[3][0].type).toBe(tokenAt('public class Real {}', 'public'))
  })

  it('retains IL tokens while switching themes and limits very long C# lines', () => {
    monaco.languages.register({ id: 'il' })
    const registration = monaco.languages.setMonarchTokensProvider('il', ilLanguage)
    try {
      for (const theme of THEMES) {
        monaco.editor.setTheme(theme)
        const [tokens] = monaco.editor.tokenize('IL_0000: ldarg.0', 'il')
        expect(tokens.map((token) => token.type)).toEqual(expect.arrayContaining(['constant.offset.il', 'keyword.opcode.il']))
      }
      const [tokens] = monaco.editor.tokenize('x'.repeat(20000), 'csharp')
      expect(tokens).toHaveLength(1)
      expect(tokens[0].type).toBe('')
    }
    finally {
      registration.dispose()
    }
  })
})
