import { useRef, useState } from 'react'
import type {
  BreakpointConditionKind,
  BreakpointHitCountKind,
  BreakpointSettings,
} from '../../../shared/protocol'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { trapTabKey, useModalLayer } from './modal-stack'

/**
 * The breakpoint settings dialog, ported from dnSpy's `ShowCodeBreakpointSettingsVM`. Each section is
 * a checkbox that enables its own controls, so a breakpoint says nothing until it is asked to.
 *
 * Expressions are not checked here. The parser lives in the backend, and WPF does the same: a typo in
 * a condition shows up at the hit, where it breaks and reports itself rather than silently skipping.
 */
export const BreakpointSettingsDialog = ({ title, settings, onClose, onSave }: {
  title: string
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

  const [filterOn, setFilterOn] = useState(!!settings?.filter)
  const [filter, setFilter] = useState(settings?.filter ?? '')

  const [traceOn, setTraceOn] = useState(!!settings?.trace)
  const [trace, setTrace] = useState(settings?.trace?.message ?? '')
  const [traceContinue, setTraceContinue] = useState(settings?.trace?.continue ?? true)

  const [labels, setLabels] = useState(settings?.labels?.join(', ') ?? '')

  const hitCountValue = Number(hitCount)
  const hitCountValid = !hitCountOn || (Number.isInteger(hitCountValue) && hitCountValue > 0)

  const save = (): void => {
    const next: BreakpointSettings = {}
    if (conditionOn && condition !== '')
      next.condition = { kind: conditionKind, expression: condition }
    if (hitCountOn && hitCountValid)
      next.hitCount = { kind: hitCountKind, count: hitCountValue }
    if (filterOn && filter !== '')
      next.filter = filter
    if (traceOn && trace !== '')
      next.trace = { message: trace, continue: traceContinue }
    const parsedLabels = labels.split(',').map((label) => label.trim()).filter((label) => label !== '')
    if (parsedLabels.length > 0)
      next.labels = parsedLabels
    // The store normalizes this back to `undefined` when nothing was set, which is what clears a
    // breakpoint's settings: unticking every box and pressing OK.
    onSave(next)
    onClose()
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
        onKeyDown={(event) => trapTabKey(event, dialog.current)}
      >
        <div className="modal-title">
          <span id="breakpoint-settings-title">{title}</span>
          <button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>

        <div className="breakpoint-settings-body">
          <section className="breakpoint-setting">
            <label className="breakpoint-setting-header">
              <input type="checkbox" checked={conditionOn} onChange={(event) => setConditionOn(event.target.checked)} />
              <span>{t('Condition')}</span>
            </label>
            <div className="breakpoint-setting-controls">
              <select
                aria-label={t('Condition')}
                disabled={!conditionOn}
                value={conditionKind}
                onChange={(event) => setConditionKind(event.target.value as BreakpointConditionKind)}
              >
                <option value="isTrue">{t('Is true')}</option>
                <option value="whenChanged">{t('When changed')}</option>
              </select>
              <input
                aria-label={t('Expression')}
                disabled={!conditionOn}
                value={condition}
                onChange={(event) => setCondition(event.target.value)}
              />
            </div>
          </section>

          <section className="breakpoint-setting">
            <label className="breakpoint-setting-header">
              <input type="checkbox" checked={hitCountOn} onChange={(event) => setHitCountOn(event.target.checked)} />
              <span>{t('Hit Count')}</span>
            </label>
            <div className="breakpoint-setting-controls">
              <select
                aria-label={t('Hit Count')}
                disabled={!hitCountOn}
                value={hitCountKind}
                onChange={(event) => setHitCountKind(event.target.value as BreakpointHitCountKind)}
              >
                <option value="equals">{t('is equal to')}</option>
                <option value="multipleOf">{t('is a multiple of')}</option>
                <option value="greaterThanOrEquals">{t('is greater than or equal to')}</option>
              </select>
              <input
                type="number"
                min={1}
                aria-label={t('Hit Count')}
                aria-invalid={!hitCountValid}
                disabled={!hitCountOn}
                value={hitCount}
                onChange={(event) => setHitCount(event.target.value)}
              />
            </div>
          </section>

          <section className="breakpoint-setting">
            <label className="breakpoint-setting-header">
              <input type="checkbox" checked={filterOn} onChange={(event) => setFilterOn(event.target.checked)} />
              <span>{t('Filter')}</span>
            </label>
            <div className="breakpoint-setting-controls">
              <input
                aria-label={t('Filter')}
                disabled={!filterOn}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <p className="breakpoint-setting-help">
              {t('A filter can use {names}, for example {example}.', {
                names: 'MachineName, ProcessId, ProcessName, ThreadId, ThreadName',
                example: 'ProcessId == 0x1234 && ThreadName == "Main Thread"',
              })}
            </p>
          </section>

          <section className="breakpoint-setting">
            <label className="breakpoint-setting-header">
              <input type="checkbox" checked={traceOn} onChange={(event) => setTraceOn(event.target.checked)} />
              <span>{t('When Hit')}</span>
            </label>
            <div className="breakpoint-setting-controls">
              <input
                aria-label={t('Print message:')}
                disabled={!traceOn}
                value={trace}
                onChange={(event) => setTrace(event.target.value)}
              />
            </div>
            <label className="breakpoint-setting-continue">
              <input
                type="checkbox"
                disabled={!traceOn}
                checked={traceContinue}
                onChange={(event) => setTraceContinue(event.target.checked)}
              />
              <span>{t('Continue execution')}</span>
            </label>
            <p className="breakpoint-setting-help">
              {t('Use {expression} to print a value, and keywords such as {keywords}.', {
                expression: '{expression}',
                keywords: '$FUNCTION, $CALLER, $CALLSTACK, $TID, $TNAME, $PID, $PNAME',
              })}
            </p>
          </section>

          <section className="breakpoint-setting">
            <div className="breakpoint-setting-header"><span>{t('Labels')}</span></div>
            <div className="breakpoint-setting-controls">
              <input
                aria-label={t('Labels')}
                placeholder={t('Comma separated labels')}
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
              />
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={!hitCountValid} onClick={save}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
