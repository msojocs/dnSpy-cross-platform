import type { AnalyzerNode, AnalyzerSource, AnalyzerTarget, CodeStatement, TextSpan } from '../../shared/protocol'

// The pieces of dnSpy's analyzer tree that need no React and no store: how a row is written, the order rows
// are shown in, what Copy puts on the clipboard, and where "Show Reference in Method" puts the caret.

/** One row of the analyzer tree as the client holds it: the backend's row under a key of its own, since the
 * same member can show up any number of times — under different searches, or found twice by one. */
export interface AnalyzerRow {
  key: string
  parentKey?: string
  node: AnalyzerNode
}

/** Where a row's children stand: being fetched by the request named, or fetched. */
export type AnalyzerChildren =
  | { status: 'loading'; requestKey: string }
  | { status: 'loaded'; keys: string[]; truncated: boolean }

/** What the tree is drawn from; the store holds it, and these helpers only read it. */
export interface AnalyzerTreeState {
  rootKeys: string[]
  rows: Record<string, AnalyzerRow>
  children: Record<string, AnalyzerChildren>
  expanded: Record<string, boolean>
}

/** One line of the drawn tree: a row, or the "Searching..." line a search shows while it runs. */
export type AnalyzerLine =
  | { kind: 'row'; key: string; depth: number; row: AnalyzerRow; text: string }
  | { kind: 'searching'; key: string; depth: number }

// The rows dnSpy's NodeFormatter appends a token to: the members. An accessor row is written as its
// keyword alone, and an assembly, a module and a search row carry none.
const KINDS_WITH_TOKEN = new Set(['type', 'method', 'field', 'property', 'event'])

const formatToken = (token: number): string => (token >>> 0).toString(16).toUpperCase().padStart(8, '0')

/**
 * The text a row wears — what dnSpy's analyzer node writes: "(hides) " in front of a member that hides the
 * one it was found for, a search row's header in the UI language, and the member's token behind it when
 * tokens are shown. The text is also what the rows are sorted by and what Copy writes.
 */
export const composeAnalyzerText = (node: AnalyzerNode, t: (message: string) => string, showToken: boolean): string => {
  if (node.kind === 'search')
    return t(node.label)
  const prefix = node.hidesParent ? `(${t('hides')}) ` : ''
  const token = showToken && !node.accessor && node.metadataToken != null && KINDS_WITH_TOKEN.has(node.kind)
    ? ` @${formatToken(node.metadataToken)}`
    : ''
  return `${prefix}${node.label}${token}`
}

/**
 * dnSpy sorts every level but the top one with `StringComparer.OrdinalIgnoreCase` over the row's text:
 * code unit by code unit, after upper-casing — not a locale's collation, which would put "_" and "a"
 * elsewhere.
 */
export const compareOrdinalIgnoreCase = (left: string, right: string): number => {
  const a = left.toUpperCase()
  const b = right.toUpperCase()
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The tree as it is drawn: the roots in the order they were analyzed, every other level sorted by its text
 * (equal texts keep the order they were found in), and a "Searching..." line under a search still running.
 */
export const flattenAnalyzerTree = (state: AnalyzerTreeState, compose: (node: AnalyzerNode) => string): AnalyzerLine[] => {
  const lines: AnalyzerLine[] = []
  const visit = (keys: string[], depth: number, sort: boolean): void => {
    let entries = keys.flatMap((key) => {
      const row = state.rows[key]
      return row ? [{ key, row, text: compose(row.node) }] : []
    })
    if (sort)
      entries = entries.map((entry, index) => ({ entry, index }))
        .sort((a, b) => compareOrdinalIgnoreCase(a.entry.text, b.entry.text) || a.index - b.index)
        .map(({ entry }) => entry)
    for (const { key, row, text } of entries) {
      lines.push({ kind: 'row', key, depth, row, text })
      if (!state.expanded[key])
        continue
      const children = state.children[key]
      if (children?.status === 'loading' && row.node.kind === 'search')
        lines.push({ kind: 'searching', key: `${key}:searching`, depth: depth + 1 })
      else if (children?.status === 'loaded')
        visit(children.keys, depth + 1, true)
    }
  }
  visit(state.rootKeys, 0, false)
  return lines
}

/**
 * What dnSpy's analyzer Copy writes: each selected row on a line of its own, indented with a tab per level,
 * in the order the tree shows them — and a line break after the last when there is more than one.
 */
export const analyzerCopyText = (lines: AnalyzerLine[], selected: ReadonlySet<string>): string => {
  const copied = lines.flatMap((line) => line.kind === 'row' && selected.has(line.key) ? [`${'\t'.repeat(line.depth)}${line.text}`] : [])
  return copied.length > 1 ? `${copied.join('\n')}\n` : copied.join('')
}

/** The 1-based line and column of a text offset — the position Monaco puts a caret at. */
export const lineColumnOfOffset = (text: string, offset: number): { line: number; column: number } => {
  let line = 1
  let lineStart = 0
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) {
    line++
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/** The text offset of a 1-based line and column. */
export const offsetOfLineColumn = (text: string, line: number, column: number): number => {
  let lineStart = 0
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', lineStart)
    if (next < 0)
      return text.length
    lineStart = next + 1
  }
  return Math.min(lineStart + Math.max(column, 1) - 1, text.length)
}

const samePath = (left: string | null | undefined, right: string | null | undefined): boolean =>
  !!left && !!right && left === right

/** Whether a span of the decompiled text names one of the members an instruction refers to. */
const spanNamesTarget = (span: TextSpan, targets: AnalyzerTarget[]): boolean =>
  targets.some((target) => (target.nodeId && span.targetNodeId === target.nodeId)
    || (target.modulePath && samePath(span.targetModulePath, target.modulePath) && span.targetMetadataToken === target.metadataToken))

interface DecompiledMethod {
  text: string
  spans: TextSpan[]
  codeStatements?: CodeStatement[]
}

/**
 * Where dnSpy's "Show Reference in Method" puts the caret (AnalyzerService.GoTo): on the statement whose IL
 * holds the instruction the result was found at — the one the debugger would stop on for that offset — and
 * there on the first reference to what the instruction names, or at the statement's start when the text
 * names it some other way. Nothing when the document has no statement for it: a result without an offset,
 * or a view such as IL that carries no statement map.
 */
export const findReferenceCaret = (document: DecompiledMethod, source: AnalyzerSource): { line: number; column: number } | undefined => {
  const ilOffset = source.ilOffset
  if (ilOffset == null)
    return undefined
  // A hidden sequence point has no text of its own to put the caret in.
  const statements = (document.codeStatements ?? []).filter((statement) =>
    !statement.isHidden && statement.metadataToken === source.methodToken && samePath(statement.modulePath, source.modulePath))
  const statement = statements.find((candidate) => candidate.sequencePointIlOffset <= ilOffset && ilOffset < candidate.ilEndOffset)
    ?? [...statements].reverse().find((candidate) => candidate.sequencePointIlOffset <= ilOffset)
  if (!statement)
    return undefined
  const start = offsetOfLineColumn(document.text, statement.startLine, statement.startColumn)
  const end = offsetOfLineColumn(document.text, statement.endLine, statement.endColumn)
  const reference = [...document.spans]
    .sort((a, b) => a.start - b.start)
    .find((span) => span.start >= start && span.start < end && spanNamesTarget(span, source.targets))
  return reference ? lineColumnOfOffset(document.text, reference.start) : { line: statement.startLine, column: statement.startColumn }
}
