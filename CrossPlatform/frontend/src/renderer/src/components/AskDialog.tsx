import { useRef, useState } from 'react'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'
import { useModalLayer } from './modal-stack'

interface AskDialogProps {
  title: string
  /** The text box's label, translated by the caller. */
  label: string
  initial?: string
  /** Why the text cannot be accepted, already translated, or nothing when it can. */
  validate(text: string): string | undefined
  /** Runs the command; an answer is why it could not, shown in the box's place and leaving the dialog open. */
  onAccept(text: string): void | Promise<string | undefined>
  onClose(): void
}

/**
 * dnSpy's MsgBox.Ask: a title, one labelled text box whose text is checked as it is typed — the error shown under
 * it and OK greyed while there is one — and OK and Cancel. Go to RID and Go to MD Table Row are asked with it.
 */
export const AskDialog = ({ title, label, initial = '', validate, onAccept, onClose }: AskDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(initial)
  const [failure, setFailure] = useState<string>()
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)
  const error = validate(text)
  const accept = (): void => {
    if (error !== undefined)
      return
    const result = onAccept(text)
    if (result)
      void result.then(setFailure)
  }
  return (
    <div className="modal-backdrop" role="presentation" style={{ zIndex: 120 + depth * 10 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal hex-dialog ask-dialog" role="dialog" aria-modal="true" aria-label={t(title)} ref={dialog}>
        <div className="modal-title"><span>{t(title)}</span><button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="hex-dialog-body">
          <label className="hex-field">
            <span>{label}</span>
            <input
              autoFocus
              aria-label={label}
              aria-invalid={error !== undefined && text.length > 0}
              value={text}
              onChange={(event) => { setText(event.target.value); setFailure(undefined) }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); accept() } }}
            />
          </label>
          {(failure ?? (text.trim().length > 0 ? error : undefined)) !== undefined && <div className="modal-error" role="alert">{failure ?? error}</div>}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={error !== undefined} onClick={accept}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
