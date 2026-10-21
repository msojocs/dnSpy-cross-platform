import type { BlockStructure, KeywordReference, TextPart, TextSpan } from '../../shared/protocol'
import { isNavigableSpan } from '../../shared/protocol'

/**
 * The document viewer's reading of the spans a decompiled document carries — dnSpy's DocumentViewerControl,
 * SpanDataCollection and the reference highlighter, without the editor: what lies under a click or the caret,
 * which spans name the same thing, where Tab and Alt+Down go, and where a followed reference puts the caret.
 */

/**
 * The reference a click lands on. dnSpy hit-tests the mouse strictly (`Find(pos, false)`), so the character
 * just past a reference's end is not on it.
 */
export const spanAtClick = (spans: readonly TextSpan[], offset: number): TextSpan | undefined =>
  spans.find((span) => isNavigableSpan(span) && offset >= span.start && offset < span.start + span.length)

/**
 * The reference the caret is on. The caret sits between characters, and dnSpy counts the position just past a
 * reference's end as on it (`Find` with `allowIntersection`) — so a caret right after a name still highlights
 * it, and F12 there still follows it. A reference that starts at the caret wins over one that ends there.
 */
export const spanAtCaret = (spans: readonly TextSpan[], offset: number): TextSpan | undefined =>
  spans.find((span) => isNavigableSpan(span) && offset >= span.start && offset < span.start + span.length)
  ?? spans.find((span) => isNavigableSpan(span) && offset === span.start + span.length)

/** The keyword of a related-keyword group the caret is on, with the same reach as {@link spanAtCaret}. */
export const keywordAtCaret = (keywords: readonly KeywordReference[], offset: number): KeywordReference | undefined =>
  keywords.find((keyword) => offset >= keyword.start && offset < keyword.start + keyword.length)
  ?? keywords.find((keyword) => offset === keyword.start + keyword.length)

const samePath = (left: string, right: string): boolean => left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()

/**
 * dnSpy's CompareReferences: whether two spans name the same thing. A local is itself; an opcode is the
 * opcode; an address is the same place of the same file; a member is its node when both know it, and its file and token otherwise.
 */
export const sameReference = (left: TextSpan, right: TextSpan): boolean => {
  if (left.opCode || right.opCode)
    return Boolean(left.opCode) && left.opCode === right.opCode
  // dnSpy's AddressReference compares its file, its kind and its address.
  if (left.address || right.address)
    return Boolean(left.address && right.address) && left.address!.isRva === right.address!.isRva && left.address!.address === right.address!.address
      && (left.address!.modulePath ?? '') === (right.address!.modulePath ?? '')
  if (left.localId || right.localId)
    return Boolean(left.localId) && left.localId === right.localId
  if (left.targetNodeId && right.targetNodeId)
    return left.targetNodeId === right.targetNodeId
  if (left.targetModulePath && right.targetModulePath && left.targetMetadataToken != null)
    return samePath(left.targetModulePath, right.targetModulePath) && left.targetMetadataToken === right.targetMetadataToken
  return false
}

/** The three looks dnSpy's reference highlighter gives a span: where it is defined, written, or only read. */
export type ReferenceHighlightKind = 'definition' | 'write' | 'reference'

export interface ReferenceHighlight {
  start: number
  length: number
  kind: ReferenceHighlightKind
}

/** Every span that names what `current` names, as the highlighter marks it. */
export const referenceHighlights = (spans: readonly TextSpan[], current: TextSpan): ReferenceHighlight[] =>
  spans.filter((span) => isNavigableSpan(span) && sameReference(span, current)).map((span) => ({
    start: span.start,
    length: span.length,
    kind: span.kind === 'definition' ? 'definition' : span.isWrite ? 'write' : 'reference',
  }))

/** Every keyword of the group `current` belongs to, all marked as plain references the way dnSpy marks them. */
export const keywordHighlights = (keywords: readonly KeywordReference[], current: KeywordReference): ReferenceHighlight[] =>
  keywords.filter((keyword) => keyword.group === current.group).map((keyword) => ({ start: keyword.start, length: keyword.length, kind: 'reference' }))

/** A stretch of the text a movement lands on. */
export interface TextRange {
  start: number
  length: number
}

const cycle = <T extends TextRange>(ranges: readonly T[], offset: number, forward: boolean): T | undefined => {
  if (ranges.length === 0)
    return undefined
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  if (forward)
    return sorted.find((range) => range.start > offset) ?? sorted[0]
  return [...sorted].reverse().find((range) => range.start < offset) ?? sorted[sorted.length - 1]
}

/**
 * dnSpy's MoveReference — Tab, Shift+Tab, Ctrl+Shift+Down and Up: from the related keyword the caret is on to
 * the next of its group, or from the reference to the next one that names the same thing, wrapping around at
 * either end. Nothing moves when the caret is on neither.
 */
export const nextReference = (
  spans: readonly TextSpan[],
  keywords: readonly KeywordReference[],
  offset: number,
  forward: boolean,
): TextRange | undefined => {
  const keyword = keywordAtCaret(keywords, offset)
  if (keyword)
    return cycle(keywords.filter((candidate) => candidate.group === keyword.group), keyword.start, forward)
  const span = spanAtCaret(spans, offset)
  if (!span)
    return undefined
  return cycle(spans.filter((candidate) => isNavigableSpan(candidate) && sameReference(candidate, span)), span.start, forward)
}

/** Whether a span is the definition of a metadata member — what Alt+Down and Alt+Up step through. */
export const isMemberDefinition = (span: TextSpan): boolean =>
  span.kind === 'definition' && !span.localId && Boolean(span.targetNodeId || span.targetModulePath)

/** dnSpy's MoveToNextDefinition: the next member definition after the caret, or the one before it, wrapping. */
export const nextDefinition = (spans: readonly TextSpan[], offset: number, forward: boolean): TextSpan | undefined => {
  const definitions = spans.filter(isMemberDefinition)
  const current = definitions.find((span) => offset >= span.start && offset <= span.start + span.length)
  return cycle(definitions, current ? current.start : offset, forward)
}

/**
 * dnSpy's MoveCaretToSpan: the caret goes to the end of the span — or to its start when another reference
 * begins right at the end, so the caret does not land on that one — and the span is selected from the other end.
 */
export const caretForSpan = (spans: readonly TextSpan[], range: TextRange): { anchor: number; active: number } => {
  const end = range.start + range.length
  const another = spans.some((span) => span.start === end && isNavigableSpan(span))
  return another ? { anchor: end, active: range.start } : { anchor: range.start, active: end }
}

/** The definition of the member a reference names, when the document holds one — dnSpy's FindDefinition. */
export const definitionOf = (spans: readonly TextSpan[], reference: TextSpan): TextSpan | undefined =>
  spans.find((span) => span.kind === 'definition' && span !== reference && sameReference(span, reference))

/** The definition of a member by its node — where a followed reference puts the caret once its document is shown. */
export const definitionForNode = (spans: readonly TextSpan[], nodeId: string): TextSpan | undefined =>
  spans.find((span) => span.kind === 'definition' && !span.localId && span.targetNodeId === nodeId)

/** The Quick Info a local carries: its first span's, which the backend writes for the whole local. */
export const localToolTip = (spans: readonly TextSpan[], localId: string): TextPart[] | undefined =>
  spans.find((span) => span.localId === localId && span.toolTip)?.toolTip ?? undefined

/** The 1-based line and column of a text offset, counting `\r\n`, `\r` and `\n` as one line break each. */
export const positionAt = (text: string, offset: number): { line: number; column: number } => {
  let line = 1
  let lineStart = 0
  const end = Math.min(Math.max(offset, 0), text.length)
  for (let index = 0; index < end; index++) {
    const ch = text[index]
    if (ch === '\r' && text[index + 1] === '\n')
      continue
    if (ch === '\n' || ch === '\r') {
      line++
      lineStart = index + 1
    }
  }
  return { line, column: end - lineStart + 1 }
}

/** dnSpy's OpCodeReferenceHandler: the page an opcode reference opens. */
export const opCodeUrl = (opCode: string): string =>
  `https://docs.microsoft.com/dotnet/api/system.reflection.emit.opcodes.${opCode.toLowerCase().replaceAll('.', '_').replace(/_+$/, '')}`

/** What the Go to Line box accepts: a 1-based line, an optional 1-based column; or what it says when it cannot. */
export type GoToLineResult = { line: number; column?: number } | { error: string }

/**
 * dnSpy's GoToCommand.TryGetRowCol: "line" or "line, column", or ", column" for the caret's own line, every
 * number counted from 1. A line past the last one is refused; the message is dnSpy's.
 */
export const parseGoToLine = (text: string, currentLine: number, lineCount: number, translate: (text: string, values?: Record<string, string | number>) => string): GoToLineResult => {
  const invalid = (): GoToLineResult => (text.trim() === '' ? { error: translate('Enter a line number') } : { error: translate('Invalid line: {0}', { 0: text }) })
  const positive = (value: string): number | undefined => {
    const parsed = Number.parseInt(value, 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  const full = /^\s*(\d+)\s*(,\s*(\d+))?\s*$/.exec(text)
  if (full) {
    const line = positive(full[1])
    if (line === undefined || line > lineCount)
      return invalid()
    if (full[3] === undefined)
      return { line }
    const column = positive(full[3])
    return column === undefined ? invalid() : { line, column }
  }
  const columnOnly = /^\s*,\s*(\d+)\s*$/.exec(text)
  if (columnOnly) {
    const column = positive(columnOnly[1])
    return column === undefined ? invalid() : { line: currentLine, column }
  }
  return invalid()
}

/** A block structure line: the lines between its two ends, at the column of whichever end is further left. */
export interface BlockLine {
  kind: string
  /** The first and last line the vertical line crosses, 1-based; the lines of the two ends are left out. */
  fromLine: number
  toLine: number
  /** The 1-based column the line is drawn through the middle of. */
  column: number
}

/**
 * dnSpy's BlockStructureService: each block gets a vertical line from the line below its top to the line above
 * its bottom, through the first non-blank character of whichever end line is indented less — so a block whose
 * ends share a line gets none.
 */
export const blockLines = (
  blocks: readonly BlockStructure[],
  lineOf: (offset: number) => number,
  lineText: (line: number) => string,
): BlockLine[] => {
  const lines: BlockLine[] = []
  for (const block of blocks) {
    const top = lineOf(block.start)
    const bottom = lineOf(block.end)
    if (bottom - top < 2)
      continue
    const indent = (line: number): number => {
      const text = lineText(line)
      const match = /^\s*/.exec(text)
      return match ? match[0].length : 0
    }
    lines.push({ kind: block.kind, fromLine: top + 1, toLine: bottom - 1, column: Math.min(indent(top), indent(bottom)) + 1 })
  }
  return lines
}

/** dnSpy's ThemeClassificationTypeNameKeys.BlockStructure* color for a block kind, as a theme color name. */
export const blockStructureColor = (kind: string): string =>
  `blockStructure${kind.charAt(0).toUpperCase()}${kind.slice(1)}`

/** What dnSpy's LineCompressor makes of a line: drawn at full height, blank, or made only of non-letters. */
export type LineCompressionKind = 'normal' | 'blank' | 'noLetters'

/**
 * dnSpy's LineCompressor (WPF/Text/Editor/LineCompressor.cs): which lines the viewer draws shorter. A line with a
 * letter or a digit anywhere — the middle character is checked first — keeps its height; a long line always does;
 * an empty or whitespace-only line is `blank`; anything else shorter than that limit is `noLetters`, so a line of
 * punctuation or an empty brace can be compressed too. The caller decides which of the two kinds to compress.
 */
export const lineCompressionKind = (text: string): LineCompressionKind => {
  if (text.length === 0)
    return 'blank'
  if (/[\p{L}\p{N}]/u.test(text[Math.floor(text.length / 2)] ?? ''))
    return 'normal'
  if (text.length > 150)
    return 'normal'
  if (/[\p{L}\p{N}]/u.test(text))
    return 'normal'
  return /^\s*$/u.test(text) ? 'blank' : 'noLetters'
}

const groupDigits = (digits: string, group: number): string => {
  if (digits.length <= group)
    return digits
  const parts: string[] = []
  for (let end = digits.length; end > 0; end -= group)
    parts.unshift(digits.slice(Math.max(0, end - group), end))
  return parts.join('_')
}

/** The value a C#, Visual Basic or IL integer literal names, or undefined for a word that is not one. */
export const integerLiteralValue = (word: string): bigint | undefined => {
  const text = word.replaceAll('_', '').replace(/(?:UL|LU|U|L)$/i, '')
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(text))
      return BigInt(`0x${text.slice(2)}`)
    if (/^&[hH][0-9a-fA-F]+$/.test(text))
      return BigInt(`0x${text.slice(2)}`)
    if (/^0[bB][01]+$/.test(text))
      return BigInt(`0b${text.slice(2)}`)
    if (/^[0-9]+$/.test(text))
      return BigInt(text)
  } catch {
    // A literal too large for BigInt is not a number this tooltip can write.
  }
  return undefined
}

/**
 * dnSpy's NumberDocumentViewerToolTipProvider: the value in base 2, 8, 10 and 16, grouped the way NumberUtils
 * groups them — four digits in binary, octal and hex, three in decimal.
 */
export const numberToolTip = (value: bigint): string[] => {
  const unsigned = value < 0n ? value + (1n << 64n) : value
  return [
    `Base 2: ${groupDigits(unsigned.toString(2), 4)}`,
    `Base 8: ${groupDigits(unsigned.toString(8), 4)}`,
    `Base 10: ${groupDigits(unsigned.toString(10), 3)}`,
    `Base 16: ${groupDigits(unsigned.toString(16).toUpperCase(), 4)}`,
  ]
}

/** Escapes text for HTML, which is what the clipboard's HTML flavor and the hover's markdown both need. */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

/** A run of text in one color, for the clipboard's HTML flavor. */
export interface ColoredRun {
  text: string
  color?: string
}

/**
 * dnSpy's HtmlBuilderService: the copied text as HTML, each run in its color, lines joined with `<br/>`, in the
 * editor's font — what a rich text editor pastes as colored code.
 */
export const buildClipboardHtml = (lines: readonly (readonly ColoredRun[])[], fontFamily: string, fontSize: number, tabSize: number): string => {
  const body = lines.map((runs) => runs.map((run) => {
    const text = escapeHtml(run.text.replaceAll('\t', ' '.repeat(tabSize))).replaceAll('  ', '&nbsp; ')
    return run.color ? `<span style="color:${escapeHtml(run.color)};">${text}</span>` : text
  }).join('')).join('<br/>')
  return `<div style="font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px;white-space:pre;">${body}</div>`
}
