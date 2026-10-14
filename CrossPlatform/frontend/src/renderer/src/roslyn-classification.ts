import type * as Monaco from 'monaco-editor'
import type { ClassifiedSpan, ClassifyResponse } from '../../shared/protocol'

/**
 * Roslyn's semantic colors drawn over a Monaco editor — what dnSpy's RoslynClassifier feeds its text views. Each
 * span becomes an inline decoration in the `tc-<color>` class the stylesheet maps to the theme's colors, so the
 * editor's own (lexical) highlighting only shows until the first answer arrives.
 */
export const classificationDecorations = (
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  spans: readonly ClassifiedSpan[],
): Monaco.editor.IModelDeltaDecoration[] =>
  spans.filter((span) => span.length > 0).map((span) => {
    const start = model.getPositionAt(span.start)
    const end = model.getPositionAt(span.start + span.length)
    return {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: { inlineClassName: `tc-${span.color}` },
    }
  })

/** The spans of `text` as they stand in `text.trim()`: the part before it dropped, the ones past it clipped. */
export const spansOfTrimmed = (text: string, spans: readonly ClassifiedSpan[]): ClassifiedSpan[] => {
  const offset = text.length - text.trimStart().length
  const length = text.trim().length
  const result: ClassifiedSpan[] = []
  for (const span of spans) {
    const start = Math.max(0, span.start - offset)
    const end = Math.min(length, span.start + span.length - offset)
    if (end > start)
      result.push({ start, length: end - start, color: span.color })
  }
  return result
}

export interface Classifier extends Monaco.IDisposable {
  /** The colors of the text as it is now, or undefined while they are still being worked out. */
  current(): ClassifiedSpan[] | undefined
}

/**
 * Keeps an editor colored by `classify` as its text changes — the REPL editor's `OnCommandUpdatedAsync` loop:
 * every change asks again, and an answer for text that has changed since is dropped.
 */
export const attachClassifier = (
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  classify: (text: string) => Promise<ClassifyResponse>,
): Classifier => {
  const decorations = editor.createDecorationsCollection()
  let version = 0
  let latest: { text: string; spans: ClassifiedSpan[] } | undefined
  let disposed = false

  const refresh = (): void => {
    const model = editor.getModel()
    if (!model) return
    const requested = ++version
    const text = model.getValue()
    if (text.length === 0) {
      latest = { text, spans: [] }
      decorations.clear()
      return
    }
    classify(text).then((response) => {
      if (disposed || requested !== version || model.getValue() !== text) return
      latest = { text, spans: response.spans }
      decorations.set(classificationDecorations(monaco, model, response.spans))
    }, () => {
      // A failed classification leaves the text in the editor's own colors, as the WPF window does.
      if (requested === version) decorations.clear()
    })
  }

  const changed = editor.onDidChangeModelContent(refresh)
  refresh()
  return {
    current: () => {
      const text = editor.getModel()?.getValue()
      return latest && latest.text === text ? latest.spans : undefined
    },
    dispose: () => {
      disposed = true
      changed.dispose()
      decorations.clear()
    },
  }
}
