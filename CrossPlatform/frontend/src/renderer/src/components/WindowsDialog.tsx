import { useEffect, useMemo, useRef, useState } from 'react'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'

/** One row of the Windows dialog — a document tab the layout currently shows. */
export interface WindowTabEntry {
  id: string
  name: string
  moduleName: string
  modulePath: string
}

interface WindowsDialogProps {
  tabs: WindowTabEntry[]
  onActivate(tabId: string): void
  /** Enabled with exactly one selected code document, like the File menu's Save. */
  canSave(tabId: string): boolean
  onSave(tabId: string): void
  onCloseTabs(tabIds: string[]): void
  onClose(): void
}

/**
 * dnSpy's TabsDlg (Window > Windows...): a list of every open document tab with Activate, Save and
 * Close Window buttons. Double-clicking a row activates that tab, and several rows can be selected
 * for Close Window.
 */
export const WindowsDialog = ({ tabs, onActivate, canSave, onSave, onCloseTabs, onClose }: WindowsDialogProps): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(tabs[0] ? [tabs[0].id] : []))
  const { t } = useLanguage()

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('.windows-dialog-row[aria-selected="true"]')?.focus()
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const keepFocusInDialog = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Tab' || !dialog.current)
      return
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    if (focusable.length === 0)
      return
    const first = focusable[0]
    const last = focusable.at(-1)!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const liveSelected = useMemo(() => {
    const ids = new Set(tabs.map((tab) => tab.id))
    return new Set([...selected].filter((id) => ids.has(id)))
  }, [selected, tabs])

  const pick = (tabId: string, event: React.MouseEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(liveSelected)
      if (next.has(tabId)) next.delete(tabId)
      else next.add(tabId)
      setSelected(next)
    } else if (event.shiftKey) {
      const anchor = [...liveSelected].at(-1) ?? tabId
      const ids = tabs.map((tab) => tab.id)
      const from = ids.indexOf(anchor)
      const to = ids.indexOf(tabId)
      setSelected(new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1)))
    } else {
      setSelected(new Set([tabId]))
    }
  }

  const selectedOne = liveSelected.size === 1 ? [...liveSelected][0] : undefined
  const activate = (): void => {
    if (selectedOne)
      onActivate(selectedOne)
  }
  const closeSelected = (): void => {
    if (liveSelected.size > 0) {
      onCloseTabs([...liveSelected])
      setSelected(new Set())
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal windows-dialog" role="dialog" aria-modal="true" aria-labelledby="windows-dialog-title" onKeyDown={keepFocusInDialog}>
        <div className="modal-title">
          <span id="windows-dialog-title">{t('Windows')}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="windows-dialog-table" role="grid" aria-label={t('Windows')}>
          <div className="windows-dialog-header" role="row">
            <span role="columnheader">{t('Name')}</span>
            <span role="columnheader">{t('Module')}</span>
            <span role="columnheader">{t('Path')}</span>
          </div>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="row"
              tabIndex={-1}
              className={`windows-dialog-row${liveSelected.has(tab.id) ? ' windows-dialog-row-selected' : ''}`}
              aria-selected={liveSelected.has(tab.id)}
              onClick={(event) => pick(tab.id, event)}
              onDoubleClick={() => { setSelected(new Set([tab.id])); onActivate(tab.id) }}
            >
              <span role="gridcell" title={tab.name}>{tab.name}</span>
              <span role="gridcell" title={tab.moduleName}>{tab.moduleName}</span>
              <span role="gridcell" title={tab.modulePath}>{tab.modulePath}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button type="button" className="primary" disabled={!selectedOne} onClick={activate}>{t('Activate')}</button>
          <button type="button" disabled={!selectedOne || !canSave(selectedOne)} onClick={() => { if (selectedOne) onSave(selectedOne) }}>{t('Save')}</button>
          <button type="button" disabled={liveSelected.size === 0} onClick={closeSelected}>{t('Close Window')}</button>
        </div>
      </div>
    </div>
  )
}
