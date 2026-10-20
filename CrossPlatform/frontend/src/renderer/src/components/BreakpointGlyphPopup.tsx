import { useEffect, useState } from 'react'
import type { TextPart } from '../../../shared/protocol'
import type { LineBreakpoint } from '../app-store'
import { useLanguage } from '../localization'
import { DsIcon } from './DsIcon'

type Translate = (message: string, values?: Record<string, string | number>) => string

/**
 * BreakpointGlyphTextMarkerHandler's tool tip: the bound message when there is one, the location — line, character,
 * IL offset and the method — and the conditions and actions the breakpoint has, each part on lines of its own.
 */
export const breakpointToolTip = (
  breakpoint: LineBreakpoint,
  position: { line: number; column: number },
  method: string | undefined,
  debugging: boolean,
  t: Translate,
): string => {
  const parts: string[] = []
  if (breakpoint.severity && breakpoint.message)
    parts.push(t('The breakpoint will not currently be hit. {message}', { message: t(breakpoint.message) }))
  const offset = breakpoint.ilOffset === undefined ? '(???)' : `0x${breakpoint.ilOffset.toString(16).toUpperCase().padStart(4, '0')}`
  parts.push(`${t('Location')}: ${t('line {line} character {character}', { line: position.line, character: position.column })} ${t('IL offset {offset}', { offset })}${method ? ` ('${method}')` : ''}`)
  const settings = breakpoint.settings
  const INDENTATION = '    '
  if (settings?.condition || settings?.hitCount || settings?.filter !== undefined) {
    const lines = [t('Conditions:')]
    if (settings.condition)
      lines.push(INDENTATION + t('Conditional expression:') + ' ' + (settings.condition.kind === 'whenChanged'
        ? t("'{expression}' has changed", { expression: settings.condition.expression })
        : t("'{expression}' is true", { expression: settings.condition.expression })))
    if (settings.hitCount) {
      const { kind, count } = settings.hitCount
      const text = kind === 'multipleOf'
        ? t('Hit count is a multiple of {count}', { count })
        : kind === 'greaterThanOrEquals'
          ? t('Hit count is greater than or equal to {count}', { count })
          : t('Hit count is equal to {count}', { count })
      lines.push(INDENTATION + text + (debugging ? ` (${t('currently {count}', { count: breakpoint.hitCount ?? 0 })})` : ''))
    }
    if (settings.filter !== undefined)
      lines.push(INDENTATION + t("Filter: '{filter}'", { filter: settings.filter }))
    parts.push(lines.join('\n'))
  }
  if (settings?.trace) {
    const lines = [t('Actions:')]
    if (!settings.trace.continue)
      lines.push(INDENTATION + t('Break'))
    lines.push(INDENTATION + t("Log message '{message}', to Output window", { message: settings.trace.message }))
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

/** The method a tool tip names, as dnSpy's decompiler writes it with FormatterOptions.Default. */
export const toolTipMethodText = (parts: TextPart[] | undefined): string | undefined => parts?.map((part) => part.text).join('')

/**
 * BreakpointGlyphPopupControl: when the mouse rests on a breakpoint's glyph, a small tool bar right of the margin and
 * above the line — Settings and Enable/Disable — and the breakpoint's tool tip under the line. It fades out a second
 * after the mouse has left both the margin and the tool bar, and comes back if the mouse returns.
 */
export const BreakpointGlyphPopup = ({ breakpoint, left, top, lineHeight, toolTip, fading, onSettings, onToggle, onEnter, onLeave }: {
  breakpoint: LineBreakpoint
  left: number
  top: number
  lineHeight: number
  toolTip: string
  fading: boolean
  onSettings(): void
  onToggle(): void
  onEnter(): void
  onLeave(): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(true), [])
  return (
    <>
      <div
        className={`breakpoint-glyph-popup${fading ? ' fading' : ''}`}
        role="toolbar"
        aria-label={t('Breakpoint')}
        style={{ left, top: top + 1 - 26, opacity: fading || !shown ? 0 : 1 }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <button className="icon-button" title={t('Settings...')} aria-label={t('Settings...')} onClick={onSettings}><DsIcon name="Settings" /></button>
        <button
          className="icon-button"
          title={breakpoint.enabled ? t('Disable breakpoint') : t('Enable breakpoint')}
          aria-label={breakpoint.enabled ? t('Disable breakpoint') : t('Enable breakpoint')}
          onClick={onToggle}
        ><DsIcon name="ToggleAllBreakpoints" /></button>
      </div>
      <div className="breakpoint-glyph-tooltip" role="tooltip" style={{ left, top: top + lineHeight }}>
        {toolTip.split('\n').map((line, index) => <div key={index} className={index === 0 && breakpoint.severity ? 'breakpoint-glyph-tooltip-error' : undefined}>{line || ' '}</div>)}
      </div>
    </>
  )
}
