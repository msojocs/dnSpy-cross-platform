import type * as Monaco from 'monaco-editor'
import { lineCompressionKind } from './document-viewer'

/** dnSpy's SpacerMargin.SELECTION_MARGIN_WIDTH: the blank strip before the text that selects whole lines. */
export const SELECTION_MARGIN_WIDTH = 10
/** The part of Monaco's line-decorations strip the bookmark markers are drawn in (the rest is the selection margin). */
export const BOOKMARK_STRIP_WIDTH = 14
/** dnSpy's LineCompressor.SCALE: a compressed line is three quarters as tall as a normal one. */
export const LINE_COMPRESSION_SCALE = 0.75

/** How many character widths a line takes on screen, counting a tab as the next tab stop. */
export const visualWidthOf = (text: string, tabSize: number): number => {
  let width = 0
  for (let index = 0; index < text.length; index++)
    width = text[index] === '\t' ? width + tabSize - (width % tabSize) : width + 1
  return width
}

/** The two line-compression options dnSpy's Advanced page turns over. */
export interface LineCompressionOptions {
  compressEmptyOrWhitespaceLines: boolean
  compressNonLetterLines: boolean
}

/** How a line's height is decided: the view's width in character widths, and whether it may wrap at all. */
export interface LineCompressionLayout {
  wraps: boolean
  /** The width of the text view, in pixels. */
  contentWidth: number
  /** The width of a character, in pixels. */
  charWidth: number
  tabSize: number
}

/**
 * dnSpy's LineCompressor: whether a line is drawn shorter than the others. A line that takes more than one view
 * line keeps its height — dnSpy leaves wrapped lines alone — and the caller decides which of the two kinds it
 * compresses.
 */
export const isCompressedLine = (text: string, options: LineCompressionOptions, layout: LineCompressionLayout): boolean => {
  const kind = lineCompressionKind(text)
  const compress = (kind === 'blank' && options.compressEmptyOrWhitespaceLines)
    || (kind === 'noLetters' && options.compressNonLetterLines)
  if (!compress)
    return false
  return !layout.wraps || text.length === 0 || visualWidthOf(text, layout.tabSize) * layout.charWidth <= layout.contentWidth
}

/** Selects the whole of the lines from `anchorLine` to `line`, including the line break, as dnSpy's SelectLine does. */
export const selectWholeLines = (editor: Monaco.editor.IStandaloneCodeEditor, anchorLine: number, line: number): void => {
  const model = editor.getModel()
  if (!model)
    return
  const from = Math.min(anchorLine, line)
  const to = Math.max(anchorLine, line)
  const next = Math.min(to + 1, model.getLineCount())
  editor.setSelection({
    startLineNumber: from,
    startColumn: 1,
    endLineNumber: next,
    endColumn: next === to + 1 ? 1 : model.getLineMaxColumn(next),
  })
}
