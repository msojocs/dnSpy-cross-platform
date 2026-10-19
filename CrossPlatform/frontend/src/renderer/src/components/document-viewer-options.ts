import { normalizeZoom } from '../zoom'
import { loadAppOptions, saveAppOptions } from './app-options'

/** Changes the document viewers' zoom — dnSpy keeps one ZoomLevel for all of them, and remembers it. */
export const setDocumentViewerZoom = (zoom: (current: number) => number): void => {
  const options = loadAppOptions()
  const next = normalizeZoom(zoom(options.documentViewer.zoomLevel))
  if (next !== options.documentViewer.zoomLevel)
    saveAppOptions({ ...options, documentViewer: { ...options.documentViewer, zoomLevel: next } })
}

/** Turns one of the Text Viewer's general options over — the View menu's toggles and their chords. */
export const toggleDocumentViewerOption = (option: 'wordWrap' | 'highlightCurrentLine' | 'useVisibleWhitespace'): void => {
  const options = loadAppOptions()
  const general = options.documentViewer.general
  saveAppOptions({ ...options, documentViewer: { ...options.documentViewer, general: { ...general, [option]: !general[option] } } })
}
