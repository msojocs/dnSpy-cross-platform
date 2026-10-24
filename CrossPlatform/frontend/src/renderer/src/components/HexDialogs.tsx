import { useEffect, useRef, useState } from 'react'
import type { HexMetadataKind, HexPositionKind } from '../../../shared/protocol'
import { HEX_VALUE_FORMATS, type HexValuesFormat } from '../hex-model'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { useModalLayer } from './modal-stack'
import { formatNumberText } from './widgets/number-text'

/**
 * The hex editor's dialogs — dnSpy's `GoToPositionDlg`, `GoToMetadataDlg`, `SelectDlg` and `LocalSettingsDlg` —
 * laid out the way the XAML lays them out: a labelled number box beside a kind box whose entries carry their
 * Ctrl gestures, and the buttons of each. Numbers are read and written the way their view models do it.
 */

const digitSeparator = /_/g

/** `SimpleTypeConverter.ParseUInt64`: decimal, or hexadecimal after `0x`/`&H`, `_` allowed anywhere. */
export function parseUnsignedText(text: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = text.trim().replace(digitSeparator, '')
  let parsed: number
  if (/^(0x|&H)/i.test(value)) {
    const digits = value.slice(2)
    if (digits === '' || digits.trim() !== digits || !/^[0-9a-f]+$/i.test(digits))
      return undefined
    parsed = Number.parseInt(digits, 16)
  }
  else {
    if (!/^\+?\d+$/.test(value))
      return undefined
    parsed = Number.parseInt(value, 10)
  }
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined
}

/** `SimpleTypeConverter.ParseInt64`, which `Integer64VM` tries before the unsigned parse: an optional minus. */
export function parseSignedText(text: string): number | undefined {
  const value = text.trim().replace(digitSeparator, '')
  const negative = value.startsWith('-')
  const magnitude = parseUnsignedText(negative ? value.slice(1) : value)
  if (magnitude === undefined)
    return undefined
  return negative ? -magnitude : magnitude
}

/** The parse the hex editor's commands have always used; kept under its old name for the views that call it. */
export const parseHexNumber = (text: string): number | undefined => parseUnsignedText(text)

/** `HexPosition.ToString`: always hexadecimal, `0x` and upper case digits. */
const hexPositionText = (value: number): string => `0x${value.toString(16).toUpperCase()}`

/** `HexPosition.TryParse`: `0x`/`&H` hexadecimal or decimal, `_` allowed anywhere. */
const parseHexPosition = (text: string): number | undefined => parseUnsignedText(text)

const Modal = ({ title, onClose, onKeyDown, children, footer, className }: { title: string; onClose(): void; onKeyDown?(event: React.KeyboardEvent): void; children: React.ReactNode; footer: React.ReactNode; className?: string }): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)
  const { t } = useLanguage()
  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 120 + depth * 10 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`modal hex-dialog ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={t(title)} ref={dialog} onKeyDown={onKeyDown}>
        <div className="modal-title"><span>{t(title)}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="hex-dialog-body">{children}</div>
        <div className="modal-actions">{footer}</div>
      </div>
    </div>
  )
}

/** One entry of a kind box: its text and the gesture the dialog binds to it. */
interface KindEntry<T> {
  kind: T
  text: string
  gesture: string
}

const KindBox = <T extends string,>({ label, entries, value, onChange }: { label: string; entries: KindEntry<T>[]; value: T; onChange(kind: T): void }): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <select className="hex-kind-box" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {entries.map((entry) => <option key={entry.kind} value={entry.kind}>{`${t(entry.text)}  ${entry.gesture}`}</option>)}
    </select>
  )
}

/** The Ctrl+digit (or Ctrl+letter) gestures a dialog binds to the entries of its kind boxes. */
const gestureKey = (event: React.KeyboardEvent): string | undefined => {
  if (!event.ctrlKey || event.altKey || event.shiftKey)
    return undefined
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1]
  if (digit)
    return `Ctrl+${digit}`
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1]
  return letter ? `Ctrl+${letter}` : undefined
}

const POSITION_KINDS: KindEntry<HexPositionKind>[] = [
  { kind: 'absolute', text: 'Position', gesture: 'Ctrl+1' },
  { kind: 'file', text: 'File', gesture: 'Ctrl+2' },
  { kind: 'rva', text: 'RVA', gesture: 'Ctrl+3' },
  { kind: 'current', text: 'Current Position', gesture: 'Ctrl+4' },
]

export interface GoToPositionResult {
  kind: HexPositionKind
  value: number
  selectToNewPosition: boolean
}

/** dnSpy's Go to Offset: the box starts out with the UInt32 the caret is on, the way `GoToPositionVM` is made. */
export const HexGoToPositionDialog = ({ initial, initialKind = 'absolute', onAccept, onClose }: { initial: number; initialKind?: HexPositionKind; onAccept(result: GoToPositionResult): void; onClose(): void }): React.JSX.Element => {
  const [kind, setKind] = useState<HexPositionKind>(initialKind)
  const [text, setText] = useState(formatNumberText(initial))
  const [selectToNewPosition, setSelectToNewPosition] = useState(false)
  const { t } = useLanguage()
  // Integer64VM: a signed number first, so the current position can be moved backwards, then an unsigned one.
  const value = parseSignedText(text) ?? parseUnsignedText(text)
  const accept = (): void => { if (value !== undefined) onAccept({ kind, value, selectToNewPosition }) }
  return (
    <Modal
      title="Go to Offset"
      className="hex-goto-dialog"
      onClose={onClose}
      onKeyDown={(event) => {
        const entry = POSITION_KINDS.find((candidate) => candidate.gesture === gestureKey(event))
        if (entry) { event.preventDefault(); setKind(entry.kind) }
        else if (event.key === 'Enter' && !(event.target as HTMLElement).matches('button, select')) { event.preventDefault(); accept() }
      }}
      footer={(
        <>
          <label className="hex-check-row hex-dialog-footer-check"><input type="checkbox" checked={selectToNewPosition} onChange={(event) => setSelectToNewPosition(event.target.checked)} />{t('Select to new position')}</label>
          <button className="primary" disabled={value === undefined} onClick={accept}>{t('OK')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </>
      )}
    >
      <div className="hex-dialog-row">
        <label className="hex-field"><span>{t('Offset')}</span><input autoFocus aria-invalid={value === undefined} value={text} onChange={(event) => setText(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label>
        <KindBox<HexPositionKind> label={t('Position')} entries={POSITION_KINDS} value={kind} onChange={setKind} />
      </div>
    </Modal>
  )
}

export interface GoToMetadataResult {
  kind: HexMetadataKind
  value: number
}

/**
 * dnSpy's Go to Metadata: a token, an offset into a heap or a GUID index, checked against the file's metadata as
 * it is typed (`OffsetTokenVM.CheckOffsetToken`) — here by asking the backend whether it names anything.
 */
export const HexGoToMetadataDialog = ({ initial, hasPeHeaders, validate, onAccept, onClose }: {
  initial: number
  hasPeHeaders: boolean
  validate(kind: HexMetadataKind, value: number): Promise<boolean>
  onAccept(result: GoToMetadataResult): void
  onClose(): void
}): React.JSX.Element => {
  const kinds: KindEntry<HexMetadataKind>[] = [
    { kind: 'table', text: 'Metadata Token', gesture: 'Ctrl+1' },
    ...(hasPeHeaders ? [{ kind: 'memberRva' as const, text: 'Method Body', gesture: 'Ctrl+2' }] : []),
    { kind: 'blob', text: '#Blob', gesture: 'Ctrl+3' },
    { kind: 'strings', text: '#Strings', gesture: 'Ctrl+4' },
    { kind: 'us', text: '#US', gesture: 'Ctrl+5' },
    { kind: 'guid', text: '#GUID', gesture: 'Ctrl+6' },
  ]
  const [kind, setKind] = useState<HexMetadataKind>('table')
  const [text, setText] = useState(formatNumberText(initial >>> 0))
  const [valid, setValid] = useState<boolean | undefined>(undefined)
  const { t } = useLanguage()
  const value = parseUnsignedText(text, 0xFFFFFFFF)
  useEffect(() => {
    let current = true
    setValid(undefined)
    if (value === undefined) {
      setValid(false)
      return
    }
    void validate(kind, value).then((answer) => { if (current) setValid(answer) }, () => { if (current) setValid(false) })
    return () => { current = false }
  }, [kind, value, validate])
  const accept = (): void => { if (value !== undefined && valid) onAccept({ kind, value }) }
  const label = kind === 'table' || kind === 'memberRva' ? 'Token' : kind === 'guid' ? 'Index' : 'Offset'
  return (
    <Modal
      title="Go to Metadata"
      className="hex-goto-dialog"
      onClose={onClose}
      onKeyDown={(event) => {
        const entry = kinds.find((candidate) => candidate.gesture === gestureKey(event))
        if (entry) { event.preventDefault(); setKind(entry.kind) }
        else if (event.key === 'Enter' && !(event.target as HTMLElement).matches('button, select')) { event.preventDefault(); accept() }
      }}
      footer={<><span className="modal-action-spacer" /><button className="primary" disabled={!valid} onClick={accept}>{t('OK')}</button><button onClick={onClose}>{t('Cancel')}</button></>}
    >
      <div className="hex-dialog-row">
        <label className="hex-field">
          <span>{t(label)}</span>
          <input autoFocus aria-label={t(label)} aria-invalid={valid === false} title={valid === false ? t('Invalid offset or metadata token') : undefined} value={text} onChange={(event) => setText(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <KindBox<HexMetadataKind> label={t('Metadata')} entries={kinds} value={kind} onChange={setKind} />
      </div>
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

const POSITION_LENGTH_KINDS: KindEntry<'position' | 'length'>[] = [
  { kind: 'position', text: 'Position', gesture: 'Ctrl+O' },
  { kind: 'length', text: 'Length', gesture: 'Ctrl+L' },
]

/** dnSpy's Select: a start and an end (or a length), both written as `HexPosition`s. */
export const HexSelectDialog = ({ start, end, onAccept, onClose }: { start: number; end: number; onAccept(result: SelectResult): void; onClose(): void }): React.JSX.Element => {
  const [kind, setKind] = useState<HexPositionKind>('absolute')
  const [mode, setMode] = useState<'position' | 'length'>('position')
  const [startText, setStartText] = useState(hexPositionText(start))
  const [endText, setEndText] = useState(hexPositionText(end))
  const { t } = useLanguage()
  const parsedStart = parseHexPosition(startText)
  const parsedEnd = parseHexPosition(endText)
  const accept = (): void => {
    if (parsedStart !== undefined && parsedEnd !== undefined)
      onAccept({ kind, start: parsedStart, end: parsedEnd, mode })
  }
  return (
    <Modal
      title="Select"
      className="hex-select-dialog"
      onClose={onClose}
      onKeyDown={(event) => {
        const gesture = gestureKey(event)
        const positionEntry = POSITION_KINDS.find((candidate) => candidate.gesture === gesture)
        const modeEntry = POSITION_LENGTH_KINDS.find((candidate) => candidate.gesture === gesture)
        if (positionEntry) { event.preventDefault(); setKind(positionEntry.kind) }
        else if (modeEntry) { event.preventDefault(); setMode(modeEntry.kind) }
        else if (event.key === 'Enter' && !(event.target as HTMLElement).matches('button, select')) { event.preventDefault(); accept() }
      }}
      footer={<><span className="modal-action-spacer" /><button className="primary" disabled={parsedStart === undefined || parsedEnd === undefined} onClick={accept}>{t('OK')}</button><button onClick={onClose}>{t('Cancel')}</button></>}
    >
      <div className="hex-dialog-grid">
        <label className="hex-field"><span>{t('Start')}</span><input autoFocus aria-invalid={parsedStart === undefined} value={startText} onChange={(event) => setStartText(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label>
        <label className="hex-field"><span>{t('End')}</span><input aria-invalid={parsedEnd === undefined} value={endText} onChange={(event) => setEndText(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label>
        <KindBox<HexPositionKind> label={t('Position')} entries={POSITION_KINDS} value={kind} onChange={setKind} />
        <KindBox<'position' | 'length'> label={t('End')} entries={POSITION_LENGTH_KINDS} value={mode} onChange={setMode} />
      </div>
    </Modal>
  )
}

/** The local settings of one hex view — dnSpy's `LocalGroupOptions`. `endPosition` is exclusive. */
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
}

const MIN_OFFSET_BIT_SIZE = 0
const MAX_OFFSET_BIT_SIZE = 64
const MIN_BYTES_PER_LINE = 0
const MAX_BYTES_PER_LINE = 1024

/** dnSpy's Local Hex Editor Settings, with its Default Settings and Reset buttons. */
export const HexLocalSettingsDialog = ({ settings, defaults, onAccept, onClose }: { settings: HexLocalSettings; defaults: HexLocalSettings; onAccept(settings: HexLocalSettings): void; onClose(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const textsOf = (from: HexLocalSettings): { start: string; end: string; base: string; bits: string; bytes: string } => ({
    start: formatNumberText(from.startPosition),
    end: formatNumberText(from.endPosition > 0 ? from.endPosition - 1 : from.endPosition),
    base: formatNumberText(from.basePosition),
    // Int32VM(useDecimal: true): these two are written in decimal.
    bits: String(from.offsetBitSize),
    bytes: String(from.bytesPerLine),
  })
  const [value, setValue] = useState(settings)
  const [texts, setTexts] = useState(() => textsOf(settings))
  const start = parseUnsignedText(texts.start)
  const end = parseUnsignedText(texts.end)
  const base = parseUnsignedText(texts.base)
  const bits = parseUnsignedText(texts.bits)
  const bytes = parseUnsignedText(texts.bytes)
  const bitsValid = bits !== undefined && bits >= MIN_OFFSET_BIT_SIZE && bits <= MAX_OFFSET_BIT_SIZE
  const bytesValid = bytes !== undefined && bytes >= MIN_BYTES_PER_LINE && bytes <= MAX_BYTES_PER_LINE
  const valid = start !== undefined && end !== undefined && base !== undefined && bitsValid && bytesValid
  const set = <K extends keyof HexLocalSettings>(key: K, next: HexLocalSettings[K]): void => setValue((current) => ({ ...current, [key]: next }))
  const current = (): HexLocalSettings | undefined => valid
    ? { ...value, startPosition: start!, endPosition: end! + 1, basePosition: base!, offsetBitSize: bits!, bytesPerLine: bytes! }
    : undefined
  const initializeFrom = (from: HexLocalSettings): void => {
    setValue(from)
    setTexts(textsOf(from))
  }
  const sameAsDefaults = (() => {
    const now = current()
    return now !== undefined && (Object.keys(defaults) as (keyof HexLocalSettings)[]).every((key) => now[key] === defaults[key])
  })()
  const accept = (): void => {
    const result = current()
    if (result)
      onAccept(result)
  }
  const numberField = (label: string, key: keyof typeof texts, ok: boolean, tooltip?: string): React.JSX.Element => (
    <label className="hex-field" title={tooltip}>
      <span>{t(label)}</span>
      <input aria-label={t(label)} aria-invalid={!ok} value={texts[key]} onChange={(event) => { const text = event.target.value; setTexts((old) => ({ ...old, [key]: text })) }} />
    </label>
  )
  return (
    <Modal
      title="Local Hex Editor Settings"
      className="hex-local-settings-dialog"
      onClose={onClose}
      onKeyDown={(event) => { if (event.key === 'Enter' && !(event.target as HTMLElement).matches('button, select')) { event.preventDefault(); accept() } }}
      footer={(
        <>
          <button disabled={sameAsDefaults} onClick={() => initializeFrom(defaults)}>{t('Default Settings')}</button>
          <span className="modal-action-spacer" />
          <button className="primary" disabled={!valid} onClick={accept}>{t('OK')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
          <button onClick={() => initializeFrom(settings)}>{t('Reset')}</button>
        </>
      )}
    >
      <div className="hex-dialog-grid">
        {numberField('Start Offset', 'start', start !== undefined)}
        {numberField('End Offset', 'end', end !== undefined)}
        {numberField('Base Offset', 'base', base !== undefined, t("This value is added to start offset before it's shown on the screen"))}
        {numberField('Offset Bit Size', 'bits', bitsValid)}
        {numberField('Bytes per Line', 'bytes', bytesValid)}
        <label className="hex-field">
          <span>{t('Value Format')}</span>
          <select value={value.valuesFormat} onChange={(event) => set('valuesFormat', event.target.value as HexValuesFormat)}>
            {/* SettingsConstants.ValueFormatList is written in English, untranslated. */}
            {HEX_VALUE_FORMATS.map((choice) => <option key={choice.format} value={choice.format}>{choice.label}</option>)}
          </select>
        </label>
        <label className="hex-check-row" title={t('All offsets are relative to the start offset')}><input type="checkbox" checked={value.showOffset} onChange={(event) => set('showOffset', event.target.checked)} />{t('Show Offset')}</label>
        <label className="hex-check-row"><input type="checkbox" checked={value.showValues} onChange={(event) => set('showValues', event.target.checked)} />{t('Show Values')}</label>
        <label className="hex-check-row"><input type="checkbox" checked={value.showAscii} onChange={(event) => set('showAscii', event.target.checked)} />{t('Show ASCII')}</label>
        <label className="hex-check-row"><input type="checkbox" checked={value.useRelativePositions} onChange={(event) => set('useRelativePositions', event.target.checked)} />{t('Use Relative Offsets')}</label>
      </div>
    </Modal>
  )
}

/** The value-format submenu and the local settings offer the same list, in dnSpy's order and English words. */
export const VALUE_FORMAT_CHOICES: { value: HexValuesFormat; label: string }[] = HEX_VALUE_FORMATS.map((info) => ({ value: info.format, label: info.label }))

/**
 * dnSpy's ProgressDlg as Save Selection shows it: the file being written under the title, a bar that fills a chunk at
 * a time and Cancel, which stops the save (and the file it had begun is deleted).
 */
export const HexSaveProgressDialog = ({ title, description, progress, onCancel }: { title: string; description: string; progress: number; onCancel(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <Modal
      title={title}
      onClose={onCancel}
      className="hex-progress-dialog"
      footer={<button type="button" onClick={onCancel}>{t('Cancel')}</button>}
    >
      <div className="hex-progress-description" title={description}>{description}</div>
      <progress aria-label={t('Progress')} max={1} value={Math.max(0, Math.min(1, progress))} />
    </Modal>
  )
}
