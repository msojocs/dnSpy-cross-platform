import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../localization'

/**
 * dnSpy's WaitAdorner over a tab that decompiles: "Decompiling...", an indeterminate progress bar and a Cancel button
 * that takes the keyboard focus when the tab had it. It fades in over half a second (DocumentViewerControl's
 * ShowCancelButton) so a small document never flickers it, and swallows the mouse the way the adorner does. The
 * button disables itself once clicked, like WaitAdorner.button_Click.
 */
export const WaitAdorner = ({ message, onCancel }: { message: string; onCancel(): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [canceled, setCanceled] = useState(false)

  useEffect(() => {
    const button = buttonRef.current
    // Only a tab that had the keyboard focus hands it to the button; one the user is not in leaves it where it is.
    const host = button?.closest('.document-view')
    if (button && host && (host.contains(document.activeElement) || document.activeElement === document.body))
      button.focus()
  }, [])

  return (
    <div
      className="wait-adorner"
      role="status"
      aria-live="polite"
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
    >
      <div className="wait-adorner-content">
        <div className="wait-adorner-message">{message}</div>
        <progress className="wait-adorner-progress" aria-label={message} />
        <div className="modal-actions wait-adorner-actions">
          <button
            ref={buttonRef}
            type="button"
            disabled={canceled}
            onClick={() => {
              setCanceled(true)
              onCancel()
            }}
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
