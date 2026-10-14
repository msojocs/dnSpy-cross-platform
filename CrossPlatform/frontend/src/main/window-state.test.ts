import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOnSomeDisplay, loadWindowState, resolveWindowPlacement, saveWindowState, type SavedWindowState } from './window-state'

const display = { x: 0, y: 0, width: 1920, height: 1080 }
const saved = (bounds: SavedWindowState['bounds'], rest: Partial<SavedWindowState> = {}): SavedWindowState =>
  ({ bounds, isMaximized: false, isFullScreen: false, ...rest })

describe('resolveWindowPlacement', () => {
  it('opens at dnSpy\'s default size, leaving the position to the window manager, when nothing was saved', () => {
    expect(resolveWindowPlacement(undefined, [display])).toEqual({ width: 1300, height: 730, isMaximized: false, isFullScreen: false })
  })

  it('puts back the saved bounds when they still land on a display', () => {
    expect(resolveWindowPlacement(saved({ x: 40, y: 60, width: 800, height: 500 }), [display]))
      .toEqual({ x: 40, y: 60, width: 800, height: 500, isMaximized: false, isFullScreen: false })
  })

  it('falls back to dnSpy\'s default rectangle when the saved position is off every display', () => {
    // The monitor the window was on is gone: the saved position is to the right of the one that is left.
    const offscreen = saved({ x: 3000, y: 3000, width: 800, height: 500 }, { isMaximized: true })
    expect(resolveWindowPlacement(offscreen, [display]))
      .toEqual({ x: 10, y: 10, width: 1300, height: 730, isMaximized: true, isFullScreen: false })
  })

  it('keeps a window that hangs off the edge, as long as enough of it is on the display', () => {
    // dnSpy asks for 50x50 visible, so a window past the right edge with its title bar showing is kept.
    const hanging = saved({ x: 1870, y: 100, width: 800, height: 500 })
    expect(resolveWindowPlacement(hanging, [display])).toMatchObject({ x: 1870, y: 100 })
  })

  it('restores a maximized window, and the full screen it was left in', () => {
    expect(resolveWindowPlacement(saved({ x: 0, y: 0, width: 800, height: 500 }, { isMaximized: true }), [display]).isMaximized).toBe(true)
    expect(resolveWindowPlacement(saved({ x: 0, y: 0, width: 800, height: 500 }, { isFullScreen: true }), [display]).isFullScreen).toBe(true)
  })

  it('does not maximize a window that was left full screen, as dnSpy restores one state or the other', () => {
    const both = saved({ x: 0, y: 0, width: 800, height: 500 }, { isMaximized: true, isFullScreen: true })
    expect(resolveWindowPlacement(both, [display])).toMatchObject({ isMaximized: false, isFullScreen: true })
  })
})

describe('isOnSomeDisplay', () => {
  it('measures the overlap against dnSpy\'s 50x50', () => {
    expect(isOnSomeDisplay({ x: 1870, y: 0, width: 800, height: 500 }, [display])).toBe(true)
    expect(isOnSomeDisplay({ x: 1871, y: 0, width: 800, height: 500 }, [display])).toBe(false)
    expect(isOnSomeDisplay({ x: 0, y: 1031, width: 800, height: 500 }, [display])).toBe(false)
  })

  it('accepts a display other than the first', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1080 }
    expect(isOnSomeDisplay({ x: 2000, y: 100, width: 800, height: 500 }, [display, second])).toBe(true)
  })
})

describe('loadWindowState', () => {
  const write = (contents: string): string => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dnspy-window-state-')), 'window-state.json')
    writeFileSync(file, contents)
    return file
  }

  it('reads back what was written', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dnspy-window-state-')), 'window-state.json')
    saveWindowState(file, saved({ x: 40, y: 60, width: 800, height: 500 }, { isMaximized: true }))
    expect(loadWindowState(file)).toEqual(saved({ x: 40, y: 60, width: 800, height: 500 }, { isMaximized: true }))
  })

  it('says nothing was saved for a file that is missing, unreadable or not what it should be', () => {
    expect(loadWindowState(path.join(tmpdir(), 'dnspy-no-such-window-state.json'))).toBeUndefined()
    expect(loadWindowState(write('not json'))).toBeUndefined()
    expect(loadWindowState(write('{"bounds":{"x":1,"y":2}}'))).toBeUndefined()
    expect(loadWindowState(write('{"bounds":{"x":null,"y":2,"width":800,"height":500}}'))).toBeUndefined()
    expect(loadWindowState(write('{"bounds":{"x":0,"y":0,"width":0,"height":0}}'))).toBeUndefined()
  })

  it('reads a state written without the state flags as a plain, unmaximized window', () => {
    expect(loadWindowState(write('{"bounds":{"x":1,"y":2,"width":800,"height":500}}')))
      .toEqual(saved({ x: 1, y: 2, width: 800, height: 500 }))
  })
})
