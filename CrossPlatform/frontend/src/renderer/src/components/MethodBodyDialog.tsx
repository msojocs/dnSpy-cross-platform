import { useEffect, useRef, useState } from 'react'
import type { IlBodyInstruction, IlExceptionHandler, IlLocal, IlMethodBody, MemberRefDto, MethodSigDto, TreeNode, TypeSigDto } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { showDebugMenu } from './DebugToolWindows'
import {
  checkIlClipboard,
  handlersAsText,
  ilClipboardFor,
  insertLocals,
  instructionAddressesAsText,
  instructionOffsets,
  instructionsAsText,
  localsAsText,
  moveIndexes,
  operandTokensAsText,
  pasteInstructions,
  reorderLocals,
  setIlClipboard,
  type IlClipboardKind,
} from './il-body-clipboard'
import {
  IL_CODE_TYPES,
  IL_HANDLER_TYPES,
  IL_OPCODES,
  branchTargets,
  ilBodyError,
  newExceptionHandler,
  newInstruction,
  newLocal,
  operandKindFor,
  statementSelection,
  withOpcode,
  type IlBodyKind,
  type IlOperandKind,
} from './il-body-model'
import { MemberRefDialog, MethodSigDialog, MethodSpecDialog, TypeSpecDialog, memberRefDisplay, type MethodSpecValue } from './IlOperandDialogs'
import { OptionsShell, type OptionsTab } from './OptionsShell'
import { TypePickerDialog } from './TypePickerDialog'
import { methodRefLabel, pickedMethodRef } from './widgets/method-ref'
import { describeMethodSig, describeTypeSig } from './widgets/type-sig-text'
import { TypeSigEditor } from './widgets/TypeSigEditor'

interface MethodBodyDialogProps {
  node: TreeNode
  /** The IL range of the statement the command was run from, whose instructions open selected — dnSpy's
   *  `Edit IL Instructions` from a code document. */
  selection?: { start: number; end: number }
  onClose(): void
}

/** The window a body field opens: the type of a local variable or the catch type of a handler. */
type TypeEdit =
  | { kind: 'local'; index: number }
  | { kind: 'handler'; index: number }

/** The dialog an operand's "..." opened, for the instruction at `index`. */
type OperandEdit =
  | { index: number; dialog: 'pick'; mode: 'type' | 'method' | 'field' }
  | { index: number; dialog: 'typeSpec' }
  | { index: number; dialog: 'memberRef'; isField: boolean }
  | { index: number; dialog: 'methodSpec' }
  | { index: number; dialog: 'methodSig' }
  | { index: number; dialog: 'switch' }

/** One entry of a list's context menu: dnSpy's ContextMenuHandler. `key` is the bare or Ctrl gesture. */
interface ListCommand {
  key: string
  label: string
  shortcut?: string
  icon?: string
  enabled: boolean
  run(): void
  /** The gesture: a letter alone, or with Ctrl (and Alt), as KeyboardEvent.key in lower case. */
  gesture?: { key: string; ctrl?: boolean; alt?: boolean }
}

/** The operand fields an operand dialog replaces wholesale, so nothing of the old operand is left behind. */
const CLEARED_OPERAND: Partial<IlBodyInstruction> = {
  nodeId: undefined, token: undefined, methodRef: undefined, methodSpecArguments: undefined, typeSignature: undefined,
  callSiteSignature: undefined, memberRef: undefined, methodSpecCustomAttributes: undefined, tokenOwnerNodeId: undefined,
}

/** Whether a key event is one a list's bare-letter shortcuts may take: no text control has it, no modifier is held. */
const takesBareKey = (event: React.KeyboardEvent): boolean =>
  !event.ctrlKey && !event.altKey && !event.metaKey && !(event.target as HTMLElement).closest('input, select, textarea')

/** dnlib's conditional branches, which Invert Branch and Convert to Unconditional Branch act on. */
const CONDITIONAL_BRANCHES = new Set([
  'beq', 'beq.s', 'bge', 'bge.s', 'bge.un', 'bge.un.s', 'bgt', 'bgt.s', 'bgt.un', 'bgt.un.s', 'ble', 'ble.s', 'ble.un',
  'ble.un.s', 'blt', 'blt.s', 'blt.un', 'blt.un.s', 'bne.un', 'bne.un.s', 'brfalse', 'brfalse.s', 'brtrue', 'brtrue.s',
])

/** The instructions whose stack effect dnSpy cannot replace with pops: the ones that leave the method or branch away. */
const NO_POPS = new Set(['ret', 'throw', 'rethrow', 'endfinally', 'endfilter', 'jmp', 'leave', 'leave.s', 'br', 'br.s', 'switch', 'nop'])

/**
 * dnSpy's Edit Method Body window: the three tabs of `MethodBodyDlg` — instructions, locals and exception
 * handlers — over one body. Every list is driven by its context menu and the gestures its entries show, the
 * way ListBoxHelperBase builds them: the instruction commands, add, move, remove, and the clipboard. The commands
 * that need the operand signatures run in the backend.
 */
export const MethodBodyDialog = ({ node, selection, onClose }: MethodBodyDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const methodBodyChanged = useAppStore((state) => state.methodBodyChanged)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const [body, setBody] = useState<IlMethodBody>()
  const [initialBody, setInitialBody] = useState<IlMethodBody>()
  const [loadFailure, setLoadFailure] = useState<string>()
  const [writeFailure, setWriteFailure] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [localSelected, setLocalSelected] = useState<number[]>([])
  const [handlerSelected, setHandlerSelected] = useState<number[]>([])
  const [typeEdit, setTypeEdit] = useState<TypeEdit>()
  const [operandEdit, setOperandEdit] = useState<OperandEdit>()
  const [assemblyRootIds, setAssemblyRootIds] = useState<string[]>()
  const anchors = useRef<Record<IlClipboardKind, number | undefined>>({ instructions: undefined, locals: undefined, handlers: undefined })
  // The clipboard tells this dialog's copies from another's, which is what "same instance" means to dnSpy.
  const instance = useRef(Symbol('method-body'))

  useEffect(() => {
    let cancelled = false
    if (!workspaceId)
      return
    void window.dnSpy.getIlBody(workspaceId, node.id)
      .then((loaded) => {
        if (cancelled)
          return
        setBody(loaded)
        setInitialBody(loaded)
        setSelected(selection ? statementSelection(loaded.instructions, selection.start, selection.end) : [])
      })
      .catch((reason: unknown) => { if (!cancelled) setLoadFailure(reason instanceof Error ? reason.message : String(reason)) })
    // The MethodDef and ModuleRef classes of a MemberRef come from the assembly the method is in.
    void window.dnSpy.getNodePath(workspaceId, node.id)
      .then((path) => { if (!cancelled && path.nodes[0]) setAssemblyRootIds([path.nodes[0].id]) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [workspaceId, node.id, selection])

  const invalid = body ? ilBodyError(body) : undefined

  const patch = (next: Partial<IlMethodBody>): void =>
    setBody((current) => current ? { ...current, ...next } : current)

  const patchInstruction = (index: number, next: IlBodyInstruction): void =>
    setBody((current) => current ? { ...current, instructions: current.instructions.map((instruction, at) => at === index ? next : instruction) } : current)

  const runTransform = async (operation: string, indexes = selected): Promise<void> => {
    if (!workspaceId || !body)
      return
    try {
      const result = await window.dnSpy.transformIlBody(workspaceId, node.id, operation, body.locals, body.instructions, indexes, body.parameterNames)
      patch({ locals: result.locals, instructions: result.instructions })
    }
    catch (reason) {
      setWriteFailure(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const copyText = (text: string): void => {
    if (text)
      void navigator.clipboard?.writeText?.(text).catch(() => undefined)
  }

  const save = async (): Promise<void> => {
    if (!workspaceId || !body)
      return
    if (invalid) {
      setWriteFailure(invalid)
      return
    }
    setSaving(true)
    setWriteFailure(undefined)
    let transactionId: string | undefined
    try {
      transactionId = (await window.dnSpy.beginEdit(workspaceId)).transactionId
      await window.dnSpy.queueIlBody(workspaceId, transactionId, node.id, body)
      const committed = await window.dnSpy.commitEdit(workspaceId, transactionId)
      await methodBodyChanged(node, committed)
      onClose()
    }
    catch (reason) {
      if (transactionId) {
        try { await window.dnSpy.rollbackEdit(workspaceId, transactionId) } catch { /* already committed or invalidated */ }
      }
      const message = reason instanceof Error ? reason.message : String(reason)
      setWriteFailure(message)
      appendOutput(t('IL edit failed: {message}', { message }))
    }
    finally {
      setSaving(false)
    }
  }

  if (loadFailure) {
    return (
      <OptionsShell
        title="Edit Method Body"
        hideTabStrip
        tabs={[{ label: 'Instructions', content: <div className="modal-error">{loadFailure}</div> }]}
        invalid
        error={loadFailure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }
  if (!body)
    return <OptionsShell title="Edit Method Body" hideTabStrip tabs={[{ label: 'Instructions', content: <div className="il-loading">{t('Loading...')}</div> }]} invalid onAccept={onClose} onClose={onClose} />

  const bodyKind = body.bodyType as IlBodyKind
  const offsets = instructionOffsets(body.instructions)

  // ---------------------------------------------------------------------------------------------------------
  // The standard block every list has (ListBoxHelperBase.AddStandardMenuHandlers): add, move, remove, clipboard.
  // ---------------------------------------------------------------------------------------------------------

  interface ListModel<T> {
    kind: IlClipboardKind
    items: readonly T[]
    selected: number[]
    setSelected(selected: number[]): void
    create(): T
    /** Writes a new item list in, given the order — old indexes, or new items — it was rebuilt in. */
    reorder(order: readonly (number | T)[]): void
    labels: { before: string; after: string; append: string; remove: string; removePlural: string; removeAll: string }
    asText(indexes: number[]): string
    paste(at: number): void
  }

  const standardCommands = <T,>(model: ListModel<T>): (ListCommand | null)[] => {
    const sorted = [...model.selected].sort((left, right) => left - right)
    const count = model.items.length
    const order = (): (number | T)[] => model.items.map((_, index) => index)
    const insert = (at: number): void => {
      const next = order()
      next.splice(at, 0, model.create())
      model.reorder(next)
      model.setSelected([at])
    }
    const move = (delta: -1 | 1): void => {
      const moved = moveIndexes(count, sorted, delta)
      model.reorder(moved.order)
      model.setSelected(moved.selected)
    }
    const remove = (indexes: number[]): void => {
      model.reorder(order().filter((index) => !indexes.includes(index as number)))
      model.setSelected([])
    }
    const clip = ilClipboardFor(model.kind, instance.current)
    const pasteAt = sorted.length > 0 ? sorted[0] : count
    return [
      { key: 'before', label: t(model.labels.before), icon: 'NewItem', enabled: true, gesture: { key: 'f' }, shortcut: 'F', run: () => insert(sorted[0] ?? count) },
      { key: 'after', label: t(model.labels.after), icon: 'NewItem', enabled: true, gesture: { key: 'c' }, shortcut: 'C', run: () => insert(sorted.length > 0 ? sorted[sorted.length - 1] + 1 : count) },
      { key: 'append', label: t(model.labels.append), enabled: true, gesture: { key: 'a' }, shortcut: 'A', run: () => insert(count) },
      null,
      { key: 'up', label: t('Move Up'), icon: 'MoveUp', enabled: sorted.length > 0 && sorted.some((index, at) => index !== at), gesture: { key: 'u' }, shortcut: 'U', run: () => move(-1) },
      { key: 'down', label: t('Move Down'), icon: 'DownloadNoColor', enabled: sorted.length > 0 && sorted.some((index, at) => index !== count - sorted.length + at), gesture: { key: 'd' }, shortcut: 'D', run: () => move(1) },
      null,
      { key: 'remove', label: t(sorted.length > 1 ? model.labels.removePlural : model.labels.remove), icon: 'Cancel', enabled: sorted.length > 0, gesture: { key: 'delete' }, shortcut: t('Del'), run: () => remove(sorted) },
      { key: 'removeAll', label: t(model.labels.removeAll), icon: 'Cancel', enabled: count > 0, gesture: { key: 'delete', ctrl: true }, shortcut: 'Ctrl+Del', run: () => remove(order() as number[]) },
      null,
      { key: 'copyText', label: t('Copy as Text'), icon: 'Copy', enabled: sorted.length > 0, gesture: { key: 't', ctrl: true }, shortcut: 'Ctrl+T', run: () => copyText(model.asText(sorted)) },
      {
        key: 'cut', label: t('Cut'), icon: 'Cut', enabled: sorted.length > 0, gesture: { key: 'x', ctrl: true }, shortcut: 'Ctrl+X',
        run: () => {
          setIlClipboard({ kind: model.kind, source: instance.current, methodNodeId: node.id, items: sorted.map((index) => model.items[index]), locals: body.locals })
          remove(sorted)
        },
      },
      {
        key: 'copy', label: t('Copy'), icon: 'Copy', enabled: sorted.length > 0, gesture: { key: 'c', ctrl: true }, shortcut: 'Ctrl+C',
        run: () => setIlClipboard({ kind: model.kind, source: instance.current, methodNodeId: node.id, items: sorted.map((index) => structuredClone(model.items[index])), locals: body.locals }),
      },
      { key: 'paste', label: t('Paste'), icon: 'Paste', enabled: clip !== undefined, gesture: { key: 'v', ctrl: true }, shortcut: 'Ctrl+V', run: () => model.paste(pasteAt) },
      { key: 'pasteAfter', label: t('Paste After Selection'), icon: 'Paste', enabled: clip !== undefined && sorted.length > 0, gesture: { key: 'v', ctrl: true, alt: true }, shortcut: 'Ctrl+Alt+V', run: () => model.paste(Math.min(sorted[0] + 1, count)) },
    ]
  }

  const instructionModel: ListModel<IlBodyInstruction> = {
    kind: 'instructions',
    items: body.instructions,
    selected,
    setSelected,
    create: () => newInstruction(body.instructions),
    reorder: (order) => patch({ instructions: order.map((entry) => typeof entry === 'number' ? body.instructions[entry] : entry) }),
    labels: {
      before: 'Add New Instruction Before Selection',
      after: 'Add New Instruction After Selection',
      append: 'Append New Instruction',
      remove: 'Remove Instruction',
      removePlural: 'Remove Instructions',
      removeAll: 'Remove All Instructions',
    },
    asText: (indexes) => instructionsAsText(body, indexes),
    paste: (at) => {
      const data = ilClipboardFor('instructions', instance.current)
      if (!data)
        return
      const next = pasteInstructions(body, data, at, data.source === instance.current)
      setBody(next)
    },
  }

  const localModel: ListModel<IlLocal> = {
    kind: 'locals',
    items: body.locals,
    selected: localSelected,
    setSelected: setLocalSelected,
    create: newLocal,
    reorder: (order) => setBody(reorderLocals(body, order)),
    labels: {
      before: 'Add New Local Before Selection',
      after: 'Add New Local After Selection',
      append: 'Append New Local',
      remove: 'Remove Local',
      removePlural: 'Remove Locals',
      removeAll: 'Remove All Locals',
    },
    asText: (indexes) => localsAsText(body.locals, indexes),
    paste: (at) => {
      const data = ilClipboardFor('locals', instance.current)
      if (data)
        setBody(insertLocals(body, at, (data.items as IlLocal[]).map((local) => structuredClone(local))))
    },
  }

  const handlerModel: ListModel<IlExceptionHandler> = {
    kind: 'handlers',
    items: body.exceptionHandlers,
    selected: handlerSelected,
    setSelected: setHandlerSelected,
    create: () => newExceptionHandler(body.instructions),
    reorder: (order) => patch({ exceptionHandlers: order.map((entry) => typeof entry === 'number' ? body.exceptionHandlers[entry] : entry) }),
    labels: {
      before: 'Add New Exception Handler Before Selection',
      after: 'Add New Exception Handler After Selection',
      append: 'Append New Exception Handler',
      remove: 'Remove Exception Handler',
      removePlural: 'Remove Exception Handlers',
      removeAll: 'Remove All Exception Handlers',
    },
    asText: (indexes) => handlersAsText(body, indexes),
    paste: (at) => {
      const data = ilClipboardFor('handlers', instance.current)
      if (!data)
        return
      const handlers = [...body.exceptionHandlers]
      handlers.splice(at, 0, ...(data.items as IlExceptionHandler[]).map((handler) => structuredClone(handler)))
      patch({ exceptionHandlers: handlers })
    },
  }

  /** InstructionsListHelper's own entries, before the standard block, and its three copy commands after it. */
  const instructionCommands = (): (ListCommand | null)[] => {
    const chosen = [...selected].sort((left, right) => left - right).map((index) => body.instructions[index])
    const opcodes = chosen.map((instruction) => instruction.opCode.trim().toLowerCase())
    const plural = chosen.length > 1
    return [
      { key: 'nop', label: t(plural ? 'NOP Instructions' : 'NOP Instruction'), enabled: opcodes.some((code) => code !== 'nop'), gesture: { key: 'n' }, shortcut: 'N', run: () => void runTransform('replaceWithNop') },
      { key: 'nops', label: t('Replace with NOPs'), enabled: opcodes.some((code) => code !== 'nop'), gesture: { key: 'r' }, shortcut: 'R', run: () => void runTransform('replaceWithMultipleNops') },
      { key: 'invert', label: t(plural ? 'Invert Branches' : 'Invert Branch'), icon: 'Branch', enabled: opcodes.some((code) => CONDITIONAL_BRANCHES.has(code)), gesture: { key: 'i' }, shortcut: 'I', run: () => void runTransform('invertBranch') },
      { key: 'unconditional', label: t(plural ? 'Convert to Unconditional Branches' : 'Convert to Unconditional Branch'), enabled: opcodes.some((code) => CONDITIONAL_BRANCHES.has(code)), gesture: { key: 'b' }, shortcut: 'B', run: () => void runTransform('convertBranchToUnconditional') },
      { key: 'pops', label: t('Remove and Add Pops'), enabled: opcodes.some((code) => !NO_POPS.has(code)), gesture: { key: 'p' }, shortcut: 'P', run: () => void runTransform('removeAndAddPops') },
      null,
      { key: 'simplify', label: t('Simplify All Instructions'), enabled: body.instructions.length > 0, gesture: { key: 's' }, shortcut: 'S', run: () => void runTransform('simplifyAll', body.instructions.map((_, index) => index)) },
      { key: 'optimize', label: t('Optimize All Instructions'), enabled: body.instructions.length > 0, gesture: { key: 'o' }, shortcut: 'O', run: () => void runTransform('optimizeAll', body.instructions.map((_, index) => index)) },
      null,
      ...standardCommands(instructionModel),
      { key: 'tokens', label: t(plural ? 'Copy MD Tokens' : 'Copy MD Token'), enabled: chosen.some((instruction) => Boolean(instruction.token)), gesture: { key: 'm', ctrl: true }, shortcut: 'Ctrl+M', run: () => copyText(operandTokensAsText(body.instructions, selected)) },
      { key: 'rva', label: t(plural ? 'Copy RVAs' : 'Copy RVA'), enabled: chosen.length > 0, gesture: { key: 'r', ctrl: true }, shortcut: 'Ctrl+R', run: () => copyText(instructionAddressesAsText(body.instructions, selected, body.rva)) },
      { key: 'offset', label: t(plural ? 'Copy File Offsets' : 'Copy File Offset'), enabled: chosen.length > 0, gesture: { key: 'f', ctrl: true }, shortcut: 'Ctrl+F', run: () => copyText(instructionAddressesAsText(body.instructions, selected, body.fileOffset)) },
    ]
  }

  /** ExceptionHandlersListHelper: the standard block and the catch types' tokens. */
  const handlerCommands = (): (ListCommand | null)[] => {
    const tokens = [...handlerSelected].sort((left, right) => left - right)
      .map((index) => body.exceptionHandlers[index]?.catchTypeToken)
      .filter((token): token is string => Boolean(token))
    return [
      ...standardCommands(handlerModel),
      {
        key: 'tokens', label: t(tokens.length > 1 ? 'Copy MD Tokens' : 'Copy MD Token'), enabled: tokens.length > 0, gesture: { key: 'm', ctrl: true }, shortcut: 'Ctrl+M',
        run: () => copyText(tokens.length > 1 ? `${tokens.map((token) => `0x${token}`).join('\n')}\n` : `0x${tokens[0]}`),
      },
    ]
  }

  /** Shows a list's context menu, after making sure the clipboard is still dnSpy's. */
  const showMenu = (title: string, commands: () => (ListCommand | null)[], event: React.MouseEvent): void => {
    event.preventDefault()
    const position = { x: event.clientX, y: event.clientY }
    void checkIlClipboard().then(() => showDebugMenu(title, commands().map((command) => command && {
      key: command.key,
      label: command.label,
      icon: command.icon,
      shortcut: command.shortcut,
      disabled: !command.enabled,
      run: command.run,
    }), position))
  }

  /** A list's gestures — the key bindings and bare letters ListBoxHelperBase registers. */
  const handleKeys = (commands: () => (ListCommand | null)[]) => (event: React.KeyboardEvent): void => {
    const key = event.key.toLowerCase()
    const bare = takesBareKey(event)
    for (const command of commands()) {
      const gesture = command?.gesture
      if (!command || !gesture || gesture.key !== key)
        continue
      const ctrl = gesture.ctrl === true
      const alt = gesture.alt === true
      if (ctrl !== (event.ctrlKey || event.metaKey) || alt !== event.altKey)
        continue
      if (!ctrl && key !== 'delete' && !bare)
        continue
      if (!ctrl && key === 'delete' && (event.target as HTMLElement).closest('input, select, textarea'))
        continue
      event.preventDefault()
      event.stopPropagation()
      // A key the command cannot act on is swallowed all the same, the way dnSpy's handler marks it handled.
      if (command.enabled) {
        if (command.key === 'paste' || command.key === 'pasteAfter')
          void checkIlClipboard().then(() => command.run())
        else
          command.run()
      }
      return
    }
  }

  /** ListBox selection: a click selects one row, Ctrl adds or takes one away, Shift extends from the anchor. */
  const selectRow = (kind: IlClipboardKind, index: number, current: number[], set: (next: number[]) => void, event: React.MouseEvent): void => {
    if ((event.target as HTMLElement).closest('input, select, button, textarea'))
      return
    if (event.button === 2 && current.includes(index))
      return
    const anchor = anchors.current[kind]
    if (event.shiftKey && anchor !== undefined) {
      const start = Math.min(anchor, index)
      const end = Math.max(anchor, index)
      set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      set(current.includes(index) ? current.filter((value) => value !== index) : [...current, index].sort((left, right) => left - right))
      anchors.current[kind] = index
      return
    }
    set([index])
    anchors.current[kind] = index
  }

  /** dnSpy's operand "..." menu: the pickers and creators the operand's kind can take. */
  const showOperandMenu = (index: number, kind: IlOperandKind, anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect()
    const entries = [
      (kind === 'type' || kind === 'token') && { key: 'type', label: t('Type...'), run: () => setOperandEdit({ index, dialog: 'pick', mode: 'type' }) },
      (kind === 'type' || kind === 'token') && { key: 'typeSpec', label: t('TypeSpec...'), run: () => setOperandEdit({ index, dialog: 'typeSpec' }) },
      (kind === 'method' || kind === 'token') && { key: 'method', label: t('Method...'), run: () => setOperandEdit({ index, dialog: 'pick', mode: 'method' }) },
      (kind === 'method' || kind === 'token') && { key: 'methodMemberRef', label: t('Method MemberRef...'), run: () => setOperandEdit({ index, dialog: 'memberRef', isField: false }) },
      (kind === 'method' || kind === 'token') && { key: 'methodSpec', label: t('MethodSpec...'), run: () => setOperandEdit({ index, dialog: 'methodSpec' }) },
      (kind === 'field' || kind === 'token') && { key: 'field', label: t('Field...'), run: () => setOperandEdit({ index, dialog: 'pick', mode: 'field' }) },
      (kind === 'field' || kind === 'token') && { key: 'fieldMemberRef', label: t('Field MemberRef...'), run: () => setOperandEdit({ index, dialog: 'memberRef', isField: true }) },
    ].filter((entry): entry is { key: string; label: string; run(): void } => Boolean(entry))
    showDebugMenu(t('Operand'), entries, { x: rect.left, y: rect.bottom })
  }

  const editOperand = (index: number, kind: IlOperandKind, anchor: HTMLElement): void => {
    if (kind === 'signature')
      setOperandEdit({ index, dialog: 'methodSig' })
    else if (kind === 'switch')
      setOperandEdit({ index, dialog: 'switch' })
    else
      showOperandMenu(index, kind, anchor)
  }

  const instructionsTab = (
    <div className="il-body-tab">
      <datalist id="il-opcode-list">{IL_OPCODES.map((opcode) => <option key={opcode} value={opcode} />)}</datalist>
      <div className="il-editor-options">
        <label>{t('Body Type')}
          <select aria-label={t('Body Type')} value={bodyKind} onChange={(event) => patch({ bodyType: event.target.value as IlBodyKind })}>
            <option value="none">{t('None')}</option>
            <option value="cil">{t('IL')}</option>
            <option value="native">{t('Native')}</option>
          </select>
        </label>
        <label>{t('Code Type')}
          <select aria-label={t('Code Type')} value={body.codeType} onChange={(event) => patch({ codeType: Number(event.target.value) })}>
            {IL_CODE_TYPES.map((entry) => <option key={entry.value} value={entry.value}>{t(entry.label)}</option>)}
          </select>
        </label>
        {bodyKind === 'native' && (
          <label>{t('RVA')}<input aria-label={t('RVA')} type="number" min={0} value={body.nativeRva} onChange={(event) => patch({ nativeRva: Number(event.target.value) })} /></label>
        )}
        {bodyKind === 'cil' && (
          <>
            <label title={t('Don\'t recalculate the MaxStack value when saving the file')}><input type="checkbox" checked={body.keepOldMaxStack} onChange={(event) => patch({ keepOldMaxStack: event.target.checked })} /> {t('Keep Old MaxStack')}</label>
            <label><input type="checkbox" checked={body.initLocals} onChange={(event) => patch({ initLocals: event.target.checked })} /> {t('Init Locals')}</label>
            <label>{t('MaxStack')}<input aria-label={t('MaxStack')} type="number" min={0} max={65535} value={body.maxStack} onChange={(event) => patch({ maxStack: Number(event.target.value) })} /></label>
            <label>{t('Header RVA')}<input readOnly value={`0x${body.headerRva.toString(16).toUpperCase()}`} /></label>
            <label>{t('Header Offset')}<input readOnly value={`0x${body.headerFileOffset.toString(16).toUpperCase()}`} /></label>
            <label>{t('LocalVarSigTok')}<input readOnly aria-label={t('LocalVarSigTok')} value={`0x${body.localVarSigTok.toString(16).toUpperCase()}`} /></label>
          </>
        )}
      </div>
      {bodyKind === 'cil' && (
        <div
          className="il-body-grid"
          role="grid"
          aria-label={t('Instructions')}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={handleKeys(instructionCommands)}
          onContextMenu={(event) => showMenu(t('Instructions'), instructionCommands, event)}
        >
          <div className="il-body-grid-header">{t('Index')}</div>
          <div className="il-body-grid-header">{t('Offset')}</div>
          <div className="il-body-grid-header">{t('OpCode')}</div>
          <div className="il-body-grid-header">{t('Operand')}</div>
          {body.instructions.map((instruction, index) => (
            <InstructionRow
              key={`${index}:${instruction.label}`}
              index={index}
              offset={offsets[index]}
              instruction={instruction}
              locals={body.locals}
              parameterNames={body.parameterNames}
              instructions={body.instructions}
              selected={selected.includes(index)}
              onSelect={(event) => selectRow('instructions', index, selected, setSelected, event)}
              onChange={(next) => patchInstruction(index, next)}
              onEditOperand={(kind, anchor) => editOperand(index, kind, anchor)}
            />
          ))}
        </div>
      )}
      {bodyKind !== 'cil' && <div className="il-loading">{bodyKind === 'none' ? t('The method has no body.') : t('This method has a native body.')}</div>}
    </div>
  )

  const localsTab = (
    <div className="il-body-tab">
      <div
        className="il-body-grid il-locals-grid"
        role="grid"
        aria-label={t('Locals')}
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={handleKeys(() => standardCommands(localModel))}
        onContextMenu={(event) => showMenu(t('Locals'), () => standardCommands(localModel), event)}
      >
        <div className="il-body-grid-header">{t('Index')}</div>
        <div className="il-body-grid-header">{t('Pinned')}</div>
        <div className="il-body-grid-header">{t('Compiler generated')}</div>
        <div className="il-body-grid-header">{t('Name')}</div>
        <div className="il-body-grid-header">{t('Type')}</div>
        {body.locals.map((local, index) => (
          <LocalRow
            key={index}
            index={index}
            local={local}
            selected={localSelected.includes(index)}
            onSelect={(event) => selectRow('locals', index, localSelected, setLocalSelected, event)}
            onChange={(next) => patch({ locals: body.locals.map((current, at) => at === index ? next : current) })}
            onEditType={() => setTypeEdit({ kind: 'local', index })}
          />
        ))}
      </div>
    </div>
  )

  const handlersTab = (
    <div className="il-body-tab">
      <div
        className="il-body-grid il-handlers-grid"
        role="grid"
        aria-label={t('Exception Handlers')}
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={handleKeys(handlerCommands)}
        onContextMenu={(event) => showMenu(t('Exception Handlers'), handlerCommands, event)}
      >
        <div className="il-body-grid-header">{t('Index')}</div>
        <div className="il-body-grid-header">{t('Type')}</div>
        {(['TryStart', 'TryEnd', 'FilterStart', 'HandlerStart', 'HandlerEnd'] as const).map((column) => <div key={column} className="il-body-grid-header">{t(column)}</div>)}
        <div className="il-body-grid-header">{t('CatchType')}</div>
        {body.exceptionHandlers.map((handler, index) => (
          <HandlerRow
            key={index}
            index={index}
            handler={handler}
            instructions={body.instructions}
            selected={handlerSelected.includes(index)}
            onSelect={(event) => selectRow('handlers', index, handlerSelected, setHandlerSelected, event)}
            onEditCatchType={() => setTypeEdit({ kind: 'handler', index })}
            onChange={(next) => patch({ exceptionHandlers: body.exceptionHandlers.map((current, at) => at === index ? next : current) })}
          />
        ))}
      </div>
    </div>
  )

  const tabs: OptionsTab[] = [
    { label: 'Instructions', content: instructionsTab },
    { label: 'Locals', content: localsTab },
    { label: 'Exception Handlers', content: handlersTab },
  ]

  const editing = operandEdit ? body.instructions[operandEdit.index] : undefined
  const setOperand = (next: Partial<IlBodyInstruction>): void => {
    if (operandEdit && editing)
      patchInstruction(operandEdit.index, { ...editing, ...CLEARED_OPERAND, ...next })
    setOperandEdit(undefined)
  }

  return (
    <>
      <OptionsShell
        title="Edit Method Body"
        className="il-body-dialog"
        tabs={tabs}
        invalid={invalid !== undefined}
        busy={saving}
        error={writeFailure ?? invalid}
        onAccept={() => void save()}
        onClose={onClose}
        onReset={() => { if (initialBody) { setBody(initialBody); setSelected([]); setLocalSelected([]); setHandlerSelected([]) } }}
      />
      {typeEdit && workspaceId && (
        <IlTypeDialog
          title={typeEdit.kind === 'local' ? 'Create a Local Type' : 'Create an Exception Catch Type'}
          value={typeEdit.kind === 'local' ? body.locals[typeEdit.index]?.type ?? null : body.exceptionHandlers[typeEdit.index]?.catchType ?? null}
          isLocal={typeEdit.kind === 'local'}
          onChange={(type) => {
            if (typeEdit.kind === 'local') {
              const current = body.locals[typeEdit.index]
              if (current)
                patch({ locals: body.locals.map((local, at) => at === typeEdit.index ? { ...local, type, display: compareType(type, local.name) } : local) })
            }
            else {
              const current = body.exceptionHandlers[typeEdit.index]
              if (current)
                patch({ exceptionHandlers: body.exceptionHandlers.map((handler, at) => at === typeEdit.index ? { ...handler, catchType: type } : handler) })
            }
            setTypeEdit(undefined)
          }}
          onClose={() => setTypeEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'pick' && workspaceId && (
        <TypePickerDialog
          workspaceId={workspaceId}
          mode={operandEdit.mode}
          onPick={(picked, trail) => {
            if (operandEdit.mode === 'method') {
              // A method picked from the tree names the definition; a reference is built from it for the backend.
              void window.dnSpy.getNodeOptions(workspaceId, 'method', { nodeId: picked.id }).then((response) => {
                const reference = response.method ? pickedMethodRef(trail, response.method) : undefined
                setOperand({ nodeId: picked.id, methodRef: reference, operandDisplay: reference ? methodRefLabel(reference) : picked.description ?? picked.label })
              }, () => setOperand({ nodeId: picked.id, operandDisplay: picked.description ?? picked.label }))
            }
            else
              setOperand({ nodeId: picked.id, operandDisplay: picked.description ?? picked.label })
          }}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'typeSpec' && workspaceId && (
        <TypeSpecDialog
          workspaceId={workspaceId}
          value={editing?.typeSignature ?? null}
          onAccept={(type) => setOperand({ typeSignature: type, operandDisplay: describeTypeSig(type) })}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'memberRef' && workspaceId && (
        <MemberRefDialog
          workspaceId={workspaceId}
          isField={operandEdit.isField}
          value={editing?.memberRef?.isField === operandEdit.isField ? editing.memberRef : null}
          assemblyRootIds={assemblyRootIds}
          onAccept={(reference: MemberRefDto) => setOperand({ memberRef: reference, operandDisplay: reference.display || memberRefDisplay(reference) })}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'methodSpec' && workspaceId && editing && (
        <MethodSpecDialog
          workspaceId={workspaceId}
          value={methodSpecOf(editing)}
          onAccept={(spec) => setOperand({
            nodeId: spec.method?.methodRef ? undefined : spec.method?.nodeId,
            token: spec.method?.methodRef || spec.method?.memberRef ? undefined : spec.method?.token,
            tokenOwnerNodeId: spec.method?.token ? editing.tokenOwnerNodeId : undefined,
            methodRef: spec.method?.methodRef,
            memberRef: spec.method?.memberRef,
            methodSpecArguments: spec.arguments,
            methodSpecCustomAttributes: spec.customAttributes,
            operandDisplay: `${spec.method?.display ?? ''}<${spec.arguments.map((argument) => describeTypeSig(argument)).join(',')}>`,
          })}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'methodSig' && workspaceId && (
        <MethodSigDialog
          workspaceId={workspaceId}
          value={editing?.callSiteSignature ?? null}
          onAccept={(signature: MethodSigDto) => setOperand({ callSiteSignature: signature, operandDisplay: describeMethodSig(signature) })}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
      {operandEdit?.dialog === 'switch' && editing && (
        <SwitchOperandDialog
          targets={branchTargets({ ...editing, operandKind: 'switch' })}
          instructions={body.instructions}
          onAccept={(targets) => {
            patchInstruction(operandEdit.index, { ...editing, operand: targets.join(','), operandDisplay: targets.join(', ') })
            setOperandEdit(undefined)
          }}
          onClose={() => setOperandEdit(undefined)}
        />
      )}
    </>
  )
}

/** What a MethodSpec operand's dialog starts from: the operand when it is one, an empty spec otherwise. */
const methodSpecOf = (instruction: IlBodyInstruction): MethodSpecValue => ({
  method: instruction.methodRef || instruction.memberRef || instruction.nodeId || instruction.token
    ? {
      nodeId: instruction.nodeId,
      token: instruction.methodSpecArguments ? undefined : instruction.token,
      methodRef: instruction.methodRef,
      memberRef: instruction.memberRef?.isField ? null : instruction.memberRef,
      display: instruction.methodRef ? methodRefLabel(instruction.methodRef) : instruction.memberRef?.display ?? instruction.operandDisplay ?? '',
    }
    : null,
  arguments: instruction.methodSpecArguments ?? [],
  customAttributes: instruction.methodSpecCustomAttributes ?? [],
})

/** The text of a local's Type column for a type the dialog just edited. */
const compareType = (type: TypeSigDto, name: string | null | undefined): string => `${type.display || type.kind} ${name ?? ''}`.trim()

interface InstructionRowProps {
  index: number
  offset: number
  instruction: IlBodyInstruction
  instructions: IlBodyInstruction[]
  locals: IlLocal[]
  parameterNames: string[]
  selected: boolean
  onSelect(event: React.MouseEvent): void
  onChange(next: IlBodyInstruction): void
  onEditOperand(kind: IlOperandKind, anchor: HTMLElement): void
}

const InstructionRow = ({ index, offset, instruction, instructions, locals, parameterNames, selected, onSelect, onChange, onEditOperand }: InstructionRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const kind = (instruction.operandKind ?? operandKindFor(instruction.opCode)) as IlOperandKind
  const labels = instructions.map((entry) => entry.label)
  return (
    <div className={`il-body-grid-row${selected ? ' selected' : ''}`} role="row" aria-selected={selected} onMouseDown={onSelect}>
      <span className="il-index-cell">{index}</span>
      <span className="il-offset-cell">{`IL_${offset.toString(16).toUpperCase().padStart(4, '0')}`}</span>
      <input list="il-opcode-list" aria-label={t('OpCode {index}', { index })} value={instruction.opCode} onChange={(event) => onChange(withOpcode(instruction, event.target.value))} />
      <div className="il-operand-cell">
        {kind === 'none' && <span className="il-operand-none">—</span>}
        {(kind === 'number' || kind === 'string') && (
          <input aria-label={t('Operand {index}', { index })} value={instruction.operand ?? ''} onChange={(event) => onChange({ ...instruction, operand: event.target.value, operandDisplay: event.target.value })} />
        )}
        {kind === 'branch' && (
          <select aria-label={t('Operand {index}', { index })} value={instruction.operand ?? ''} onChange={(event) => onChange({ ...instruction, operand: event.target.value, operandDisplay: event.target.value })}>
            <option value="">{t('None')}</option>
            {labels.map((label) => <option key={label} value={label}>{label}</option>)}
          </select>
        )}
        {kind === 'local' && (
          <select aria-label={t('Operand {index}', { index })} value={instruction.operand ?? ''} onChange={(event) => onChange({ ...instruction, operand: event.target.value, operandDisplay: `V_${event.target.value}` })}>
            <option value="">{t('None')}</option>
            {locals.map((local, at) => <option key={at} value={String(at)}>{(local.name ?? `V_${at}`) + ` (${at})`}</option>)}
          </select>
        )}
        {kind === 'argument' && (
          <select aria-label={t('Operand {index}', { index })} value={instruction.operand ?? ''} onChange={(event) => onChange({ ...instruction, operand: event.target.value, operandDisplay: parameterNames[Number(event.target.value)] })}>
            <option value="">{t('None')}</option>
            {parameterNames.map((name, at) => <option key={at} value={String(at)}>{name + ` (${at})`}</option>)}
          </select>
        )}
        {(kind === 'type' || kind === 'field' || kind === 'method' || kind === 'token' || kind === 'signature' || kind === 'switch') && (
          <div className="il-operand-reference">
            <span title={instruction.operandDisplay ?? ''}>{kind === 'switch' ? `[${branchTargets(instruction).join(', ')}]` : instruction.operandDisplay ?? instruction.token ?? 'null'}</span>
            <button type="button" aria-label={t('Pick {index}', { index })} onClick={(event) => onEditOperand(kind, event.currentTarget)}>…</button>
          </div>
        )}
      </div>
    </div>
  )
}

interface LocalRowProps {
  index: number
  local: IlLocal
  selected: boolean
  onSelect(event: React.MouseEvent): void
  onChange(next: IlLocal): void
  onEditType(): void
}

const LocalRow = ({ index, local, selected, onSelect, onChange, onEditType }: LocalRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div className={`il-body-grid-row${selected ? ' selected' : ''}`} role="row" aria-selected={selected} onMouseDown={onSelect}>
      <span className="il-index-cell">{index}</span>
      <span><input type="checkbox" aria-label={t('Pinned {index}', { index })} checked={local.isPinned} onChange={(event) => onChange({ ...local, isPinned: event.target.checked })} /></span>
      <span><input type="checkbox" aria-label={t('Compiler generated {index}', { index })} checked={(local.attributes & 0x01) !== 0} onChange={(event) => onChange({ ...local, attributes: event.target.checked ? local.attributes | 0x01 : local.attributes & ~0x01 })} /></span>
      <input aria-label={t('Name {index}', { index })} value={local.name ?? ''} onChange={(event) => onChange({ ...local, name: event.target.value || null, display: compareType(local.type ?? { kind: 'empty' } as TypeSigDto, event.target.value) })} />
      <button type="button" className="il-type-button" aria-label={t('Type {index}', { index })} title={local.type?.display ?? local.display} onClick={onEditType}>{local.type?.display || local.display || t('Type')}</button>
    </div>
  )
}

interface HandlerRowProps {
  index: number
  handler: IlExceptionHandler
  instructions: IlBodyInstruction[]
  selected: boolean
  onSelect(event: React.MouseEvent): void
  onChange(next: IlExceptionHandler): void
  onEditCatchType(): void
}

const HandlerRow = ({ index, handler, instructions, selected, onSelect, onChange, onEditCatchType }: HandlerRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const labels = instructions.map((instruction) => instruction.label)
  const position = (name: 'tryStart' | 'tryEnd' | 'filterStart' | 'handlerStart' | 'handlerEnd', column: string): React.JSX.Element => (
    <select aria-label={t('{column} {index}', { column, index })} value={handler[name] ?? ''} onChange={(event) => onChange({ ...handler, [name]: event.target.value || null })}>
      <option value="">{t('None')}</option>
      {labels.map((label) => <option key={label} value={label}>{label}</option>)}
    </select>
  )
  return (
    <div className={`il-body-grid-row${selected ? ' selected' : ''}`} role="row" aria-selected={selected} onMouseDown={onSelect}>
      <span className="il-index-cell">{index}</span>
      <select aria-label={t('Handler Type {index}', { index })} value={handler.handlerType} onChange={(event) => onChange({ ...handler, handlerType: event.target.value as IlExceptionHandler['handlerType'] })}>
        {IL_HANDLER_TYPES.map((type) => <option key={type} value={type}>{t(type === 'catch' ? 'Catch' : type === 'filter' ? 'Filter' : type === 'finally' ? 'Finally' : 'Fault')}</option>)}
      </select>
      {position('tryStart', 'TryStart')}
      {position('tryEnd', 'TryEnd')}
      {position('filterStart', 'FilterStart')}
      {position('handlerStart', 'HandlerStart')}
      {position('handlerEnd', 'HandlerEnd')}
      <button type="button" className="il-type-button" aria-label={t('CatchType {index}', { index })} onClick={onEditCatchType}>{handler.catchType?.display || handler.catchType?.type?.name || t('None')}</button>
    </div>
  )
}

interface IlTypeDialogProps {
  title: string
  value: TypeSigDto | null
  isLocal: boolean
  onChange(type: TypeSigDto): void
  onClose(): void
}

/** A one-page window over `TypeSigEditor`, which is dnSpy's `TypeSigCreatorDlg`. */
const IlTypeDialog = ({ title, value, isLocal, onChange, onClose }: IlTypeDialogProps): React.JSX.Element => {
  const workspaceId = useAppStore((state) => state.workspaceId)
  const [type, setType] = useState<TypeSigDto | null>(value)
  if (!workspaceId)
    return <></>
  return (
    <OptionsShell
      title={title}
      hideTabStrip
      className="type-sig-shell"
      tabs={[{ label: title, content: <TypeSigEditor workspaceId={workspaceId} value={type} onChange={setType} options={{ isLocal }} /> }]}
      invalid={type === null}
      onAccept={() => { if (type) onChange(type) }}
      onClose={onClose}
    />
  )
}

interface SwitchOperandDialogProps {
  targets: string[]
  instructions: IlBodyInstruction[]
  onAccept(targets: string[]): void
  onClose(): void
}

/**
 * dnSpy's SwitchOperandDlg: the switch's targets, one instruction each, in a list with its own Add, Remove and
 * Move commands — SwitchOperandsListHelper's standard block.
 */
const SwitchOperandDialog = ({ targets: initial, instructions, onAccept, onClose }: SwitchOperandDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [targets, setTargets] = useState(initial)
  const [selectedTarget, setSelectedTarget] = useState<number>()
  const labels = instructions.map((instruction) => instruction.label)
  const move = (delta: -1 | 1): void => {
    if (selectedTarget === undefined)
      return
    const moved = moveIndexes(targets.length, [selectedTarget], delta)
    setTargets(moved.order.map((index) => targets[index]))
    setSelectedTarget(moved.selected[0])
  }
  const content = (
    <div className="options-form">
      <div className="il-switch-targets" role="listbox" aria-label={t('Switch targets')}>
        {targets.map((target, index) => (
          <div key={index} role="option" aria-selected={selectedTarget === index} className={selectedTarget === index ? 'selected' : undefined} onMouseDown={() => setSelectedTarget(index)}>
            <span className="il-index-cell">{index}</span>
            <select aria-label={t('Target {index}', { index })} value={target} onChange={(event) => setTargets(targets.map((current, at) => at === index ? event.target.value : current))}>
              <option value="">{t('None')}</option>
              {labels.map((label) => <option key={label} value={label}>{label}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="options-inline">
        <button type="button" onClick={() => { setTargets([...targets, labels[0] ?? '']); setSelectedTarget(targets.length) }}>{t('Append New Instruction')}</button>
        <button type="button" disabled={selectedTarget === undefined} onClick={() => { setTargets(targets.filter((_, index) => index !== selectedTarget)); setSelectedTarget(undefined) }}>{t('Remove Instruction')}</button>
        <button type="button" disabled={selectedTarget === undefined} onClick={() => move(-1)}>{t('Move Up')}</button>
        <button type="button" disabled={selectedTarget === undefined} onClick={() => move(1)}>{t('Move Down')}</button>
      </div>
    </div>
  )
  return (
    <OptionsShell
      title="Switch"
      hideTabStrip
      tabs={[{ label: 'Switch', content }]}
      invalid={targets.some((target) => target === '')}
      onAccept={() => onAccept(targets)}
      onClose={onClose}
    />
  )
}

