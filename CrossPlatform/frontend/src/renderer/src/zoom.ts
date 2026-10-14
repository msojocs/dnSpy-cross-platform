/**
 * dnSpy's ZoomSelector: the levels the tab content is scaled through, Ctrl+wheel and the three Ctrl keys
 * stepping one level at a time. The list is dnSpy's own — rounded from 100 * 1.1^x, the steps the text
 * editor takes, with the larger ones picked so images are not left blurry.
 */
export const zoomLevels: readonly number[] = [
  20, 22, 24, 26, 29, 32, 35, 39, 42, 47, 50, 56, 62, 70, 75, 83, 91, 100,
  110, 125, 140, 150, 175, 200, 225, 250, 275, 300, 350, 400,
]

/** dnSpy keeps a zoom within 5% of 1 as plain 100%: ZoomSelector.SetZoomValue snaps it back. */
const snapsTo100 = (percent: number): boolean => Math.abs(percent - 100) < 5

/** The level above the one given, or the top level when it is already at or above it. */
export const zoomIn = (percent: number): number => zoomLevels.find((level) => level > percent) ?? zoomLevels[zoomLevels.length - 1]

/** The level below the one given, or the bottom level when it is already at or below it. */
export const zoomOut = (percent: number): number => [...zoomLevels].reverse().find((level) => level < percent) ?? zoomLevels[0]

/** Puts a level back inside the range dnSpy allows and snaps the ones near 100% to it. */
export const normalizeZoom = (percent: number): number => {
  if (!Number.isFinite(percent))
    return 100
  if (snapsTo100(percent))
    return 100
  return Math.min(zoomLevels[zoomLevels.length - 1], Math.max(zoomLevels[0], Math.round(percent)))
}
