import { describe, expect, it } from 'vitest'
import type { AnalyzerNode, AnalyzerSource, CodeStatement, TextSpan } from '../../shared/protocol'
import {
  analyzerCopyText,
  compareOrdinalIgnoreCase,
  composeAnalyzerText,
  findReferenceCaret,
  flattenAnalyzerTree,
  lineColumnOfOffset,
  offsetOfLineColumn,
  type AnalyzerTreeState,
} from './analyzer-model'

const node = (extra: Partial<AnalyzerNode>): AnalyzerNode => ({
  kind: 'method',
  label: 'NS.Type.M() : void',
  hasChildren: true,
  isSetter: false,
  hidesParent: false,
  isPublic: true,
  ...extra,
})

const identity = (message: string): string => message

describe('composeAnalyzerText', () => {
  it('writes a member the way dnSpy does, with its token when tokens are shown', () => {
    const row = node({ metadataToken: 0x06000012 })
    expect(composeAnalyzerText(row, identity, true)).toBe('NS.Type.M() : void @06000012')
    expect(composeAnalyzerText(row, identity, false)).toBe('NS.Type.M() : void')
  })

  it('puts "(hides)" in front of a member that hides the one it was found for', () => {
    expect(composeAnalyzerText(node({ hidesParent: true, metadataToken: 1 }), identity, false)).toBe('(hides) NS.Type.M() : void')
    expect(composeAnalyzerText(node({ hidesParent: true }), (message) => message === 'hides' ? '隐藏' : message, false)).toBe('(隐藏) NS.Type.M() : void')
  })

  it('translates a search header and writes no token for searches, accessors, assemblies and modules', () => {
    expect(composeAnalyzerText(node({ kind: 'search', label: 'Used By', metadataToken: 5 }), (message) => message === 'Used By' ? '被使用' : message, true)).toBe('被使用')
    expect(composeAnalyzerText(node({ label: 'get', accessor: 'get', metadataToken: 0x06000001 }), identity, true)).toBe('get')
    expect(composeAnalyzerText(node({ kind: 'assembly', label: 'Asm, Version=1.0.0.0', metadataToken: 0x20000001 }), identity, true)).toBe('Asm, Version=1.0.0.0')
    expect(composeAnalyzerText(node({ kind: 'module', label: 'Asm.dll', metadataToken: 1 }), identity, true)).toBe('Asm.dll')
  })
})

describe('compareOrdinalIgnoreCase', () => {
  it('compares code units after upper-casing, not by a locale', () => {
    expect(compareOrdinalIgnoreCase('abc', 'ABD')).toBeLessThan(0)
    expect(compareOrdinalIgnoreCase('Used By', 'uses')).toBeLessThan(0)
    expect(compareOrdinalIgnoreCase('a', 'A')).toBe(0)
    // "_" (0x5F) sorts after the upper-case letters, where a locale's collation would put it first.
    expect(compareOrdinalIgnoreCase('_x', 'Z')).toBeGreaterThan(0)
  })
})

const tree = (): AnalyzerTreeState => ({
  rootKeys: ['r2', 'r1'],
  rows: {
    r1: { key: 'r1', node: node({ label: 'B.M() : void' }) },
    r2: { key: 'r2', node: node({ label: 'A.M() : void' }) },
    s1: { key: 's1', parentKey: 'r1', node: node({ kind: 'search', label: 'Uses', search: 'uses' }) },
    s2: { key: 's2', parentKey: 'r1', node: node({ kind: 'search', label: 'Used By', search: 'usedBy' }) },
    x1: { key: 'x1', parentKey: 's1', node: node({ label: 'Z.N() : void' }) },
    x2: { key: 'x2', parentKey: 's1', node: node({ label: 'z.N() : void' }) },
    x3: { key: 'x3', parentKey: 's1', node: node({ label: 'A.N() : void' }) },
  },
  children: {
    r1: { status: 'loaded', keys: ['s1', 's2'], truncated: false },
    s1: { status: 'loaded', keys: ['x1', 'x2', 'x3'], truncated: false },
    s2: { status: 'loading', requestKey: 'k' },
  },
  expanded: { r1: true, s1: true, s2: true },
})

describe('flattenAnalyzerTree', () => {
  it('keeps the roots in the order they were analyzed and sorts every level under them by text', () => {
    const lines = flattenAnalyzerTree(tree(), (row) => row.label)
    expect(lines.map((line) => line.kind === 'row' ? line.text : 'Searching...')).toEqual([
      'A.M() : void',
      'B.M() : void',
      // "Used By" sorts before "Uses" ordinal-ignoring-case: ' ' is below 's'.
      'Used By',
      'Searching...',
      'Uses',
      'A.N() : void',
      // Equal texts keep the order they were found in.
      'Z.N() : void',
      'z.N() : void',
    ])
    expect(lines.map((line) => line.depth)).toEqual([0, 0, 1, 2, 1, 2, 2, 2])
  })

  it('shows nothing under a row that is closed, and no "Searching..." for a member still fetching its rows', () => {
    const state = tree()
    state.expanded.r1 = false
    expect(flattenAnalyzerTree(state, (row) => row.label)).toHaveLength(2)

    const loading = tree()
    loading.children.r2 = { status: 'loading', requestKey: 'k2' }
    loading.expanded.r2 = true
    expect(flattenAnalyzerTree(loading, (row) => row.label).filter((line) => line.kind === 'searching')).toHaveLength(1)
  })
})

describe('analyzerCopyText', () => {
  it('writes each selected row on a line, a tab per level, in the order the tree shows them', () => {
    const lines = flattenAnalyzerTree(tree(), (row) => row.label)
    expect(analyzerCopyText(lines, new Set(['x3', 'r1', 's1']))).toBe('B.M() : void\n\tUses\n\t\tA.N() : void\n')
    // One row is written without a line break after it.
    expect(analyzerCopyText(lines, new Set(['s1']))).toBe('\tUses')
    expect(analyzerCopyText(lines, new Set())).toBe('')
  })
})

describe('text positions', () => {
  it('turns offsets and 1-based lines and columns into each other', () => {
    const text = 'ab\ncde\n\nf'
    expect(lineColumnOfOffset(text, 0)).toEqual({ line: 1, column: 1 })
    expect(lineColumnOfOffset(text, 4)).toEqual({ line: 2, column: 2 })
    expect(lineColumnOfOffset(text, 8)).toEqual({ line: 4, column: 1 })
    expect(offsetOfLineColumn(text, 2, 2)).toBe(4)
    expect(offsetOfLineColumn(text, 4, 1)).toBe(8)
    expect(offsetOfLineColumn(text, 9, 1)).toBe(text.length)
  })
})

describe('findReferenceCaret', () => {
  const statement = (startLine: number, ilOffset: number, ilEndOffset: number, extra: Partial<CodeStatement> = {}): CodeStatement => ({
    startLine,
    endLine: startLine,
    startColumn: 3,
    endColumn: 40,
    ilOffset,
    ilEndOffset,
    sequencePointIlOffset: ilOffset,
    modulePath: '/app/A.dll',
    metadataToken: 0x06000001,
    sourceMethodToken: 0x06000001,
    description: 'M',
    isHidden: false,
    ...extra,
  })
  //            line 1                line 2                       line 3
  const text = 'void M() {\n  var w = new Worker();\n  w.Run(); w.Run();\n}'
  const offsetOf = (fragment: string, from = 0): number => text.indexOf(fragment, from)
  const spans: TextSpan[] = [
    { start: offsetOf('Worker'), length: 6, kind: 'reference', targetNodeId: 'ctor' },
    { start: offsetOf('Run'), length: 3, kind: 'reference', targetModulePath: '/lib/B.dll', targetMetadataToken: 0x06000009 },
    { start: offsetOf('Run', offsetOf('Run') + 1), length: 3, kind: 'reference', targetModulePath: '/lib/B.dll', targetMetadataToken: 0x06000009 },
  ]
  const document = {
    text,
    spans,
    codeStatements: [
      statement(2, 0, 6),
      statement(3, 6, 20),
      // A statement of another body that happens to share the offsets: a lambda's, say.
      statement(2, 6, 20, { metadataToken: 0x06000002 }),
    ],
  }
  const source = (extra: Partial<AnalyzerSource>): AnalyzerSource => ({
    methodNodeId: 'm',
    modulePath: '/app/A.dll',
    methodToken: 0x06000001,
    ilOffset: 1,
    targets: [{ nodeId: 'ctor' }],
    ...extra,
  })

  it('puts the caret on the reference to the target inside the statement holding the offset', () => {
    expect(findReferenceCaret(document, source({}))).toEqual({ line: 2, column: 15 })
    // A target in a module the workspace does not hold is matched by file and token, the first use in the
    // statement winning.
    expect(findReferenceCaret(document, source({ ilOffset: 12, targets: [{ modulePath: '/lib/B.dll', metadataToken: 0x06000009 }] }))).toEqual({ line: 3, column: 5 })
  })

  it('falls back to the statement start, and to the last statement before the offset', () => {
    expect(findReferenceCaret(document, source({ targets: [{ nodeId: 'other' }] }))).toEqual({ line: 2, column: 3 })
    expect(findReferenceCaret(document, source({ ilOffset: 40, targets: [] }))).toEqual({ line: 3, column: 3 })
  })

  it('has no place to go without an offset or a statement for the body', () => {
    expect(findReferenceCaret(document, source({ ilOffset: null }))).toBeUndefined()
    expect(findReferenceCaret(document, source({ methodToken: 0x06000005 }))).toBeUndefined()
    expect(findReferenceCaret({ text, spans, codeStatements: [] }, source({}))).toBeUndefined()
  })
})
