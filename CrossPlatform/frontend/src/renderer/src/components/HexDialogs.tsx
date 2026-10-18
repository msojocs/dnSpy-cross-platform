import { useRef, useState } from 'react'
import type { HexMetadataKind, HexPositionKind } from '../../../shared/protocol'
import type { HexOffsetFormatKind, HexValuesFormat } from '../hex-model'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { useModalLayer } from './modal-stack'

/**
 * The three dialogs of the hex editor that take a number — Go to Position, Go to Metadata and Select —
 * plus the local settings. They are dnSpy's `GoToPositionDlg`, `GoToMetadataDlg`, `SelectDlg` and
 * `LocalSettingsDlg`, with the same fields and the same kinds: the two that take an address offer
 * absolute, file, RVA and current-position modes, and every number is read the way dnSpy's
 * `SimpleTypeConverter` reads one — decimal, or hexadecimal after `0x`/`&H`/with an `h` suffix.
 */

/** dnSpy's `SimpleTypeConverter.ParseUInt64`: decimal, or hexadecimal after `0x`, `&H` or an `h` suffix. */
export function parseHexNumber(text: string): number | undefined {
  const value = text.trim()
  if (value === '')
    return undefined
  let digits = value
  let radix = 10
  if (/^0x/i.test(digits) || /^&H/i.test(digits)) {
    digits = digits.slice(2)
    radix = 16
  }
  else if (/^[0-9A-Fa-f]+h$/i.test(digits)) {
    digits = digits.slice(0, -1)
    radix = 16
  }
  if (digits === '' || digits.trim() !== digits)
    return undefined
  const parsed = radix === 16 ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const Modal = ({ title, onClose, children, footer }: { title: string; onClose(): void; children: React.ReactNode; footer: React.ReactNode }): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)
  const { t } = useLanguage()
  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 120 + depth * 10 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal hex-dialog" role="dialog" aria-modal="true" aria-label={t(title)} ref={dialog}>
        <div className="modal-title"><span>{t(title)}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="hex-dialog-body">{children}</div>
        <div className="modal-actions">{footer}</div>
      </div>
    </div>
  )
}

/** One selectable line of a dnSpy kind list — a radio row with its gesture text. */
const KindRow = ({ name, checked, label, shortcut, onChange }: { name: string; checked: boolean; label: string; shortcut?: string; onChange(): void }): React.JSX.Element => (
  <label className="hex-kind-row">
    <input type="radio" name={name} checked={checked} onChange={onChange} />
    <span>{label}</span>
    {shortcut && <span className="hex-kind-shortcut">{shortcut}</span>}
  </label>
)

const NumberField = ({ label, value, onChange, autoFocus }: { label: string; value: string; onChange(value: string): void; autoFocus?: boolean }): React.JSX.Element => (
  <label className="hex-field">
    <span>{label}</span>
    <input autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} />
  </label>
)

const POSITION_KINDS: { kind: HexPositionKind; label: string; shortcut: string }[] = [
  { kind: 'absolute', label: 'Absolute position', shortcut: 'Ctrl+1' },
  { kind: 'file', label: 'File position', shortcut: 'Ctrl+2' },
  { kind: 'rva', label: 'RVA', shortcut: 'Ctrl+3' },
  { kind: 'current', label: 'Current position', shortcut: 'Ctrl+4' },
]

export interface GoToPositionResult {
  kind: HexPositionKind
  value: number
  selectToNewPosition: boolean
}

export const HexGoToPositionDialog = ({ initial, onAccept, onClose }: { initial: number; onAccept(result: GoToPositionResult): void; onClose(): void }): React.JSX.Element => {
  const [kind, setKind] = useState<HexPositionKind>('absolute')
  const [text, setText] = useState(String(initial))
  const [selectToNewPosition, setSelectToNewPosition] = useState(false)
  const { t } = useLanguage()
  const value = parseHexNumber(text)
  const accept = (): void => { if (value !== undefined) onAccept({ kind, value, selectToNewPosition }) }
  return (
    <Modal
      title="Go to Position"
      onClose={onClose}
      footer={<><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={value === undefined} onClick={accept}>{t('OK')}</button></>}
    >
      <div role="radiogroup" aria-label={t('Position')}>
        {POSITION_KINDS.map((entry) => <KindRow key={entry.kind} name="hex-position-kind" checked={kind === entry.kind} label={t(entry.label)} shortcut={entry.shortcut} onChange={() => setKind(entry.kind)} />)}
      </div>
      <NumberField label={kind === 'rva' ? 'RVA' : 'Offset'} value={text} onChange={setText} autoFocus />
      <label className="hex-check-row"><input type="checkbox" checked={selectToNewPosition} onChange={(event) => setSelectToNewPosition(event.target.checked)} />{t('Select to new position')}</label>
    </Modal>
  )
}

const METADATA_KINDS: { kind: HexMetadataKind; label: string; shortcut: string }[] = [
  { kind: 'table', label: 'Metadata token', shortcut: 'Ctrl+1' },
  { kind: 'memberRva', label: 'Method body', shortcut: 'Ctrl+2' },
  { kind: 'blob', label: '#Blob', shortcut: 'Ctrl+3' },
  { kind: 'strings', label: '#Strings', shortcut: 'Ctrl+4' },
  { kind: 'us', label: '#US', shortcut: 'Ctrl+5' },
  { kind: 'guid', label: '#GUID', shortcut: 'Ctrl+6' },
]

export interface GoToMetadataResult {
  kind: HexMetadataKind
  value: number
}

export const HexGoToMetadataDialog = ({ initial, onAccept, onClose }: { initial: number; onAccept(result: GoToMetadataResult): void; onClose(): void }): React.JSX.Element => {
  const [kind, setKind] = useState<HexMetadataKind>('table')
  const [text, setText] = useState(initial === 0 ? '' : `0x${initial.toString(16).toUpperCase()}`)
  const { t } = useLanguage()
  const value = parseHexNumber(text)
  const accept = (): void => { if (value !== undefined) onAccept({ kind, value }) }
  return (
    <Modal
      title="Go to Metadata"
      onClose={onClose}
      footer={<><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={value === undefined} onClick={accept}>{t('OK')}</button></>}
    >
      <div role="radiogroup" aria-label={t('Metadata')}>
        {METADATA_KINDS.map((entry) => <KindRow key={entry.kind} name="hex-metadata-kind" checked={kind === entry.kind} label={t(entry.label)} shortcut={entry.shortcut} onChange={() => setKind(entry.kind)} />)}
      </div>
      <NumberField label={kind === 'table' || kind === 'memberRva' ? 'Token' : kind === 'guid' ? 'Index' : 'Offset'} value={text} onChange={setText} autoFocus />
    </Modal>
  )
}

export interface SelectResult {
  kind: HexPositionKind
  start: number
  /** The end position or the length, depending on `mode`. */
  end: number
  mode: 'position' | 'length'
}

export const HexSelectDialog = ({ start, end, onAccept, onClose }: { start: number; end: number; onAccept(result: SelectResult): void; onClose(): void }): React.JSX.Element => {
  const [kind, setKind] = useState<HexPositionKind>('absolute')
  const [mode, setMode] = useState<'position' | 'length'>('position')
  const [startText, setStartText] = useState(String(start))
  const [endText, setEndText] = useState(String(Math.max(start, end - 1)))
  const { t } = useLanguage()
  const parsedStart = parseHexNumber(startText)
  const parsedEnd = parseHexNumber(endText)
  const accept = (): void => {
    if (parsedStart !== undefined && parsedEnd !== undefined)
      onAccept({ kind, start: parsedStart, end: parsedEnd, mode })
  }
  return (
    <Modal
      title="Select"
      onClose={onClose}
      footer={<><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={parsedStart === undefined || parsedEnd === undefined} onClick={accept}>{t('OK')}</button></>}
    >
      <div role="radiogroup" aria-label={t('Position')}>
        {POSITION_KINDS.map((entry) => <KindRow key={entry.kind} name="hex-select-kind" checked={kind === entry.kind} label={t(entry.label)} shortcut={entry.shortcut} onChange={() => setKind(entry.kind)} />)}
      </div>
      <div role="radiogroup" aria-label={t('End')}>
        <KindRow name="hex-select-mode" checked={mode === 'position'} label={t('End position')} shortcut="Ctrl+O" onChange={() => setMode('position')} />
        <KindRow name="hex-select-mode" checked={mode === 'length'} label={t('Length')} shortcut="Ctrl+L" onChange={() => setMode('length')} />
      </div>
      <NumberField label={t('Start')} value={startText} onChange={setStartText} autoFocus />
      <NumberField label={mode === 'position' ? t('End') : t('Length')} value={endText} onChange={setEndText} />
    </Modal>
  )
}

/** The local settings of one hex view — dnSpy's `LocalSettingsVM`: the columns it shows, the positions it
 * is limited to, and the line layout it draws with. */
export interface HexLocalSettings {
  showOffset: boolean
  showValues: boolean
  showAscii: boolean
  useRelativePositions: boolean
  startPosition: number
  endPosition: number
  basePosition: number
  offsetBitSize: number
  bytesPerLine: number
  valuesFormat: HexValuesFormat
  offsetFormat: HexOffsetFormatKind
}

export const HexLocalSettingsDialog = ({ settings, fileLength, onAccept, onClose }: { settings: HexLocalSettings; fileLength: number; onAccept(settings: HexLocalSettings): void; onClose(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [value, setValue] = useState(settings)
  const [startText, setStartText] = useState(String(settings.startPosition))
  const [endText, setEndText] = useState(String(Math.max(settings.startPosition, settings.endPosition - 1)))
  const [baseText, setBaseText] = useState(String(settings.basePosition))
  const [bytesText, setBytesText] = useState(String(settings.bytesPerLine))
  const [offsetText, setOffsetText] = useState(String(settings.offsetBitSize))
  const start = parseHexNumber(startText)
  const end = parseHexNumber(endText)
  const base = parseHexNumber(baseText)
  const bytes = parseHexNumber(bytesText)
  const bitSize = parseHexNumber(offsetText)
  const valid = start !== undefined && end !== undefined && base !== undefined && bytes !== undefined && bitSize !== undefined
    && start <= end && end < Math.max(1, fileLength) && bitSize <= 64
  const set = <K extends keyof HexLocalSettings>(key: K, next: HexLocalSettings[K]): void => setValue((current) => ({ ...current, [key]: next }))
  const accept = (): void => {
    if (!valid)
      return
    onAccept({ ...value, startPosition: start!, endPosition: end! + 1, basePosition: base!, bytesPerLine: bytes!, offsetBitSize: bitSize! })
  }
  return (
    <Modal
      title="Hex Editor Settings"
      onClose={onClose}
      footer={<><button onClick={() => setValue(settings)}>{t('Reinitialize')}</button><span className="modal-action-spacer" /><button onClick={onClose}>{t('Cancel')}</button><button className="primary" disabled={!valid} onClick={accept}>{t('OK')}</button></>}
    >
      <fieldset className="hex-fieldset">
        <legend>{t('Columns')}</legend>
        <label className="hex-check-row"><input type="checkbox" checked={value.showOffset} onChange={(event) => set('showOffset', event.target.checked)} />{t('Offset')}</label>
        <label className="hex-check-row"><input type="checkbox" checked={value.showValues} onChange={(event) => set('showValues', event.target.checked)} />{t('Values')}</label>
        <label className="hex-check-row"><input type="checkbox" checked={value.showAscii} onChange={(event) => set('showAscii', event.target.checked)} />{t('ASCII')}</label>
      </fieldset>
      <fieldset className="hex-fieldset">
        <legend>{t('Layout')}</legend>
        <NumberField label={t('Bytes per line')} value={bytesText} onChange={setBytesText} />
        <NumberField label={t('Offset size (bits)')} value={offsetText} onChange={setOffsetText} />
        <label className="hex-field">
          <span>{t('Values format')}</span>
          <select value={value.valuesFormat} onChange={(event) => set('valuesFormat', event.target.value as HexValuesFormat)}>
            {VALUE_FORMAT_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{t(choice.label)}</option>)}
          </select>
        </label>
        <label className="hex-field">
          <span>{t('Offset format')}</span>
          <select value={value.offsetFormat} onChange={(event) => set('offsetFormat', event.target.value as HexOffsetFormatKind)}>
            <option value="hex">{t('6789ABCD')}</option>
            <option value="cSharp">{t('0x6789ABCD')}</option>
            <option value="vb">{t('&H6789ABCD')}</option>
            <option value="masm">{t('6789ABCDh')}</option>
          </select>
        </label>
      </fieldset>
      <fieldset className="hex-fieldset">
        <legend>{t('Positions')}</legend>
        <NumberField label={t('Start')} value={startText} onChange={setStartText} />
        <NumberField label={t('End')} value={endText} onChange={setEndText} />
        <NumberField label={t('Base')} value={baseText} onChange={setBaseText} />
        <label className="hex-check-row"><input type="checkbox" checked={value.useRelativePositions} onChange={(event) => set('useRelativePositions', event.target.checked)} />{t('Use relative positions')}</label>
      </fieldset>
    </Modal>
  )
}

/** The value-format submenu and the local settings offer the same list, in dnSpy's order. */
export const VALUE_FORMAT_CHOICES: { value: HexValuesFormat; label: string }[] = [
  { value: 'hexByte', label: 'Byte (hex)' },
  { value: 'decimalByte', label: 'Byte (decimal)' },
  { value: 'hexUInt16', label: 'UInt16 (hex)' },
  { value: 'decimalUInt16', label: 'UInt16 (decimal)' },
  { value: 'hexUInt16Be', label: 'UInt16 (hex, big endian)' },
  { value: 'decimalUInt16Be', label: 'UInt16 (decimal, big endian)' },
  { value: 'hexUInt32', label: 'UInt32 (hex)' },
  { value: 'decimalUInt32', label: 'UInt32 (decimal)' },
  { value: 'hexUInt32Be', label: 'UInt32 (hex, big endian)' },
  { value: 'decimalUInt32Be', label: 'UInt32 (decimal, big endian)' },
  { value: 'hexUInt64', label: 'UInt64 (hex)' },
  { value: 'decimalUInt64', label: 'UInt64 (decimal)' },
  { value: 'hexUInt64Be', label: 'UInt64 (hex, big endian)' },
  { value: 'decimalUInt64Be', label: 'UInt64 (decimal, big endian)' },
  { value: 'hexSByte', label: 'SByte (hex)' },
  { value: 'decimalSByte', label: 'SByte (decimal)' },
  { value: 'hexInt16', label: 'Int16 (hex)' },
  { value: 'decimalInt16', label: 'Int16 (decimal)' },
  { value: 'hexInt16Be', label: 'Int16 (hex, big endian)' },
  { value: 'decimalInt16Be', label: 'Int16 (decimal, big endian)' },
  { value: 'hexInt32', label: 'Int32 (hex)' },
  { value: 'decimalInt32', label: 'Int32 (decimal)' },
  { value: 'hexInt32Be', label: 'Int32 (hex, big endian)' },
  { value: 'decimalInt32Be', label: 'Int32 (decimal, big endian)' },
  { value: 'hexInt64', label: 'Int64 (hex)' },
  { value: 'decimalInt64', label: 'Int64 (decimal)' },
  { value: 'hexInt64Be', label: 'Int64 (hex, big endian)' },
  { value: 'decimalInt64Be', label: 'Int64 (decimal, big endian)' },
  { value: 'single', label: 'Single' },
  { value: 'singleBe', label: 'Single (big endian)' },
  { value: 'double', label: 'Double' },
  { value: 'doubleBe', label: 'Double (big endian)' },
  { value: 'bit8', label: '8 Bits' },
]
