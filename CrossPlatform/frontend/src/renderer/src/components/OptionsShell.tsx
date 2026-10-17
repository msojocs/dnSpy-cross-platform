import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { trapTabKey, useModalLayer } from './modal-stack'

export interface OptionsTab {
  /** The tab's caption, which is the resource string the WPF dialog's `TabItem` carries. */
  label: string
  /** What the tab says about itself, for the rare page that needs to say anything at all — dnSpy's
   * `Kind` page is one, where the tooltip is the whole reason the page can be ignored. */
  tooltip?: string
  content: React.ReactNode
}

interface OptionsShellProps {
  /** The dialog's title. dnSpy's dialogs are one window for creating and editing both, so the only
   * thing that tells them apart is this and the values it was handed. */
  title: string
  tabs: OptionsTab[]
  onAccept(): void
  onClose(): void
  /** Puts every value back to what the dialog opened with — dnSpy's "Restore Settings" button. */
  onReset?(): void
  /** What dnSpy calls `HasError`: the dialog's own validation, which gates its OK button. */
  invalid?: boolean
  busy?: boolean
  error?: string
  /** The tab to open on; the first one unless something else is more useful. */
  initialTab?: number
  /** Drops the tab strip for a dialog that has no tabs at all — dnSpy's custom attribute dialog is the
   * one, and it takes the same shell with its single page showing. */
  hideTabStrip?: boolean
  className?: string
}

/**
 * The window every asm-editor dialog is drawn in: a title bar, the tab strip the WPF dialogs put their
 * option pages on, and the button row at the bottom.
 *
 * The tab strip is a strip of buttons rather than anything the platform draws, for the same reason the
 * rest of this port renders its own chrome — and because WPF's `TabItem`s carry no icons or badges that
 * would be lost by it.
 */
export const OptionsShell = ({ title, tabs, onAccept, onClose, onReset, invalid = false, busy = false, error, initialTab = 0, hideTabStrip = false, className }: OptionsShellProps): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  // Only the innermost dialog answers Escape: a tab list opens pickers and item dialogs over this one,
  // and Escape belongs to whichever of them is on top.
  const depth = useModalLayer(onClose)
  const { t } = useLanguage()
  const [tab, setTab] = useState(initialTab)

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ zIndex: 100 + depth * 10 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        ref={dialog}
        className={`modal options-shell${hideTabStrip ? ' no-tabs' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t(title)}
        onKeyDown={(event) => trapTabKey(event, dialog.current)}
      >
        <div className="modal-title"><span>{t(title)}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        {!hideTabStrip && (
          <div className="options-tabs" role="tablist">
            {tabs.map((entry, index) => (
              <button
                key={entry.label}
                type="button"
                role="tab"
                id={`options-tab-${index}`}
                aria-selected={index === tab}
                aria-controls={`options-tabpanel-${index}`}
                title={entry.tooltip === undefined ? undefined : t(entry.tooltip)}
                className={index === tab ? 'selected' : undefined}
                onClick={() => setTab(index)}
              >
                {t(entry.label)}
              </button>
            ))}
          </div>
        )}
        <div className="options-tabpanel" role="tabpanel" id={`options-tabpanel-${tab}`} aria-labelledby={hideTabStrip ? undefined : `options-tab-${tab}`}>
          {tabs[tab]?.content}
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          {onReset && <button type="button" disabled={busy} onClick={onReset}>{t('Reset')}</button>}
          <span className="modal-action-spacer" />
          <button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={invalid || busy} onClick={onAccept}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
