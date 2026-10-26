import { useEffect, useState } from 'react'
import { normalizeZoom, zoomLevels } from '../zoom'
import { useLanguage } from '../localization'

/** dnSpy's ZoomControl box: the zoom as "100 %", which typing a number and Enter changes. */
export const ZoomControl = ({ zoom, onZoom, className, listId }: { zoom: number; onZoom(value: number): void; className: string; listId: string }): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(`${zoom} %`)
  useEffect(() => setText(`${zoom} %`), [zoom])
  const apply = (): void => {
    const value = Number.parseFloat(text.replace('%', '').trim())
    if (Number.isFinite(value) && value >= zoomLevels[0] && value <= zoomLevels[zoomLevels.length - 1])
      onZoom(normalizeZoom(value))
    else
      setText(`${zoom} %`)
  }
  return (
    <div className={className}>
      <input
        aria-label={t('Zoom')}
        list={listId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setText(`${zoom} %`)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
          }
          else if (event.key === 'Escape') {
            event.preventDefault()
            setText(`${zoom} %`)
          }
        }}
      />
      <datalist id={listId}>
        {[...zoomLevels].reverse().map((level) => <option key={level} value={`${level} %`} />)}
      </datalist>
    </div>
  )
}
