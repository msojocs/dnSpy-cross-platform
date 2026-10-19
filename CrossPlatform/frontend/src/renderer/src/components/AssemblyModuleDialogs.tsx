import { useEffect, useState } from 'react'
import type { AssemblyOptions, ModuleOptions, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { OptionsShell, type OptionsTab } from './OptionsShell'
import { CustomAttributeListEditor } from './widgets/CustomAttributeListEditor'
import { DeclSecurityListEditor } from './widgets/DeclSecurityListEditor'
import { customAttributeDraft, customAttributeDto, type CustomAttributeDraft } from './widgets/custom-attribute'
import { declSecurityDraft, declSecurityDto, type DeclSecurityDraft } from './widgets/decl-security'

/** dnlib's AssemblyHashAlgorithm, in the order dnSpy's combo box shows it. */
const HASH_ALGORITHMS = [
  { value: 0, label: 'None' },
  { value: 0x8001, label: 'MD2' },
  { value: 0x8002, label: 'MD4' },
  { value: 0x8003, label: 'MD5' },
  { value: 0x8004, label: 'SHA1' },
  { value: 0x8005, label: 'MAC' },
  { value: 0x8008, label: 'SSL3-SHAMD5' },
  { value: 0x8009, label: 'HMAC' },
  { value: 0x800A, label: 'TLS1PRF' },
  { value: 0x800B, label: 'HASH-REPLACE-OWF' },
  { value: 0x800C, label: 'SHA-256' },
  { value: 0x800D, label: 'SHA-384' },
  { value: 0x800E, label: 'SHA-512' },
] as const

/** dnlib's AssemblyAttributes.PA_Mask values, which the Processor Architecture combo offers. */
const PROCESSOR_ARCHITECTURES = [
  { value: 0x00, label: 'MSIL' },
  { value: 0x10, label: 'x86' },
  { value: 0x20, label: 'IA64' },
  { value: 0x30, label: 'AMD64' },
  { value: 0x40, label: 'ARM' },
  { value: 0x50, label: 'ARM64' },
  { value: 0x60, label: 'No Platform' },
] as const

const CONTENT_TYPES = [
  { value: 0x000, label: 'Default' },
  { value: 0x200, label: 'Windows Runtime' },
] as const

const ASSEMBLY_FLAGS = [
  { value: 0x0001, label: 'Public Key' },
  { value: 0x0080, label: 'Processor Architecture Specified' },
  { value: 0x0100, label: 'Retargetable' },
  { value: 0x4000, label: 'Disable JIT Compile Optimizer' },
  { value: 0x8000, label: 'Enable JIT Compile Tracking' },
] as const

const MODULE_KINDS = [
  { value: 0, label: 'Console' },
  { value: 1, label: 'Windows' },
  { value: 2, label: 'Dll' },
  { value: 3, label: 'NetModule' },
] as const

/** dnlib's PE.Machine, the values a .NET image is written with. */
const MACHINES = [
  { value: 0x0000, label: 'Unknown' },
  { value: 0x014C, label: 'I386' },
  { value: 0x0162, label: 'R3000' },
  { value: 0x0166, label: 'R4000' },
  { value: 0x0168, label: 'R10000' },
  { value: 0x0169, label: 'WCEMIPSV2' },
  { value: 0x0184, label: 'ALPHA' },
  { value: 0x01A2, label: 'SH3' },
  { value: 0x01A3, label: 'SH3DSP' },
  { value: 0x01A4, label: 'SH3E' },
  { value: 0x01A6, label: 'SH4' },
  { value: 0x01A8, label: 'SH5' },
  { value: 0x01C0, label: 'ARM' },
  { value: 0x01C2, label: 'THUMB' },
  { value: 0x01C4, label: 'ARMNT' },
  { value: 0x01D3, label: 'AM33' },
  { value: 0x01F0, label: 'POWERPC' },
  { value: 0x01F1, label: 'POWERPCFP' },
  { value: 0x0200, label: 'IA64' },
  { value: 0x0266, label: 'MIPS16' },
  { value: 0x0284, label: 'ALPHA64' },
  { value: 0x0366, label: 'MIPSFPU' },
  { value: 0x0466, label: 'MIPSFPU16' },
  { value: 0x0520, label: 'TRICORE' },
  { value: 0x0CEF, label: 'CEF' },
  { value: 0x0EBC, label: 'EBC' },
  { value: 0x8664, label: 'AMD64' },
  { value: 0x9041, label: 'M32R' },
  { value: 0xAA64, label: 'ARM64' },
  { value: 0xC0EE, label: 'CEE' },
] as const

/** dnlib's PE.Characteristics, the sixteen COFF header bits dnSpy's PE tab has a box for. */
const CHARACTERISTICS = [
  { value: 0x0001, label: 'Relocs Stripped' },
  { value: 0x0002, label: 'Executable Image' },
  { value: 0x0004, label: 'Line Nums Stripped' },
  { value: 0x0008, label: 'Local Syms Stripped' },
  { value: 0x0010, label: 'Aggressive WS Trim' },
  { value: 0x0020, label: 'Large Address Aware' },
  { value: 0x0040, label: 'Reserved 0040h' },
  { value: 0x0080, label: 'Bytes Reversed Lo' },
  { value: 0x0100, label: '32-Bit Machine' },
  { value: 0x0200, label: 'Debug Stripped' },
  { value: 0x0400, label: 'Removable Run From Swap' },
  { value: 0x0800, label: 'Net Run From Swap' },
  { value: 0x1000, label: 'System' },
  { value: 0x2000, label: 'Dll' },
  { value: 0x4000, label: 'Up System Only' },
  { value: 0x8000, label: 'Bytes Reversed Hi' },
] as const

/** dnlib's PE.DllCharacteristics. */
const DLL_CHARACTERISTICS = [
  { value: 0x0001, label: 'Reserved1' },
  { value: 0x0002, label: 'Reserved2' },
  { value: 0x0004, label: 'Reserved3' },
  { value: 0x0008, label: 'Reserved4' },
  { value: 0x0010, label: 'Reserved5' },
  { value: 0x0020, label: 'High Entropy VA' },
  { value: 0x0040, label: 'Dynamic Base' },
  { value: 0x0080, label: 'Force Integrity' },
  { value: 0x0100, label: 'NX Compat' },
  { value: 0x0200, label: 'No Isolation' },
  { value: 0x0400, label: 'No SEH' },
  { value: 0x0800, label: 'No Bind' },
  { value: 0x1000, label: 'App Container' },
  { value: 0x2000, label: 'WDM Driver' },
  { value: 0x4000, label: 'Guard CF' },
  { value: 0x8000, label: 'Terminal Server Aware' },
] as const

/** dnlib's MD.ComImageFlags, the Cor20 header's flags word. */
const COR20_FLAGS = [
  { value: 0x00000001, label: 'ILOnly' },
  { value: 0x00000004, label: 'ILLibrary' },
  { value: 0x00000002, label: '32BitRequired' },
  { value: 0x00020000, label: '32BitPreferred' },
  { value: 0x00010000, label: 'TrackDebugData' },
  { value: 0x00000008, label: 'StrongNameSigned' },
] as const

const has = (flags: number, bit: number): boolean => (flags & bit) === bit
const withFlag = (flags: number, bit: number, on: boolean): number => on ? flags | bit : flags & ~bit

const FlagBoxes = <T extends number>({ flags, entries, onChange, legend }: { flags: number; entries: readonly { value: T, label: string }[]; onChange(flags: number): void; legend?: string }): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <fieldset className="il-flags">
      {legend && <legend>{t(legend)}</legend>}
      {entries.map((entry) => (
        <label key={entry.value}>
          <input type="checkbox" checked={has(flags, entry.value)} onChange={(event) => onChange(withFlag(flags, entry.value, event.target.checked))} />
          {t(entry.label)}
        </label>
      ))}
    </fieldset>
  )
}

const NumberBox = ({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }): React.JSX.Element => {
  const { t } = useLanguage()
  return <label>{t(label)}<input aria-label={t(label)} type="number" min={0} max={65535} value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} /></label>
}

interface AssemblyOptionsDialogProps {
  /** The assembly to edit; Create Assembly has none. */
  node?: TreeNode
  /** dnSpy's Create Assembly: the same window, titled for it, starting from AssemblyOptions.Create("MyAssembly")
   *  and with the .NET Version box the edit window hides. */
  create?: boolean
  onClose(): void
}

/** The .NET versions Create Assembly and Create NetModule offer — dnSpy's NetModuleOptionsVM.clrVersionList. */
export const CLR_VERSIONS = [
  { value: '1.0', label: '1.0' },
  { value: '1.1', label: '1.1' },
  { value: '2.0', label: '2.0 - 3.5' },
  { value: '4.0', label: '4.0 - 4.8' },
] as const

/** dnSpy's AssemblyOptions.Create: a name, version 0.0.0.0, SHA1 and nothing else. */
export const newAssemblyOptions = (name: string): AssemblyOptions => ({
  name,
  culture: '',
  hashAlgorithm: 0x8004,
  attributes: 0,
  publicKey: '',
  versionMajor: 0,
  versionMinor: 0,
  versionBuild: 0,
  versionRevision: 0,
  customAttributes: [],
  declSecurities: [],
  fullName: '',
})

/** dnlib's AssemblyDef.FullName for options that have not been near an assembly yet. */
const assemblyFullName = (options: AssemblyOptions): string => {
  const token = options.publicKey.trim() ? 'PublicKeyToken=<key>' : 'PublicKeyToken=null'
  return `${options.name}, Version=${options.versionMajor}.${options.versionMinor}.${options.versionBuild}.${options.versionRevision}, Culture=${options.culture || 'neutral'}, ${token}`
}

/** dnSpy's `AssemblyOptionsDlg`: Main, Custom Attributes and Security Declarations. */
export const AssemblyOptionsDialog = ({ node, create = false, onClose }: AssemblyOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const applyAssemblyOptions = useAppStore((state) => state.applyAssemblyOptions)
  const createAssembly = useAppStore((state) => state.createAssembly)
  const [options, setOptions] = useState<AssemblyOptions | undefined>(() => create ? newAssemblyOptions('MyAssembly') : undefined)
  const [initial, setInitial] = useState<AssemblyOptions | undefined>(() => create ? newAssemblyOptions('MyAssembly') : undefined)
  const [clrVersion, setClrVersion] = useState<string>('4.0')
  const [customAttributes, setCustomAttributes] = useState<CustomAttributeDraft[]>([])
  const [declSecurities, setDeclSecurities] = useState<DeclSecurityDraft[]>([])
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId || create || !node)
      return
    let cancelled = false
    void window.dnSpy.getAssemblyOptions(workspaceId, node.id)
      .then((loaded) => {
        if (cancelled)
          return
        setOptions(loaded)
        setInitial(loaded)
        setCustomAttributes(loaded.customAttributes.map(customAttributeDraft))
        setDeclSecurities(loaded.declSecurities.map(declSecurityDraft))
      })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, node, create])

  const title = create ? 'Create Assembly' : 'Edit Assembly'
  if (!options || !workspaceId) {
    return (
      <OptionsShell
        title={title}
        hideTabStrip
        tabs={[{ label: 'Main', content: <div className={failure ? 'modal-error' : 'il-loading'}>{failure ?? t('Loading...')}</div> }]}
        invalid={failure !== undefined}
        error={failure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }

  const patch = (next: Partial<AssemblyOptions>): void => setOptions((current) => current ? { ...current, ...next } : current)
  const processor = options.attributes & 0x70
  const contentType = options.attributes & 0xE00
  const main = (
    <div className="options-form">
      <div className="options-row">
        <label>{t('Name')}<input aria-label={t('Name')} value={options.name} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>{t('Culture')}<input aria-label={t('Culture')} value={options.culture ?? ''} onChange={(event) => patch({ culture: event.target.value })} /></label>
      </div>
      <label>{t('Public Key')}<span className="options-inline">
        <input aria-label={t('Public Key')} value={options.publicKey} onChange={(event) => patch({ publicKey: event.target.value })} />
        <input type="file" aria-label={t('Open Public Key File')} onChange={(event) => {
          const file = event.target.files?.[0]
          if (file)
            void file.arrayBuffer().then((data) => patch({ publicKey: Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, '0')).join('') }))
        }} />
      </span></label>
      <div className="options-row">
        <label>{t('Hash Algorithm')}
          <select aria-label={t('Hash Algorithm')} value={options.hashAlgorithm} onChange={(event) => patch({ hashAlgorithm: Number(event.target.value) })}>
            {HASH_ALGORITHMS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label>{t('Processor Architecture')}
          <select aria-label={t('Processor Architecture')} value={processor} onChange={(event) => patch({ attributes: (options.attributes & ~0x70) | Number(event.target.value) })}>
            {PROCESSOR_ARCHITECTURES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label>{t('Content Type')}
          <select aria-label={t('Content Type')} value={contentType} onChange={(event) => patch({ attributes: (options.attributes & ~0xE00) | Number(event.target.value) })}>
            {CONTENT_TYPES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
      </div>
      <div className="options-row">
        <NumberBox label="Version Major" value={options.versionMajor} onChange={(versionMajor) => patch({ versionMajor })} />
        <NumberBox label="Version Minor" value={options.versionMinor} onChange={(versionMinor) => patch({ versionMinor })} />
        <NumberBox label="Version Build" value={options.versionBuild} onChange={(versionBuild) => patch({ versionBuild })} />
        <NumberBox label="Version Revision" value={options.versionRevision} onChange={(versionRevision) => patch({ versionRevision })} />
      </div>
      {create && (
        <label>{t('.NET Version')}
          <select aria-label={t('.NET Version')} value={clrVersion} onChange={(event) => setClrVersion(event.target.value)}>
            {CLR_VERSIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
      )}
      <FlagBoxes flags={options.attributes} entries={ASSEMBLY_FLAGS} onChange={(attributes) => patch({ attributes })} legend="Flags" />
      <label>{t('Full Name')}<input readOnly aria-label={t('Full Name')} value={create ? assemblyFullName(options) : options.fullName} /></label>
    </div>
  )
  const tabs: OptionsTab[] = [
    { label: 'Main', content: main },
    { label: 'Custom Attributes', content: <CustomAttributeListEditor workspaceId={workspaceId} items={customAttributes} onChange={setCustomAttributes} /> },
    { label: 'Security Declarations', content: <DeclSecurityListEditor workspaceId={workspaceId} items={declSecurities} onChange={setDeclSecurities} /> },
  ]
  return (
    <OptionsShell
      title={title}
      className="options-dialog"
      tabs={tabs}
      invalid={!options.name.trim()}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        let written: AssemblyOptions
        try {
          written = { ...options, customAttributes: customAttributes.map(customAttributeDto), declSecurities: declSecurities.map(declSecurityDto) }
        }
        catch (reason) {
          setBusy(false)
          setFailure(reason instanceof Error ? reason.message : String(reason))
          return
        }
        const done = create || !node ? createAssembly(written, clrVersion) : applyAssemblyOptions(node, written)
        void done.then((applied) => { setBusy(false); if (applied) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => {
        if (initial) {
          setOptions(initial)
          setClrVersion('4.0')
          setCustomAttributes(initial.customAttributes.map(customAttributeDraft))
          setDeclSecurities(initial.declSecurities.map(declSecurityDraft))
        }
      }}
    />
  )
}

interface ModuleOptionsDialogProps {
  node: TreeNode
  onClose(): void
}

/** dnSpy's `ModuleOptionsDlg`: Main, Metadata, Cor20, PE and Custom Attributes. */
export const ModuleOptionsDialog = ({ node, onClose }: ModuleOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const applyModuleOptions = useAppStore((state) => state.applyModuleOptions)
  const [options, setOptions] = useState<ModuleOptions>()
  const [initial, setInitial] = useState<ModuleOptions>()
  const [customAttributes, setCustomAttributes] = useState<CustomAttributeDraft[]>([])
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    void window.dnSpy.getModuleOptions(workspaceId, node.id)
      .then((loaded) => { if (cancelled) return; setOptions(loaded); setInitial(loaded); setCustomAttributes(loaded.customAttributes.map(customAttributeDraft)) })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, node.id])

  if (!options || !workspaceId) {
    return (
      <OptionsShell
        title="Edit Module"
        hideTabStrip
        tabs={[{ label: 'Main', content: <div className={failure ? 'modal-error' : 'il-loading'}>{failure ?? t('Loading...')}</div> }]}
        invalid={failure !== undefined}
        error={failure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }

  const patch = (next: Partial<ModuleOptions>): void => setOptions((current) => current ? { ...current, ...next } : current)
  const main = (
    <div className="options-form">
      <div className="options-row">
        <label>{t('Name')}<input aria-label={t('Name')} value={options.name} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>{t('Module Type')}
          <select aria-label={t('Module Type')} value={options.kind} onChange={(event) => patch({ kind: Number(event.target.value) })}>
            {MODULE_KINDS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
      </div>
      <label>{t('Mvid')}<input aria-label={t('Mvid')} value={options.mvid} onChange={(event) => patch({ mvid: event.target.value })} /></label>
      <label>{t('EncId')}<input aria-label={t('EncId')} value={options.encId} onChange={(event) => patch({ encId: event.target.value })} /></label>
      <label>{t('EncBaseId')}<input aria-label={t('EncBaseId')} value={options.encBaseId} onChange={(event) => patch({ encBaseId: event.target.value })} /></label>
      <label>{t('Managed Entry Point')}<input aria-label={t('Managed Entry Point')} placeholder="0x06000001" value={options.managedEntryPoint ?? ''} onChange={(event) => patch({ managedEntryPoint: event.target.value })} /></label>
      <label>{t('Native Entry Point')}<input aria-label={t('Native Entry Point')} type="number" min={0} value={options.nativeEntryPoint} onChange={(event) => patch({ nativeEntryPoint: Number(event.target.value) || 0 })} /></label>
    </div>
  )
  const metadata = (
    <div className="options-form">
      <label>{t('Version String')}<input aria-label={t('Version String')} value={options.runtimeVersion ?? ''} onChange={(event) => patch({ runtimeVersion: event.target.value })} /></label>
      <NumberBox label="Header Version" value={options.tablesHeaderVersion} onChange={(tablesHeaderVersion) => patch({ tablesHeaderVersion })} />
    </div>
  )
  const cor20 = (
    <div className="options-form">
      <label>{t('Runtime Version')}<input aria-label={t('Runtime Version')} value={options.cor20HeaderRuntimeVersion ?? ''} onChange={(event) => patch({ cor20HeaderRuntimeVersion: event.target.value })} /></label>
      <FlagBoxes flags={options.cor20HeaderFlags} entries={COR20_FLAGS} onChange={(cor20HeaderFlags) => patch({ cor20HeaderFlags })} />
    </div>
  )
  const pe = (
    <div className="options-form">
      <label>{t('Machine')}
        <select aria-label={t('Machine')} value={options.machine} onChange={(event) => patch({ machine: Number(event.target.value) })}>
          {MACHINES.map((entry) => <option key={entry.label} value={entry.value}>{entry.label}</option>)}
        </select>
      </label>
      <FlagBoxes flags={options.characteristics} entries={CHARACTERISTICS} onChange={(characteristics) => patch({ characteristics })} legend="Characteristics" />
      <FlagBoxes flags={options.dllCharacteristics} entries={DLL_CHARACTERISTICS} onChange={(dllCharacteristics) => patch({ dllCharacteristics })} legend="DLL Characteristics" />
    </div>
  )
  const tabs: OptionsTab[] = [
    { label: 'Main', content: main },
    { label: 'Metadata', content: metadata },
    { label: 'Cor20', content: cor20 },
    { label: 'PE', content: pe },
    { label: 'Custom Attributes', content: <CustomAttributeListEditor workspaceId={workspaceId} items={customAttributes} onChange={setCustomAttributes} /> },
  ]
  return (
    <OptionsShell
      title="Edit Module"
      className="options-dialog"
      tabs={tabs}
      invalid={!options.name.trim()}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        let written: ModuleOptions
        try {
          written = { ...options, customAttributes: customAttributes.map(customAttributeDto) }
        }
        catch (reason) {
          setBusy(false)
          setFailure(reason instanceof Error ? reason.message : String(reason))
          return
        }
        void applyModuleOptions(node, written).then((applied) => { setBusy(false); if (applied) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => {
        if (initial) {
          setOptions(initial)
          setCustomAttributes(initial.customAttributes.map(customAttributeDraft))
        }
      }}
    />
  )
}
