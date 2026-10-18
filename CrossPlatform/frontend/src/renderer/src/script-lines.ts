import type { ClassifiedSpan, ScriptOutputEntry, ScriptOutputKind } from '../../shared/protocol'

/** One rendered stretch of a log line: a color class, semantic colors, or neither. */
export interface ScriptLinePart {
  text: string
  /** A color class name the host gave the line. */
  color?: string | null
  /** Semantic colors, for an echo of input that was colored while it was typed. */
  colors?: readonly ClassifiedSpan[]
}

/** One line of the log the window draws. */
export interface ScriptLine {
  kind: ScriptOutputKind
  parts: ScriptLinePart[]
  /** An echo line's code, without its prompt: what Save Code and Copy Code write. */
  code?: string
}

/**
 * Lets the parts of a line span several entries — a script's `Print` leaves a line open for the
 * next `Print` or `PrintLine` — and ends the line at the newline the host writes. The terminal kinds
 * (a result, a diagnostic, help) end their line even without one.
 */
export const scriptLines = (entries: readonly ScriptOutputEntry[]): ScriptLine[] => {
  const lines: ScriptLine[] = []
  let open: ScriptLine | undefined
  const flush = (): void => {
    if (open) {
      lines.push(open)
      open = undefined
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'echo') {
      flush()
      let offset = 0
      for (const [index, code] of entry.text.split('\n').entries()) {
        const parts: ScriptLinePart[] = [{ text: index === 0 ? '> ' : '. ' }]
        if (entry.colors) {
          const lineSpans = entry.colors
            .filter((span) => span.start >= offset && span.start + span.length <= offset + code.length)
            .map((span) => ({ ...span, start: span.start - offset }))
          if (lineSpans.length > 0)
            parts.push({ text: code, colors: lineSpans })
          else
            parts.push({ text: code })
        }
        else
          parts.push({ text: code })
        lines.push({ kind: 'echo', parts, code })
        offset += code.length + 1
      }
      continue
    }
    // Only output fragments can leave a line open; everything else starts on a line of its own.
    if (entry.kind !== 'output')
      flush()
    const segments = entry.text.split('\n')
    for (const [index, text] of segments.entries()) {
      if (index > 0)
        flush()
      // The newline at the end closes the line rather than opening an empty one.
      if (text.length === 0 && index === segments.length - 1)
        continue
      open ??= { kind: entry.kind, parts: [] }
      open.parts.push({ text, color: entry.color })
    }
    if (entry.kind !== 'output')
      flush()
  }
  flush()
  return lines
}

/** The code a window's "Save Code" and "Copy Code" write: every submission, prompts and output left out. */
export const scriptCodeText = (entries: readonly ScriptOutputEntry[], pendingInput?: string): string => {
  const code = entries.filter((entry) => entry.kind === 'echo').map((entry) => entry.text)
  if (pendingInput && pendingInput.trim().length > 0)
    code.push(pendingInput)
  return code.join('\n')
}

/** The whole text the window shows, prompts included, which is what "Save" writes. */
export const scriptText = (entries: readonly ScriptOutputEntry[], pendingInput?: string): string => {
  const text = scriptLines(entries).map((line) => line.parts.map((part) => part.text).join('')).join('\n')
  if (!pendingInput || pendingInput.trim().length === 0)
    return text
  return text.length === 0 ? `> ${pendingInput}` : `${text}\n> ${pendingInput}`
}

