import { describe, expect, it } from 'vitest'
import type { IlBodyInstruction, IlLocal, IlMethodBody } from '../../../shared/protocol'
import {
  handlersAsText,
  instructionOffsets,
  instructionsAsText,
  insertLocals,
  localsAsText,
  moveIndexes,
  operandTokensAsText,
  pasteInstructions,
  removeLocals,
  type IlClipboard,
} from './il-body-clipboard'

const local = (name: string, pinned = false): IlLocal => ({ name, type: { kind: 'type', type: { scope: '', namespace: 'System', name: 'Int32' }, valueType: true, display: 'System.Int32' }, isPinned: pinned, attributes: 0, display: `System.Int32 ${name}` })

const body = (instructions: IlBodyInstruction[], locals: IlLocal[] = []): IlMethodBody => ({
  bodyType: 'cil', codeType: 0, maxStack: 8, keepOldMaxStack: false, initLocals: true, localVarSigTok: 0,
  headerRva: 0x2050, headerFileOffset: 0x250, rva: 0x2051, fileOffset: 0x251, nativeRva: 0,
  locals, instructions, exceptionHandlers: [], parameterNames: ['value'],
})

const source = body([
  { label: 'IL_0000', opCode: 'ldloc.0', operandKind: 'local', operand: '0' },
  { label: 'IL_0001', opCode: 'brtrue.s', operandKind: 'branch', operand: 'IL_0004' },
  { label: 'IL_0003', opCode: 'ldarg.0', operandKind: 'argument', operand: '0' },
  { label: 'IL_0004', opCode: 'ret', operandKind: 'none' },
], [local('flag')])

const clip = (items: IlBodyInstruction[], sameSource: symbol): IlClipboard => ({ kind: 'instructions', source: sameSource, methodNodeId: 'm1', items, locals: source.locals })

describe('the method body window\'s lists', () => {
  it('lay the instructions out the way dnlib sizes them', () => {
    expect(instructionOffsets(source.instructions)).toEqual([0, 1, 3, 4])
    expect(instructionOffsets([
      { label: 'a', opCode: 'ldc.i4', operandKind: 'number', operand: '5' },
      { label: 'b', opCode: 'ldloc', operandKind: 'local', operand: '0' },
      { label: 'c', opCode: 'switch', operandKind: 'switch', operand: 'a,b' },
      { label: 'd', opCode: 'call', operandKind: 'method' },
      { label: 'e', opCode: 'ret', operandKind: 'none' },
    ])).toEqual([0, 5, 9, 22, 27])
  })

  it('write instructions as text the way InstructionsListHelper does', () => {
    expect(instructionsAsText(source, [1, 0])).toBe('0\t0000\tldloc.0\tflag (0)\n1\t0001\tbrtrue.s\t3 (0004) ret\n')
    expect(instructionsAsText(source, [2])).toBe('2\t0003\tldarg.0\tvalue (0)')
    expect(localsAsText([local('a', true)], [0])).toBe('0\tP\t\ta\tSystem.Int32')
    expect(operandTokensAsText([{ label: 'x', opCode: 'call', token: '0A00000C' }, { label: 'y', opCode: 'ret' }], [0, 1])).toBe('0x0A00000C')
    expect(handlersAsText({ instructions: source.instructions, exceptionHandlers: [{ handlerType: 'finally', tryStart: 'IL_0000', tryEnd: 'IL_0003', handlerStart: 'IL_0003', handlerEnd: 'IL_0004', catchType: null, display: '' }] }, [0]))
      .toBe('0\t0 (0000)\t2 (0003)\tnull\t2 (0003)\t3 (0004)\tFinally\tnull')
  })

  it('paste into the same window: a branch into the copies goes to a copy, one out of them keeps its target', () => {
    const instance = Symbol('dialog')
    const pasted = pasteInstructions(source, clip([source.instructions[1], source.instructions[3]], instance), 0, true)
    expect(pasted.instructions.slice(0, 2).map((instruction) => [instruction.opCode, instruction.operand])).toEqual([['brtrue.s', pasted.instructions[1].label], ['ret', undefined]])
    expect(pasted.instructions[0].label).not.toBe('IL_0001')
    const outside = pasteInstructions(source, clip([source.instructions[1]], instance), 4, true)
    expect(outside.instructions[4].operand).toBe('IL_0004')
  })

  it('paste into another window: locals come along, arguments and targets outside the copies name nothing', () => {
    const target = body([{ label: 'IL_0000', opCode: 'ret', operandKind: 'none' }], [local('existing')])
    const pasted = pasteInstructions(target, clip(source.instructions.slice(0, 3), Symbol('other')), 0, false)
    expect(pasted.locals.map((entry) => entry.name)).toEqual(['existing', 'flag'])
    expect(pasted.instructions[0].operand).toBe('1')
    expect(pasted.instructions[1].operand).toBe('')
    expect(pasted.instructions[2].operand).toBe('')
  })

  it('renumber the instructions when the local list changes', () => {
    const twoLocals = body([{ label: 'a', opCode: 'ldloc.s', operandKind: 'local', operand: '1' }], [local('x'), local('y')])
    expect(insertLocals(twoLocals, 0, [local('new')]).instructions[0].operand).toBe('2')
    expect(removeLocals(twoLocals, [0]).instructions[0].operand).toBe('0')
    expect(removeLocals(twoLocals, [1]).instructions[0].operand).toBe('')
  })

  it('move a selection one place, leaving a block at the edge where it is', () => {
    expect(moveIndexes(4, [1, 2], -1)).toEqual({ order: [1, 2, 0, 3], selected: [0, 1] })
    expect(moveIndexes(4, [0, 2], -1)).toEqual({ order: [0, 2, 1, 3], selected: [0, 1] })
    expect(moveIndexes(4, [3], 1)).toEqual({ order: [0, 1, 2, 3], selected: [3] })
  })
})
