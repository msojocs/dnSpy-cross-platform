import { useEffect, useState } from 'react'
import { useLanguage } from '../localization'
import { CloseGlyph, MaximizeGlyph, MinimizeGlyph, RestoreGlyph } from './DsGlyphs'

/** The caption buttons of dnSpy's main window: MetroWindow's minimize, maximize or restore, and close
 *  (WinSysButton), each drawn with the template's own glyph. */
export const WindowControls = (): React.JSX.Element => {
  const [isMaximized, setIsMaximized] = useState(false)
  const { t } = useLanguage()

  useEffect(() => {
    let mounted = true
    void window.dnSpy.isWindowMaximized().then((value) => {
      if (mounted) setIsMaximized(value)
    })
    const unsubscribe = window.dnSpy.onWindowMaximizedChange(setIsMaximized)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const toggleMaximize = async (): Promise<void> => {
    setIsMaximized(await window.dnSpy.toggleMaximizeWindow())
  }

  return (
    <div className="window-controls" role="group" aria-label={t('Window controls')}>
      <button
        type="button"
        className="window-control-button"
        aria-label={t('Minimize window')}
        title={t('Minimize')}
        onClick={() => void window.dnSpy.minimizeWindow()}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="window-control-button"
        aria-label={isMaximized ? t('Restore window') : t('Maximize window')}
        title={isMaximized ? t('Restore') : t('Maximize')}
        onClick={() => void toggleMaximize()}
      >
        {isMaximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="window-control-button window-close-button"
        aria-label={t('Close window')}
        title={t('Close')}
        onClick={() => void window.dnSpy.closeWindow()}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}
