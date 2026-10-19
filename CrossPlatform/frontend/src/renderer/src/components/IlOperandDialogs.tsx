import { useState } from 'react'
import type { CustomAttributeDto, MemberRefDto, MemberRefParentDto, MethodRefDto, MethodSigDto, TreeNode, TypeSigDto } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { OptionsShell, type OptionsTab } from './OptionsShell'
import { TypePickerDialog, type PickerMode } from './TypePickerDialog'
import { CustomAttributeListEditor } from './widgets/CustomAttributeListEditor'
import { customAttributeDraft, customAttributeDto, type CustomAttributeDraft } from './widgets/custom-attribute'
import { MethodSigEditor } from './widgets/MethodSigEditor'
import { pickedMethodRef, methodRefFullName } from './widgets/method-ref'
import { describeMethodSig, describeTypeSig, isMethodSigComplete, isTypeSigComplete, referenceOf } from './widgets/type-sig-text'
import { TypeSigEditor } from './widgets/TypeSigEditor'
import { TypeSigListEditor } from './widgets/TypeSigListEditor'

/** `void`, which dnSpy's MethodSigCreator starts a new signature's return type as. */
export const VOID_TYPE: TypeSigDto = { kind: 'type', type: { scope: '', namespace: 'System', name: 'Void' }, valueType: true, display: 'System.Void' }

/** dnSpy's new MethodSig: the default calling convention, no flags, `void`, no parameters. */
export const newMethodSig = (): MethodSigDto => ({ callingConvention: 0, returnType: VOID_TYPE, parameters: [], genericParameterCount: 0 })

interface TypeSpecDialogProps {
  workspaceId: string
  value: TypeSigDto | null
  onAccept(value: TypeSigDto): void
  onClose(): void
}

/** dnSpy's "Create TypeSpec": a TypeSigCreator whose result is used as a type. */
export const TypeSpecDialog = ({ workspaceId, value, onAccept, onClose }: TypeSpecDialogProps): React.JSX.Element => {
  const [type, setType] = useState<TypeSigDto | null>(value)
  return (
    <OptionsShell
      title="Create TypeSpec"
      hideTabStrip
      className="type-sig-shell"
      tabs={[{ label: 'Create TypeSpec', content: <TypeSigEditor workspaceId={workspaceId} value={type} onChange={setType} options={{ canAddGenericTypeVar: true, canAddGenericMethodVar: true }} /> }]}
      invalid={!isTypeSigComplete(type)}
      onAccept={() => { if (type) onAccept(type) }}
      onClose={onClose}
    />
  )
}

interface MethodSigDialogProps {
  workspaceId: string
  value: MethodSigDto | null
  onAccept(value: MethodSigDto): void
  onClose(): void
}

/** dnSpy's "Create MethodSig" for a calli: a MethodSigCreator with the vararg parameters it allows there. */
export const MethodSigDialog = ({ workspaceId, value, onAccept, onClose }: MethodSigDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [signature, setSignature] = useState<MethodSigDto>(value ?? newMethodSig())
  const error = signature.returnType.kind === 'empty' ? 'A return type is required' : undefined
  return (
    <OptionsShell
      title="Create MethodSig"
      hideTabStrip
      className="type-sig-shell"
      tabs={[{ label: 'Create MethodSig', content: <MethodSigEditor workspaceId={workspaceId} value={signature} onChange={setSignature} canHaveSentinel options={{ canAddGenericTypeVar: true, canAddGenericMethodVar: true }} /> }]}
      invalid={error !== undefined || !isMethodSigComplete(signature)}
      error={error === undefined ? undefined : t(error)}
      onAccept={() => onAccept(signature)}
      onClose={onClose}
    />
  )
}

/** How a MemberRef reads: dnlib's FullName — `Type Class::Name(Parameters)`, or `Type Class::Name` for a field. */
export const memberRefDisplay = (reference: Pick<MemberRefDto, 'isField' | 'class' | 'name' | 'methodSignature' | 'fieldType'>): string => {
  const owner = reference.class?.display || 'null'
  if (reference.isField)
    return `${reference.fieldType ? describeTypeSig(reference.fieldType) : 'null'} ${owner}::${reference.name}`
  const signature = reference.methodSignature
  if (!signature)
    return `null ${owner}::${reference.name}`
  return `${describeTypeSig(signature.returnType)} ${owner}::${reference.name}(${signature.parameters.map((parameter) => describeTypeSig(parameter)).join(',')})`
}

interface MemberRefDialogProps {
  workspaceId: string
  isField: boolean
  /** The reference to start from — dnSpy seeds the dialog with the operand when it is one. */
  value?: MemberRefDto | null
  /** The roots of the assembly the instruction is in: the MethodDef and ModuleRef classes come from there. */
  assemblyRootIds?: string[]
  onAccept(value: MemberRefDto): void
  onClose(): void
}

type MemberRefPick = 'init' | 'type' | 'methodDef' | 'moduleRef'

/**
 * dnSpy's MemberRefDlg: the name (or a member to take everything from), the class — a type, a TypeSpec, a method
 * of the module or a module of the assembly — the field's type or the method's signature, and custom attributes.
 * OK waits for a class and a signature.
 */
export const MemberRefDialog = ({ workspaceId, isField, value, assemblyRootIds, onAccept, onClose }: MemberRefDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [name, setName] = useState(value?.name ?? '')
  const [owner, setOwner] = useState<MemberRefParentDto | null>(value?.class ?? null)
  const [fieldType, setFieldType] = useState<TypeSigDto | null>(value?.fieldType ?? null)
  const [signature, setSignature] = useState<MethodSigDto>(value?.methodSignature ?? newMethodSig())
  const [attributes, setAttributes] = useState<CustomAttributeDraft[]>((value?.customAttributes ?? []).map(customAttributeDraft))
  const [pick, setPick] = useState<MemberRefPick>()
  const [typeSpec, setTypeSpec] = useState(false)
  const [failure, setFailure] = useState<string>()

  const invalid = owner === null || (isField ? !isTypeSigComplete(fieldType) : !isMethodSigComplete(signature))

  const accept = (): void => {
    if (invalid)
      return
    const reference: MemberRefDto = {
      isField,
      class: owner,
      name,
      methodSignature: isField ? null : signature,
      fieldType: isField ? fieldType : null,
      customAttributes: attributes.map(customAttributeDto),
      display: '',
    }
    onAccept({ ...reference, display: memberRefDisplay(reference) })
  }

  /** Initialize from Field / Method: the class, name and signature of the member the picker returns. */
  const initializeFrom = async (node: TreeNode, trail: TreeNode[]): Promise<void> => {
    setPick(undefined)
    const typeNode = [...trail].reverse().find((entry) => entry.kind === 'type')
    if (!typeNode)
      return
    const declaringType: TypeSigDto = { kind: 'type', type: referenceOf(typeNode, trail) }
    try {
      if (isField) {
        const options = await window.dnSpy.getNodeOptions(workspaceId, 'field', { nodeId: node.id })
        if (!options.field?.fieldSig)
          return
        setName(options.field.name)
        setFieldType(options.field.fieldSig)
      }
      else {
        const options = await window.dnSpy.getNodeOptions(workspaceId, 'method', { nodeId: node.id })
        const reference = options.method ? pickedMethodRef(trail, options.method) : undefined
        if (!reference)
          return
        setName(reference.name)
        setSignature(reference.signature)
      }
      setOwner({ kind: 'type', type: declaringType, display: describeTypeSig(declaringType) })
      setAttributes([])
    }
    catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const choose = (node: TreeNode, trail: TreeNode[]): void => {
    const mode = pick
    setPick(undefined)
    if (mode === 'init') {
      void initializeFrom(node, trail)
      return
    }
    if (mode === 'type') {
      const type: TypeSigDto = { kind: 'type', type: referenceOf(node, trail) }
      setOwner({ kind: 'type', type, display: describeTypeSig(type) })
    }
    else if (mode === 'methodDef') {
      setOwner({ kind: 'methodDef', nodeId: node.id, display: node.description ?? node.label })
    }
    else if (mode === 'moduleRef') {
      setOwner({ kind: 'moduleRef', moduleName: node.label, display: node.label })
    }
  }

  const pickerMode: Record<MemberRefPick, PickerMode> = { init: isField ? 'field' : 'method', type: 'type', methodDef: 'method', moduleRef: 'module' }
  const pickerTitle: Record<MemberRefPick, string> = { init: isField ? 'Pick a Field' : 'Pick a Method', type: 'Pick a Type', methodDef: 'Pick a Method', moduleRef: 'Pick a Module' }

  const main = (
    <div className="options-form">
      <label>{t('Name')}<input aria-label={t('Name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" onClick={() => setPick('init')}>{t(isField ? 'Initialize from Field...' : 'Initialize from Method...')}</button>
      {failure && <div className="modal-error">{failure}</div>}
    </div>
  )
  const classTab = (
    <div className="options-form">
      <label>{t('Class')}<input readOnly aria-label={t('Class')} value={owner?.display || 'null'} /></label>
      <div className="options-inline">
        <button type="button" title={t('Initialize Class to a Type')} onClick={() => setPick('type')}>{t('Type')}</button>
        <button type="button" title={t('Initialize Class to a TypeSpec')} onClick={() => setTypeSpec(true)}>{t('TypeSpec')}</button>
        <button type="button" title={t('Initialize Class to a MethodDef')} onClick={() => setPick('methodDef')}>{t('MethodDef')}</button>
        <button type="button" title={t('Initialize Class to a ModuleRef')} onClick={() => setPick('moduleRef')}>{t('ModuleRef')}</button>
      </div>
    </div>
  )
  const tabs: OptionsTab[] = [
    { label: 'Main', content: main },
    { label: 'Class', content: classTab },
    isField
      ? { label: 'FieldSig', content: <TypeSigEditor workspaceId={workspaceId} value={fieldType} onChange={setFieldType} options={{ canAddGenericTypeVar: true, canAddGenericMethodVar: true }} /> }
      : { label: 'MethodSig', content: <MethodSigEditor workspaceId={workspaceId} value={signature} onChange={setSignature} canHaveSentinel options={{ canAddGenericTypeVar: true, canAddGenericMethodVar: true }} /> },
    { label: 'Custom Attrs', content: <CustomAttributeListEditor workspaceId={workspaceId} items={attributes} onChange={setAttributes} /> },
  ]

  return (
    <>
      <OptionsShell
        title={isField ? 'Edit Field MemberRef' : 'Edit Method MemberRef'}
        className="memberref-dialog"
        tabs={tabs}
        invalid={invalid}
        onAccept={accept}
        onClose={onClose}
        onReset={() => {
          setName(value?.name ?? '')
          setOwner(value?.class ?? null)
          setFieldType(value?.fieldType ?? null)
          setSignature(value?.methodSignature ?? newMethodSig())
          setAttributes((value?.customAttributes ?? []).map(customAttributeDraft))
        }}
      />
      {pick && (
        <TypePickerDialog
          workspaceId={workspaceId}
          mode={pickerMode[pick]}
          title={pickerTitle[pick]}
          rootNodeIds={pick === 'methodDef' || pick === 'moduleRef' ? assemblyRootIds : undefined}
          onPick={choose}
          onClose={() => setPick(undefined)}
        />
      )}
      {typeSpec && (
        <TypeSpecDialog
          workspaceId={workspaceId}
          value={owner?.kind === 'typeSpec' ? owner.type ?? null : null}
          onAccept={(type) => { setOwner({ kind: 'typeSpec', type, display: describeTypeSig(type) }); setTypeSpec(false) }}
          onClose={() => setTypeSpec(false)}
        />
      )}
    </>
  )
}

/** The method a MethodSpec instantiates: a definition the tree holds, a reference built from it, or a MemberRef. */
export interface MethodSpecMethod {
  nodeId?: string | null
  token?: string | null
  methodRef?: MethodRefDto | null
  memberRef?: MemberRefDto | null
  display: string
}

export interface MethodSpecValue {
  method: MethodSpecMethod | null
  arguments: TypeSigDto[]
  customAttributes: CustomAttributeDto[]
}

interface MethodSpecDialogProps {
  workspaceId: string
  value: MethodSpecValue
  onAccept(value: MethodSpecValue): void
  onClose(): void
}

/** dnSpy's MethodSpecDlg: the method, its instantiation types and its custom attributes. OK waits for a method. */
export const MethodSpecDialog = ({ workspaceId, value, onAccept, onClose }: MethodSpecDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [method, setMethod] = useState<MethodSpecMethod | null>(value.method)
  const [types, setTypes] = useState<TypeSigDto[]>(value.arguments)
  const [attributes, setAttributes] = useState<CustomAttributeDraft[]>(value.customAttributes.map(customAttributeDraft))
  const [picking, setPicking] = useState(false)

  const pickMethod = async (node: TreeNode, trail: TreeNode[]): Promise<void> => {
    setPicking(false)
    const options = await window.dnSpy.getNodeOptions(workspaceId, 'method', { nodeId: node.id })
    const reference = options.method ? pickedMethodRef(trail, options.method) : undefined
    setMethod({ nodeId: node.id, methodRef: reference, display: reference ? methodRefFullName(reference) : node.description ?? node.label })
  }

  const tabs: OptionsTab[] = [
    {
      label: 'Main',
      content: (
        <div className="options-form">
          <label>
            <button type="button" onClick={() => setPicking(true)}>{t('Method')}</button>
            <input readOnly aria-label={t('Method')} value={method?.display || 'null'} />
          </label>
        </div>
      ),
    },
    {
      label: 'Method Instantiation Types',
      content: <TypeSigListEditor workspaceId={workspaceId} values={types} onChange={setTypes} options={{ canAddGenericTypeVar: true, canAddGenericMethodVar: true }} />,
    },
    { label: 'Custom Attrs', content: <CustomAttributeListEditor workspaceId={workspaceId} items={attributes} onChange={setAttributes} /> },
  ]

  return (
    <>
      <OptionsShell
        title="Edit MethodSpec"
        className="methodspec-dialog"
        tabs={tabs}
        invalid={method === null}
        onAccept={() => { if (method) onAccept({ method, arguments: types, customAttributes: attributes.map(customAttributeDto) }) }}
        onClose={onClose}
        onReset={() => { setMethod(value.method); setTypes(value.arguments); setAttributes(value.customAttributes.map(customAttributeDraft)) }}
      />
      {picking && <TypePickerDialog workspaceId={workspaceId} mode="method" title="Pick a Method" onPick={(node, trail) => { void pickMethod(node, trail) }} onClose={() => setPicking(false)} />}
    </>
  )
}

/** The text of a method signature for an operand cell — dnSpy's MethodSig full name. */
export const methodSigDisplay = (signature: MethodSigDto, notSet: string): string => describeMethodSig(signature, notSet)
