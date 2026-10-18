import type { IlBodyInstruction, IlExceptionHandler, IlLocal, IlMethodBody } from '../../../shared/protocol'

/**
 * What an instruction's operand needs, derived from its opcode — dnSpy's `InstructionOperandType`,
 * which it reads out of the opcode's `OperandType`. The values are the `IlOperandKinds` the backend
 * speaks, so the same string picks the editor here and tells the backend how to read the value.
 */
export type IlOperandKind = 'none' | 'number' | 'string' | 'branch' | 'switch' | 'local' | 'argument' | 'type' | 'field' | 'method' | 'token' | 'signature'

const KINDS = new Map<string, IlOperandKind>()
const add = (kind: IlOperandKind, opcodes: string): void => {
  for (const opcode of opcodes.split(' '))
    KINDS.set(opcode, kind)
}

add('branch', 'br br.s brfalse brfalse.s brtrue brtrue.s beq beq.s bge bge.s bge.un bge.un.s bgt bgt.s bgt.un bgt.un.s ble ble.s ble.un ble.un.s blt blt.s blt.un blt.un.s bne.un bne.un.s leave leave.s')
add('switch', 'switch')
add('local', 'ldloc ldloc.s ldloc.0 ldloc.1 ldloc.2 ldloc.3 ldloca ldloca.s stloc stloc.s stloc.0 stloc.1 stloc.2 stloc.3')
add('argument', 'ldarg ldarg.s ldarg.0 ldarg.1 ldarg.2 ldarg.3 ldarga ldarga.s starg starg.s')
add('number', 'ldc.i4 ldc.i4.s ldc.i4.m1 ldc.i4.0 ldc.i4.1 ldc.i4.2 ldc.i4.3 ldc.i4.4 ldc.i4.5 ldc.i4.6 ldc.i4.7 ldc.i4.8 ldc.i8 ldc.r4 ldc.r8 unaligned.')
add('string', 'ldstr')
add('type', 'box unbox unbox.any castclass isinst newarr ldelem ldelem.i1 ldelem.u1 ldelem.i2 ldelem.u2 ldelem.i4 ldelem.u4 ldelem.i8 ldelem.i ldelem.r4 ldelem.r8 ldelem.ref stelem stelem.i stelem.i1 stelem.i2 stelem.i4 stelem.i8 stelem.r4 stelem.r8 stelem.ref ldobj stobj initobj constrained. mkrefany refanyval sizeof cpobj')
add('field', 'ldfld ldflda stfld ldsfld ldsflda stsfld')
add('method', 'call callvirt newobj ldftn ldvirtftn jmp')
add('signature', 'calli')
add('token', 'ldtoken')

/** The operand kind the opcode demands, or `none` for the opcodes that take no operand. */
export const operandKindFor = (opcode: string): IlOperandKind => KINDS.get(opcode.trim().toLowerCase()) ?? 'none'

/** The opcode names the editor offers, sorted the way dnSpy sorts its opcode list. */
export const IL_OPCODES: readonly string[] = [...KINDS.keys(), 'nop', 'ret', 'pop', 'dup', 'throw', 'rethrow', 'endfinally', 'endfilter', 'ldnull'].sort((left, right) => left.localeCompare(right))

/** dnSpy's `MethodBodyType`: a body the method has none of, CIL, or native code. */
export type IlBodyKind = 'none' | 'cil' | 'native'

/** dnSpy's `CodeType` enum, whose values are dnlib's `MethodImplAttributes` low two bits. */
export const IL_CODE_TYPES = [
  { value: 0, label: 'IL' },
  { value: 1, label: 'Native' },
  { value: 2, label: 'OPTIL' },
  { value: 3, label: 'Runtime' },
] as const

/** The four clauses an exception handler may be. */
export const IL_HANDLER_TYPES = ['catch', 'filter', 'finally', 'fault'] as const

/** The offset an instruction's label carries, or undefined for a label the editor made up. */
export const offsetOfLabel = (label: string): number | undefined => {
  const match = /^IL_([0-9A-Fa-f]{4,8})$/.exec(label)
  return match ? Number.parseInt(match[1], 16) : undefined
}

/** A label nothing in the list uses yet. */
export const nextLabel = (instructions: readonly IlBodyInstruction[]): string => {
  const used = new Set(instructions.map((instruction) => instruction.label))
  for (let index = 0; ; index++) {
    const label = `L${index}`
    if (!used.has(label))
      return label
  }
}

/** A fresh `nop`, which is what dnSpy's Append New adds. */
export const newInstruction = (instructions: readonly IlBodyInstruction[]): IlBodyInstruction => ({
  label: nextLabel(instructions),
  opCode: 'nop',
  operandKind: 'none',
})

/** Replaces the opcode and settles the operand editor to what the new opcode takes. */
export const withOpcode = (instruction: IlBodyInstruction, opcode: string): IlBodyInstruction => {
  const kind = operandKindFor(opcode)
  // dnSpy's `UpdateOperandType` keeps the numeric fields when the operand stays numeric; anything else
  // has lost its meaning and is cleared rather than left to be read as the wrong kind of value.
  if (kind === instruction.operandKind || (kind === 'number' && instruction.operandKind === 'number'))
    return { ...instruction, opCode: opcode, operandKind: kind }
  return { ...instruction, opCode: opcode, operandKind: kind, operand: kind === 'none' ? undefined : '', operandDisplay: undefined, nodeId: undefined, token: undefined, methodRef: undefined, methodSpecArguments: undefined, typeSignature: undefined, callSiteSignature: undefined }
}

/** The local a local operand names, or undefined when the index is not one the list holds. */
export const localIndex = (operand: string | null | undefined): number | undefined => {
  const index = operand === undefined || operand === null || operand === '' ? Number.NaN : Number(operand)
  return Number.isInteger(index) && index >= 0 ? index : undefined
}

/** Every label a branch or switch operand names. */
export const branchTargets = (instruction: IlBodyInstruction): string[] =>
  instruction.operandKind === 'switch'
    ? (instruction.operand ?? '').split(',').map((label) => label.trim()).filter((label) => label.length > 0)
    : instruction.operandKind === 'branch' && instruction.operand
      ? [instruction.operand]
      : []

/**
 * What the dialog refuses to write — dnSpy's `HasError`, which gates its OK button. The backend checks
 * the same things again; this is what keeps a body the editor already knows is broken from being sent.
 */
export const ilBodyError = (body: Pick<IlMethodBody, 'bodyType' | 'instructions' | 'locals' | 'exceptionHandlers' | 'parameterNames'>): string | undefined => {
  if (body.bodyType === 'native')
    return undefined
  if (body.bodyType === 'none')
    return undefined
  if (body.instructions.length === 0)
    return 'A method body must contain at least one instruction.'
  const labels = new Set<string>()
  for (const instruction of body.instructions) {
    if (!instruction.label.trim())
      return 'An instruction label is empty.'
    if (labels.has(instruction.label))
      return `Instruction label is duplicated: ${instruction.label}.`
    labels.add(instruction.label)
    if (!instruction.opCode.trim())
      return `An instruction next to ${instruction.label} has no opcode.`
    const kind = instruction.operandKind ?? operandKindFor(instruction.opCode)
    if (kind === 'branch' && !instruction.operand)
      return `${instruction.opCode} needs a branch target.`
    if (kind === 'local') {
      const index = localIndex(instruction.operand)
      if (index === undefined || index >= body.locals.length)
        return `${instruction.opCode} needs a local variable.`
    }
    if (kind === 'argument') {
      const index = localIndex(instruction.operand)
      if (index === undefined || index >= body.parameterNames.length)
        return `${instruction.opCode} needs an argument.`
    }
    if (kind === 'number' && instruction.operand !== undefined && instruction.operand !== null && instruction.operand !== '' && !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(instruction.operand.trim()))
      return `${instruction.opCode} needs a number.`
  }
  for (const instruction of body.instructions) {
    for (const target of branchTargets(instruction)) {
      if (!labels.has(target))
        return `Branch target does not exist: ${target}.`
    }
  }
  for (const handler of body.exceptionHandlers) {
    if (!handler.tryStart || !handler.handlerStart)
      return 'An exception handler needs a try block and a handler.'
    if (handler.handlerType === 'catch' && !handler.catchType)
      return 'A catch clause needs a catch type.'
    if (handler.handlerType === 'filter' && !handler.filterStart)
      return 'A filter clause needs a filter start.'
    for (const label of [handler.tryStart, handler.tryEnd, handler.filterStart, handler.handlerStart, handler.handlerEnd]) {
      if (label && !labels.has(label))
        return `Exception handler position does not exist: ${label}.`
    }
  }
  return undefined
}

/** A new exception handler, with the two positions the catch clause always has preselected. */
export const newExceptionHandler = (instructions: readonly IlBodyInstruction[]): IlExceptionHandler => ({
  handlerType: 'catch',
  tryStart: instructions[0]?.label,
  tryEnd: undefined,
  filterStart: undefined,
  handlerStart: instructions[instructions.length - 1]?.label,
  handlerEnd: undefined,
  catchType: null,
  display: '',
})

/** A new local variable, which dnSpy starts as an `Int32` with no name. */
export const newLocal = (): IlLocal => ({
  name: null,
  type: { kind: 'type', type: { scope: '', namespace: 'System', name: 'Int32' }, valueType: true },
  isPinned: false,
  attributes: 0,
  display: 'System.Int32',
})

/** The rows a statement's IL range covers, for "Edit IL Instructions" from a code document. */
export const statementSelection = (instructions: readonly IlBodyInstruction[], start: number, end: number): number[] => {
  const selected: number[] = []
  instructions.forEach((instruction, index) => {
    const offset = offsetOfLabel(instruction.label)
    if (offset !== undefined && offset >= start && offset < Math.max(end, start + 1))
      selected.push(index)
  })
  return selected
}
