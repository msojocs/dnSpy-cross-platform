import type { editor as MonacoEditor } from 'monaco-editor'
import type { CodeStatement } from '../../shared/protocol'
import { breakpointImage, breakpointKind, breakpointPositionInDocument, statementOfLocation, type BreakpointKind, type LineBreakpoint } from './app-store'
import { dsImageClass, ensureDsImage } from './ds-image'

/**
 * The marks dnSpy's text editor draws for the debugger: a breakpoint's glyph in the margin and its marker over
 * the statement (BreakpointMarker), and the current statement, the frame switched to and the statements of the
 * other frames (CallStackMarker, ActiveStatementService). Each marker is a theme colour pair: the marker's own
 * background and outline, and the text colour of the classification it carries.
 */

/** BreakpointMarker's table: the marker and the classification each kind of breakpoint draws its statement with. */
const breakpointMarker = (kind: BreakpointKind): { marker: string; classification?: string } => {
  const disabled = kind.endsWith('Disabled')
  const base = kind.replace(/(Enabled|Disabled)$/, '')
  const name = disabled ? `Disabled${base}Statement` : `${base}Statement`
  // A plain disabled breakpoint keeps an outline and leaves the text its own colour.
  return { marker: `${name}Marker`, classification: kind === 'BreakpointDisabled' ? undefined : name }
}

const BREAKPOINT_KINDS: BreakpointKind[] = [
  'BreakpointEnabled', 'BreakpointDisabled', 'AdvancedBreakpointEnabled', 'AdvancedBreakpointDisabled',
  'BreakpointWarning', 'BreakpointError', 'AdvancedBreakpointWarning', 'AdvancedBreakpointError',
  'TracepointEnabled', 'TracepointDisabled', 'AdvancedTracepointEnabled', 'AdvancedTracepointDisabled',
  'TracepointWarning', 'TracepointError', 'AdvancedTracepointWarning', 'AdvancedTracepointError',
]

/** The call stack's markers: CallStackMarker's two and ActiveStatementService's. */
export type StatementMarkerKind = 'CurrentStatement' | 'CallReturn' | 'ActiveStatement'

const statementMarker = (kind: StatementMarkerKind): { marker: string; classification?: string } =>
  kind === 'ActiveStatement' ? { marker: 'ActiveStatementMarker' } : { marker: `${kind}Marker`, classification: kind }

const markerRule = (className: string, marker: string, classification: string | undefined): string => {
  const key = marker.toLowerCase()
  const rules = [`.monaco-editor .${className}-marker{background:var(--tcbg-${key},transparent);box-shadow:inset 0 0 0 1px var(--tcfg-${key},transparent)}`]
  if (classification)
    rules.push(`.monaco-editor .view-line .${className}-text{color:var(--tc-${classification.toLowerCase()},inherit)!important}`)
  return rules.join('\n')
}

let styleSheet: HTMLStyleElement | undefined

/** The rules of every marker, put on the page once: they only name theme variables, so a theme switch needs nothing. */
const ensureMarkerStyles = (): void => {
  if (styleSheet || typeof document === 'undefined')
    return
  styleSheet = document.createElement('style')
  styleSheet.dataset.debuggerMarkers = ''
  styleSheet.textContent = [
    ...BREAKPOINT_KINDS.map((kind) => {
      const { marker, classification } = breakpointMarker(kind)
      return markerRule(`bp-${kind}`, marker, classification)
    }),
    ...(['CurrentStatement', 'CallReturn', 'ActiveStatement'] as StatementMarkerKind[]).map((kind) => {
      const { marker, classification } = statementMarker(kind)
      return markerRule(`stmt-${kind}`, marker, classification)
    }),
  ].join('\n')
  document.head.append(styleSheet)
}

/** The glyph class of one of dnSpy's images in the margin. */
export const glyphClass = (image: string): string => {
  ensureDsImage(image)
  return `ds-glyph ${dsImageClass(image)}`
}

type Decoration = MonacoEditor.IModelDeltaDecoration

/**
 * A breakpoint's glyph and its marker, for every breakpoint this document holds a statement of. Several on one
 * line share the glyph of the first, as dnSpy's margin draws the one on top.
 */
export const breakpointDecorations = (nodeId: string, statements: CodeStatement[] | undefined, breakpoints: LineBreakpoint[]): Decoration[] => {
  ensureMarkerStyles()
  const decorations: Decoration[] = []
  const glyphLines = new Set<number>()
  for (const breakpoint of breakpoints) {
    const position = breakpointPositionInDocument(nodeId, statements, breakpoint)
    if (!position || position.line <= 0)
      continue
    const kind = breakpointKind(breakpoint)
    if (!glyphLines.has(position.line)) {
      glyphLines.add(position.line)
      decorations.push({
        range: { startLineNumber: position.line, startColumn: 1, endLineNumber: position.line, endColumn: 1 },
        options: { glyphMarginClassName: `${glyphClass(breakpointImage(kind))} breakpoint-glyph`, stickiness: 1 },
      })
    }
    // A breakpoint the document cannot place on a statement has its glyph only.
    if (position.column > 0 && (position.endLine > position.line || position.endColumn > position.column)) {
      decorations.push({
        range: { startLineNumber: position.line, startColumn: position.column, endLineNumber: position.endLine, endColumn: position.endColumn },
        options: { className: `bp-${kind}-marker`, inlineClassName: breakpointMarker(kind).classification ? `bp-${kind}-text` : undefined, stickiness: 1 },
      })
    }
  }
  return decorations
}

/** A frame of the stopped thread, as the markers need it. */
export interface MarkedFrame {
  modulePath?: string
  metadataToken?: number
  ilOffset?: number
  /** The frame the runtime is in: frame 0. */
  current: boolean
  /** The frame the user switched to. */
  active: boolean
}

/**
 * CallStackMarker and ActiveStatementService: the current statement (frame 0) with its yellow arrow, the statement
 * of the frame the user switched to with the green one when that is another frame, and every other frame's
 * statement marked as active.
 */
export const callStackDecorations = (statements: CodeStatement[] | undefined, frames: MarkedFrame[]): Decoration[] => {
  ensureMarkerStyles()
  const decorations: Decoration[] = []
  frames.forEach((frame) => {
    if (frame.modulePath === undefined || frame.metadataToken === undefined || frame.ilOffset === undefined || frame.ilOffset < 0)
      return
    const statement = statementOfLocation(statements, frame.modulePath, frame.metadataToken, frame.ilOffset)
    if (!statement)
      return
    const kind: StatementMarkerKind = frame.current ? 'CurrentStatement' : frame.active ? 'CallReturn' : 'ActiveStatement'
    const image = kind === 'CurrentStatement' ? 'CurrentInstructionPointer' : kind === 'CallReturn' ? 'CallReturnInstructionPointer' : undefined
    if (image) {
      decorations.push({
        range: { startLineNumber: statement.startLine, startColumn: 1, endLineNumber: statement.startLine, endColumn: 1 },
        options: { glyphMarginClassName: `${glyphClass(image)} debug-stopped-glyph`, stickiness: 1 },
      })
    }
    decorations.push({
      range: { startLineNumber: statement.startLine, startColumn: statement.startColumn, endLineNumber: statement.endLine, endColumn: statement.endColumn },
      options: {
        className: `stmt-${kind}-marker${kind === 'CurrentStatement' ? ' debug-stopped-line' : ''}`,
        inlineClassName: kind === 'ActiveStatement' ? undefined : `stmt-${kind}-text`,
        stickiness: 1,
        // The current statement is drawn over everything else; a breakpoint on the same statement shows through the others.
        zIndex: kind === 'CurrentStatement' ? 30 : 20,
      },
    })
  })
  return decorations
}
