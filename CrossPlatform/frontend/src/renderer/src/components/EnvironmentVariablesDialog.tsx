import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'

/** One row of the environment editor, in the order dnSpy's list shows them. */
export interface EnvironmentRow {
  key: string
  value: string
}

/** The rows an environment's text holds, in order; a blank or keyless line is not a variable. */
export const parseEnvironmentRows = (text: string): EnvironmentRow[] => {
  const rows: EnvironmentRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    rows.push({ key: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1) })
  }
  return rows
}

/** The text the Debug Program dialog's MRU stores for a set of rows. */
export const formatEnvironmentRows = (rows: readonly EnvironmentRow[]): string =>
  rows.filter((row) => row.key.length > 0).map((row) => `${row.key}=${row.value}`).join('\n')

/** The rows as the launch request's environment object; blank keys are left out, as DbgEnvironment does. */
export const environmentOfRows = (rows: readonly EnvironmentRow[]): Record<string, string> => {
  const environment: Record<string, string> = {}
  for (const row of rows) {
    if (row.key.length > 0)
      environment[row.key] = row.value
  }
  return environment
}

/**
 * dnSpy's EnvironmentStringParser: `A=1;B=2`, where a value may be quoted to hold `;` or `=`.
 * Returns undefined for text that is not a whole sequence of pairs.
 */
export const parseEnvironmentString = (text: string): EnvironmentRow[] | undefined => {
  const rows: EnvironmentRow[] = []
  let position = 0
  const token = (): { kind: 'eof' | 'separator' | 'assign' | 'string' | 'invalid'; value: string } => {
    if (position >= text.length)
      return { kind: 'eof', value: '' }
    const current = text[position++]
    if (current === ';') return { kind: 'separator', value: '' }
    if (current === '=') return { kind: 'assign', value: '' }
    if (current === '"') {
      const start = position
      while (position < text.length && text[position++] !== '"') {
        // Scan to the closing quote.
      }
      if (position >= text.length && text[position - 1] !== '"')
        return { kind: 'invalid', value: '' }
      if (position === start)
        return { kind: 'invalid', value: '' }
      return { kind: 'string', value: text.slice(start, position - 1) }
    }
    const start = position - 1
    while (position < text.length && text[position] !== ';' && text[position] !== '=')
      position++
    return { kind: 'string', value: text.slice(start, position) }
  }
  for (;;) {
    const key = token()
    if (key.kind === 'eof') break
    if (key.kind !== 'string') return undefined
    const assign = token()
    if (assign.kind !== 'assign') return undefined
    const value = token()
    if (value.kind !== 'string') return undefined
    rows.push({ key: key.value, value: value.value })
    const separator = token()
    if (separator.kind === 'eof') break
    if (separator.kind !== 'separator') return undefined
  }
  return rows
}

/**
 * dnSpy's EditEnvironmentDlg: the rows the target is started with, with Add, Add Many, Remove,
 * Reset and OK/Cancel. The dialog edits a copy; only OK writes it back.
 */
export const EnvironmentVariablesDialog = ({ initial, onClose, onAccept }: {
  initial: readonly EnvironmentRow[]
  onClose(): void
  onAccept(rows: EnvironmentRow[]): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState<EnvironmentRow[]>(() => initial.map((row) => ({ ...row })))
  const [selected, setSelected] = useState<number | undefined>(rows.length > 0 ? 0 : undefined)
  const [addManyOpen, setAddManyOpen] = useState(false)
  const [addManyText, setAddManyText] = useState('')
  const [addManyInvalid, setAddManyInvalid] = useState(false)

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (addManyOpen) setAddManyOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [addManyOpen, onClose])

  const add = (): void => {
    setRows((current) => [...current, { key: '', value: '' }])
    setSelected(rows.length)
  }

  const remove = (): void => {
    if (selected === undefined) return
    setRows((current) => current.filter((_, index) => index !== selected))
    setSelected(rows.length > 1 ? Math.min(selected, rows.length - 2) : undefined)
  }

  const reset = (): void => {
    setRows(initial.map((row) => ({ ...row })))
    setSelected(initial.length > 0 ? 0 : undefined)
  }

  const addMany = (): void => {
    const parsed = parseEnvironmentString(addManyText)
    if (!parsed) {
      setAddManyInvalid(true)
      return
    }
    setRows((current) => [...current, ...parsed])
    setSelected(rows.length)
    setAddManyOpen(false)
    setAddManyText('')
    setAddManyInvalid(false)
  }

  const update = (index: number, field: 'key' | 'value', value: string): void => {
    setRows((current) => current.map((row, candidate) => candidate === index ? { ...row, [field]: value } : row))
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal environment-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-dialog-title">
        <div className="modal-title">
          <span id="environment-dialog-title">{t('Environment Variables')}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="environment-body">
          <div className="debug-table environment-table" role="grid" aria-label={t('Environment Variables')}>
            <div className="debug-table-header" role="columnheader">{t('Key')}</div>
            <div className="debug-table-header" role="columnheader">{t('Value')}</div>
            {rows.map((row, index) => (
              <div
                className={`environment-row${selected === index ? ' selected' : ''}`}
                role="row"
                aria-selected={selected === index}
                key={index}
                onMouseDown={() => setSelected(index)}
              >
                <input aria-label={`${t('Key')} ${index + 1}`} value={row.key} onChange={(event) => update(index, 'key', event.target.value)} />
                <input aria-label={`${t('Value')} ${index + 1}`} value={row.value} onChange={(event) => update(index, 'value', event.target.value)} />
              </div>
            ))}
          </div>
          <div className="environment-buttons">
            <button type="button" onClick={add}>{t('Add')}</button>
            <button type="button" onClick={() => { setAddManyOpen(true); setAddManyInvalid(false) }}>{t('Add Many')}</button>
            <button type="button" onClick={remove} disabled={selected === undefined}>{t('Remove')}</button>
            <button type="button" onClick={reset}>{t('Reset')}</button>
          </div>
        </div>
        {addManyOpen && (
          <div className="environment-add-many">
            <textarea
              aria-label={t('Add Many')}
              placeholder="A=1;B=2"
              value={addManyText}
              onChange={(event) => { setAddManyText(event.target.value); setAddManyInvalid(false) }}
            />
            {addManyInvalid && <span className="environment-error" role="alert">{t('Invalid Input String')}</span>}
            <div className="environment-add-many-actions">
              <button type="button" onClick={() => setAddManyOpen(false)}>{t('Cancel')}</button>
              <button type="button" className="primary" onClick={addMany}>{t('Add')}</button>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" onClick={() => { onAccept(rows); onClose() }}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
