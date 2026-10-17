import { useEffect, useRef, useState } from 'react'
import appIconUrl from '../../../../../packaging/linux/icons/128x128.png'
// Both of these are read where they are written — the notices beside the package they describe and the
// credits out of the WPF tree — and are copied into this package's resources/ so the bundler has them,
// since it may not read above this package's root. A test keeps the copies the same as the originals.
import thirdPartyNotices from '../../../../resources/THIRD-PARTY-NOTICES.md?raw'
import credits from '../../../../resources/CREDITS.txt?raw'
import { useLanguage } from '../localization'
import { CloseGlyph } from './DsGlyphs'

interface AboutDialogProps {
  onClose(): void
}

/** Which of the dialog's two long texts is open. dnSpy shows them one after another in its About tab; here
 * they are folded away so the box stays a box, and only one is open at a time. */
type OpenText = 'credits' | 'notices' | undefined

export const AboutDialog = ({ onClose }: AboutDialogProps): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [version, setVersion] = useState<string>()
  const [openText, setOpenText] = useState<OpenText>(undefined)
  const { t } = useLanguage()

  useEffect(() => closeButton.current?.focus(), [])

  // dnSpy's AboutScreen writes the app's version at the top of the tab. It comes from the main process,
  // which is where the packaged version is known.
  useEffect(() => {
    let mounted = true
    void window.dnSpy.getStartupOptions().then((options) => {
      if (mounted) setVersion(options.version)
    })
    return () => { mounted = false }
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
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
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

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-description" onKeyDown={keepFocusInDialog}>
        <div className="modal-title">
          <span id="about-title">{t('About dnSpy')}</span>
          <button ref={closeButton} type="button" className="icon-button" aria-label={t('Close About')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="about-content">
          <div className="about-brand">
            <img className="about-logo" src={appIconUrl} alt="" />
            <div>
              {/* dnSpy's own heading is "dnSpy <version> (.NET)" (AboutScreen.Write). */}
              <div className="about-name">{version ? `dnSpy ${version} (.NET)` : 'dnSpy'}</div>
              <div className="about-version">{t('Version {version}', { version: version ?? '—' })}</div>
            </div>
          </div>
          <p id="about-description">{t('Cross-platform .NET assembly browser, decompiler, editor and debugger.')}</p>
          <p className="about-license">{t('Licensed under GNU GPL v3.0 only.')}</p>
          {/* dnSpy's About tab ends with the credits and the third-party licenses, one after the other
              (AboutScreen.WriteResourceFile). */}
          <div className="about-folds">
            <button type="button" className="about-fold" aria-expanded={openText === 'credits'} onClick={() => setOpenText(openText === 'credits' ? undefined : 'credits')}>
              {t('Credits')}
            </button>
            <button type="button" className="about-fold" aria-expanded={openText === 'notices'} onClick={() => setOpenText(openText === 'notices' ? undefined : 'notices')}>
              {t('Third-Party Notices')}
            </button>
          </div>
          {openText && (
            <pre className="about-text" aria-label={t(openText === 'credits' ? 'Credits' : 'Third-Party Notices')}>
              {openText === 'credits' ? credits : thirdPartyNotices}
            </pre>
          )}
        </div>
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button type="button" className="primary" onClick={onClose}>{t('Close')}</button>
        </div>
      </div>
    </div>
  )
}
