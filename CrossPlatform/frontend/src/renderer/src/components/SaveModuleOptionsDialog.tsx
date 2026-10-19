import { useEffect, useState } from 'react'
import type { DocumentSaveOptions, WriterOptions } from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { OptionsShell, type OptionsTab } from './OptionsShell'
import { formatNumberText, numberErrorTemplate, parseNumberText } from './widgets/number-text'

/** dnlib's ModuleKind, in the order dnSpy's EnumVM lists it: by name. */
export const MODULE_KINDS = [
  { value: 0, name: 'Console' },
  { value: 2, name: 'Dll' },
  { value: 3, name: 'NetModule' },
  { value: 1, name: 'Windows' },
] as const

/** dnlib's Machine, the way SaveModuleOptionsVM lists it: the five common ones first, then the rest by name. */
const MACHINES: readonly (readonly [number, string])[] = (() => {
  const all: [number, string][] = [
    [0x0, 'Unknown'], [0x14C, 'I386'], [0x162, 'R3000'], [0x166, 'R4000'], [0x168, 'R10000'], [0x169, 'WCEMIPSV2'],
    [0x184, 'ALPHA'], [0x1A2, 'SH3'], [0x1A3, 'SH3DSP'], [0x1A4, 'SH3E'], [0x1A6, 'SH4'], [0x1A8, 'SH5'], [0x1C0, 'ARM'],
    [0x1C2, 'THUMB'], [0x1C4, 'ARMNT'], [0x1D3, 'AM33'], [0x1F0, 'POWERPC'], [0x1F1, 'POWERPCFP'], [0x200, 'IA64'],
    [0x266, 'MIPS16'], [0x284, 'ALPHA64'], [0x366, 'MIPSFPU'], [0x466, 'MIPSFPU16'], [0x520, 'TRICORE'],
    [0x7A0, 'ARM64_Native_FreeBSD'], [0xCEF, 'CEF'], [0xEBC, 'EBC'], [0x1856, 'ARMNT_Native_Sun'], [0x1857, 'ARMNT_Native_NetBSD'],
    [0x18DE, 'I386_Native_Sun'], [0x18DF, 'I386_Native_NetBSD'], [0x1992, 'S390X_Native_Sun'], [0x1993, 'S390X_Native_NetBSD'],
    [0x2BA0, 'AMD64_Native_FreeBSD'], [0x4644, 'S390X_Native_Apple'], [0x4708, 'I386_Native_Apple'], [0x4780, 'ARMNT_Native_Apple'],
    [0x7A35, 'I386_Native_Linux'], [0x7ABD, 'ARMNT_Native_Linux'], [0x7B79, 'S390X_Native_Linux'], [0x8664, 'AMD64'],
    [0x9041, 'M32R'], [0x9FF6, 'AMD64_Native_Sun'], [0x9FF7, 'AMD64_Native_NetBSD'], [0xAA64, 'ARM64'], [0xAC00, 'ARMNT_Native_FreeBSD'],
    [0xAC88, 'I386_Native_FreeBSD'], [0xADC4, 'S390X_Native_FreeBSD'], [0xB3F6, 'ARM64_Native_Sun'], [0xB3F7, 'ARM64_Native_NetBSD'],
    [0xC020, 'AMD64_Native_Apple'], [0xC0EE, 'CEE'], [0xD11D, 'ARM64_Native_Linux'], [0xEC20, 'ARM64_Native_Apple'], [0xFD1D, 'AMD64_Native_Linux'],
  ]
  const first = [0x14C, 0x8664, 0x200, 0x1C4, 0xAA64]
  return [
    ...first.map((value) => all.find((entry) => entry[0] === value)!),
    ...all.filter((entry) => !first.includes(entry[0])).sort((left, right) => left[1].localeCompare(right[1])),
  ]
})()

/** dnlib's Machine.Is64Bit: the 64-bit machines and their native-OS variants. */
const is64BitMachine = (machine: number): boolean => {
  const name = MACHINES.find((entry) => entry[0] === machine)?.[1] ?? ''
  return name === 'IA64' || /^(AMD64|ARM64|S390X)/.test(name)
}

/** dnlib's Subsystem, WindowsGui and WindowsCui first and then the rest by name. */
const SUBSYSTEMS: readonly (readonly [number, string])[] = [
  [2, 'WindowsGui'], [3, 'WindowsCui'],
  ...([[10, 'EfiApplication'], [11, 'EfiBootServiceDriver'], [13, 'EfiRom'], [12, 'EfiRuntimeDriver'], [1, 'Native'], [8, 'NativeWindows'],
    [5, 'Os2Cui'], [7, 'PosixCui'], [0, 'Unknown'], [16, 'WindowsBootApplication'], [9, 'WindowsCeGui'], [14, 'Xbox']] as [number, string][]),
]

const CHARACTERISTICS: readonly (readonly [number, string])[] = [
  [0x1, 'Relocs Stripped'], [0x2, 'Executable Image'], [0x4, 'Line Nums Stripped'], [0x8, 'Local Syms Stripped'],
  [0x10, 'Aggressive WS Trim'], [0x20, 'Large Address Aware'], [0x40, 'Reserved 0040h'], [0x80, 'Bytes Reversed Lo'],
  [0x100, '32-Bit Machine'], [0x200, 'Debug Stripped'], [0x400, 'Removable Run From Swap'], [0x800, 'Net Run From Swap'],
  [0x1000, 'System'], [0x2000, 'Dll'], [0x4000, 'Up System Only'], [0x8000, 'Bytes Reversed Hi'],
]

const DLL_CHARACTERISTICS: readonly (readonly [number, string])[] = [
  [0x1, 'Reserved1'], [0x2, 'Reserved2'], [0x4, 'Reserved3'], [0x8, 'Reserved4'], [0x10, 'Reserved5'], [0x20, 'High Entropy VA'],
  [0x40, 'Dynamic Base'], [0x80, 'Force Integrity'], [0x100, 'NX Compat'], [0x200, 'No Isolation'], [0x400, 'No SEH'],
  [0x800, 'No Bind'], [0x1000, 'AppContainer'], [0x2000, 'WDM Driver'], [0x4000, 'Guard CF'], [0x8000, 'Terminal Server Aware'],
]

const COR20_FLAGS: readonly (readonly [number, string])[] = [
  [0x1, 'ILOnly'], [0x4, 'ILLibrary'], [0x2, '32BitRequired'], [0x20000, '32BitPreferred'], [0x10000, 'TrackDebugData'], [0x8, 'StrongNameSigned'],
]

/** dnlib's MetadataFlags the MD Writer Options page sets, by the check box that sets it. */
const PRESERVE_RIDS: readonly (readonly [number, string])[] = [
  [0x1, 'TypeRef'], [0x2, 'TypeDef'], [0x4, 'Field'], [0x8, 'Method'], [0x10, 'Param'], [0x20, 'MemberRef'],
  [0x40, 'StandAloneSig'], [0x80, 'Event'], [0x100, 'Property'], [0x200, 'TypeSpec'], [0x400, 'MethodSpec'],
]
const PRESERVE_ALL_RIDS = 0x7FF
const PRESERVE_HEAPS: readonly (readonly [number, string])[] = [[0x800, '#Strings'], [0x1000, '#US'], [0x2000, '#Blob']]
const CREATE_HEAPS: readonly (readonly [number, string])[] = [[0x20000, '#Strings'], [0x40000, '#US'], [0x80000, '#Blob'], [0x10000, '#GUID']]
const PRESERVE_EXTRA_SIGNATURE_DATA = 0x4000
const KEEP_OLD_MAX_STACK = 0x8000

/** A nullable number box of the window, and the largest value it holds. */
type NumberField = keyof Pick<WriterOptions,
  'metadataSignature' | 'metadataMajorVersion' | 'metadataMinorVersion' | 'metadataReserved1' | 'metadataStorageFlags' | 'metadataReserved2'
  | 'tablesReserved1' | 'tablesMajorVersion' | 'tablesMinorVersion' | 'tablesExtraData' | 'tablesLog2Rid'
  | 'cor20MajorRuntimeVersion' | 'cor20MinorRuntimeVersion' | 'cor20EntryPoint'
  | 'timeDateStamp' | 'pointerToSymbolTable' | 'numberOfSymbols' | 'majorLinkerVersion' | 'minorLinkerVersion' | 'imageBase'
  | 'sectionAlignment' | 'fileAlignment' | 'majorOperatingSystemVersion' | 'minorOperatingSystemVersion' | 'majorImageVersion'
  | 'minorImageVersion' | 'majorSubsystemVersion' | 'minorSubsystemVersion' | 'win32VersionValue' | 'sizeOfStackReserve'
  | 'sizeOfStackCommit' | 'sizeOfHeapReserve' | 'sizeOfHeapCommit' | 'loaderFlags' | 'numberOfRvaAndSizes'>

const BYTE = 0xFF
const UINT16 = 0xFFFF
const UINT32 = 0xFFFFFFFF
const UINT64 = Number.MAX_SAFE_INTEGER

const NUMBER_FIELDS: Record<NumberField, number> = {
  metadataSignature: UINT32, metadataMajorVersion: UINT16, metadataMinorVersion: UINT16, metadataReserved1: UINT32, metadataStorageFlags: BYTE, metadataReserved2: BYTE,
  tablesReserved1: UINT32, tablesMajorVersion: BYTE, tablesMinorVersion: BYTE, tablesExtraData: UINT32, tablesLog2Rid: BYTE,
  cor20MajorRuntimeVersion: UINT16, cor20MinorRuntimeVersion: UINT16, cor20EntryPoint: UINT32,
  timeDateStamp: UINT32, pointerToSymbolTable: UINT32, numberOfSymbols: UINT32, majorLinkerVersion: BYTE, minorLinkerVersion: BYTE, imageBase: UINT64,
  sectionAlignment: UINT32, fileAlignment: UINT32, majorOperatingSystemVersion: UINT16, minorOperatingSystemVersion: UINT16, majorImageVersion: UINT16,
  minorImageVersion: UINT16, majorSubsystemVersion: UINT16, minorSubsystemVersion: UINT16, win32VersionValue: UINT32, sizeOfStackReserve: UINT64,
  sizeOfStackCommit: UINT64, sizeOfHeapReserve: UINT64, sizeOfHeapCommit: UINT64, loaderFlags: UINT32, numberOfRvaAndSizes: UINT32,
}

/** The text each nullable box starts with: dnSpy's SimpleTypeConverter, an empty box for a value that is not there. */
const textsOf = (writer: WriterOptions | null): Record<NumberField, string> =>
  Object.fromEntries((Object.keys(NUMBER_FIELDS) as NumberField[]).map((field) => {
    const value = writer?.[field]
    return [field, value === null || value === undefined ? '' : formatNumberText(value)]
  })) as Record<NumberField, string>

/** Why a nullable box cannot be read, or undefined when it can — an empty box can always be read. */
const fieldError = (text: string, max: number): string | undefined => {
  const parsed = parseNumberText(text, max)
  return parsed.error === undefined ? undefined : numberErrorTemplate(parsed.error)
}

/** dnSpy's MetadataHeaderOptionsVM.ValidateVersionString: 256 bytes of UTF-8 with the terminating zero. */
const versionStringTooLong = (text: string | null): boolean => new TextEncoder().encode(`${text ?? ''}\0`).length > 256

/** The extension the file picker suggests for a module kind: dnSpy's SaveModuleOptionsVM.Extension. */
export const extensionOf = (moduleKind: number): string => moduleKind === 2 ? 'dll' : moduleKind === 3 ? 'netmodule' : 'exe'

interface SaveModuleOptionsDialogProps {
  workspaceId: string
  options: DocumentSaveOptions
  onAccept(options: DocumentSaveOptions): void
  onClose(): void
}

/**
 * dnSpy's SaveModuleOptionsDlg — Main, MD Writer Options, Metadata, Cor20 and PE — or, for a document saved as
 * bytes, its SaveHexOptionsDlg with the file name alone. Every number is one of dnSpy's nullable boxes: empty
 * means the writer keeps what it would use, and a flags group whose value is not there shows every box of it
 * undecided until one of them is clicked.
 */
export const SaveModuleOptionsDialog = ({ workspaceId, options, onAccept, onClose }: SaveModuleOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [fileName, setFileName] = useState(options.fileName)
  const [writer, setWriter] = useState<WriterOptions | null>(options.writer)
  const [texts, setTexts] = useState(() => textsOf(options.writer))
  const [mixedModeOptions, setMixedModeOptions] = useState(options)
  const [fileNameError, setFileNameError] = useState<string>()

  useEffect(() => {
    let current = true
    void window.dnSpy.validateSaveFileName(fileName).then((error) => {
      if (current)
        setFileNameError(error ? t(error.template, error.folder === undefined ? undefined : { folder: error.folder }) : undefined)
    })
    return () => { current = false }
  }, [fileName, t])

  const patch = (next: Partial<WriterOptions>): void => setWriter((value) => value ? { ...value, ...next } : value)
  const numberError = (field: NumberField): string | undefined => fieldError(texts[field], NUMBER_FIELDS[field])
  const numbersInvalid = (Object.keys(NUMBER_FIELDS) as NumberField[]).some((field) => numberError(field) !== undefined)
  const invalid = fileNameError !== undefined || (writer !== null && (numbersInvalid || versionStringTooLong(writer.metadataVersionString)))

  const accept = (): void => {
    if (invalid)
      return
    const values = writer === null ? null : {
      ...writer,
      ...Object.fromEntries((Object.keys(NUMBER_FIELDS) as NumberField[]).map((field) => [field, parseNumberText(texts[field], NUMBER_FIELDS[field]).value ?? null])),
    } as WriterOptions
    onAccept({ ...mixedModeOptions, fileName, writer: values })
  }

  /** dnSpy's Reset: every option read from the module again for the writer it is on now; the file name stays. */
  const reset = async (): Promise<void> => {
    const next = await window.dnSpy.getSaveOptions(workspaceId, options.documentId, writer?.useMixedMode)
    setMixedModeOptions(next)
    setWriter(next.writer)
    setTexts(textsOf(next.writer))
  }

  const pickFileName = async (): Promise<void> => {
    const picked = await window.dnSpy.pickSaveFileName(fileName, writer ? 'module' : 'any', writer ? extensionOf(writer.moduleKind) : undefined)
    if (picked)
      setFileName(picked)
  }

  const fileNameRow = (
    <label>{t('Filename')}
      <span className="options-inline">
        <input aria-label={t('Filename')} value={fileName} onChange={(event) => setFileName(event.target.value)} title={fileNameError} aria-invalid={fileNameError !== undefined} />
        <button type="button" aria-label={t('Pick a file name')} onClick={() => void pickFileName()}>...</button>
      </span>
    </label>
  )

  if (writer === null) {
    return (
      <OptionsShell
        title="Save Module"
        className="save-options-dialog"
        hideTabStrip
        tabs={[{ label: 'Main', content: <div className="options-form">{fileNameRow}</div> }]}
        invalid={invalid}
        error={fileNameError}
        onAccept={accept}
        onClose={onClose}
      />
    )
  }

  /** Toggling the mixed-mode box re-reads every option for the other writer, as dnSpy's Reinitialize does. */
  const setMixedMode = async (useMixedMode: boolean): Promise<void> => {
    const next = await window.dnSpy.getSaveOptions(workspaceId, options.documentId, useMixedMode)
    setMixedModeOptions(next)
    if (next.writer) {
      setWriter({ ...next.writer, writePdb: next.canWritePdb })
      setTexts(textsOf(next.writer))
    }
  }

  const setModuleKind = (moduleKind: number): void => {
    // ModuleKind sets the subsystem and the Dll bit, the way the WPF combo's callback does.
    const characteristics = writer.characteristics ?? 0
    patch({
      moduleKind,
      subsystem: moduleKind === 1 ? 2 : 3,
      characteristics: moduleKind === 2 || moduleKind === 3 ? characteristics | 0x2000 : characteristics & ~0x2000,
    })
  }

  const setMachine = (machine: number): void => {
    const characteristics = writer.characteristics ?? 0
    patch({ machine, characteristics: is64BitMachine(machine) ? (characteristics & ~0x100) | 0x20 : characteristics | 0x100 })
  }

  const flag = (mask: number, label: string, tooltip?: string, disabled?: boolean): React.JSX.Element => (
    <label key={label} title={tooltip === undefined ? undefined : t(tooltip)}>
      <input type="checkbox" disabled={disabled} checked={(writer.metadataFlags & mask) === mask} onChange={(event) => patch({ metadataFlags: event.target.checked ? writer.metadataFlags | mask : writer.metadataFlags & ~mask })} />
      {t(label)}
    </label>
  )

  const numberBox = (field: NumberField, label: string, tooltip?: string): React.JSX.Element => {
    const error = numberError(field)
    return (
      <label key={field} title={tooltip === undefined ? undefined : t(tooltip)}>{t(label)}
        <input
          aria-label={t(label)}
          value={texts[field]}
          aria-invalid={error !== undefined}
          title={error === undefined ? undefined : t(error, { min: '0', max: String(NUMBER_FIELDS[field]), maxHex: NUMBER_FIELDS[field].toString(16).toUpperCase() })}
          onChange={(event) => setTexts((current) => ({ ...current, [field]: event.target.value }))}
        />
      </label>
    )
  }

  /** A group of three-state boxes over one `Flags?` value: all undecided while the value is not there. */
  const flagsGroup = (legend: string, value: number | null, entries: readonly (readonly [number, string])[], onChange: (next: number) => void): React.JSX.Element => (
    <fieldset className="il-flags">
      <legend>{t(legend)}</legend>
      {entries.map(([mask, label]) => (
        <label key={label}>
          <input
            type="checkbox"
            checked={value !== null && (value & mask) !== 0}
            ref={(element) => { if (element) element.indeterminate = value === null }}
            onChange={(event) => onChange(event.target.checked ? (value ?? 0) | mask : (value ?? 0) & ~mask)}
          />
          {t(label)}
        </label>
      ))}
    </fieldset>
  )

  /** A `bool?` box: checked, unchecked, or undecided, which only the value can put it back to. */
  const nullableBox = (value: boolean | null, label: string, onChange: (next: boolean) => void): React.JSX.Element => (
    <label key={label}>
      <input type="checkbox" checked={value === true} ref={(element) => { if (element) element.indeterminate = value === null }} onChange={(event) => onChange(event.target.checked)} />
      {t(label)}
    </label>
  )

  const allRids = writer.metadataFlags & PRESERVE_ALL_RIDS
  const isModuleDefMD = mixedModeOptions.canUseMixedMode

  const main = (
    <div className="options-form">
      <label><input type="checkbox" disabled={!mixedModeOptions.canWritePdb} checked={writer.writePdb} onChange={(event) => patch({ writePdb: event.target.checked })} /> {t('Save PDB File')}</label>
      <label title={t("Should be checked if it's a mixed-mode module (eg. C++/.NET).\nMost options will be re-initialized when this checkbox is clicked")}>
        <input type="checkbox" disabled={!mixedModeOptions.canUseMixedMode} checked={writer.useMixedMode} onChange={(event) => void setMixedMode(event.target.checked)} /> {t('Mixed-Mode Module')}
      </label>
      <label title={t('.NET methods that have the exact same code will share method bodies.\nThe output file will be a little bit smaller')}>
        <input type="checkbox" checked={writer.shareMethodBodies} onChange={(event) => patch({ shareMethodBodies: event.target.checked })} /> {t('Shared Method Bodies')}
      </label>
      <label>{t('Module Type')}
        <select aria-label={t('Module Type')} value={writer.moduleKind} onChange={(event) => setModuleKind(Number(event.target.value))}>
          {MODULE_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.name}</option>)}
        </select>
      </label>
      {fileNameRow}
    </div>
  )

  const mdWriterOptions = (
    <div className="options-form">
      <fieldset className="il-flags">
        <legend>
          <label title={t('If the file is still obfuscated, RIDs might need to be preserved')}>
            <input
              type="checkbox"
              disabled={!isModuleDefMD}
              checked={allRids === PRESERVE_ALL_RIDS}
              ref={(element) => { if (element) element.indeterminate = allRids !== 0 && allRids !== PRESERVE_ALL_RIDS }}
              onChange={(event) => patch({ metadataFlags: event.target.checked ? writer.metadataFlags | PRESERVE_ALL_RIDS : writer.metadataFlags & ~PRESERVE_ALL_RIDS })}
            />
            {t('Preserve All MD Tokens')}
          </label>
        </legend>
        {PRESERVE_RIDS.map(([mask, label]) => flag(mask, label, undefined, !isModuleDefMD))}
      </fieldset>
      <fieldset className="il-flags">
        <legend>{t('Preserve Heap Offsets')}</legend>
        {PRESERVE_HEAPS.map(([mask, label]) => flag(mask, label, undefined, !isModuleDefMD))}
      </fieldset>
      <fieldset className="il-flags">
        <legend>{t('Create Heap Even If Empty')}</legend>
        {CREATE_HEAPS.map(([mask, label]) => flag(mask, label))}
      </fieldset>
      <fieldset className="il-flags">
        <legend>{t('Misc Options')}</legend>
        {flag(PRESERVE_EXTRA_SIGNATURE_DATA, 'Preserve Extra Signature Data', 'Preserve any extra data after the signatures.\nSome obfuscators put data there', !isModuleDefMD)}
        {flag(KEEP_OLD_MAX_STACK, 'Keep Old MaxStack Value', 'Use the MaxStack value from the method instead of calculating a new MaxStack value.\nNeeded if the methods are still obfuscated')}
        <label>
          <input
            type="checkbox"
            disabled={!isModuleDefMD}
            checked={writer.preserveOtherMetadataStreams}
            // dnSpy creates every heap the original file has when the unknown streams are copied, so the heap order holds.
            onChange={(event) => patch({ preserveOtherMetadataStreams: event.target.checked, metadataFlags: event.target.checked ? writer.metadataFlags | 0xF0000 : writer.metadataFlags })}
          />
          {t('Copy Unknown Metadata Streams')}
        </label>
      </fieldset>
    </div>
  )

  const versionStringError = versionStringTooLong(writer.metadataVersionString) ? t('Version string is too long') : undefined
  const metadata = (
    <div className="options-form">
      <fieldset className="hex-fieldset">
        <legend>{t('Metadata Header Options')}</legend>
        {numberBox('metadataSignature', 'Signature')}
        <label>{t('VersionString')}
          <input aria-label={t('VersionString')} value={writer.metadataVersionString ?? ''} aria-invalid={versionStringError !== undefined} title={versionStringError} onChange={(event) => patch({ metadataVersionString: event.target.value || null })} />
        </label>
        {numberBox('metadataMajorVersion', 'MajorVersion')}
        {numberBox('metadataMinorVersion', 'MinorVersion')}
        {numberBox('metadataReserved1', 'Reserved1')}
        {numberBox('metadataReserved2', 'Reserved2')}
        {numberBox('metadataStorageFlags', 'StorageFlags', 'Leave this blank or set it only to 0. Any other value will crash the assembly')}
      </fieldset>
      <fieldset className="hex-fieldset">
        <legend>{t('Tables Heap Options')}</legend>
        {numberBox('tablesMajorVersion', 'MajorVersion')}
        {numberBox('tablesMinorVersion', 'MinorVersion')}
        {numberBox('tablesReserved1', 'Reserved1')}
        {numberBox('tablesExtraData', 'ExtraData')}
        {numberBox('tablesLog2Rid', 'Log2Rid')}
        {nullableBox(writer.tablesHasDeletedRows, 'HasDeletedRows', (next) => patch({ tablesHasDeletedRows: next }))}
        {nullableBox(writer.tablesUseEnc, 'Use #- Table', (next) => patch({ tablesUseEnc: next }))}
        {nullableBox(writer.tablesForceBigColumns, 'Force Big Columns', (next) => patch({ tablesForceBigColumns: next }))}
      </fieldset>
    </div>
  )

  const cor20 = (
    <div className="options-form">
      {numberBox('cor20MajorRuntimeVersion', 'Major RT Ver')}
      {numberBox('cor20MinorRuntimeVersion', 'Minor RT Ver')}
      {numberBox('cor20EntryPoint', 'Entry Point')}
      {flagsGroup('Flags', writer.cor20Flags, COR20_FLAGS, (next) => patch({ cor20Flags: next }))}
    </div>
  )

  const pe = (
    <div className="options-form">
      <label><input type="checkbox" checked={writer.addCheckSum} onChange={(event) => patch({ addCheckSum: event.target.checked })} /> {t('Add PE Checksum')}</label>
      <label><input type="checkbox" checked={writer.addMvidSection} onChange={(event) => patch({ addMvidSection: event.target.checked })} /> {t('Add MVID Section')}</label>
      <label>{t('Machine')}
        <select aria-label={t('Machine')} value={writer.machine} onChange={(event) => setMachine(Number(event.target.value))}>
          {MACHINES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select>
      </label>
      <label>{t('Subsystem')}
        <select aria-label={t('Subsystem')} value={writer.subsystem} onChange={(event) => patch({ subsystem: Number(event.target.value) })}>
          {SUBSYSTEMS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select>
      </label>
      {flagsGroup('Characteristics', writer.characteristics, CHARACTERISTICS, (next) => patch({ characteristics: next }))}
      {flagsGroup('DllCharacteristics', writer.dllCharacteristics, DLL_CHARACTERISTICS, (next) => patch({ dllCharacteristics: next }))}
      {numberBox('timeDateStamp', 'TimeDateStamp')}
      {numberBox('pointerToSymbolTable', 'PointerToSymbolTable')}
      {numberBox('numberOfSymbols', 'NumberOfSymbols')}
      {numberBox('majorLinkerVersion', 'MajorLinkerVersion')}
      {numberBox('minorLinkerVersion', 'MinorLinkerVersion')}
      {numberBox('imageBase', 'ImageBase')}
      {numberBox('sectionAlignment', 'SectionAlignment')}
      {numberBox('fileAlignment', 'FileAlignment')}
      {numberBox('majorOperatingSystemVersion', 'MajorOperatingSystemVersion')}
      {numberBox('minorOperatingSystemVersion', 'MinorOperatingSystemVersion')}
      {numberBox('majorImageVersion', 'MajorImageVersion')}
      {numberBox('minorImageVersion', 'MinorImageVersion')}
      {numberBox('majorSubsystemVersion', 'MajorSubsystemVersion')}
      {numberBox('minorSubsystemVersion', 'MinorSubsystemVersion')}
      {numberBox('win32VersionValue', 'Win32VersionValue')}
      {numberBox('sizeOfStackReserve', 'SizeOfStackReserve')}
      {numberBox('sizeOfStackCommit', 'SizeOfStackCommit')}
      {numberBox('sizeOfHeapReserve', 'SizeOfHeapReserve')}
      {numberBox('sizeOfHeapCommit', 'SizeOfHeapCommit')}
      {numberBox('loaderFlags', 'LoaderFlags')}
      {numberBox('numberOfRvaAndSizes', 'NumberOfRvaAndSizes')}
    </div>
  )

  const tabs: OptionsTab[] = [
    { label: 'Main', content: main },
    { label: 'MD Writer Options', content: mdWriterOptions },
    { label: 'Metadata', content: metadata },
    { label: 'Cor20', content: cor20 },
    { label: 'PE', content: pe },
  ]

  return (
    <OptionsShell
      title="Save Module"
      className="save-options-dialog"
      tabs={tabs}
      invalid={invalid}
      error={fileNameError ?? versionStringError}
      onAccept={accept}
      onClose={onClose}
      onReset={() => void reset()}
    />
  )
}
