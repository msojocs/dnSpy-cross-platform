import { useEffect, useRef, useState } from 'react'
import { useAppOptions } from './app-options'
import { backgroundImageSize, limitImageSize, parseTimeSpan, placementAlignment, type Size } from './background-image'

/** The paths the window's box holds: one per line, blanks and spaces around them left out. */
const listedPaths = (images: string): string[] =>
  images.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)

/**
 * dnSpy's Background Image window: the images its settings point at, drawn behind everything in the window.
 * dnSpy gives each view — the text editor, the hex view — a copy of the same image; here there is one
 * window-wide layer under the whole shell, which is the same picture in the same place.
 */
export const BackgroundImage = (): React.JSX.Element | null => {
  const settings = useAppOptions().backgroundImage
  const host = useRef<HTMLDivElement>(null)
  const [sources, setSources] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })

  // The paths are read once per change: folders are expanded and every image is handed over as a data URL,
  // which the renderer cannot do for itself.
  useEffect(() => {
    const paths = settings.isEnabled ? listedPaths(settings.images) : []
    if (paths.length === 0) {
      setSources([])
      return
    }
    let current = true
    void window.dnSpy.loadBackgroundImages(paths).then((images) => {
      if (!current)
        return
      setSources(images.map((image) => image.dataUrl))
    })
    return () => { current = false }
  }, [settings.isEnabled, settings.images])

  // dnSpy's ImageSourceService shows the first image, or — when "Random Image" is on — picks one, and moves
  // to another every Interval.
  useEffect(() => {
    if (sources.length === 0)
      return
    if (!settings.isRandom) {
      setIndex(0)
      return
    }
    setIndex(Math.floor(Math.random() * sources.length))
    const milliseconds = parseTimeSpan(settings.interval)
    if (milliseconds === undefined || milliseconds <= 0 || sources.length < 2)
      return
    const timer = setInterval(() => setIndex((value) => (value + 1) % sources.length), milliseconds)
    return () => clearInterval(timer)
  }, [settings.isRandom, settings.interval, sources])

  // The image is drawn at a size worked out from the viewport, so the viewport has to be watched: a window
  // the user drags bigger has to carry the image with it.
  useEffect(() => {
    const element = host.current
    if (!element)
      return
    const measure = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [sources.length])

  // The editor and the tab surfaces read this to know that they are to show what is behind them.
  useEffect(() => {
    const showing = settings.isEnabled && sources.length > 0
    document.documentElement.dataset.backgroundImage = String(showing)
    return () => { delete document.documentElement.dataset.backgroundImage }
  }, [settings.isEnabled, sources.length])

  if (!settings.isEnabled || sources.length === 0)
    return null

  const url = sources[Math.min(index, sources.length - 1)]
  const inner: Size = {
    width: Math.max(viewport.width * (1 - (settings.leftMarginWidthPercent + settings.rightMarginWidthPercent) / 100), 0),
    height: Math.max(viewport.height * (1 - (settings.topMarginHeightPercent + settings.bottomMarginHeightPercent) / 100), 0),
  }
  const fitted = backgroundImageSize(natural, inner, settings.stretch, settings.stretchDirection)
  const limited = limitImageSize(fitted, settings.maxWidth, settings.maxHeight)
  const scale = settings.zoom / 100
  const alignment = placementAlignment(settings.imagePlacement)

  return (
    <div
      ref={host}
      className="background-image"
      aria-hidden="true"
      style={{
        // The margins are insets of the window, and the image is placed inside what they leave.
        inset: `${settings.topMarginHeightPercent}% ${settings.rightMarginWidthPercent}% ${settings.bottomMarginHeightPercent}% ${settings.leftMarginWidthPercent}%`,
        justifyContent: alignment.justifyContent,
        alignItems: alignment.alignItems,
      }}
    >
      <img
        src={url}
        alt=""
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={{
          width: limited.width * scale,
          height: limited.height * scale,
          opacity: settings.opacity,
          // dnSpy's two offsets move the image away from the edge its placement put it against.
          transform: `translate(${settings.horizontalOffset}px, ${settings.verticalOffset}px)`,
        }}
      />
    </div>
  )
}
