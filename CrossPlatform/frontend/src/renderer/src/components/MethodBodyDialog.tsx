import { useEffect, useRef, useState } from 'react'
import type { IlBodyInstruction, IlExceptionHandler, IlLocal, IlMethodBody, MethodRefDto, TreeNode, TypeSigDto } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { OptionsShell, type OptionsTab } from './OptionsShell'
import { TypePickerDialog } from './TypePickerDialog'
import {
  IL_CODE_TYPES,
  IL_HANDLER_TYPES,
  IL_OPCODES,
  ilBodyError,
  newExceptionHandler,
  newInstruction,
  newLocal,
  offsetOfLabel,
  operandKindFor,
  statementSelection,
  withOpcode,
  type IlBodyKind,
  type IlOperandKind,
} from './il-body-model'
import { MethodRefPickerDialog } from './widgets/MethodRefPickerDialog'
import { methodRefLabel } from './widgets/method-ref'
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

/** The picker an operand's button opens. */
type OperandPick = { index: number; mode: 'type' | 'field' | 'method' }


/**
 * dnSpy's Edit Method Body window: the three tabs of `MethodBodyDlg` — instructions, locals and
 * exception handlers — over one body. The instruction list keeps WPF's context-menu commands, which the
 * backend runs because the stack ones need the operand signatures; the local and handler lists are
 * edited in place, the way the two ListViews are.
 */
export const MethodBodyDialog = ({ node, selection, onClose }: MethodBodyDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const methodBodyChanged = useAppStore((state) => state.methodBodyChanged)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const [body, setBody] = useState<IlMethodBody>()
  const [initialInstructions, setInitialInstructions] = useState<IlMethodBody>()
  const [loadFailure, setLoadFailure] = useState<string>()
  const [writeFailure, setWriteFailure] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [typeEdit, setTypeEdit] = useState<TypeEdit>()
  const [pick, setPick] = useState<OperandPick>()
  const selectionAnchor = useRef<number | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    if (!workspaceId)
      return
    void window.dnSpy.getIlBody(workspaceId, node.id)
      .then((loaded) => {
        if (cancelled)
          return
        setBody(loaded)
        setInitialInstructions(loaded)
        setSelected(selection ? statementSelection(loaded.instructions, selection.start, selection.end) : [])
      })
      .catch((reason: unknown) => { if (!cancelled) setLoadFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, node.id, selection])

  const invalid = body ? ilBodyError(body) : undefined

  const patch = (next: Partial<IlMethodBody>): void =>
    setBody((current) => current ? { ...current, ...next } : current)

  const patchInstruction = (index: number, next: IlBodyInstruction): void =>
    setBody((current) => current ? { ...current, instructions: current.instructions.map((instruction, at) => at === index ? next : instruction) } : current)

  const runTransform = async (operation: string): Promise<void> => {
    if (!workspaceId || !body)
      return
    try {
      const result = await window.dnSpy.transformIlBody(workspaceId, node.id, operation, body.locals, body.instructions, selected, body.parameterNames)
      patch({ locals: result.locals, instructions: result.instructions })
    }
    catch (reason) {
      setWriteFailure(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const addInstruction = (where: 'before' | 'after' | 'append'): void => {
    if (!body)
      return
    const instruction = newInstruction(body.instructions)
    const instructions = [...body.instructions]
    const at = where === 'append' ? instructions.length : where === 'before' ? (selected[0] ?? instructions.length) : (selected[selected.length - 1] ?? instructions.length - 1) + 1
    instructions.splice(at, 0, instruction)
    patch({ instructions })
    setSelected([at])
  }

  const removeInstructions = (): void => {
    if (!body || selected.length === 0)
      return
    const instructions = body.instructions.filter((_, index) => !selected.includes(index))
    patch({ instructions })
    setSelected([])
  }

  const moveInstructions = (delta: number): void => {
    if (!body || selected.length === 0)
      return
    const instructions = [...body.instructions]
    const indexes = delta < 0 ? selected : [...selected].reverse()
    const moved: number[] = []
    for (const index of indexes) {
      const target = index + delta
      if (target < 0 || target >= instructions.length || selected.includes(target))
        continue
      const [instruction] = instructions.splice(index, 1)
      instructions.splice(target, 0, instruction)
      moved.push(target)
    }
    patch({ instructions })
    setSelected(moved.sort((left, right) => left - right))
  }

  const selectRow = (index: number, event: React.MouseEvent): void => {
    if ((event.target as HTMLElement).closest('input, select, button, textarea'))
      return
    if (event.shiftKey && selectionAnchor.current !== undefined) {
      const start = Math.min(selectionAnchor.current, index)
      const end = Math.max(selectionAnchor.current, index)
      setSelected(Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index].sort((left, right) => left - right))
      selectionAnchor.current = index
      return
    }
    setSelected([index])
    selectionAnchor.current = index
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
  const instructionCount = body.instructions.length

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
        <>
          <div className="il-editor-actions">
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('simplifyAll')}>{t('Simplify All Instructions')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('optimizeAll')}>{t('Optimize All Instructions')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('replaceWithNop')}>{t('NOP Instruction')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('replaceWithMultipleNops')}>{t('Replace with NOPs')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('invertBranch')}>{t('Invert Branch')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('convertBranchToUnconditional')}>{t('Convert to Unconditional Branch')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => void runTransform('removeAndAddPops')}>{t('Remove and Add Pops')}</button>
          </div>
          <div className="il-editor-actions">
            <button type="button" onClick={() => addInstruction('before')}>{t('Add New Instruction Before Selection')}</button>
            <button type="button" onClick={() => addInstruction('after')}>{t('Add New Instruction After Selection')}</button>
            <button type="button" onClick={() => addInstruction('append')}>{t('Append New Instruction')}</button>
            <button type="button" disabled={selected.length === 0} onClick={removeInstructions}>{t('Remove Instruction')}</button>
            <button type="button" disabled={instructionCount === 0} onClick={() => { patch({ instructions: [] }); setSelected([]) }}>{t('Remove All Instructions')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => moveInstructions(-1)}>{t('Move Up')}</button>
            <button type="button" disabled={selected.length === 0} onClick={() => moveInstructions(1)}>{t('Move Down')}</button>
          </div>
          <div className="il-body-grid" role="grid" aria-label={t('Instructions')}>
            <div className="il-body-grid-header">{t('Index')}</div>
            <div className="il-body-grid-header">{t('Offset')}</div>
            <div className="il-body-grid-header">{t('OpCode')}</div>
            <div className="il-body-grid-header">{t('Operand')}</div>
            <div />
            {body.instructions.map((instruction, index) => (
              <InstructionRow
                key={`${index}:${instruction.label}`}
                index={index}
                instruction={instruction}
                locals={body.locals}
                parameterNames={body.parameterNames}
                instructions={body.instructions}
                selected={selected.includes(index)}
                onSelect={(event) => selectRow(index, event)}
                onChange={(next) => patchInstruction(index, next)}
                onPick={() => setPick({ index, mode: operandKindFor(instruction.opCode) === 'field' ? 'field' : operandKindFor(instruction.opCode) === 'method' ? 'method' : 'type' })}
                onRemove={() => { patch({ instructions: body.instructions.filter((_, at) => at !== index) }); setSelected([]) }}
              />
            ))}
          </div>
        </>
      )}
      {bodyKind !== 'cil' && <div className="il-loading">{bodyKind === 'none' ? t('The method has no body.') : t('This method has a native body.')}</div>}
    </div>
  )

  const localsTab = (
    <div className="il-body-tab">
      <div className="il-body-grid il-locals-grid" role="grid" aria-label={t('Locals')}>
        <div className="il-body-grid-header">{t('Index')}</div>
        <div className="il-body-grid-header">{t('Pinned')}</div>
        <div className="il-body-grid-header">{t('Compiler generated')}</div>
        <div className="il-body-grid-header">{t('Name')}</div>
        <div className="il-body-grid-header">{t('Type')}</div>
        <div />
        {body.locals.map((local, index) => (
          <LocalRow
            key={index}
            index={index}
            local={local}
            onChange={(next) => patch({ locals: body.locals.map((current, at) => at === index ? next : current) })}
            onEditType={() => setTypeEdit({ kind: 'local', index })}
            onRemove={() => patch({ locals: body.locals.filter((_, at) => at !== index) })}
          />
        ))}
      </div>
      <div className="il-editor-actions">
        <button type="button" onClick={() => patch({ locals: [...body.locals, newLocal()] })}>{t('Add')}</button>
      </div>
    </div>
  )

  const handlersTab = (
    <div className="il-body-tab">
      <div className="il-body-grid il-handlers-grid" role="grid" aria-label={t('Exception Handlers')}>
        <div className="il-body-grid-header">{t('Index')}</div>
        <div className="il-body-grid-header">{t('Type')}</div>
        {(['TryStart', 'TryEnd', 'FilterStart', 'HandlerStart', 'HandlerEnd'] as const).map((column) => <div key={column} className="il-body-grid-header">{t(column)}</div>)}
        <div className="il-body-grid-header">{t('CatchType')}</div>
        <div />
        {body.exceptionHandlers.map((handler, index) => (
          <HandlerRow
            key={index}
            index={index}
            handler={handler}
            instructions={body.instructions}
            onEditCatchType={() => setTypeEdit({ kind: 'handler', index })}
            onChange={(next) => patch({ exceptionHandlers: body.exceptionHandlers.map((current, at) => at === index ? next : current) })}
            onRemove={() => patch({ exceptionHandlers: body.exceptionHandlers.filter((_, at) => at !== index) })}
          />
        ))}
      </div>
      <div className="il-editor-actions">
        <button type="button" onClick={() => patch({ exceptionHandlers: [...body.exceptionHandlers, newExceptionHandler(body.instructions)] })}>{t('Add')}</button>
      </div>
    </div>
  )

  const tabs: OptionsTab[] = [
    { label: 'Instructions', content: instructionsTab },
    { label: 'Locals', content: localsTab },
    { label: 'Exception Handlers', content: handlersTab },
  ]

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
        onReset={() => { if (initialInstructions) { setBody(initialInstructions); setSelected([]) } }}
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
      {pick && workspaceId && (
        <OperandPicker
          workspaceId={workspaceId}
          mode={pick.mode}
          onMethod={(reference) => {
            const instruction = body.instructions[pick.index]
            if (instruction)
              patchInstruction(pick.index, { ...instruction, methodRef: reference, methodSpecArguments: undefined, nodeId: undefined, token: undefined, operandDisplay: reference ? methodRefLabel(reference) : undefined })
            setPick(undefined)
          }}
          onNode={(picked) => {
            const instruction = body.instructions[pick.index]
            if (instruction)
              patchInstruction(pick.index, { ...instruction, nodeId: picked.id, token: undefined, methodRef: undefined, operandDisplay: picked.description ?? picked.label })
            setPick(undefined)
          }}
          onClose={() => setPick(undefined)}
        />
      )}
    </>
  )
}

/** The text a local's Type column shows for a type the dialog just edited. */
const compareType = (type: TypeSigDto, name: string | null | undefined): string => `${type.display || type.kind} ${name ?? ''}`.trim()

interface InstructionRowProps {
  index: number
  instruction: IlBodyInstruction
  instructions: IlBodyInstruction[]
  locals: IlLocal[]
  parameterNames: string[]
  selected: boolean
  onSelect(event: React.MouseEvent): void
  onChange(next: IlBodyInstruction): void
  onPick(): void
  onRemove(): void
}

const InstructionRow = ({ index, instruction, instructions, locals, parameterNames, selected, onSelect, onChange, onPick, onRemove }: InstructionRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const kind = (instruction.operandKind ?? operandKindFor(instruction.opCode)) as IlOperandKind
  const labels = instructions.map((entry) => entry.label)
  return (
    <div className={`il-body-grid-row${selected ? ' selected' : ''}`} role="row" aria-selected={selected} onMouseDown={onSelect}>
      <span className="il-index-cell">{index}</span>
      <span className="il-offset-cell">{offsetOfLabel(instruction.label) === undefined ? '' : `IL_${(offsetOfLabel(instruction.label) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`}</span>
      <input list="il-opcode-list" aria-label={t('OpCode {index}', { index })} value={instruction.opCode} onChange={(event) => onChange(withOpcode(instruction, event.target.value))} />
      <div className="il-operand-cell">
        {kind === 'none' && <span className="il-operand-none">—</span>}
        {(kind === 'number' || kind === 'string' || kind === 'switch') && (
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
        {(kind === 'type' || kind === 'field' || kind === 'method' || kind === 'token') && (
          <div className="il-operand-reference">
            <span title={instruction.operandDisplay ?? ''}>{instruction.operandDisplay ?? instruction.token ?? ''}</span>
            <button type="button" aria-label={t('Pick {index}', { index })} onClick={onPick}>…</button>
          </div>
        )}
        {kind === 'signature' && <span title={instruction.operandDisplay ?? ''}>{instruction.operandDisplay ?? ''}</span>}
      </div>
      <button type="button" className="icon-button" title={t('Remove Instruction')} aria-label={t('Remove Instruction {index}', { index })} onClick={onRemove}>×</button>
    </div>
  )
}

interface LocalRowProps {
  index: number
  local: IlLocal
  onChange(next: IlLocal): void
  onEditType(): void
  onRemove(): void
}

const LocalRow = ({ index, local, onChange, onEditType, onRemove }: LocalRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div className="il-body-grid-row" role="row">
      <span className="il-index-cell">{index}</span>
      <span><input type="checkbox" aria-label={t('Pinned {index}', { index })} checked={local.isPinned} onChange={(event) => onChange({ ...local, isPinned: event.target.checked })} /></span>
      <span><input type="checkbox" aria-label={t('Compiler generated {index}', { index })} checked={(local.attributes & 0x01) !== 0} onChange={(event) => onChange({ ...local, attributes: event.target.checked ? local.attributes | 0x01 : local.attributes & ~0x01 })} /></span>
      <input aria-label={t('Name {index}', { index })} value={local.name ?? ''} onChange={(event) => onChange({ ...local, name: event.target.value || null, display: compareType(local.type ?? { kind: 'empty' } as TypeSigDto, event.target.value) })} />
      <button type="button" className="il-type-button" aria-label={t('Type {index}', { index })} title={local.type?.display ?? local.display} onClick={onEditType}>{local.type?.display || local.display || t('Type')}</button>
      <button type="button" className="icon-button" aria-label={t('Remove local {index}', { index })} onClick={onRemove}>×</button>
    </div>
  )
}

interface HandlerRowProps {
  index: number
  handler: IlExceptionHandler
  instructions: IlBodyInstruction[]
  onChange(next: IlExceptionHandler): void
  onEditCatchType(): void
  onRemove(): void
}

const HandlerRow = ({ index, handler, instructions, onChange, onEditCatchType, onRemove }: HandlerRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const labels = instructions.map((instruction) => instruction.label)
  const position = (name: 'tryStart' | 'tryEnd' | 'filterStart' | 'handlerStart' | 'handlerEnd', column: string): React.JSX.Element => (
    <select aria-label={t('{column} {index}', { column, index })} value={handler[name] ?? ''} onChange={(event) => onChange({ ...handler, [name]: event.target.value || null })}>
      <option value="">{t('None')}</option>
      {labels.map((label) => <option key={label} value={label}>{label}</option>)}
    </select>
  )
  return (
    <div className="il-body-grid-row" role="row">
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
      <button type="button" className="icon-button" aria-label={t('Remove handler {index}', { index })} onClick={onRemove}>×</button>
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

interface OperandPickerProps {
  workspaceId: string
  mode: 'type' | 'field' | 'method'
  onMethod(reference: MethodRefDto | undefined): void
  onNode(node: TreeNode): void
  onClose(): void
}

/** The two pickers dnSpy's operand editor opens: the member picker for a call and the type picker. */
const OperandPicker = ({ workspaceId, mode, onMethod, onNode, onClose }: OperandPickerProps): React.JSX.Element => {
  if (mode === 'method')
    return <MethodRefPickerDialog workspaceId={workspaceId} value={undefined} isNew onAccept={(reference) => onMethod(reference)} onCancel={onClose} />
  return <TypePickerDialog workspaceId={workspaceId} mode={mode} onPick={(node) => onNode(node)} onClose={onClose} />
}
