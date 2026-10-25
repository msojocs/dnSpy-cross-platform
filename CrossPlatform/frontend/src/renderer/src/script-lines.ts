import type { ClassifiedSpan, ScriptOutputEntry, ScriptOutputKind } from '../../shared/protocol'

/** One rendered stretch of a log line: a color class, semantic colors, or neither. */
export interface ScriptLinePart {
  text: string
  /** A color class name the host gave the line. */
  color?: string | null
  /** Semantic colors, for an echo of input that was colored while it was typed or a line whose parts are colored. */
  colors?: readonly ClassifiedSpan[]
}

/** One line of the log the window draws. */
export interface ScriptLine {
  kind: ScriptOutputKind
  parts: ScriptLinePart[]
  /** An echo line's code, without its prompt: what Save Code and Copy Code write. */
  code?: string
}

/** The colors a run of `text` at `offset` gets, moved to start at zero and clipped to the run. */
const spansIn = (colors: readonly ClassifiedSpan[] | undefined, offset: number, text: string): ClassifiedSpan[] | undefined => {
  if (!colors || colors.length === 0)
    return undefined
  const spans: ClassifiedSpan[] = []
  for (const span of colors) {
    const start = Math.max(0, span.start - offset)
    const end = Math.min(text.length, span.start + span.length - offset)
    if (end > start)
      spans.push({ start, length: end - start, color: span.color })
  }
  return spans.length > 0 ? spans : undefined
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
        const parts: ScriptLinePart[] = [{ text: index === 0 ? '> ' : '. ', color: index === 0 ? 'replPrompt1' : 'replPrompt2' }]
        const colors = spansIn(entry.colors, offset, code)
        parts.push(colors ? { text: code, colors } : { text: code })
        lines.push({ kind: 'echo', parts, code })
        offset += code.length + 1
      }
      continue
    }
    // Only output fragments can leave a line open; everything else starts on a line of its own.
    if (entry.kind !== 'output')
      flush()
    const segments = entry.text.split('\n')
    let offset = 0
    for (const [index, text] of segments.entries()) {
      if (index > 0)
        flush()
      // The newline at the end closes the line rather than opening an empty one.
      if (text.length === 0 && index === segments.length - 1) {
        offset += 1
        continue
      }
      open ??= { kind: entry.kind, parts: [] }
      const colors = spansIn(entry.colors, offset, text)
      const part: ScriptLinePart = { text }
      if (entry.color)
        part.color = entry.color
      if (colors)
        part.colors = colors
      open.parts.push(part)
      offset += text.length + 1
    }
    if (entry.kind !== 'output')
      flush()
  }
  flush()
  return lines
}

/** The line number margin's color of a log line, one of dnSpy's three REPL line-number colors. */
export type ScriptLineNumberColor = 'replLineNumberInput1' | 'replLineNumberInput2' | 'replLineNumberOutput'

export interface ScriptLineNumber {
  /** The number the margin shows; dnSpy restarts it for every output block and every submission. */
  lineNumber: number
  color: ScriptLineNumberColor
}

/**
 * dnSpy's ReplCustomLineNumberMarginOwner: the line numbers of the REPL view. Every sub-buffer — the output
 * between two prompts, and each submitted command — is numbered from one, and consecutive submissions alternate
 * between the two input colors while output lines use the output color.
 */
export const scriptLineNumbers = (lines: readonly ScriptLine[]): ScriptLineNumber[] => {
  const numbers: ScriptLineNumber[] = []
  let output = 0
  let input = 0
  let submissions = 0
  for (const line of lines) {
    if (line.kind === 'echo') {
      // A new submission starts at the primary prompt; the `. ` lines are the rest of the same input.
      if (line.parts[0]?.text === '> ') {
        input = 0
        output = 0
        submissions++
      }
      input++
      numbers.push({ lineNumber: input, color: submissions % 2 === 1 ? 'replLineNumberInput1' : 'replLineNumberInput2' })
    }
    else {
      output++
      numbers.push({ lineNumber: output, color: 'replLineNumberOutput' })
    }
  }
  return numbers
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
