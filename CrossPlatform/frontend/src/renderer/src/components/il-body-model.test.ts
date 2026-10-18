import { describe, expect, it } from 'vitest'
import type { IlMethodBody } from '../../../shared/protocol'
import {
  branchTargets,
  ilBodyError,
  newExceptionHandler,
  newInstruction,
  offsetOfLabel,
  operandKindFor,
  statementSelection,
  withOpcode,
} from './il-body-model'

describe('il-body-model', () => {
  it('derives the operand editor from the opcode the way dnSpy does', () => {
    expect(operandKindFor('ret')).toBe('none')
    expect(operandKindFor('ldloc.0')).toBe('local')
    expect(operandKindFor('ldarg.s')).toBe('argument')
    expect(operandKindFor('brtrue.s')).toBe('branch')
    expect(operandKindFor('switch')).toBe('switch')
    expect(operandKindFor('ldc.i4.s')).toBe('number')
    expect(operandKindFor('ldstr')).toBe('string')
    expect(operandKindFor('call')).toBe('method')
    expect(operandKindFor('ldfld')).toBe('field')
    expect(operandKindFor('box')).toBe('type')
    expect(operandKindFor('calli')).toBe('signature')
    expect(operandKindFor('ldtoken')).toBe('token')
    // An opcode the table does not know takes no operand, which is also what dnSpy's default does.
    expect(operandKindFor('not-an-opcode')).toBe('none')
  })

  it('clears an operand that the new opcode cannot carry', () => {
    const branch = { label: 'L0', opCode: 'br', operandKind: 'branch', operand: 'L1' }
    expect(withOpcode(branch, 'nop')).toEqual({ label: 'L0', opCode: 'nop', operandKind: 'none', operand: undefined, operandDisplay: undefined, nodeId: undefined, token: undefined, methodRef: undefined, methodSpecArguments: undefined, typeSignature: undefined, callSiteSignature: undefined })
    // A number stays where it is when the new opcode is numeric too.
    expect(withOpcode({ label: 'L0', opCode: 'ldc.i4', operandKind: 'number', operand: '42' }, 'ldc.i8')).toMatchObject({ opCode: 'ldc.i8', operandKind: 'number', operand: '42' })
  })

  it('reads labels and picks one the list does not use yet', () => {
    expect(offsetOfLabel('IL_0012')).toBe(0x12)
    expect(offsetOfLabel('L12')).toBeUndefined()
    expect(newInstruction([{ label: 'L0', opCode: 'nop' }]).label).toBe('L1')
  })

  it('names every switch target, not just a branch one', () => {
    expect(branchTargets({ label: 'L0', opCode: 'br', operandKind: 'branch', operand: 'L2' })).toEqual(['L2'])
    expect(branchTargets({ label: 'L0', opCode: 'switch', operandKind: 'switch', operand: 'L1, L3' })).toEqual(['L1', 'L3'])
    expect(branchTargets({ label: 'L0', opCode: 'ret' })).toEqual([])
  })

  it('selects the instructions a statement covers', () => {
    const instructions = ['IL_0000', 'IL_0002', 'IL_0005', 'IL_0007'].map((label) => ({ label, opCode: 'nop' }))
    expect(statementSelection(instructions, 2, 7)).toEqual([1, 2])
    expect(statementSelection(instructions, 7, 7)).toEqual([3])
  })

  it('refuses a body dnSpy would refuse', () => {
    const body: Pick<IlMethodBody, 'bodyType' | 'instructions' | 'locals' | 'exceptionHandlers' | 'parameterNames'> = {
      bodyType: 'cil',
      parameterNames: ['value'],
      locals: [{ type: { kind: 'type' }, isPinned: false, attributes: 0, display: 'System.Int32' }],
      instructions: [{ label: 'IL_0000', opCode: 'ldarg.0', operandKind: 'argument', operand: '1' }],
      exceptionHandlers: [],
    }
    expect(ilBodyError(body)).toBe('ldarg.0 needs an argument.')

    expect(ilBodyError({ ...body, instructions: [{ label: 'IL_0000', opCode: 'br', operandKind: 'branch', operand: 'L9' }] }))
      .toBe('Branch target does not exist: L9.')
    expect(ilBodyError({ ...body, instructions: [{ label: 'IL_0000', opCode: 'ldc.i4', operandKind: 'number', operand: 'x' }] }))
      .toBe('ldc.i4 needs a number.')

    const valid = { ...body, instructions: [{ label: 'IL_0000', opCode: 'ldarg.0', operandKind: 'argument', operand: '0' }, { label: 'IL_0001', opCode: 'ret', operandKind: 'none' }] }
    expect(ilBodyError(valid)).toBeUndefined()
  })

  it('opens a new handler on the first and last instruction, with no catch type yet', () => {
    expect(newExceptionHandler([{ label: 'IL_0000', opCode: 'nop' }, { label: 'IL_0001', opCode: 'ret' }])).toMatchObject({
      handlerType: 'catch',
      tryStart: 'IL_0000',
      handlerStart: 'IL_0001',
      catchType: null,
    })
  })
})
