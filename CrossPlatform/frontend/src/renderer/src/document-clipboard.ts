import * as monaco from 'monaco-editor/editor/editor.api'
import type { TextSpan } from '../../shared/protocol'
import { buildClipboardHtml, type ColoredRun } from './document-viewer'
import { textColorValue } from './document-editor'
import { useAppStore } from './app-store'

/** dnSpy's HtmlBuilderService leaves out the HTML flavor for a copy past one MiB of text. */
const MAX_HTML_COPY_LENGTH = 1024 * 1024

/** The color each of Monaco's token classes (`mtk<n>`) is drawn in, read off the stylesheet the theme writes. */
const tokenColors = (): Map<string, string> => {
  const colors = new Map<string, string>()
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule))
        continue
      const match = /\.(mtk\d+)$/.exec(rule.selectorText)
      if (match && rule.style.color)
        colors.set(match[1], rule.style.color)
    }
  }
  return colors
}

/** The color of every character of a line: Monaco's lexical color, then dnSpy's color for the spans over it. */
const lineColors = (model: monaco.editor.ITextModel, lineNumber: number, spans: readonly TextSpan[], tokens: Map<string, string>): (string | undefined)[] => {
  const text = model.getLineContent(lineNumber)
  const colors: (string | undefined)[] = new Array<string | undefined>(text.length).fill(undefined)
  const html = monaco.editor.colorizeModelLine(model, lineNumber, model.getOptions().tabSize)
  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  let column = 0
  for (const element of Array.from(parsed.body.querySelectorAll('span'))) {
    const token = Array.from(element.classList).find((name) => /^mtk\d+$/.test(name))
    const color = token ? tokens.get(token) : undefined
    // colorizeModelLine writes a space as a non-breaking one and expands nothing else, so lengths agree.
    const length = (element.textContent ?? '').length
    for (let index = column; index < column + length && index < colors.length; index++)
      colors[index] = color
    column += length
  }
  const lineStart = model.getOffsetAt({ lineNumber, column: 1 })
  const lineEnd = lineStart + text.length
  for (const span of spans) {
    if (!span.color || span.start >= lineEnd || span.start + span.length <= lineStart)
      continue
    const color = textColorValue(span.color)
    if (!color)
      continue
    for (let offset = Math.max(span.start, lineStart); offset < Math.min(span.start + span.length, lineEnd); offset++)
      colors[offset - lineStart] = color
  }
  return colors
}

const runsOf = (text: string, colors: readonly (string | undefined)[]): ColoredRun[] => {
  const runs: ColoredRun[] = []
  for (let index = 0; index < text.length; index++) {
    const color = colors[index]
    const last = runs[runs.length - 1]
    if (last && last.color === color)
      last.text += text[index]
    else
      runs.push({ text: text[index], color })
  }
  return runs
}

/**
 * dnSpy's copy in a text view (EditorOperations.CutOrCopySelection): the selected text, or the caret's whole line
 * when nothing is selected, as plain text and — up to a MiB of it — as HTML in the colors the view shows it in.
 */
export const copyWithFormatting = async (
  editor: monaco.editor.ICodeEditor,
  spans: readonly TextSpan[],
  translate: (message: string, values?: Record<string, string | number>) => string,
): Promise<void> => {
  const model = editor.getModel()
  const selections = editor.getSelections()
  if (!model || !selections || selections.length === 0)
    return
  const nonEmpty = selections.filter((selection) => !selection.isEmpty())
    .sort((left, right) => left.startLineNumber - right.startLineNumber || left.startColumn - right.startColumn)
  const ranges: monaco.IRange[] = nonEmpty.length > 0
    ? nonEmpty
    : [(() => {
        const line = selections[0].positionLineNumber
        return line < model.getLineCount()
          ? { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }
          : { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }
      })()]
  const eol = model.getEOL()
  const text = ranges.map((range) => model.getValueInRange(range)).join(eol)
  let html: string | undefined
  if (text.length <= MAX_HTML_COPY_LENGTH) {
    const tokens = tokenColors()
    const lines: ColoredRun[][] = []
    for (const range of ranges) {
      for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber; lineNumber++) {
        const content = model.getLineContent(lineNumber)
        const from = lineNumber === range.startLineNumber ? range.startColumn - 1 : 0
        const to = lineNumber === range.endLineNumber ? range.endColumn - 1 : content.length
        // A range that ends at the start of a line ends with the line break before it.
        if (lineNumber === range.endLineNumber && lineNumber !== range.startLineNumber && to === 0)
          continue
        const colors = lineColors(model, lineNumber, spans, tokens)
        lines.push(runsOf(content.slice(from, to), colors.slice(from, to)))
      }
    }
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo)
    html = buildClipboardHtml(lines, fontInfo.fontFamily, fontInfo.fontSize, model.getOptions().tabSize)
  }
  try {
    const items: Record<string, Blob> = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
    if (html !== undefined)
      items['text/html'] = new Blob([html], { type: 'text/html' })
    await navigator.clipboard.write([new ClipboardItem(items)])
  } catch {
    try {
      await navigator.clipboard.writeText(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useAppStore.getState().appendOutput(translate('Copy failed: {message}', { message }))
    }
  }
}
