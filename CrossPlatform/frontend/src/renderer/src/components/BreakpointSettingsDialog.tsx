import { useEffect, useRef, useState } from 'react'
import type {
  BreakpointConditionKind,
  BreakpointHitCountKind,
  BreakpointSettings,
} from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { DsIcon } from './DsIcon'
import { trapTabKey, useModalLayer } from './modal-stack'

/** The keywords a tracepoint message can use, the list ShowTracepointMessageHelp prints. */
const TRACEPOINT_KEYWORDS = `$ADDRESS $ADDRESS1 $ADDRESS2 $ADDRESS3 $ADDRESS4 $ADDRESS5
$ADID
$BPADDR
$CALLER $CALLER1 $CALLER2 $CALLER3 $CALLER4 $CALLER5
$CALLERMODULE $CALLERMODULE1 $CALLERMODULE2 $CALLERMODULE3 $CALLERMODULE4 $CALLERMODULE5
$CALLEROFFSET $CALLEROFFSET1 $CALLEROFFSET2 $CALLEROFFSET3 $CALLEROFFSET4 $CALLEROFFSET5
$CALLERTOKEN $CALLERTOKEN1 $CALLERTOKEN2 $CALLERTOKEN3 $CALLERTOKEN4 $CALLERTOKEN5
$CALLSTACK $CALLSTACK5 $CALLSTACK10 $CALLSTACK15 $CALLSTACK20
$FUNCTION $FUNCTION1 $FUNCTION2 $FUNCTION3 $FUNCTION4 $FUNCTION5
$MID
$PID
$PNAME
$TID
$TNAME`

/**
 * dnSpy's Breakpoint Settings dialog (ShowCodeBreakpointSettingsDlg): four rows, each a box that switches its own
 * controls on — the conditional expression and how it decides, the hit count and how it compares, the filter, and the
 * message logged with whether execution goes on. A box that is on is kept even with empty text, as dnSpy keeps it.
 * The filter is checked as it is typed, and an expression that does not read keeps OK disabled with the reason
 * beside it; the condition and the message are only evaluated at a hit.
 */
export const BreakpointSettingsDialog = ({ settings, onClose, onSave }: {
  settings: BreakpointSettings | undefined
  onClose(): void
  onSave(settings: BreakpointSettings | undefined): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)

  const [conditionOn, setConditionOn] = useState(!!settings?.condition)
  const [conditionKind, setConditionKind] = useState<BreakpointConditionKind>(settings?.condition?.kind ?? 'isTrue')
  const [condition, setCondition] = useState(settings?.condition?.expression ?? '')

  const [hitCountOn, setHitCountOn] = useState(!!settings?.hitCount)
  const [hitCountKind, setHitCountKind] = useState<BreakpointHitCountKind>(settings?.hitCount?.kind ?? 'equals')
  // Kept as text so a half-typed number does not snap back to a valid one under the user's cursor.
  const [hitCount, setHitCount] = useState(String(settings?.hitCount?.count ?? 1))

  const [filterOn, setFilterOn] = useState(settings?.filter !== undefined)
  const [filter, setFilter] = useState(settings?.filter ?? '')
  const [filterError, setFilterError] = useState<string | null>(null)

  const [traceOn, setTraceOn] = useState(!!settings?.trace)
  const [trace, setTrace] = useState(settings?.trace?.message ?? '')
  const [traceContinue, setTraceContinue] = useState(settings?.trace?.continue ?? true)

  const hitCountValue = Number(hitCount)
  const hitCountValid = !hitCountOn || (Number.isInteger(hitCountValue) && hitCountValue > 0)

  // dnSpy verifies the filter on a timer after each keystroke; the answer is the backend's parser's.
  useEffect(() => {
    if (!filterOn) {
      setFilterError(null)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      void window.dnSpy.verifyBreakpointFilter?.(filter).then((error) => { if (current) setFilterError(error) }, () => { if (current) setFilterError(null) })
    }, 250)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [filterOn, filter])

  const hasError = !hitCountValid || (filterOn && filterError !== null)

  const save = (): void => {
    if (hasError)
      return
    const next: BreakpointSettings = {}
    if (conditionOn)
      next.condition = { kind: conditionKind, expression: condition }
    if (hitCountOn)
      next.hitCount = { kind: hitCountKind, count: hitCountValue }
    if (filterOn)
      next.filter = filter
    if (traceOn)
      next.trace = { message: trace, continue: traceContinue }
    onSave(next)
    onClose()
  }

  const showFilterHelp = (): void => {
    void window.dnSpy.showMessage([
      t('Example: {example}', { example: 'ProcessId == 0x1234 && ThreadName == "Main Thread"' }),
      '',
      t('Variables that can be used:'),
      '',
      'MachineName\nProcessId\nProcessName\nThreadId\nThreadName',
    ].join('\n'))
  }

  const showTraceHelp = (): void => {
    void window.dnSpy.showMessage([
      t('Example: {example}', { example: '$CALLERTOKEN: string: {s}' }),
      '',
      t('Use {xxx} to evaluate expression xxx'),
      '',
      t('Escape sequences: {sequences}', { sequences: '\\\\ \\$ \\{ \\} \\a \\b \\f \\n \\r \\t \\v' }),
      '',
      t('The following keywords can be used:'),
      '',
      TRACEPOINT_KEYWORDS,
    ].join('\n'))
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ zIndex: 100 + depth * 10 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        ref={dialog}
        className="modal breakpoint-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="breakpoint-settings-title"
        onKeyDown={(event) => {
          trapTabKey(event, dialog.current)
          if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault()
            save()
          }
        }}
      >
        <div className="modal-title">
          <span id="breakpoint-settings-title">{t('Breakpoint Settings')}</span>
          <button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>

        <div className="breakpoint-settings-grid">
          <label className="breakpoint-setting-check">
            <input type="checkbox" checked={conditionOn} onChange={(event) => setConditionOn(event.target.checked)} />
            <span>{t('Conditional Expression')}</span>
          </label>
          <select aria-label={t('Conditional Expression')} disabled={!conditionOn} value={conditionKind} onChange={(event) => setConditionKind(event.target.value as BreakpointConditionKind)}>
            <option value="isTrue">{t('Is true')}</option>
            <option value="whenChanged">{t('When changed')}</option>
          </select>
          <input aria-label={t('Expression')} disabled={!conditionOn} value={condition} onChange={(event) => setCondition(event.target.value)} />
          <span />

          <label className="breakpoint-setting-check">
            <input type="checkbox" checked={hitCountOn} onChange={(event) => setHitCountOn(event.target.checked)} />
            <span>{t('Hit Count')}</span>
          </label>
          <select aria-label={t('Hit Count')} disabled={!hitCountOn} value={hitCountKind} onChange={(event) => setHitCountKind(event.target.value as BreakpointHitCountKind)}>
            <option value="equals">=</option>
            <option value="multipleOf">{t('Is a multiple of')}</option>
            <option value="greaterThanOrEquals">&gt;=</option>
          </select>
          <input
            aria-label={t('Hit count value')}
            aria-invalid={!hitCountValid}
            disabled={!hitCountOn}
            value={hitCount}
            onChange={(event) => setHitCount(event.target.value)}
          />
          <span />

          <label className="breakpoint-setting-check">
            <input type="checkbox" checked={filterOn} onChange={(event) => setFilterOn(event.target.checked)} />
            <span>{t('Filter')}</span>
          </label>
          <span />
          <input aria-label={t('Filter')} aria-invalid={filterOn && filterError !== null} title={filterOn ? filterError ?? undefined : undefined} disabled={!filterOn} value={filter} onChange={(event) => setFilter(event.target.value)} />
          <button className="icon-button" title={t('Help')} aria-label={t('Filter help')} onClick={showFilterHelp}><DsIcon name="StatusHelp" /></button>

          <label className="breakpoint-setting-check">
            <input type="checkbox" checked={traceOn} onChange={(event) => setTraceOn(event.target.checked)} />
            <span>{t('Log Message')}</span>
          </label>
          <label className="breakpoint-setting-continue">
            <input type="checkbox" disabled={!traceOn} checked={traceContinue} onChange={(event) => setTraceContinue(event.target.checked)} />
            <span>{t('Continue execution')}</span>
          </label>
          <input aria-label={t('Log Message')} disabled={!traceOn} value={trace} onChange={(event) => setTrace(event.target.value)} />
          <button className="icon-button" title={t('Help')} aria-label={t('Log message help')} onClick={showTraceHelp}><DsIcon name="StatusHelp" /></button>
        </div>

        <div className="modal-actions">
          <span className="breakpoint-settings-error" role="status">{filterOn && filterError ? filterError : ''}</span>
          <span className="modal-action-spacer" />
          <button className="primary" disabled={hasError} onClick={save}>{t('OK')}</button>
          <button onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}
