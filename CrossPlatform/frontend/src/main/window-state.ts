import { readFileSync, writeFileSync } from 'node:fs'
import type { BrowserWindow, Rectangle } from 'electron'

/** dnSpy's SavedWindowState: the window's normal bounds, whether it was maximized, and whether it was full
 * screen. The bounds are the ones the window goes back to when it is restored from either of the other two. */
export interface SavedWindowState {
  bounds: Rectangle
  isMaximized: boolean
  isFullScreen: boolean
}

/** Where a window is put when the app starts. `x` and `y` are left out when no position was ever saved, which
 * leaves the window manager to pick one — dnSpy does the same, and only sets Top/Left for saved bounds. */
export interface WindowPlacement {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
  isFullScreen: boolean
}

/** dnSpy's AppWindow.DefaultWindowLocation (10, 10, 1300, 730). It is both the size a window opens at when
 * nothing was saved and the whole rectangle it falls back to when what was saved no longer fits a display. */
const defaultWindowX = 10
const defaultWindowY = 10
const defaultWindowWidth = 1300
const defaultWindowHeight = 730

/** dnSpy's SavedWindowStateRestorer: this much of a saved window has to land on some display for the saved
 * position to be used. Anything less is a window whose monitor is gone, and it goes back to the default. */
const minVisibleWidth = 50
const minVisibleHeight = 50

/** The area two rectangles share. Negative when they are apart, which is the "no overlap" answer below. */
const intersectionSize = (a: Rectangle, b: Rectangle): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
})

/** Whether enough of `bounds` lands on one of `displays` to be worth restoring to. */
export const isOnSomeDisplay = (bounds: Rectangle, displays: readonly Rectangle[]): boolean =>
  displays.some((display) => {
    const visible = intersectionSize(bounds, display)
    return visible.width >= minVisibleWidth && visible.height >= minVisibleHeight
  })

/** dnSpy's SavedWindowStateRestorer, in Electron's terms: where the window goes and in what state it opens. */
export const resolveWindowPlacement = (saved: SavedWindowState | undefined, displays: readonly Rectangle[]): WindowPlacement => {
  const isFullScreen = saved?.isFullScreen ?? false
  // A full screen window keeps no maximized state of its own, and dnSpy restores the window state only when
  // the window was not full screen — otherwise the two would fight over the same window.
  const isMaximized = !isFullScreen && (saved?.isMaximized ?? false)
  if (saved && isOnSomeDisplay(saved.bounds, displays))
    return { x: saved.bounds.x, y: saved.bounds.y, width: saved.bounds.width, height: saved.bounds.height, isMaximized, isFullScreen }
  // Nothing saved, or a saved position that no longer lands on a display: dnSpy's default rectangle. Its
  // size alone is used when nothing was saved at all, and the position is left to the window manager.
  if (!saved)
    return { width: defaultWindowWidth, height: defaultWindowHeight, isMaximized, isFullScreen }
  return { x: defaultWindowX, y: defaultWindowY, width: defaultWindowWidth, height: defaultWindowHeight, isMaximized, isFullScreen }
}

/** What the window is to be remembered as. The normal bounds are read so a maximized or full screen window
 * still remembers the size it goes back to. dnSpy reads MetroWindow.RestoreBounds for the same reason. */
export const captureWindowState = (window: BrowserWindow): SavedWindowState => ({
  bounds: window.getNormalBounds(),
  isMaximized: window.isMaximized(),
  isFullScreen: window.isFullScreen(),
})

const isRectangle = (value: unknown): value is Rectangle => {
  if (typeof value !== 'object' || value === null)
    return false
  const rect = value as Partial<Rectangle>
  return Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && (rect.width ?? 0) > 0 && (rect.height ?? 0) > 0
}

const toSavedWindowState = (value: unknown): SavedWindowState | undefined => {
  if (typeof value !== 'object' || value === null)
    return undefined
  const parsed = value as Partial<SavedWindowState>
  if (!isRectangle(parsed.bounds))
    return undefined
  return {
    bounds: parsed.bounds,
    isMaximized: parsed.isMaximized === true,
    isFullScreen: parsed.isFullScreen === true,
  }
}

/** A state that cannot be read is the same as one that was never written: the window opens at its default
 * size, and the app must not fail to start over it. */
export const loadWindowState = (filePath: string): SavedWindowState | undefined => {
  try {
    return toSavedWindowState(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return undefined
  }
}

export const saveWindowState = (filePath: string, state: SavedWindowState): void => {
  try {
    writeFileSync(filePath, JSON.stringify(state))
  } catch {
    // A window state that cannot be written must not stand in the way of the window that is closing.
  }
}
