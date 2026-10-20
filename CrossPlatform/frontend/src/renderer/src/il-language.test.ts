import * as monaco from 'monaco-editor/editor/editor.api'
import { describe, expect, it } from 'vitest'
import { ilLanguage, ilLanguageConfiguration } from './il-language'

describe('IL Monaco language', () => {
  it('recognizes representative CIL opcodes and editor pairs', () => {
    expect(ilLanguage.opcodes).toEqual(expect.arrayContaining(['callvirt', 'ldstr', 'readonly.', 'ret']))
    expect(ilLanguage.typeKeywords).toEqual(expect.arrayContaining(['class', 'int32', 'string', 'void']))
    expect(ilLanguage.modifiers).toEqual(expect.arrayContaining(['managed', 'public', 'static']))
    expect(ilLanguage.directives).toEqual(expect.arrayContaining(['.class', '.maxstack', '.method']))
    expect(ilLanguageConfiguration.comments).toEqual({ lineComment: '//', blockComment: ['/*', '*/'] })
    expect(ilLanguageConfiguration.brackets).toContainEqual(['{', '}'])
  })

  it('tokenizes directives, offsets, opcodes, modifiers and types', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    })
    const languageId = 'il-tokenizer-test'
    monaco.languages.register({ id: languageId })
    const tokenRegistration = monaco.languages.setMonarchTokensProvider(languageId, ilLanguage)
    try {
      const [method] = monaco.editor.tokenize('.method Public System.Int32 get_Value()', languageId)
      expect(method.map((token) => token.type)).toEqual(expect.arrayContaining([
        'keyword.directive.il',
        'keyword.modifier.il',
        'type.identifier.il',
        'identifier.member.il',
      ]))

      const [instruction] = monaco.editor.tokenize('IL_0000: ldarg.0', languageId)
      expect(instruction.map((token) => token.type)).toEqual(expect.arrayContaining([
        'constant.offset.il',
        'keyword.opcode.il',
      ]))

      const compilerNames = '<Module>{4b60ccf7-f7e1-43ef-8566-9ce466e3c09f}::m_7b71029ea46b4e36a0bb37c3456aec7 Type::<Value>k__BackingField'
      const [compilerNameTokens] = monaco.editor.tokenize(compilerNames, languageId)
      const tokenAt = (offset: number): string | undefined => compilerNameTokens.find((token, index) =>
        token.offset <= offset && (compilerNameTokens[index + 1]?.offset ?? compilerNames.length) > offset)?.type
      expect(tokenAt(compilerNames.indexOf('>'))).toBe('type.identifier.il')
      expect(tokenAt(compilerNames.indexOf('{') + 1)).toBe('constant.module-id.il')
      expect(tokenAt(compilerNames.indexOf('::') + 2)).toBe('identifier.member.il')
      expect(tokenAt(compilerNames.lastIndexOf('>'))).toBe('identifier.member.il')

      // What dnSpy's disassembler writes around the instructions: the bytes comment, the exception blocks,
      // custom attributes and the locals.
      const typesOf = (line: string): string[] => monaco.editor.tokenize(line, languageId)[0].map((token) => token.type)
      const bytes = '/* 0x000003B8 2A           */ IL_0000: ret'
      const [bytesTokens] = monaco.editor.tokenize(bytes, languageId)
      expect(bytesTokens[0].type).toBe('comment.il')
      expect(bytesTokens.find((token) => token.offset === bytes.indexOf('IL_'))?.type).toBe('constant.offset.il')
      expect(typesOf('.try')).toEqual(['keyword.directive.il'])
      // ilasm's single quotes make a name of what is no identifier; strings are in double quotes.
      expect(typesOf("'<Code>k__BackingField'")).toEqual(['identifier.member.il'])
      expect(typesOf('ldstr "text"')).toContain('string.il')
      expect(typesOf('} // end .try')).toEqual(expect.arrayContaining(['comment.il']))
      expect(typesOf('catch [System.Runtime]System.Exception')).toContain('keyword.modifier.il')
      expect(typesOf('filter')).toEqual(['keyword.modifier.il'])
      expect(typesOf('.custom instance void [System.Runtime]System.FlagsAttribute::.ctor() = (')).toEqual(expect.arrayContaining([
        'keyword.directive.il',
        'keyword.modifier.il',
        'type.keyword.il',
      ]))
      const locals = monaco.editor.tokenize('.locals init (', languageId)[0]
      expect(locals.map((token) => token.type)).toEqual(expect.arrayContaining(['keyword.directive.il', 'keyword.modifier.il']))
      expect(locals.find((token) => token.offset === '.locals '.length)?.type).toBe('keyword.modifier.il')
    }
    finally {
      tokenRegistration.dispose()
    }
  })
})
