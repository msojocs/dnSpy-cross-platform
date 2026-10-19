import type { IlBodyInstruction, IlExceptionHandler, IlLocal, IlMethodBody } from '../../../shared/protocol'
import { branchTargets, localIndex, nextLabel, operandKindFor } from './il-body-model'

// The parts of dnSpy's ListBoxHelperBase the Edit Method Body window's three lists share — its clipboard, its
// "Copy as Text" and the instruction list's offsets — written over the index-based model the port's dialog
// edits. dnSpy's lists hold objects: a local is the same object wherever an instruction names it, so moving it
// moves nothing else. Here an instruction names a local by its index, so every change to the local list renumbers
// the instructions that name one.

/** The opcodes encoded with the 0xFE prefix, two bytes long. */
const TWO_BYTE_OPCODES = new Set([
  'arglist', 'ceq', 'cgt', 'cgt.un', 'clt', 'clt.un', 'ldftn', 'ldvirtftn', 'ldarg', 'ldarga', 'starg', 'ldloc', 'ldloca',
  'stloc', 'localloc', 'endfilter', 'unaligned.', 'volatile.', 'tail.', 'initobj', 'constrained.', 'cpblk', 'initblk',
  'no.', 'rethrow', 'sizeof', 'refanytype', 'readonly.',
])

/** The size of an operand that is not a branch, a switch, a variable or a token, by opcode: dnlib's OperandType. */
const NUMBER_OPERAND_SIZES: Record<string, number> = {
  'ldc.i4.s': 1, 'unaligned.': 1, 'ldc.i4': 4, 'ldc.r4': 4, 'ldc.i8': 8, 'ldc.r8': 8,
}

/** dnlib's Instruction.GetSize for an instruction of the editor: the opcode and the operand it carries. */
export const instructionSize = (instruction: IlBodyInstruction): number => {
  const opcode = instruction.opCode.trim().toLowerCase()
  const opcodeSize = TWO_BYTE_OPCODES.has(opcode) ? 2 : 1
  const kind = operandKindFor(opcode)
  switch (kind) {
    case 'branch':
      return opcodeSize + (opcode.endsWith('.s') ? 1 : 4)
    case 'switch':
      return opcodeSize + 4 + 4 * branchTargets({ ...instruction, operandKind: 'switch' }).length
    case 'local':
    case 'argument':
      // The macro forms (ldloc.0, ldarg.1 …) carry the index in the opcode; the .s forms a byte, the others two.
      return opcodeSize + (/\.\d$/.test(opcode) ? 0 : opcode.endsWith('.s') ? 1 : 2)
    case 'number':
      return opcodeSize + (NUMBER_OPERAND_SIZES[opcode] ?? 0)
    case 'string':
    case 'type':
    case 'field':
    case 'method':
    case 'token':
    case 'signature':
      return opcodeSize + 4
    default:
      return opcodeSize
  }
}

/** Every instruction's offset in the body as it stands now — dnSpy recomputes them as the list changes. */
export const instructionOffsets = (instructions: readonly IlBodyInstruction[]): number[] => {
  const offsets: number[] = []
  let offset = 0
  for (const instruction of instructions) {
    offsets.push(offset)
    offset += instructionSize(instruction)
  }
  return offsets
}

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0')
const hex8 = (value: number): string => value.toString(16).toUpperCase().padStart(8, '0')

/** The text dnSpy's Copy as Text writes for some lines: one per line, and a newline after the last of several. */
const joinLines = (lines: string[]): string => lines.length > 1 ? `${lines.join('\n')}\n` : lines.join('\n')

/**
 * InstructionsListHelper.CopyAsText: index, offset and opcode, then the operand — a number or a string as typed,
 * a member by its name, a branch target as the instruction it is ("3 (0007) br IL_000C"), a switch's targets in
 * brackets, and a local or an argument by its name and index.
 */
export const instructionsAsText = (body: Pick<IlMethodBody, 'instructions' | 'locals' | 'parameterNames'>, indexes: readonly number[]): string => {
  const offsets = instructionOffsets(body.instructions)
  const indexOfLabel = new Map(body.instructions.map((instruction, index) => [instruction.label, index]))
  const target = (label: string): string => {
    const index = indexOfLabel.get(label)
    if (index === undefined)
      return 'null'
    const instruction = body.instructions[index]
    const operand = instruction.operandDisplay ?? instruction.operand
    return `${index} (${hex4(offsets[index])}) ${instruction.opCode}${operand ? ` ${operand}` : ''}`
  }
  const lines = [...indexes].sort((left, right) => left - right).map((index) => {
    const instruction = body.instructions[index]
    let line = `${index}\t${hex4(offsets[index])}\t${instruction.opCode}`
    const kind = instruction.operandKind ?? operandKindFor(instruction.opCode)
    switch (kind) {
      case 'none':
        break
      case 'number':
      case 'string':
        line += `\t${instruction.operand ?? ''}`
        break
      case 'branch':
        line += `\t${instruction.operand ? target(instruction.operand) : 'null'}`
        break
      case 'switch':
        line += `\t[${branchTargets(instruction).map(target).join(', ')}]`
        break
      case 'local': {
        const at = localIndex(instruction.operand)
        const local = at === undefined ? undefined : body.locals[at]
        line += `\t${local ? `${local.name ?? `V_${at}`} (${at})` : 'null'}`
        break
      }
      case 'argument': {
        const at = localIndex(instruction.operand)
        line += `\t${at === undefined || at >= body.parameterNames.length ? 'null' : `${body.parameterNames[at]} (${at})`}`
        break
      }
      default:
        line += `\t${instruction.operandDisplay ?? 'null'}`
    }
    return line
  })
  return joinLines(lines)
}

/** LocalsListHelper.CopyAsText: index, "P" when pinned, "C" when compiler generated, name and type. */
export const localsAsText = (locals: readonly IlLocal[], indexes: readonly number[]): string =>
  joinLines([...indexes].sort((left, right) => left - right).map((index) => {
    const local = locals[index]
    return `${index}\t${local.isPinned ? 'P' : ''}\t${(local.attributes & 0x01) !== 0 ? 'C' : ''}\t${local.name ?? ''}\t${local.type?.display ?? local.display}`
  }))

/** ExceptionHandlersListHelper.CopyAsText: index, the five positions, the clause and the catch type. */
export const handlersAsText = (body: Pick<IlMethodBody, 'instructions' | 'exceptionHandlers'>, indexes: readonly number[]): string => {
  const offsets = instructionOffsets(body.instructions)
  const indexOfLabel = new Map(body.instructions.map((instruction, index) => [instruction.label, index]))
  const position = (label: string | null | undefined): string => {
    const index = label ? indexOfLabel.get(label) : undefined
    return index === undefined ? 'null' : `${index} (${hex4(offsets[index])})`
  }
  const clause = (handler: IlExceptionHandler): string => handler.handlerType[0].toUpperCase() + handler.handlerType.slice(1)
  return joinLines([...indexes].sort((left, right) => left - right).map((index) => {
    const handler = body.exceptionHandlers[index]
    return [index, position(handler.tryStart), position(handler.tryEnd), position(handler.filterStart), position(handler.handlerStart), position(handler.handlerEnd), clause(handler), handler.catchType?.display ?? 'null'].join('\t')
  }))
}

/** InstructionsListHelper.CopyOperandMDTokens: one `0x` token per instruction that names a row. */
export const operandTokensAsText = (instructions: readonly IlBodyInstruction[], indexes: readonly number[]): string =>
  joinLines([...indexes].sort((left, right) => left - right)
    .map((index) => instructions[index].token)
    .filter((token): token is string => Boolean(token))
    .map((token) => `0x${token.padStart(8, '0').toUpperCase()}`))

/** Copy RVA / Copy File Offset: the body's code base plus each instruction's offset. */
export const instructionAddressesAsText = (instructions: readonly IlBodyInstruction[], indexes: readonly number[], base: number): string => {
  const offsets = instructionOffsets(instructions)
  return joinLines([...indexes].sort((left, right) => left - right).map((index) => `0x${hex8(base + offsets[index])}`))
}

// ---------------------------------------------------------------------------------------------------------------
// The local list. An instruction names a local by its index, so a change to the list renumbers them.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Rebuilds the local list in the order `order` gives — each entry the index the local had, or a new local — and
 * points every local operand at where its local went. An operand whose local is gone names none, which is the
 * error dnSpy shows for a removed local.
 */
export const reorderLocals = (body: IlMethodBody, order: readonly (number | IlLocal)[]): IlMethodBody => {
  const newIndexOf = new Map<number, number>()
  order.forEach((entry, at) => { if (typeof entry === 'number') newIndexOf.set(entry, at) })
  const locals = order.map((entry) => typeof entry === 'number' ? body.locals[entry] : entry)
  const instructions = body.instructions.map((instruction) => {
    if ((instruction.operandKind ?? operandKindFor(instruction.opCode)) !== 'local')
      return instruction
    const old = localIndex(instruction.operand)
    if (old === undefined)
      return instruction
    const moved = newIndexOf.get(old)
    return moved === undefined
      ? { ...instruction, operand: '', operandDisplay: '' }
      : { ...instruction, operand: String(moved), operandDisplay: `V_${moved}` }
  })
  return { ...body, locals, instructions }
}

/** The locals' order with some inserted at `at`. */
export const insertLocals = (body: IlMethodBody, at: number, locals: readonly IlLocal[]): IlMethodBody => {
  const order: (number | IlLocal)[] = body.locals.map((_, index) => index)
  order.splice(at, 0, ...locals)
  return reorderLocals(body, order)
}

/** The locals' order without the ones at `indexes`. */
export const removeLocals = (body: IlMethodBody, indexes: readonly number[]): IlMethodBody =>
  reorderLocals(body, body.locals.map((_, index) => index).filter((index) => !indexes.includes(index)))

/**
 * Moves the selected items one place up or down, the way ListBoxHelperBase.MoveItemsUp/Down does: a selected item
 * next to another selected one at the edge stays where it is. Answers the new order as old indexes and where the
 * selection went.
 */
export const moveIndexes = (count: number, selected: readonly number[], delta: -1 | 1): { order: number[], selected: number[] } => {
  const order = Array.from({ length: count }, (_, index) => index)
  const chosen = new Set(selected)
  const sequence = delta < 0 ? [...chosen].sort((left, right) => left - right) : [...chosen].sort((left, right) => right - left)
  const moved = new Set<number>()
  for (const index of sequence) {
    const position = order.indexOf(index)
    const target = position + delta
    if (target < 0 || target >= count || (chosen.has(order[target]) && !moved.has(order[target])))
      continue
    ;[order[position], order[target]] = [order[target], order[position]]
    moved.add(index)
  }
  return { order, selected: [...chosen].map((index) => order.indexOf(index)).sort((left, right) => left - right) }
}

// ---------------------------------------------------------------------------------------------------------------
// The clipboard. dnSpy's is in-process too: ClipboardDataHolder keeps the objects and puts a marker on the
// system clipboard, which is what has to still be there for a paste. Copying anything else clears it.
// ---------------------------------------------------------------------------------------------------------------

export type IlClipboardKind = 'instructions' | 'locals' | 'handlers'

export interface IlClipboard {
  kind: IlClipboardKind
  /** The dialog the items were copied in; handlers only paste back into the same one, as dnSpy's do. */
  source: symbol
  /** The method the items were copied out of, which a token in them belongs to. */
  methodNodeId: string
  items: readonly unknown[]
  /** The source body's locals, which an instruction pasted into another body brings along. */
  locals: readonly IlLocal[]
}

let clipboard: IlClipboard | undefined

/** The marker dnSpy leaves on the system clipboard — ClipboardDataHolder's format — kept to know when it is gone. */
const clipboardMarker = (): string => `dnSpy.AsmEditor.ClipboardData - ${clipboard?.kind ?? ''}`

export const setIlClipboard = (data: IlClipboard): void => {
  clipboard = data
  void navigator.clipboard?.writeText?.(clipboardMarker()).catch(() => undefined)
}

/** What a list of this kind can paste: dnSpy's CanPaste, which the system clipboard still has to agree with. */
export const ilClipboardFor = (kind: IlClipboardKind, source: symbol): IlClipboard | undefined =>
  clipboard && clipboard.kind === kind && (kind !== 'handlers' || clipboard.source === source) ? clipboard : undefined

/** Clears the clipboard when something else was copied over dnSpy's marker. */
export const checkIlClipboard = async (): Promise<void> => {
  if (!clipboard || !navigator.clipboard?.readText)
    return
  try {
    if (await navigator.clipboard.readText() !== clipboardMarker())
      clipboard = undefined
  }
  catch {
    // A clipboard that cannot be read leaves the copy as it was.
  }
}

/** Forgets the clipboard — a test's reset. */
export const clearIlClipboard = (): void => { clipboard = undefined }

/**
 * InstructionsListHelper's paste: the copies get labels of their own, a branch into the copied instructions goes to
 * the copy of its target, and a branch out of them keeps its target in the same dialog or names none in another.
 * In another body a local is brought along — appended once however many copies name it — and an argument names
 * none, since a parameter belongs to its method; a token stays the source method's, which the backend imports
 * from (dnSpy's InstructionVM.Import).
 */
export const pasteInstructions = (body: IlMethodBody, data: IlClipboard, at: number, sameInstance: boolean): IlMethodBody => {
  const items = data.items as IlBodyInstruction[]
  const used = [...body.instructions]
  const labels = new Map<string, string>()
  const copies = items.map((item) => {
    const label = nextLabel(used)
    labels.set(item.label, label)
    const copy = { ...item, label }
    used.push(copy)
    return copy
  })
  const existing = new Set(body.instructions.map((instruction) => instruction.label))
  const retarget = (label: string): string => labels.get(label) ?? (sameInstance && existing.has(label) ? label : '')
  let locals = body.locals
  const localMap = new Map<number, number>()
  const mapped = copies.map((copy) => {
    const kind = copy.operandKind ?? operandKindFor(copy.opCode)
    switch (kind) {
      case 'branch': {
        const label = copy.operand ? retarget(copy.operand) : ''
        return { ...copy, operand: label, operandDisplay: label }
      }
      case 'switch': {
        const targets = branchTargets(copy).map(retarget)
        return { ...copy, operand: targets.join(','), operandDisplay: targets.join(', ') }
      }
      case 'local': {
        if (sameInstance)
          return copy
        const old = localIndex(copy.operand)
        const local = old === undefined ? undefined : data.locals[old]
        if (old === undefined || !local)
          return { ...copy, operand: '', operandDisplay: '' }
        if (!localMap.has(old)) {
          localMap.set(old, locals.length)
          locals = [...locals, { ...local }]
        }
        const index = localMap.get(old)!
        return { ...copy, operand: String(index), operandDisplay: `V_${index}` }
      }
      case 'argument':
        return sameInstance ? copy : { ...copy, operand: '', operandDisplay: '' }
      default:
        return copy
    }
  })
  const instructions = [...body.instructions]
  instructions.splice(at, 0, ...mapped)
  return { ...body, locals, instructions }
}
