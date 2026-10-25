import { normalizeZoom } from '../zoom'
import { loadAppOptions, saveAppOptions } from './app-options'

/**
 * Changes the C# Interactive window's zoom — dnSpy keeps a ZoomLevel for each REPL content type and remembers
 * it, and the window's Ctrl+wheel, its zoom control and the View menu's Zoom commands all change that one value.
 */
export const setReplCSharpZoom = (zoom: (current: number) => number): void => {
  const options = loadAppOptions()
  const repl = options.repl.cSharp
  const next = normalizeZoom(zoom(repl.zoomLevel))
  if (next !== repl.zoomLevel)
    saveAppOptions({ ...options, repl: { ...options.repl, cSharp: { ...repl, zoomLevel: next } } })
}
