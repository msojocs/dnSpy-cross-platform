import { describe, expect, it } from 'vitest'
import type { CodeStatement } from '../../../shared/protocol'
import { ilSelectionOf } from './il-selection'

const statement = (line: number, ilOffset: number): CodeStatement => ({
  startLine: line, endLine: line, startColumn: 1, endColumn: 30, ilOffset, ilEndOffset: ilOffset + 1, sequencePointIlOffset: ilOffset,
  modulePath: '/a.dll', metadataToken: 0x06000001, sourceMethodToken: 0x06000001, description: '', isHidden: false,
})

const selection = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
  startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn,
  isEmpty: () => startLine === endLine && startColumn === endColumn,
})

describe('the instructions an IL view\'s selection covers', () => {
  const document = { language: 'il', codeStatements: [statement(5, 2), statement(4, 0), statement(6, 3)] }

  it('are the statements the selection touches, top to bottom', () => {
    expect(ilSelectionOf(document, selection(4, 10, 5, 3)).map((instruction) => instruction.ilOffset)).toEqual([0, 2])
  })

  it('are none for a caret, or in a view that is not IL', () => {
    expect(ilSelectionOf(document, selection(4, 10, 4, 10))).toEqual([])
    expect(ilSelectionOf({ ...document, language: 'csharp' }, selection(4, 1, 6, 5))).toEqual([])
  })
})
