import { describe, expect, it } from 'vitest'
import type { StringReference } from '../../shared/protocol'
import { nextStringReferencesSort, sortStringReferences, stringReferencesFilter } from './string-references-model'

const reference = (overrides: Partial<StringReference>): StringReference => ({
  kind: 'il',
  literal: 'text',
  formattedLiteral: '"text"',
  isVerbatim: false,
  referrerParts: [{ text: 'Holder.Run()', color: 'text' }],
  referrerIcon: 'method',
  moduleName: 'A.dll',
  token: 0x06000001,
  nodeId: 'n',
  ilOffset: 0,
  ...overrides,
})

const literals = (references: StringReference[]): string[] => references.map((r) => r.literal)

describe('the String References list order', () => {
  const ilLate = reference({ literal: 'b', token: 0x06000002, ilOffset: 4 })
  const ilEarly = reference({ literal: 'c', token: 0x06000002, ilOffset: 1 })
  const ilFirst = reference({ literal: 'Z', token: 0x06000001, ilOffset: 9, moduleName: 'B.dll' })
  const constant = reference({ kind: 'constant', literal: 'a', token: 0x04000001, ilOffset: null })
  const attribute = reference({ kind: 'attribute', literal: 'A', token: 0x02000002, ilOffset: null, referrerParts: [{ text: 'Alpha', color: 'type' }] })
  const all = [attribute, constant, ilLate, ilFirst, ilEarly]

  it('lists by kind, then token, then IL offset when no column is sorted', () => {
    expect(literals(sortStringReferences(all, undefined))).toEqual(['Z', 'c', 'b', 'a', 'A'])
  })

  it('reverses every key going down', () => {
    expect(literals(sortStringReferences(all, { column: 'kind', descending: true }))).toEqual(['A', 'a', 'b', 'c', 'Z'])
  })

  it('compares literals without case, ties falling back on the kind order', () => {
    const tie = reference({ kind: 'constant', literal: 'b', token: 0x04000009, ilOffset: null })
    expect(literals(sortStringReferences([...all, tie], { column: 'literal', descending: false }))).toEqual(['a', 'A', 'b', 'b', 'c', 'Z'])
  })

  it('sorts referrers by their text', () => {
    const sorted = sortStringReferences(all, { column: 'referrer', descending: false })
    expect(sorted[0]).toBe(attribute)
  })

  it('tells IL rows apart by module only after the kind, the way dnSpy\'s ModuleComparer is written', () => {
    const otherModule = reference({ literal: 'm', token: 0x06000009, moduleName: '0.dll' })
    expect(literals(sortStringReferences([ilFirst, otherModule, constant], { column: 'module', descending: false }))).toEqual(['m', 'Z', 'a'])
  })

  it('cycles a header through up, down and unsorted', () => {
    const up = nextStringReferencesSort(undefined, 'literal')
    expect(up).toEqual({ column: 'literal', descending: false })
    const down = nextStringReferencesSort(up, 'literal')
    expect(down).toEqual({ column: 'literal', descending: true })
    expect(nextStringReferencesSort(down, 'literal')).toBeUndefined()
    expect(nextStringReferencesSort(down, 'module')).toEqual({ column: 'module', descending: false })
  })
})

describe('the String References filter', () => {
  const plain = reference({ literal: 'Hello\nWorld', formattedLiteral: '"Hello\\nWorld"' })
  const settings = { caseSensitive: false, regex: false, matchFormatted: false }

  it('matches a substring, without case unless asked', () => {
    expect(stringReferencesFilter('hello', settings).matches?.(plain)).toBe(true)
    expect(stringReferencesFilter('hello', { ...settings, caseSensitive: true }).matches?.(plain)).toBe(false)
    expect(stringReferencesFilter('', settings).matches?.(plain)).toBe(true)
  })

  it('matches the formatted literal when asked', () => {
    expect(stringReferencesFilter('\\n', settings).matches?.(plain)).toBe(false)
    expect(stringReferencesFilter('\\n', { ...settings, matchFormatted: true }).matches?.(plain)).toBe(true)
    expect(stringReferencesFilter('"Hello', { ...settings, matchFormatted: true }).matches?.(plain)).toBe(true)
  })

  it('matches a regular expression, and names the error of one that is not', () => {
    expect(stringReferencesFilter('^hel+o', { ...settings, regex: true }).matches?.(plain)).toBe(true)
    expect(stringReferencesFilter('^hel+o', { ...settings, regex: true, caseSensitive: true }).matches?.(plain)).toBe(false)
    const invalid = stringReferencesFilter('(', { ...settings, regex: true })
    expect(invalid.matches).toBeUndefined()
    expect(invalid.error).toBe('Invalid regular expression pattern')
  })
})
