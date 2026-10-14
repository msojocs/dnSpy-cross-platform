import type { ImagePlacement, StretchDirectionMode, StretchMode } from './app-options'

/** A width and a height — the image's own, and the area it is being fitted into. */
export interface Size {
  width: number
  height: number
}

/** dnSpy's BackgroundImageSettings.Interval, a .NET time span string such as "00:05:00". Milliseconds, or
 *  undefined for a string that names no time — a span is `[-][d.]hh:mm[:ss[.fffffff]]`. */
export const parseTimeSpan = (value: string): number | undefined => {
  const match = /^(-)?(?:(\d+)\.)?(\d+):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/.exec(value.trim())
  if (!match)
    return undefined
  const [, sign, days, hours, minutes, seconds, fraction] = match
  const milliseconds = Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds ?? 0) * 1000
    + Number(`0.${fraction ?? ''}`) * 1000
  const total = milliseconds + Number(days ?? 0) * 86_400_000
  return sign ? -total : total
}

/**
 * How large the image is drawn, which is what its Stretch and StretchDirection come to: the image's own size
 * for None, the whole viewport for Fill, and the largest or smallest fit for the other two — with "Up Only"
 * and "Down Only" taking away whichever half of that the user asked to leave alone, as WPF's
 * StretchDirection does.
 */
export const backgroundImageSize = (
  image: Size,
  viewport: Size,
  stretch: StretchMode,
  direction: StretchDirectionMode,
): Size => {
  if (image.width <= 0 || image.height <= 0)
    return { width: 0, height: 0 }
  if (stretch === 'none')
    return { width: image.width, height: image.height }
  if (stretch === 'fill')
    return { width: viewport.width, height: viewport.height }
  const scale = stretch === 'uniformToFill'
    ? Math.max(viewport.width / image.width, viewport.height / image.height)
    : Math.min(viewport.width / image.width, viewport.height / image.height)
  // StretchDirection.Both scales either way; Up Only never shrinks an image below its own size, Down Only
  // never grows it past it.
  const bounded = direction === 'upOnly' ? Math.max(scale, 1) : direction === 'downOnly' ? Math.min(scale, 1) : scale
  return { width: image.width * bounded, height: image.height * bounded }
}

/** Where the image sits in the viewport, as the flex alignment its placement names. dnSpy's nine placements
 *  are the corners, the four edges and the middle. */
export const placementAlignment = (placement: ImagePlacement): { justifyContent: string; alignItems: string } => {
  const vertical = placement.startsWith('top') ? 'flex-start' : placement.startsWith('bottom') ? 'flex-end' : 'center'
  const horizontal = placement.endsWith('Left') ? 'flex-start' : placement.endsWith('Right') ? 'flex-end' : 'center'
  switch (placement) {
    case 'top': return { justifyContent: 'center', alignItems: 'flex-start' }
    case 'bottom': return { justifyContent: 'center', alignItems: 'flex-end' }
    case 'left': return { justifyContent: 'flex-start', alignItems: 'center' }
    case 'right': return { justifyContent: 'flex-end', alignItems: 'center' }
    case 'center': return { justifyContent: 'center', alignItems: 'center' }
    default: return { justifyContent: horizontal, alignItems: vertical }
  }
}

/** The largest size the image may be drawn at, which dnSpy's two 0-valued limits leave alone. */
export const limitImageSize = (size: Size, maxWidth: number, maxHeight: number): Size => ({
  width: maxWidth > 0 ? Math.min(size.width, maxWidth) : size.width,
  height: maxHeight > 0 ? Math.min(size.height, maxHeight) : size.height,
})
