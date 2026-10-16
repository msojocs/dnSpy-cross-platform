import { describe, expect, it } from 'vitest'
import type { CodeStatement, SearchResult } from '../../shared/protocol'
import { findSearchResultCaret, SEARCH_LOCATIONS, SEARCH_TYPES, sortSearchResults } from './search-model'

const result = (name: string, location = 'Ns'): SearchResult => ({ kind: 'type', name, location })

const statement = (extra: Partial<CodeStatement>): CodeStatement => ({
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, ilOffset: 0, ilEndOffset: 1, sequencePointIlOffset: 0,
  modulePath: '/app/App.dll', metadataToken: 0x06000001, sourceMethodToken: 0x06000001, description: '', isHidden: false, ...extra,
})

describe('search model', () => {
  it('lists dnSpy\'s "Search For" entries and locations in its order, with its Ctrl letters', () => {
    expect(SEARCH_TYPES.map((entry) => entry.type)).toEqual([
      'assembly', 'module', 'namespace', 'type', 'field', 'method', 'property', 'event', 'parameter', 'local',
      'parameterLocal', 'assemblyRef', 'moduleRef', 'resource', 'genericType', 'nonGenericType', 'enum', 'interface',
      'class', 'struct', 'delegate', 'member', 'any', 'literal',
    ])
    expect(SEARCH_TYPES.filter((entry) => entry.key).map((entry) => entry.key).join('')).toBe('tfmpejinrubl')
    expect(SEARCH_LOCATIONS.map((entry) => entry.key).join('')).toBe('gsdq')
  })

  it('sorts by name ignoring case, keeping two of one name in the order they were found', () => {
    const sorted = sortSearchResults([result('beta'), result('Alpha'), result('alpha', 'Other'), result('Gamma')])
    expect(sorted.map((item) => `${item.name}|${item.location}`)).toEqual(['Alpha|Ns', 'alpha|Other', 'beta|Ns', 'Gamma|Ns'])
  })

  it('puts the caret at the start of the statement a body match is in', () => {
    const document = {
      text: 'a\n  b();\n  c();\n',
      spans: [],
      codeStatements: [
        statement({ startLine: 2, startColumn: 3, ilOffset: 0, sequencePointIlOffset: 0, ilEndOffset: 6 }),
        statement({ startLine: 3, startColumn: 3, ilOffset: 6, sequencePointIlOffset: 6, ilEndOffset: 12 }),
      ],
    }
    expect(findSearchResultCaret(document, 0x06000001, 7)).toEqual({ line: 3, column: 3 })
    // A document of another method, or one with no statements — Visual Basic — has nowhere to put it.
    expect(findSearchResultCaret(document, 0x06000002, 7)).toBeUndefined()
    expect(findSearchResultCaret({ ...document, codeStatements: undefined }, 0x06000001, 7)).toBeUndefined()
  })

  it('puts the caret on the instruction in IL, whose statements are the instructions', () => {
    const document = {
      text: '.method void Run()\n{\n  IL_0000: nop\n  IL_0001: ldc.i4 42\n  IL_0006: ret\n}\n',
      spans: [],
      codeStatements: [
        statement({ startLine: 3, endLine: 3, startColumn: 3, endColumn: 14, ilOffset: 0, ilEndOffset: 1, sequencePointIlOffset: 0 }),
        statement({ startLine: 4, endLine: 4, startColumn: 3, endColumn: 20, ilOffset: 1, ilEndOffset: 6, sequencePointIlOffset: 1 }),
        statement({ startLine: 5, endLine: 5, startColumn: 3, endColumn: 14, ilOffset: 6, ilEndOffset: 7, sequencePointIlOffset: 6 }),
      ],
    }
    expect(findSearchResultCaret(document, 0x06000001, 1)).toEqual({ line: 4, column: 3 })
  })
})
