import { describe, expect, it } from 'vitest'
import type { KeywordReference, TextSpan } from '../../shared/protocol'
import {
  blockLines, blockStructureColor, buildClipboardHtml, caretForSpan, definitionForNode, definitionOf, integerLiteralValue, keywordAtCaret,
  keywordHighlights, localToolTip, nextDefinition, nextReference, numberToolTip, opCodeUrl, parseGoToLine, positionAt, referenceHighlights,
  sameReference, spanAtCaret, spanAtClick,
} from './document-viewer'

// `int num = 0; num += left; return num;` — a local declared, written and read, a parameter, and a call.
const text = 'int num = 0; num += left; return Calc(num);'
const spans: TextSpan[] = [
  { start: 4, length: 3, kind: 'definition', localId: 'L0', color: 'local', toolTip: [{ text: '(local variable) int num', color: 'text' }] },
  { start: 13, length: 3, kind: 'reference', localId: 'L0', color: 'local', isWrite: true },
  { start: 20, length: 4, kind: 'reference', localId: 'L1', color: 'parameter' },
  { start: 33, length: 4, kind: 'reference', targetNodeId: 'n7', color: 'staticMethod' },
  { start: 38, length: 3, kind: 'reference', localId: 'L0', color: 'local' },
]
const at = (word: string, from = 0): number => text.indexOf(word, from)

describe('spans under the mouse and the caret', () => {
  it('hit-tests a click strictly but lets the caret sit just past a reference', () => {
    expect(spanAtClick(spans, at('num'))?.start).toBe(4)
    expect(spanAtClick(spans, at('num') + 3)).toBeUndefined()
    expect(spanAtCaret(spans, at('num') + 3)?.start).toBe(4)
    // A span that starts at the caret wins over one that ends there: `Calc(num` has `(` between them, so the
    // caret after `Calc` is on Calc.
    expect(spanAtCaret(spans, 37)?.targetNodeId).toBe('n7')
  })

  it('reaches a keyword the same way', () => {
    const keywords: KeywordReference[] = [{ start: 26, length: 6, group: 0 }]
    expect(keywordAtCaret(keywords, 32)?.start).toBe(26)
    expect(keywordAtCaret(keywords, 33)).toBeUndefined()
  })
})

describe('what names the same thing', () => {
  it('ties a local to itself and a member to its node or its file and token', () => {
    expect(sameReference(spans[0], spans[1])).toBe(true)
    expect(sameReference(spans[0], spans[2])).toBe(false)
    expect(sameReference(spans[3], { start: 0, length: 4, kind: 'definition', targetNodeId: 'n7' })).toBe(true)
    expect(sameReference(
      { start: 0, length: 1, kind: 'reference', targetModulePath: '/a/B.dll', targetMetadataToken: 0x06000001 },
      { start: 5, length: 1, kind: 'reference', targetModulePath: '/a/b.dll', targetMetadataToken: 0x06000001 },
    )).toBe(true)
    expect(sameReference({ start: 0, length: 1, kind: 'reference', opCode: 'ldarg.0' }, { start: 9, length: 1, kind: 'reference', opCode: 'ldarg.0' })).toBe(true)
  })

  it('marks a definition, a write and a read apart, as the highlighter does', () => {
    expect(referenceHighlights(spans, spans[4]).map((highlight) => highlight.kind)).toEqual(['definition', 'write', 'reference'])
    expect(keywordHighlights([{ start: 0, length: 2, group: 1 }, { start: 5, length: 4, group: 1 }, { start: 9, length: 2, group: 2 }], { start: 0, length: 2, group: 1 }))
      .toEqual([{ start: 0, length: 2, kind: 'reference' }, { start: 5, length: 4, kind: 'reference' }])
  })

  it('finds a reference definition in the document, and a member definition by its node', () => {
    expect(definitionOf(spans, spans[1])?.start).toBe(4)
    expect(definitionOf(spans, spans[3])).toBeUndefined()
    expect(definitionForNode([{ start: 10, length: 4, kind: 'definition', targetNodeId: 'n7' }], 'n7')?.start).toBe(10)
    expect(localToolTip(spans, 'L0')?.[0].text).toBe('(local variable) int num')
  })
})

describe('moving between references', () => {
  it('cycles through the uses of what the caret is on, wrapping at either end', () => {
    expect(nextReference(spans, [], at('num'), true)?.start).toBe(13)
    expect(nextReference(spans, [], 13, true)?.start).toBe(38)
    expect(nextReference(spans, [], 38, true)?.start).toBe(4)
    expect(nextReference(spans, [], 4, false)?.start).toBe(38)
    expect(nextReference(spans, [], 0, true)).toBeUndefined()
  })

  it('cycles through a group of related keywords when the caret is on one', () => {
    const keywords: KeywordReference[] = [{ start: 0, length: 2, group: 3 }, { start: 20, length: 4, group: 3 }, { start: 40, length: 2, group: 4 }]
    expect(nextReference(spans, keywords, 1, true)?.start).toBe(20)
    expect(nextReference(spans, keywords, 21, true)?.start).toBe(0)
  })

  it('steps through member definitions only', () => {
    const definitions: TextSpan[] = [
      { start: 10, length: 3, kind: 'definition', targetNodeId: 'a' },
      { start: 20, length: 3, kind: 'definition', localId: 'L0' },
      { start: 30, length: 3, kind: 'definition', targetModulePath: '/x.dll', targetMetadataToken: 1 },
    ]
    expect(nextDefinition(definitions, 0, true)?.start).toBe(10)
    expect(nextDefinition(definitions, 11, true)?.start).toBe(30)
    expect(nextDefinition(definitions, 31, true)?.start).toBe(10)
    expect(nextDefinition(definitions, 11, false)?.start).toBe(30)
  })

  it('puts the caret at the end of a span unless another reference starts there', () => {
    expect(caretForSpan(spans, spans[0])).toEqual({ anchor: 4, active: 7 })
    const touching: TextSpan[] = [{ start: 0, length: 3, kind: 'reference', targetNodeId: 'a' }, { start: 3, length: 2, kind: 'reference', targetNodeId: 'b' }]
    expect(caretForSpan(touching, touching[0])).toEqual({ anchor: 3, active: 0 })
  })
})

describe('the Go to Line box', () => {
  const translate = (message: string, values?: Record<string, string | number>): string =>
    message.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ''))

  it('takes a line, a line and a column, or a column on the current line', () => {
    expect(parseGoToLine('12', 3, 40, translate)).toEqual({ line: 12 })
    expect(parseGoToLine(' 12 , 5 ', 3, 40, translate)).toEqual({ line: 12, column: 5 })
    expect(parseGoToLine(', 7', 3, 40, translate)).toEqual({ line: 3, column: 7 })
  })

  it('says why it cannot go somewhere, in dnSpy\'s words', () => {
    expect(parseGoToLine('  ', 3, 40, translate)).toEqual({ error: 'Enter a line number' })
    expect(parseGoToLine('41', 3, 40, translate)).toEqual({ error: 'Invalid line: 41' })
    expect(parseGoToLine('0', 3, 40, translate)).toEqual({ error: 'Invalid line: 0' })
    expect(parseGoToLine('2,0', 3, 40, translate)).toEqual({ error: 'Invalid line: 2,0' })
    expect(parseGoToLine('x', 3, 40, translate)).toEqual({ error: 'Invalid line: x' })
  })
})

describe('block structure lines', () => {
  it('runs between the ends of a block, at the column of the end indented less', () => {
    const lines = ['class A', '{', '\tvoid M()', '\t{', '\t\tx();', '\t}', '}']
    const starts = lines.reduce<number[]>((all, _, index) => [...all, index === 0 ? 0 : all[index - 1] + lines[index - 1].length + 1], [])
    const lineOf = (offset: number): number => starts.filter((start) => start <= offset).length
    const blocks = blockLines(
      [{ start: starts[1], end: starts[6], kind: 'type' }, { start: starts[3] + 1, end: starts[5] + 1, kind: 'method' }, { start: 0, end: 2, kind: 'other' }],
      lineOf,
      (line) => lines[line - 1],
    )
    expect(blocks).toEqual([
      { kind: 'type', fromLine: 3, toLine: 6, column: 1 },
      { kind: 'method', fromLine: 5, toLine: 5, column: 2 },
    ])
    expect(blockStructureColor('anonymousMethod')).toBe('blockStructureAnonymousMethod')
  })
})

describe('tooltips, links and the clipboard', () => {
  it('writes a number in the four bases dnSpy shows', () => {
    expect(integerLiteralValue('0x2A')).toBe(42n)
    expect(integerLiteralValue('&H2A')).toBe(42n)
    expect(integerLiteralValue('1_000UL')).toBe(1000n)
    expect(integerLiteralValue('num')).toBeUndefined()
    expect(numberToolTip(42n)).toEqual(['Base 2: 10_1010', 'Base 8: 52', 'Base 10: 42', 'Base 16: 2A'])
    expect(numberToolTip(1234567n)[2]).toBe('Base 10: 1_234_567')
  })

  it('sends an opcode to its documentation page', () => {
    expect(opCodeUrl('ldarg.0')).toBe('https://docs.microsoft.com/dotnet/api/system.reflection.emit.opcodes.ldarg_0')
    expect(opCodeUrl('tail.')).toBe('https://docs.microsoft.com/dotnet/api/system.reflection.emit.opcodes.tail')
  })

  it('builds colored HTML for a copy, escaping the text and keeping its spaces', () => {
    const html = buildClipboardHtml([[{ text: 'if', color: '#0000ff' }, { text: ' (a < b)' }], [{ text: '\tx' }]], 'Consolas', 13, 4)
    expect(html).toContain('<span style="color:#0000ff;">if</span> (a &lt; b)<br/>')
    expect(html).toContain('&nbsp; &nbsp; x')
    expect(html).toContain('font-family:Consolas')
  })

  it('turns an offset into a line and a column', () => {
    expect(positionAt('ab\r\ncd\nef', 0)).toEqual({ line: 1, column: 1 })
    expect(positionAt('ab\r\ncd\nef', 5)).toEqual({ line: 2, column: 2 })
    expect(positionAt('ab\r\ncd\nef', 7)).toEqual({ line: 3, column: 1 })
  })
})
