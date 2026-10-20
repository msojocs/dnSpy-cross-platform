import Editor from './CodeEditor'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { editor as MonacoEditor } from 'monaco-editor'
// A reference that goes somewhere is decorated and clickable; which spans those are is a rule about the
// spans themselves, so it is asked of them rather than decided here.
import { isLocalSpan, isNavigableSpan, type CodeStatement, type DecompilerLanguage, type TextSpan, type TreeNode } from '../../../shared/protocol'
import { ilSelectionOf } from './il-selection'
import { bookmarkMarkers, breakpointPositionInDocument, breakpointStatementsOf, codeStatementAt, findNode, lineBreakpointAt, lineBreakpointsAt, memoryModulePathOf, statementOfLocation, useAppStore } from '../app-store'
import { breakpointDecorations, callStackDecorations } from '../debugger-markers'
import { bookmarkChords, bookmarkFunctionKeys } from '../bookmark-commands'
import type { Bookmark, BookmarkDocument, HexBodyKind, MethodBreakpointTarget } from '../app-store'
import { isActiveDocumentEditor, registerDocumentEditor, unregisterDocumentEditor } from '../editor-registry'
import { useLanguage } from '../localization'
import { monacoThemeName } from '../monaco'
import { useCategoryFont } from '../fonts'
import { setDocumentEditorData } from '../document-editor'
import {
  blockLines, blockStructureColor, caretForSpan, definitionForNode, definitionOf, keywordAtCaret, keywordHighlights, nextDefinition,
  nextReference, opCodeUrl, referenceHighlights, spanAtCaret, spanAtClick, type ReferenceHighlight, type TextRange,
} from '../document-viewer'
import { copyWithFormatting } from '../document-clipboard'
import { normalizeZoom, zoomIn, zoomLevels, zoomOut } from '../zoom'
import { DsIcon } from './DsIcon'
import { BreakpointGlyphPopup, breakpointToolTip, toolTipMethodText } from './BreakpointGlyphPopup'
import { showDebugMenu } from './DebugToolWindows'
import { externalMemberTarget, isAnalyzableNode, showCodeEditorContextMenu } from './CodeEditorContextMenu'
import { GoToLineDialog } from './EditDialogs'
import { useAppOptions, type BlockStructureLineKind } from './app-options'
import { setDocumentViewerZoom, toggleDocumentViewerOption } from './document-viewer-options'
import type { CreatedKind, HexShowKind } from './edit-menu'

// A bookmark draws in the lines-decorations strip rather than the glyph margin, which the breakpoints
// already own: a bookmark and a breakpoint on the same line then sit side by side instead of on top of
// each other. A disabled bookmark keeps its mark, drawn faint.
const bookmarkDecorations = (
  nodeId: string,
  document: BookmarkDocument | undefined,
  bookmarks: Bookmark[],
  translate: (message: string) => string,
): MonacoEditor.IModelDeltaDecoration[] =>
  bookmarkMarkers(nodeId, document, bookmarks).map((marker) => ({
    range: { startLineNumber: marker.line, startColumn: 1, endLineNumber: marker.line, endColumn: 1 },
    options: {
      linesDecorationsClassName: marker.enabled ? 'bookmark-glyph' : 'bookmark-glyph-disabled',
      hoverMessage: {
        value: [marker.message, translate(marker.enabled ? 'Enabled' : 'Disabled')].filter(Boolean).join('\n'),
      },
    },
  }))

type TextModel = MonacoEditor.ITextModel

const rangeOf = (model: TextModel, start: number, length: number): { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } => {
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(start + length)
  return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }
}

/**
 * The spans as the viewer draws them: each in the color class dnSpy's decompiler wrote it in — the semantic
 * colors on top of the editor's lexical ones — and marked by what a click does to it, which is what the mouse
 * pointer shows: a reference is followed by a plain click, a definition or a local only with Ctrl down.
 */
const spanDecorations = (model: TextModel, spans: readonly TextSpan[]): MonacoEditor.IModelDeltaDecoration[] =>
  spans.flatMap((span) => {
    const classes: string[] = []
    if (span.color)
      classes.push(`tc-${span.color}`)
    if (isNavigableSpan(span))
      classes.push(isLocalSpan(span) ? 'code-local' : span.kind === 'definition' ? 'code-definition' : 'code-reference')
    if (classes.length === 0 || span.length === 0)
      return []
    return [{ range: rangeOf(model, span.start, span.length), options: { inlineClassName: classes.join(' ') } }]
  })

// dnSpy's reference highlighter marks a definition, a write and a read each in its own color.
const highlightClass: Record<ReferenceHighlight['kind'], string> = {
  definition: 'highlighted-definition',
  write: 'highlighted-written-reference',
  reference: 'highlighted-reference',
}

/** The pixel pattern of each BlockStructureLineKind: solid, or dashes and gaps of one to four pixels. */
const dashLength: Record<BlockStructureLineKind, number> = { solid: 0, dashed1: 1, dashed2: 2, dashed3: 3, dashed4: 4 }

// The node a reference names. The tree lists a member only once its type has been expanded, so one it has not
// loaded yet is asked of the backend; a node that cannot be had leaves the menu without the commands that need it.
const referenceNodeOf = async (nodeId: string): Promise<TreeNode | undefined> => {
  const state = useAppStore.getState()
  const loaded = findNode(state, nodeId)
  if (loaded || !state.workspaceId)
    return loaded
  try {
    return await window.dnSpy.getNode(state.workspaceId, nodeId)
  } catch {
    return undefined
  }
}

/** The document's node, which the Go to commands of the context menu act on: its module is the one they search. */
const documentNodeOf = async (nodeId: string): Promise<TreeNode | undefined> => referenceNodeOf(nodeId)


/**
 * The context menu commands only the shell can run: everything that opens a tab, a dialog or a tool
 * window, plus the hex commands, which are the same ones the Edit menu carries. The viewer answers the
 * rest itself, from the caret, the document on screen and the breakpoints on it.
 */
export interface DocumentViewCommands {
  /**
   * Follows a member reference — dnSpy's FollowReference: into this tab, or with `newTab` into a new one. A
   * local is followed by the viewer itself unless it goes to a new tab, which only the shell can open.
   */
  onFollowReference(target: TextSpan, newTab: boolean): void
  /** Records where the caret is in this tab's history, before the viewer moves it somewhere else in the document. */
  onRecordHistory(): void
  onStartDebug(): void
  /** Whether a debug target is configured, so "Start Debugging..." has something to run. */
  canStartDebug: boolean
  onShowDisassembly(): void
  onDeleteNode(node: TreeNode): void
  onEditNode(node: TreeNode): void
  /** Opens the create dialog for a node of this kind inside the type the node belongs to. */
  onCreateMember(kind: CreatedKind, nested: boolean, node: TreeNode): void
  onEditMethodBody(node: TreeNode): void
  /** dnSpy's "Edit IL Instructions": the method body editor, opened on the method whose statement is
   *  under the caret with that statement's instructions selected. */
  onEditIlInstructions(statement: CodeStatement): void
  onReplaceMethodBodyWithStub(node: TreeNode): void
  onAnalyze(node: TreeNode): void
  /** dnSpy's class breakpoint and class tracepoint for the type a reference names. */
  onAddClassBreakpoint(target: MethodBreakpointTarget): void
  onAddClassTracepoint(target: MethodBreakpointTarget): void
  /** Analyzes a reference into a module the workspace does not hold, opening that module to do it. */
  onAnalyzeReference(target: TextSpan): void
  /** Opens an address in the browser, which is how the menu's "Search MSDN" runs. */
  onOpenUrl(url: string): void
  /** dnSpy's Go to Resource for the member the reference names: selects and opens the entry it reads. */
  onGoToResource(node: TreeNode): void
  /** The document viewer's token group: the entry point and the global constructor of the document's
   *  module, and Go to MD Token in it. */
  onGoToEntryPoint(node: TreeNode): void
  onGoToGlobalCctor(node: TreeNode): void
  onGoToToken(node: TreeNode): void
  /** dnSpy's Go to MD Table Row, asking for a token in the node's module, or going to the one given. */
  onGoToMdTableRow?(node: TreeNode, token?: number): void
  onOpenHex(): void
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
}

/** The language a document's Quick Info is asked in: the one it was decompiled in. */
const quickInfoLanguage = (language: DecompilerLanguage | undefined): DecompilerLanguage => language ?? 'cSharp'

/** dnSpy's ZoomControl box: the zoom as "100 %", which typing a number and Enter changes. */
const ZoomControl = ({ zoom, onZoom }: { zoom: number; onZoom(value: number): void }): React.JSX.Element => {
  const { t } = useLanguage()
  const [text, setText] = useState(`${zoom} %`)
  useEffect(() => setText(`${zoom} %`), [zoom])
  const apply = (): void => {
    const value = Number.parseFloat(text.replace('%', '').trim())
    if (Number.isFinite(value) && value >= zoomLevels[0] && value <= zoomLevels[zoomLevels.length - 1])
      onZoom(normalizeZoom(value))
    else
      setText(`${zoom} %`)
  }
  return (
    <div className="document-zoom-control">
      <input
        aria-label={t('Zoom')}
        list="document-zoom-levels"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setText(`${zoom} %`)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setText(`${zoom} %`)
          }
        }}
      />
      <datalist id="document-zoom-levels">
        {[...zoomLevels].reverse().map((level) => <option key={level} value={`${level} %`} />)}
      </datalist>
    </div>
  )
}

export const DocumentView = ({ documentId, viewId, theme, transparentBackground, commands }: { documentId: string; viewId: string; theme: string; transparentBackground: boolean; commands: DocumentViewCommands }): React.JSX.Element => {
  const viewerOptions = useAppOptions().documentViewer
  const { general, scrollBars, tabs, advanced } = viewerOptions
  const zoom = viewerOptions.zoomLevel
  const document = useAppStore((state) => state.documents[documentId])
  const workspaceId = useAppStore((state) => state.workspaceId)
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const caretReveal = useAppStore((state) => state.caretReveal)
  const toggleLineBreakpoint = useAppStore((state) => state.toggleLineBreakpoint)
  const stoppedLocation = useAppStore((state) => state.stoppedLocation)
  const debugFrames = useAppStore((state) => state.debugFrames)
  const activeDebugFrameId = useAppStore((state) => state.activeDebugFrameId)
  const debugState = useAppStore((state) => state.debugState)
  const activeDocumentId = useAppStore((state) => state.activeDocumentId)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined)
  const monacoRef = useRef<typeof import('monaco-editor') | undefined>(undefined)
  // Monaco is created asynchronously, so the effects below can find no editor on their first run. This
  // makes the mount a dependency of theirs: a document that arrives already decompiled — which is what a
  // frame navigation produces — has no later store change to run them again on.
  const [editorReady, setEditorReady] = useState(false)
  // Whether this view's context menu is open, which styles.css reads to keep the caret drawn while the menu has
  // the focus. It marks the host rather than Monaco's own node, whose class list Monaco rewrites on every blur.
  const [menuOpen, setMenuOpen] = useState(false)
  // Ctrl held down: dnSpy's viewer shows the hand over every reference then, definitions and locals included.
  const [ctrlDown, setCtrlDown] = useState(false)
  // dnSpy's Incremental Search: the direction it looks in and what has been typed so far, while it is on.
  const [incrementalSearch, setIncrementalSearch] = useState<{ forward: boolean; text: string } | undefined>(undefined)
  const incrementalRef = useRef<{ forward: boolean; text: string; start: number } | undefined>(undefined)
  // dnSpy's Go to Line box, with the line the caret was on when it was asked for.
  const [goToLine, setGoToLine] = useState<{ currentLine: number; lineCount: number } | undefined>(undefined)
  // The tool bar and tool tip of the breakpoint glyph the mouse rests on (BreakpointGlyphPopupControl).
  const [glyphPopup, setGlyphPopup] = useState<{ breakpointId: string; line: number; left: number; top: number; lineHeight: number; toolTip: string; fading: boolean }>()
  const glyphTimersRef = useRef<{ show?: ReturnType<typeof setTimeout>; hide?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout>; line?: number }>({})
  // The stopped-location request whose line this view already moved the caret to.
  const revealedTokenRef = useRef(0)
  // The caret request — a bookmark's, the analyzer's — this view already carried out.
  const appliedCaretRevealRef = useRef(0)
  // The reveal that has not landed yet. A frame navigation opens its document while the tab is still being
  // laid out, so the scroll it asks for finds an editor with no height and moves nowhere; keeping the
  // request until the line is really on screen is what makes the second attempt (on a layout change) work.
  const pendingRevealRef = useRef<{ line: number; column?: number } | undefined>(undefined)
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  // Where the caret was when Esc cleared the reference marks, which stay away until it moves.
  const highlightsClearedAtRef = useRef<number | undefined>(undefined)
  const highlightDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const separatorDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const breakpointDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const bookmarkDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const stoppedDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  // The block structure lines are drawn into a layer of their own over the text, redrawn as the view scrolls.
  const blockLayerRef = useRef<HTMLDivElement | undefined>(undefined)
  // onMount registers the mouse handler once, so it reads the current values through refs instead of the closure.
  const spansRef = useRef(document?.spans ?? [])
  const keywordsRef = useRef(document?.relatedKeywords ?? [])
  const documentRef = useRef(document)
  // The statements the breakpoint commands work off — the C# view's alone, see `breakpointStatementsOf`.
  const statementsRef = useRef(breakpointStatementsOf(document))
  const breakpointsRef = useRef(lineBreakpoints)
  const bookmarksRef = useRef(bookmarks)
  const toggleLineBreakpointRef = useRef(toggleLineBreakpoint)
  const advancedRef = useRef(advanced)
  const { locale, t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  spansRef.current = document?.spans ?? []
  keywordsRef.current = document?.relatedKeywords ?? []
  documentRef.current = document
  statementsRef.current = breakpointStatementsOf(document)
  breakpointsRef.current = lineBreakpoints
  bookmarksRef.current = bookmarks
  toggleLineBreakpointRef.current = toggleLineBreakpoint
  advancedRef.current = advanced

  const clearGlyphTimers = (): void => {
    const timers = glyphTimersRef.current
    clearTimeout(timers.show)
    clearTimeout(timers.hide)
    clearTimeout(timers.close)
    timers.show = timers.hide = timers.close = undefined
  }

  // The popup goes when the mouse has been away from the margin and the tool bar for a second, fading over another.
  const leaveGlyph = (): void => {
    const timers = glyphTimersRef.current
    clearTimeout(timers.show)
    timers.show = undefined
    timers.line = undefined
    if (timers.hide || timers.close)
      return
    timers.hide = setTimeout(() => {
      timers.hide = undefined
      setGlyphPopup((current) => current && { ...current, fading: true, toolTip: '' })
      timers.close = setTimeout(() => {
        timers.close = undefined
        setGlyphPopup(undefined)
      }, 1000)
    }, 1000)
  }

  const enterGlyphPopup = (): void => {
    const timers = glyphTimersRef.current
    clearTimeout(timers.hide)
    clearTimeout(timers.close)
    timers.hide = timers.close = undefined
    setGlyphPopup((current) => current && { ...current, fading: false })
  }

  // After the mouse has rested on a breakpoint's glyph for 150 ms its tool bar and tool tip come up.
  const hoverGlyph = (line: number): void => {
    const editor = editorRef.current
    const timers = glyphTimersRef.current
    const breakpoint = lineBreakpointAt(documentId, statementsRef.current, breakpointsRef.current, line)
    if (!editor || !breakpoint) {
      leaveGlyph()
      return
    }
    clearTimeout(timers.hide)
    clearTimeout(timers.close)
    timers.hide = timers.close = undefined
    if (timers.line === line)
      return
    timers.line = line
    clearTimeout(timers.show)
    timers.show = setTimeout(() => {
      timers.show = undefined
      const layout = editor.getLayoutInfo()
      const top = editor.getTopForLineNumber(line) - editor.getScrollTop()
      const lineHeight = editor.getOption(monacoRef.current!.editor.EditorOption.lineHeight)
      const position = breakpointPositionInDocument(documentId, statementsRef.current, breakpoint) ?? { line, column: 1 }
      const debugging = useAppStore.getState().debugState !== 'inactive'
      const toolTip = (method?: string): string => breakpointToolTip(breakpoint, position, method, debugging, tRef.current)
      setGlyphPopup({ breakpointId: breakpoint.id, line, left: layout.glyphMarginLeft + layout.glyphMarginWidth - 1, top, lineHeight, toolTip: toolTip(breakpoint.description), fading: false })
      // The method as dnSpy's decompiler writes it with its default options.
      if (breakpoint.modulePath && breakpoint.metadataToken !== undefined) {
        void window.dnSpy.formatBookmarkLocations?.(useAppStore.getState().workspaceId, [{ modulePath: breakpoint.modulePath, metadataToken: breakpoint.metadataToken, ilOffset: null }], {
          showTokens: false, showModuleNames: false, showParameterTypes: true, showParameterNames: true, showDeclaringTypes: true, showReturnTypes: true, showNamespaces: false, showIntrinsicTypeKeywords: true,
        }).then(([written]) => {
          if (written?.resolved)
            setGlyphPopup((current) => current?.breakpointId === breakpoint.id && current.toolTip ? { ...current, toolTip: toolTip(toolTipMethodText(written.parts)) } : current)
        }, () => undefined)
      }
    }, 150)
  }
  const hoverGlyphRef = useRef(hoverGlyph)
  hoverGlyphRef.current = hoverGlyph
  const leaveGlyphRef = useRef(leaveGlyph)
  leaveGlyphRef.current = leaveGlyph

  // GlyphMarginCommands: the margin's menu over a breakpoint's glyph — and none anywhere else in the margin.
  const openGlyphMarginMenu = (line: number, screen: { x: number; y: number }): void => {
    const breakpoint = lineBreakpointAt(documentId, statementsRef.current, breakpointsRef.current, line)
    if (!breakpoint)
      return
    const store = useAppStore.getState()
    const t = tRef.current
    showDebugMenu(t('Breakpoint'), [
      { key: 'delete', label: t('Delete Breakpoint'), icon: 'CheckDot', run: () => void store.removeBreakpoints([breakpoint.id]) },
      { key: 'toggle', label: breakpoint.enabled ? t('Disable Breakpoint') : t('Enable Breakpoint'), icon: 'ToggleAllBreakpoints', shortcut: 'Ctrl+F9', run: () => void store.setBreakpointsEnabled([breakpoint.id], !breakpoint.enabled) },
      null,
      { key: 'settings', label: t('Settings...'), icon: 'Settings', run: () => store.editBreakpointSettings([breakpoint.id]) },
      null,
      { key: 'export', label: t('Export...'), icon: 'Open', run: () => void store.exportBreakpoints([breakpoint.id]) },
    ], screen)
  }
  const openGlyphMarginMenuRef = useRef(openGlyphMarginMenu)
  openGlyphMarginMenuRef.current = openGlyphMarginMenu

  // Puts the caret on the stopped line and scrolls it into view. This lives apart from the effect below
  // because the layout change that gives the scroll somewhere to go arrives after the effect has run.
  const applyPendingReveal = (): void => {
    const pending = pendingRevealRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pending || !editor || !model || useAppStore.getState().activeDocumentId !== documentId)
      return
    const target = Math.min(Math.max(pending.line, 1), model.getLineCount())
    editor.setPosition({ lineNumber: target, column: Math.min(Math.max(pending.column ?? 1, 1), model.getLineMaxColumn(target)) })
    editor.revealLineInCenterIfOutsideViewport(target)
    if (editor.getVisibleRanges().some((range) => target >= range.startLineNumber && target <= range.endLineNumber))
      pendingRevealRef.current = undefined
  }
  const applyPendingRevealRef = useRef(applyPendingReveal)
  applyPendingRevealRef.current = applyPendingReveal

  // The line a caret request put the caret on, until it has been scrolled into view. An editor mounted for
  // the request has no height yet when the caret is placed, so the scroll is tried again on its layout. A
  // request that restores a scroll position — going back in the history — keeps the position instead.
  const pendingCaretLineRef = useRef<{ line: number; scrollTop?: number } | undefined>(undefined)
  const scrollToPendingCaret = (): void => {
    const pending = pendingCaretLineRef.current
    const editor = editorRef.current
    if (pending === undefined || !editor)
      return
    if (pending.scrollTop !== undefined) {
      editor.setScrollTop(pending.scrollTop)
      if (editor.getLayoutInfo().height > 0)
        pendingCaretLineRef.current = undefined
      return
    }
    editor.revealLineInCenterIfOutsideViewport(pending.line)
    if (editor.getVisibleRanges().some((range) => pending.line >= range.startLineNumber && pending.line <= range.endLineNumber))
      pendingCaretLineRef.current = undefined
  }
  const scrollToPendingCaretRef = useRef(scrollToPendingCaret)
  scrollToPendingCaretRef.current = scrollToPendingCaret

  // The mount-time handlers cannot see this render's props, and the menu has to be built from the
  // state the click lands in — so the builder is kept in a ref, like the reveal above.
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  /**
   * dnSpy's MoveCaretToSpan: the caret to the end of the range and the range selected, the view scrolled so the
   * caret shows, and the editor focused.
   */
  const moveCaretTo = (range: TextRange, center = false): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model)
      return
    const { anchor, active } = caretForSpan(spansRef.current, range)
    const from = model.getPositionAt(anchor)
    const to = model.getPositionAt(active)
    editor.setSelection({ selectionStartLineNumber: from.lineNumber, selectionStartColumn: from.column, positionLineNumber: to.lineNumber, positionColumn: to.column })
    if (center)
      editor.revealLineInCenter(to.lineNumber)
    else
      editor.revealPositionInCenterIfOutsideViewport(to)
    editor.focus()
  }
  const moveCaretToRef = useRef(moveCaretTo)
  moveCaretToRef.current = moveCaretTo

  /**
   * dnSpy's DocumentViewerControl.GoTo: an opcode opens its page; a local moves the caret to its declaration
   * (a new tab gets a copy of the document for that); a member the document defines is shown where it is
   * defined, and any other member is followed into this tab or a new one. Every move is a step in the history.
   */
  const goTo = (span: TextSpan, newTab: boolean, followLocalReferences: boolean): void => {
    if (span.opCode) {
      commandsRef.current.onOpenUrl(opCodeUrl(span.opCode))
      return
    }
    if (isLocalSpan(span)) {
      if (newTab) {
        commandsRef.current.onFollowReference(span, true)
        return
      }
      if (!followLocalReferences)
        return
      const definition = definitionOf(spansRef.current, span) ?? (span.kind === 'definition' ? span : undefined)
      if (!definition)
        return
      commandsRef.current.onRecordHistory()
      moveCaretToRef.current(definition)
      return
    }
    if (!newTab) {
      const definition = definitionOf(spansRef.current, span)
      if (definition) {
        commandsRef.current.onRecordHistory()
        moveCaretToRef.current(definition)
        return
      }
    }
    commandsRef.current.onFollowReference(span, newTab)
  }
  const goToRef = useRef(goTo)
  goToRef.current = goTo

  /** The reference highlighter: what names the same thing as the reference or the keyword under the caret. */
  const updateHighlights = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position || !highlightDecorationsRef.current)
      return
    const offset = model.getOffsetAt(position)
    // Esc took the marks away; they come back once the caret moves somewhere else.
    if (highlightsClearedAtRef.current === offset)
      return
    highlightsClearedAtRef.current = undefined
    const options = advancedRef.current
    const keyword = options.highlightRelatedKeywords ? keywordAtCaret(keywordsRef.current, offset) : undefined
    const span = !keyword && options.referenceHighlighting ? spanAtCaret(spansRef.current, offset) : undefined
    const highlights = keyword ? keywordHighlights(keywordsRef.current, keyword) : span ? referenceHighlights(spansRef.current, span) : []
    highlightDecorationsRef.current.set(highlights.map((highlight) => ({
      range: rangeOf(model, highlight.start, highlight.length),
      options: { inlineClassName: highlightClass[highlight.kind] },
    })))
  }
  const updateHighlightsRef = useRef(updateHighlights)
  updateHighlightsRef.current = updateHighlights

  /**
   * dnSpy's BlockStructureService: a vertical line for each block whose lines are on screen, at the middle of the
   * column its ends start at, in its kind's color and the dash the options pick.
   */
  const drawBlockStructure = (): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const layer = blockLayerRef.current
    if (!editor || !model || !layer)
      return
    const options = advancedRef.current
    const blocks = documentRef.current?.blockStructures ?? []
    if (!options.showBlockStructure || blocks.length === 0) {
      layer.replaceChildren()
      return
    }
    const visible = editor.getVisibleRanges()
    if (visible.length === 0) {
      layer.replaceChildren()
      return
    }
    const firstVisible = visible[0].startLineNumber
    const lastVisible = visible[visible.length - 1].endLineNumber
    const monaco = monacoRef.current
    const fontInfo = monaco ? editor.getOption(monaco.editor.EditorOption.fontInfo) : undefined
    const charWidth = fontInfo?.typicalHalfwidthCharacterWidth ?? 8
    const tabSize = model.getOptions().tabSize
    const layout = editor.getLayoutInfo()
    // Monaco leaves a widget it does not position at no size; the layer spans the text area itself.
    layer.style.width = `${layout.contentLeft + layout.contentWidth}px`
    layer.style.height = `${layout.height}px`
    const scrollTop = editor.getScrollTop()
    const scrollLeft = editor.getScrollLeft()
    const dash = dashLength[options.blockStructureLineKind] ?? 0
    const elements: HTMLElement[] = []
    for (const line of blockLines(blocks, (offset) => model.getPositionAt(offset).lineNumber, (lineNumber) => model.getLineContent(lineNumber))) {
      if (line.toLine < firstVisible || line.fromLine > lastVisible)
        continue
      // The column counts tabs as the editor draws them.
      const text = model.getLineContent(line.fromLine - 1)
      let visual = 0
      for (let index = 0; index < line.column - 1 && index < text.length; index++)
        visual = text[index] === '\t' ? visual + tabSize - (visual % tabSize) : visual + 1
      const x = layout.contentLeft + visual * charWidth + Math.floor(charWidth / 2) - scrollLeft
      if (x < layout.contentLeft)
        continue
      const top = editor.getTopForLineNumber(line.fromLine) - scrollTop
      const bottom = editor.getTopForLineNumber(line.toLine + 1) - scrollTop
      const element = window.document.createElement('div')
      element.className = 'block-structure-line'
      element.style.left = `${x}px`
      element.style.top = `${top}px`
      element.style.height = `${Math.max(0, bottom - top)}px`
      const color = `var(--tc-${blockStructureColor(line.kind).toLowerCase()}, var(--tc-blockstructureother))`
      element.style.background = dash === 0
        ? color
        : `repeating-linear-gradient(to bottom, ${color} 0 ${dash}px, transparent ${dash}px ${dash * 2}px)`
      element.style.backgroundAttachment = 'local'
      elements.push(element)
    }
    layer.replaceChildren(...elements)
  }
  const drawBlockStructureRef = useRef(drawBlockStructure)
  drawBlockStructureRef.current = drawBlockStructure

  /**
   * dnSpy's Incremental Search (SearchService with an incremental search kind): Ctrl+I looks forward and
   * Ctrl+Shift+I back, from where the caret was, for what is typed — without regard to case — selecting each match
   * as the text grows; asked again, it goes on to the next match. Backspace takes the last character back, and any
   * other key, or a click, ends it with the match left selected.
   */
  const searchIncrementally = (forward: boolean, again: boolean): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const state = incrementalRef.current
    if (!editor || !model || !state || state.text.length === 0)
      return
    const selection = editor.getSelection()
    // The first search starts where the caret was; a repeated one from the match it is on.
    const from = again && selection
      ? (forward ? model.getOffsetAt(selection.getEndPosition()) : model.getOffsetAt(selection.getStartPosition()))
      : state.start
    const position = model.getPositionAt(from)
    const match = forward
      ? model.findNextMatch(state.text, position, false, false, null, false)
      : model.findPreviousMatch(state.text, position, false, false, null, false)
    if (!match)
      return
    editor.setSelection(match.range)
    editor.revealRangeInCenterIfOutsideViewport(match.range)
  }
  const startIncrementalSearch = (forward: boolean): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const position = editor?.getPosition()
    if (!editor || !model || !position)
      return
    const current = incrementalRef.current
    if (current && current.text.length > 0) {
      incrementalRef.current = { ...current, forward }
      setIncrementalSearch({ forward, text: current.text })
      searchIncrementally(forward, true)
      return
    }
    incrementalRef.current = { forward, text: '', start: model.getOffsetAt(position) }
    setIncrementalSearch({ forward, text: '' })
    editor.focus()
  }
  const startIncrementalSearchRef = useRef(startIncrementalSearch)
  startIncrementalSearchRef.current = startIncrementalSearch
  const searchIncrementallyRef = useRef(searchIncrementally)
  searchIncrementallyRef.current = searchIncrementally

  /** dnSpy's GoToCommand: the caret to a line — its first non-blank character — or to a line and column. */
  const applyGoToLine = (line: number, column?: number): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model)
      return
    const target = Math.min(Math.max(line, 1), model.getLineCount())
    const text = model.getLineContent(target)
    const firstNonBlank = text.length - text.trimStart().length + 1
    editor.setPosition({ lineNumber: target, column: Math.min(column ?? firstNonBlank, model.getLineMaxColumn(target)) })
    editor.revealLineInCenterIfOutsideViewport(target)
    editor.focus()
  }

  /**
   * Builds and shows the code viewer's context menu for a click at `line`/`column`. What the caret is on
   * decides most of it: the span under it names the reference, the statement under it stands in for a
   * member when there is no reference, and the breakpoint on its line is what the breakpoint commands act
   * on. The hex groups are the exception — they answer for the assembly explorer's selection, exactly as
   * the Edit menu does, because the commands behind them act on the selected node: dnSpy resolves them
   * from the document instead, but showing another node's target here would put entries on screen whose
   * action is somewhere else entirely. The hex group's file command is the other exception: it opens the
   * file this viewer is showing, which is the document dnSpy's `GetActiveAssemblyTreeNode` hands it.
   */
  const openContextMenu = async (line: number, column: number, screen: { x: number; y: number }): Promise<void> => {
    const current = document
    if (!current)
      return
    const editor = editorRef.current
    const model = editor?.getModel()
    const offset = model ? model.getOffsetAt({ lineNumber: line, column }) : -1
    // The reference under the caret, which the menu's reference commands act on.
    const span = offset >= 0 ? spanAtCaret(spansRef.current, offset) : undefined
    const memberSpan = span && !isLocalSpan(span) && !span.opCode ? span : undefined
    const state0 = useAppStore.getState()
    // The hex statement group is resolved from the caret, so the menu waits for the store to have it rather
    // than building from wherever the caret was before. The node the reference names is looked up alongside:
    // the tree lists a member only once its type has been expanded, and dnSpy's commands act on whatever the
    // reference is, not on what the tree happens to show. So are the document's module's entry point and
    // global constructor, which the token group offers only when the module has them.
    // The debugger commands' targets for the reference: what dnSpy's ClassBreakpointCommands and Break When Thrown
    // resolve the TextReference to, which only the backend can say.
    const debugReference = memberSpan?.targetNodeId
      ? { nodeId: memberSpan.targetNodeId }
      : memberSpan?.targetModulePath && memberSpan.targetMetadataToken !== undefined
        ? { modulePath: memberSpan.targetModulePath, metadataToken: memberSpan.targetMetadataToken }
        : undefined
    const [referenceNode, readsResource, documentNode, entryPoint, globalCctor, , debugTargets] = await Promise.all([
      memberSpan?.targetNodeId ? referenceNodeOf(memberSpan.targetNodeId) : undefined,
      // Go to Resource shows only on a member that reads a .resources entry, which only the backend can tell
      // — ResourceRef.TryCreate reads the member's IL — so it is asked alongside the rest.
      memberSpan?.targetNodeId ? state0.findResource(memberSpan.targetNodeId).then((id) => id !== null) : false,
      documentNodeOf(current.nodeId),
      state0.workspaceId ? window.dnSpy.getSpecialNode(state0.workspaceId, current.nodeId, 'entryPoint').then((found) => Boolean(found.nodeId), () => false) : false,
      state0.workspaceId ? window.dnSpy.getSpecialNode(state0.workspaceId, current.nodeId, 'globalCctor').then((found) => Boolean(found.nodeId), () => false) : false,
      useAppStore.getState().setCodeCaret({ documentId, line, column }),
      debugReference ? state0.debugCodeTargets([debugReference]) : Promise.resolve(undefined),
    ])
    const state = useAppStore.getState()
    const statements = statementsRef.current
    const statement = codeStatementAt(statements, line, column)
    const breakpoint = lineBreakpointAt(documentId, statements, breakpointsRef.current, line)
    // dnSpy's breakpoints at the caret: the ones the statement under it has.
    const breakpoints = statement
      ? breakpointsRef.current.filter((candidate) => {
        const position = breakpointPositionInDocument(documentId, statements, candidate)
        return position?.line === statement.startLine && position.column === statement.startColumn
      })
      : []
    const selection = editor?.getSelection()
    const copyText = (text: string): void => {
      void navigator.clipboard.writeText(text).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        useAppStore.getState().appendOutput(tRef.current('Copy failed: {message}', { message }))
      })
    }
    // The menu takes the focus, and Monaco hides the caret of an editor without it — so the caret the right
    // button just placed would vanish the moment the menu came up. dnSpy keeps it on screen, showing what
    // the menu is about; the view is marked for as long as the menu is open, which keeps it drawn.
    const shown = showCodeEditorContextMenu({
      t: tRef.current,
      documentNode: findNode(state, current.nodeId) ?? documentNode,
      referenceNode,
      // "Open in New Tab" acts on the reference itself, not the node it names: dnSpy follows the
      // TextReference under the caret, and a reference into a module the workspace does not hold has no
      // node here to name. A local opens the document again with the caret on its declaration.
      referenceTarget: span,
      openInNewTabFromKeyboard: false,
      statement,
      hasSelection: selection ? !selection.isEmpty() : false,
      breakpoint,
      breakpoints,
      debugTargets,
      selectionKind: state.selectedNode?.kind,
      // A code document is open in a viewer, which is what dnSpy's file command reads the file from.
      documentAvailable: true,
      hexTarget: state.hexTarget,
      hexStatement: state.hexStatement,
      debugState: state.debugState,
      stopped: state.debugState === 'stopped' && state.stoppedLocation !== undefined,
      canStartDebug: commandsRef.current.canStartDebug,
      onOpenInNewTab: (target) => goToRef.current(target, true, true),
      onStartDebug: () => commandsRef.current.onStartDebug(),
      onShowDisassembly: () => commandsRef.current.onShowDisassembly(),
      onToggleBreakpoint: () => void toggleLineBreakpointRef.current(documentId, line, column),
      onSetBreakpointEnabled: (enabled) => {
        const targets = breakpoints.length > 0 ? breakpoints : breakpoint ? [breakpoint] : []
        if (targets.length > 0)
          void useAppStore.getState().setBreakpointsEnabled(targets.map((candidate) => candidate.id), enabled)
      },
      onShowNextStatement: () => void useAppStore.getState().revealStoppedLocation(),
      onSetNextStatement: () => void useAppStore.getState().setNextStatement(),
      onRunToCursor: () => void useAppStore.getState().runToCursor(),
      onAddMethodBreakpoints: (targets) => void useAppStore.getState().addMethodBreakpoints(targets),
      onAddClassBreakpoint: (target) => commandsRef.current.onAddClassBreakpoint(target),
      onAddClassTracepoint: (target) => commandsRef.current.onAddClassTracepoint(target),
      onBreakWhenThrown: (typeName) => void useAppStore.getState().breakWhenThrown(typeName),
      // ReloadAllMethodBodiesCommand.CodeCommand acts on the tree's selected node, as dnSpy's does.
      onReloadMethodBodies: state.selectedNode && memoryModulePathOf(state, state.selectedNode.id) ? () => { if (state.selectedNode) void useAppStore.getState().reloadMethodBodies(state.selectedNode.id) } : undefined,
      onDeleteNode: (node) => commandsRef.current.onDeleteNode(node),
      onEditNode: (node) => commandsRef.current.onEditNode(node),
      onCreateMember: (kind, nested, node) => commandsRef.current.onCreateMember(kind, nested, node),
      onEditMethodBody: (node) => commandsRef.current.onEditMethodBody(node),
      onEditIlInstructions: (statement) => commandsRef.current.onEditIlInstructions(statement),
      onReplaceMethodBodyWithStub: (node) => commandsRef.current.onReplaceMethodBodyWithStub(node),
      onAnalyze: (node) => commandsRef.current.onAnalyze(node),
      onAnalyzeReference: (target) => commandsRef.current.onAnalyzeReference(target),
      onOpenUrl: (url) => commandsRef.current.onOpenUrl(url),
      readsResource,
      onGoToResource: (node) => commandsRef.current.onGoToResource(node),
      hasEntryPoint: entryPoint,
      hasGlobalCctor: globalCctor,
      onGoToEntryPoint: (node) => commandsRef.current.onGoToEntryPoint(node),
      onGoToGlobalCctor: (node) => commandsRef.current.onGoToGlobalCctor(node),
      onGoToToken: (node) => commandsRef.current.onGoToToken(node),
      onGoToMdTableRow: commandsRef.current.onGoToMdTableRow && ((node, token) => commandsRef.current.onGoToMdTableRow?.(node, token)),
      copyText,
      onCopy: () => {
        if (editor)
          void copyWithFormatting(editor, spansRef.current, tRef.current)
      },
      ilSelection: ilSelectionOf(documentRef.current, selection),
      onCopyIlBytes: () => void useAppStore.getState().copyIlBytes(ilSelectionOf(documentRef.current, selection)),
      onFind: () => void editor?.getAction('actions.find')?.run(),
      onIncrementalSearch: () => startIncrementalSearchRef.current(true),
      onOpenHex: () => commandsRef.current.onOpenHex(),
      onShowHexAt: (kind) => commandsRef.current.onShowHexAt(kind),
      onHexWriteBody: (kind) => commandsRef.current.onHexWriteBody(kind),
      onHexCopyBody: () => commandsRef.current.onHexCopyBody(),
      onHexPasteBody: () => commandsRef.current.onHexPasteBody(),
    }, screen, {
      onClose: () => {
        setMenuOpen(false)
        // dnSpy's view has the focus back once its menu closes. Monaco's own node cannot take it, so the editor
        // is asked to — unless what closed the menu put the focus somewhere of its own, a dialog or a widget.
        const active = window.document.activeElement
        if (!active || active === window.document.body)
          editor?.focus()
      },
    })
    if (shown)
      setMenuOpen(true)
  }
  const openContextMenuRef = useRef(openContextMenu)
  openContextMenuRef.current = openContextMenu

  useEffect(() => () => unregisterDocumentEditor(viewId), [viewId])

  // Ctrl shows the hand over every reference, the way dnSpy's mouse processor updates the cursor as the
  // modifier keys change.
  useEffect(() => {
    const update = (event: KeyboardEvent): void => setCtrlDown(event.ctrlKey && !event.shiftKey && !event.altKey)
    const clear = (): void => setCtrlDown(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', clear)
    }
  }, [])

  // What the hover reads for this model: the spans, and the workspace and language a member's Quick Info is
  // asked in. The model goes with the editor, so the record goes when the document is decompiled again.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model || !document || document.loading)
      return
    setDocumentEditorData(model, { workspaceId, language: quickInfoLanguage(document.requestedLanguage), spans: document.spans })
    return () => setDocumentEditorData(model, undefined)
  }, [document?.spans, document?.requestedLanguage, document?.loading, workspaceId, editorReady])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model || !decorationsRef.current)
      return
    decorationsRef.current.set(spanDecorations(model, spansRef.current))
  }, [document?.spans, document?.text, editorReady])

  // dnSpy's procedure line separators: a line under the end of each member, when the option asks for them.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model || !separatorDecorationsRef.current)
      return
    const lines = advanced.lineSeparators ? [...new Set((document?.lineSeparators ?? []).map((offset) => model.getPositionAt(offset).lineNumber))] : []
    separatorDecorationsRef.current.set(lines.map((line) => ({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: true, className: 'line-separator' },
    })))
  }, [document?.lineSeparators, document?.text, advanced.lineSeparators, editorReady])

  // The highlighter and the block structure follow the options as they change.
  useEffect(() => {
    updateHighlightsRef.current()
  }, [advanced.referenceHighlighting, advanced.highlightRelatedKeywords, document?.spans, document?.relatedKeywords, editorReady])

  useEffect(() => {
    drawBlockStructureRef.current()
  }, [advanced.showBlockStructure, advanced.blockStructureLineKind, document?.blockStructures, document?.text, zoom, tabs.tabSize, editorReady])

  useEffect(() => {
    breakpointDecorationsRef.current?.set(breakpointDecorations(documentId, breakpointStatementsOf(document), lineBreakpoints))
  }, [documentId, lineBreakpoints, document?.codeStatements, document?.language, document?.text, editorReady])

  useEffect(() => {
    bookmarkDecorationsRef.current?.set(bookmarkDecorations(documentId, document, bookmarks, t))
  }, [documentId, bookmarks, document?.codeStatements, document?.spans, document?.text, locale, editorReady])

  // The editor is taken down while the document is decompiled again — reopened, or switched to another
  // language — and a new one is mounted when the text is back. The effects that wait for `editorReady` have
  // to run again for that one, so the flag drops with the old editor rather than staying up across the swap.
  useEffect(() => {
    if (document?.loading) {
      editorRef.current = undefined
      setEditorReady(false)
    }
  }, [document?.loading])

  // "Go to bookmark", the analyzer's "Show Reference in Method", a followed reference and the history are
  // answered here rather than in the action itself: the place has to be shown in an editor that is mounted,
  // and only the mounted view knows its own model. A request is carried out once: the document it names may
  // be decompiled again as it is opened, and the editor that comes back is where the caret goes — later
  // reloads leave the caret alone. A request for a member's definition is answered from the spans, which
  // only the loaded document has.
  useEffect(() => {
    if (!caretReveal || caretReveal.documentId !== documentId || (caretReveal.viewId !== undefined && caretReveal.viewId !== viewId))
      return
    if (caretReveal.token === appliedCaretRevealRef.current)
      return
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || document?.loading)
      return
    appliedCaretRevealRef.current = caretReveal.token
    if (caretReveal.definitionNodeId) {
      const definition = definitionForNode(spansRef.current, caretReveal.definitionNodeId)
      if (definition) {
        moveCaretTo(definition, caretReveal.center)
        pendingCaretLineRef.current = { line: model.getPositionAt(definition.start).lineNumber }
        scrollToPendingCaret()
        return
      }
    }
    const line = Math.min(Math.max(caretReveal.line, 1), model.getLineCount())
    editor.setPosition({ lineNumber: line, column: Math.min(caretReveal.column, model.getLineMaxColumn(line)) })
    editor.focus()
    pendingCaretLineRef.current = { line, scrollTop: caretReveal.scrollTop }
    scrollToPendingCaret()
  }, [caretReveal, documentId, viewId, document?.text, document?.loading, editorReady])

  // The call stack's marks in this document — the current statement, the frame switched to, the other frames'
  // statements — wherever the frames' code locations have a statement here, whatever language the view is in.
  useEffect(() => {
    const statements = document?.codeStatements
    const frames = debugState === 'stopped'
      ? debugFrames.filter((frame) => !frame.isInternal).map((frame, index) => ({
        modulePath: frame.source?.path,
        metadataToken: frame.metadataToken,
        ilOffset: frame.ilOffset,
        current: index === 0,
        active: frame.id === activeDebugFrameId,
      }))
      : []
    stoppedDecorationsRef.current?.set(callStackDecorations(statements, frames))
  }, [debugFrames, activeDebugFrameId, debugState, document?.codeStatements, document?.text, editorReady])

  // The line the active frame is stopped at, when it is in this document. Stepping moves it one statement at a
  // time, so the view follows it — otherwise the marker would advance off-screen and the step would look like
  // nothing happened.
  useEffect(() => {
    let line = 0
    let column: number | undefined
    if (stoppedLocation && stoppedLocation.modulePath !== undefined && stoppedLocation.metadataToken !== undefined && stoppedLocation.ilOffset !== undefined) {
      const statement = statementOfLocation(document?.codeStatements, stoppedLocation.modulePath, stoppedLocation.metadataToken, stoppedLocation.ilOffset)
      if (statement) {
        line = statement.startLine
        column = statement.startColumn
      }
    }
    // A document without the frame's statements is only the frame's when the backend said so.
    if (line <= 0 && stoppedLocation?.nodeId === documentId && document?.language === 'csharp') {
      line = stoppedLocation.line
      column = stoppedLocation.column
    }
    if (line <= 0 || !stoppedLocation) {
      pendingRevealRef.current = undefined
      return
    }
    // Only the editor on screen can show a line, and the tab the request opened usually mounts after the
    // request was made — so the caret is placed when this document is the one in front.
    if (activeDocumentId !== documentId)
      return
    // The request is remembered the first time it is seen, and the reveal is retried on every run after
    // that. Monaco's editor is created asynchronously, so the run that first asks for the line is usually
    // the one where no editor exists yet to scroll — the mount that can is a later run of this effect.
    // Retrying is what makes the scroll land in that case; a request that has already landed leaves
    // nothing pending, so the repeats cost nothing.
    if (revealedTokenRef.current !== stoppedLocation.token) {
      revealedTokenRef.current = stoppedLocation.token
      pendingRevealRef.current = { line, column }
      // A step scrolls but leaves the keyboard where the user put it; a frame switch or Show Next
      // Statement is a navigation, and there the caret follows into the editor.
      if (stoppedLocation.caret)
        editorRef.current?.focus()
    }
    applyPendingReveal()
  }, [documentId, stoppedLocation, activeDocumentId, document?.text, document?.codeStatements, editorReady])

  // The Text Editor category of Environment › Font, in the theme in use, scaled by the viewers' zoom.
  const { fontFamily: editorFontFamily, fontSize: baseFontSize } = useCategoryFont('textEditor')

  const editorFontSize = Math.max(1, Math.round(baseFontSize * zoom) / 100)
  // dnSpy's text view keeps its lines taller than the font unless "Don't add extra line spacing" is on.
  const lineHeight = Math.round(editorFontSize * (advanced.minimumLineSpacing ? 1.25 : 1.55))
  // One object for as long as nothing in it changes: the editor is handed it again on every render, and a new
  // one would have it apply every option afresh, which stops a smooth scroll that is under way.
  const editorOptions = useMemo<MonacoEditor.IStandaloneEditorConstructionOptions>(() => ({
    readOnly: true,
    automaticLayout: true,
    // The viewer draws dnSpy's menu instead (CodeEditorContextMenu.tsx), so Monaco's own — and
    // the browser's, which Monaco only suppresses to put its own up — is switched off.
    contextmenu: false,
    // dnSpy's viewer has neither folding nor Monaco's guides, word highlighter and links; its block
    // structure lines and its reference highlighter are drawn here instead.
    folding: false,
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    links: false,
    guides: { indentation: false, bracketPairs: false, highlightActiveIndentation: false },
    matchBrackets: advanced.highlightMatchingBrace ? 'always' : 'never',
    glyphMargin: advanced.glyphMargin,
    lineDecorationsWidth: 14,
    lineNumbers: general.showLineNumbers ? 'on' : 'off',
    wordWrap: general.wordWrap ? 'on' : 'off',
    renderLineHighlight: general.highlightCurrentLine ? 'all' : 'none',
    renderWhitespace: general.useVisibleWhitespace ? 'all' : 'none',
    scrollbar: {
      horizontal: scrollBars.horizontalScrollBar ? 'auto' : 'hidden',
      vertical: scrollBars.verticalScrollBar ? 'auto' : 'hidden',
    },
    tabSize: tabs.tabSize,
    fontFamily: editorFontFamily,
    fontSize: editorFontSize,
    lineHeight,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 8, bottom: 8 },
  }), [advanced, general, scrollBars, tabs.tabSize, editorFontFamily, editorFontSize, lineHeight])

  if (!document)
    return <div className="pane-empty">{t('Document closed')}</div>

  const editorLanguage = document.language === 'visual-basic'
    ? 'vb'
    : document.language === 'il'
      ? 'il'
      : document.language === 'plaintext'
        ? 'plaintext'
        : document.language === 'xml'
          ? 'xml'
          : 'csharp'
  const editorTheme = monacoThemeName(theme, transparentBackground)
  const showZoomControl = advanced.zoomControl && scrollBars.horizontalScrollBar

  return (
    <div
      className="document-view"
      data-reference-count={document.spans.filter(isNavigableSpan).length}
      onWheelCapture={(event) => {
        // Ctrl+wheel zooms the viewers when the option allows it — and only them, not the tab's other content.
        if (!event.ctrlKey || event.deltaY === 0)
          return
        event.preventDefault()
        event.stopPropagation()
        if (advancedRef.current.mouseWheelZoom)
          setDocumentViewerZoom((current) => (event.deltaY < 0 ? zoomIn(current) : zoomOut(current)))
      }}
    >
      <div className="document-toolbar">
        {!['csharp', 'visual-basic', 'il'].includes(document.language) && <span className="document-language-label">{document.language === 'xml' ? 'XAML/XML' : document.language}</span>}
        {document.diagnostics.length > 0 && (
          <span className="document-diagnostic" title={document.diagnostics.map((diagnostic) => diagnostic.message).join('\n')}>
            {/* The port's own count of the decompiler's warnings, in dnSpy's StatusWarning image. */}
            <DsIcon name="StatusWarning" /> {document.diagnostics.length}
          </span>
        )}
        {incrementalSearch && (
          <span className="document-incremental-search" role="status">
            {t(incrementalSearch.forward ? 'Incremental Search' : 'Reverse Incremental Search')}: {incrementalSearch.text}
          </span>
        )}
        {/* dnSpy's ZoomControl sits in the view's bottom margin; here it is in the row the view already has
            above the text, at its right end, so the text keeps the height it had. */}
        {showZoomControl && <ZoomControl zoom={zoom} onZoom={(value) => setDocumentViewerZoom(() => value)} />}
      </div>
      <div className={['editor-host', menuOpen ? 'code-menu-open' : '', ctrlDown ? 'ctrl-down' : ''].filter(Boolean).join(' ')}>
        {document.loading ? (
          <div className="loading-state"><LoaderCircle className="spin" size={18} /> {t('Loading')}</div>
        ) : (
          <Editor
            path={`${viewId}.${editorLanguage}`}
            value={document.text}
            language={editorLanguage}
            theme={editorTheme}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              monacoRef.current = monaco
              registerDocumentEditor(viewId, editor, documentId)
              // The decoration collections exist from here on, so the effects that fill them can run again.
              setEditorReady(true)

              // Restore cursor and scroll position from saved session
              const savedDoc = useAppStore.getState().documents[documentId]
              if (savedDoc?.cursorLine !== undefined && savedDoc.cursorColumn !== undefined) {
                editor.setPosition({ lineNumber: savedDoc.cursorLine, column: savedDoc.cursorColumn })
              }
              if (savedDoc?.scrollTop !== undefined) {
                editor.setScrollTop(savedDoc.scrollTop)
              }

              // Save cursor position changes
              editor.onDidChangeCursorPosition(() => {
                const position = editor.getPosition()
                if (position) {
                  useAppStore.getState().updateDocumentEditorState(
                    documentId,
                    position.lineNumber,
                    position.column,
                    editor.getScrollTop()
                  )
                }
                updateHighlightsRef.current()
              })

              // Save scroll position changes
              editor.onDidScrollChange(() => {
                // The popup belongs to a line; a scroll takes the line away from under it.
                clearGlyphTimers()
                glyphTimersRef.current.line = undefined
                setGlyphPopup(undefined)
                const position = editor.getPosition()
                if (position) {
                  useAppStore.getState().updateDocumentEditorState(
                    documentId,
                    position.lineNumber,
                    position.column,
                    editor.getScrollTop()
                  )
                }
                drawBlockStructureRef.current()
              })

              // A frame navigation opens its document while the tab is still being laid out, so the reveal
              // it asks for finds an editor without a height; this is where that request is tried again.
              editor.onDidLayoutChange(() => {
                applyPendingRevealRef.current()
                scrollToPendingCaretRef.current()
                drawBlockStructureRef.current()
              })
              editor.onDidChangeConfiguration(() => drawBlockStructureRef.current())
              const updateLanguageId = (): void => {
                const languageId = editor.getModel()?.getLanguageId()
                if (languageId)
                  editor.getDomNode()?.setAttribute('data-language-id', languageId)
              }
              updateLanguageId()
              editor.onDidChangeModel(updateLanguageId)
              decorationsRef.current = editor.createDecorationsCollection()
              highlightDecorationsRef.current = editor.createDecorationsCollection()
              separatorDecorationsRef.current = editor.createDecorationsCollection()
              breakpointDecorationsRef.current = editor.createDecorationsCollection()
              breakpointDecorationsRef.current.set(breakpointDecorations(documentId, statementsRef.current, breakpointsRef.current))
              bookmarkDecorationsRef.current = editor.createDecorationsCollection()
              bookmarkDecorationsRef.current.set(bookmarkDecorations(documentId, documentRef.current, bookmarksRef.current, tRef.current))
              stoppedDecorationsRef.current = editor.createDecorationsCollection()
              const model = editor.getModel()
              if (!model) return
              decorationsRef.current.set(spanDecorations(model, spansRef.current))

              // The block structure lines' own layer, under the pointer and over the text's background.
              const layer = window.document.createElement('div')
              layer.className = 'block-structure-layer'
              blockLayerRef.current = layer
              editor.addOverlayWidget({
                getId: () => `dnspy.blockStructure.${viewId}`,
                getDomNode: () => layer,
                getPosition: () => null,
              })

              const offsetAtCaret = (): number | undefined => {
                const position = editor.getPosition()
                return position ? model.getOffsetAt(position) : undefined
              }
              // dnSpy's FollowReference (F12, Enter) and FollowReferenceNewTab (Ctrl+F12, Ctrl+Enter): the
              // reference at the caret, a local's declaration included.
              const followAtCaret = (newTab: boolean): void => {
                const offset = offsetAtCaret()
                const span = offset === undefined ? undefined : spanAtCaret(spansRef.current, offset)
                if (span)
                  goToRef.current(span, newTab, true)
              }
              editor.addCommand(monaco.KeyCode.F12, () => followAtCaret(false))
              editor.addCommand(monaco.KeyCode.Enter, () => followAtCaret(false), '!findWidgetVisible && !findInputFocussed')
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12, () => followAtCaret(true))
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => followAtCaret(true), '!findWidgetVisible && !findInputFocussed')
              // dnSpy's MoveToNextReference and MoveToPreviousReference — Tab and Ctrl+Shift+Down, Shift+Tab and
              // Ctrl+Shift+Up — and MoveToNextDefinition and MoveToPreviousDefinition, Alt+Down and Alt+Up.
              const moveReference = (forward: boolean): void => {
                const offset = offsetAtCaret()
                const target = offset === undefined ? undefined : nextReference(spansRef.current, keywordsRef.current, offset, forward)
                if (target)
                  moveCaretToRef.current(target)
              }
              const moveDefinition = (forward: boolean): void => {
                const offset = offsetAtCaret()
                const target = offset === undefined ? undefined : nextDefinition(spansRef.current, offset, forward)
                if (target)
                  moveCaretToRef.current(target)
              }
              editor.addCommand(monaco.KeyCode.Tab, () => moveReference(true), '!findWidgetVisible && !findInputFocussed')
              editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => moveReference(false), '!findWidgetVisible && !findInputFocussed')
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.DownArrow, () => moveReference(true))
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.UpArrow, () => moveReference(false))
              editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => moveDefinition(true))
              editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => moveDefinition(false))
              // Esc clears the highlighted references and the selection — once the find box has had its Esc.
              editor.addCommand(monaco.KeyCode.Escape, () => {
                highlightDecorationsRef.current?.clear()
                const position = editor.getPosition()
                if (position) {
                  highlightsClearedAtRef.current = model.getOffsetAt(position)
                  editor.setSelection({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column })
                }
              }, '!findWidgetVisible && !suggestWidgetVisible')
              // dnSpy's Incremental Search: Ctrl+I and Ctrl+Shift+I start it, or go on to the next match; while it is
              // on, the keys typed are what it looks for.
              editor.onKeyDown((event) => {
                const browserEvent = event.browserEvent
                const isI = browserEvent.code === 'KeyI' && browserEvent.ctrlKey && !browserEvent.altKey && !browserEvent.metaKey
                if (isI) {
                  event.preventDefault()
                  event.stopPropagation()
                  startIncrementalSearchRef.current(!browserEvent.shiftKey)
                  return
                }
                const state = incrementalRef.current
                if (!state || ['Control', 'Shift', 'Alt', 'Meta'].includes(browserEvent.key))
                  return
                if (browserEvent.key === 'Backspace' && !browserEvent.ctrlKey && !browserEvent.altKey) {
                  event.preventDefault()
                  event.stopPropagation()
                  incrementalRef.current = { ...state, text: state.text.slice(0, -1) }
                  setIncrementalSearch({ forward: state.forward, text: state.text.slice(0, -1) })
                  if (state.text.length > 1)
                    searchIncrementallyRef.current(state.forward, false)
                  return
                }
                if (browserEvent.key.length === 1 && !browserEvent.ctrlKey && !browserEvent.altKey && !browserEvent.metaKey) {
                  event.preventDefault()
                  event.stopPropagation()
                  incrementalRef.current = { ...state, text: state.text + browserEvent.key }
                  setIncrementalSearch({ forward: state.forward, text: state.text + browserEvent.key })
                  searchIncrementallyRef.current(state.forward, false)
                  return
                }
                // Any other key ends the search and does what it does; Esc and Enter only end it.
                incrementalRef.current = undefined
                setIncrementalSearch(undefined)
                if (browserEvent.key === 'Escape' || browserEvent.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                }
              })
              editor.onMouseDown(() => {
                if (incrementalRef.current) {
                  incrementalRef.current = undefined
                  setIncrementalSearch(undefined)
                }
              })
              editor.onDidBlurEditorText(() => {
                if (incrementalRef.current) {
                  incrementalRef.current = undefined
                  setIncrementalSearch(undefined)
                }
              })
              // dnSpy's Go to Line, Ctrl+G.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => {
                const position = editor.getPosition()
                setGoToLine({ currentLine: position?.lineNumber ?? 1, lineCount: model.getLineCount() })
              })
              // Copy writes the HTML dnSpy's HtmlBuilderService makes beside the text, for a paste that keeps the colors.
              const copy = (): void => void copyWithFormatting(editor, spansRef.current, tRef.current)
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, copy)
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Insert, copy)
              // dnSpy's Copy IL Bytes, Ctrl+B, over the instructions an IL view's selection covers.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
                const instructions = ilSelectionOf(documentRef.current, editor.getSelection())
                if (instructions.length > 0)
                  void useAppStore.getState().copyIlBytes(instructions)
              })
              // The zoom keys of dnSpy's text editor: Ctrl+Shift+. Ctrl+= and Ctrl+NumPad+ in, their opposites out,
              // Ctrl+0 back to 100%.
              const zoomBy = (step: (current: number) => number) => (): void => setDocumentViewerZoom(step)
              for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Period, monaco.KeyCode.Equal, monaco.KeyCode.NumpadAdd])
                editor.addCommand(monaco.KeyMod.CtrlCmd | key, zoomBy(zoomIn))
              for (const key of [monaco.KeyMod.Shift | monaco.KeyCode.Comma, monaco.KeyCode.Minus, monaco.KeyCode.NumpadSubtract])
                editor.addCommand(monaco.KeyMod.CtrlCmd | key, zoomBy(zoomOut))
              for (const key of [monaco.KeyCode.Digit0, monaco.KeyCode.Numpad0])
                editor.addCommand(monaco.KeyMod.CtrlCmd | key, zoomBy(() => 100))
              // View White Space: Ctrl+Shift+8, Ctrl+R Ctrl+W, Ctrl+E S and Ctrl+E Ctrl+S. Word wrap: Ctrl+E Ctrl+W
              // and Ctrl+E W, which the window also answers when the focus is elsewhere.
              const toggleWhitespace = (): void => toggleDocumentViewerOption('useVisibleWhitespace')
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit8, toggleWhitespace)
              editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW), toggleWhitespace)
              editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyCode.KeyS), toggleWhitespace)
              editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS), toggleWhitespace)
              editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW), () => toggleDocumentViewerOption('wordWrap'))
              editor.addCommand(monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE, monaco.KeyCode.KeyW), () => toggleDocumentViewerOption('wordWrap'))
              // dnSpy's Ctrl+Shift+R in the code viewer analyzes the reference under the caret — what the
              // context menu's Analyze would, a member of a module the workspace does not hold included.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR, () => {
                const offset = offsetAtCaret()
                const span = offset === undefined ? undefined : spanAtCaret(spansRef.current, offset)
                if (!span || isLocalSpan(span) || span.opCode) return
                void (async () => {
                  const referenceNode = span.targetNodeId ? await referenceNodeOf(span.targetNodeId) : undefined
                  const external = externalMemberTarget({ referenceNode, referenceTarget: span })
                  if (isAnalyzableNode(referenceNode))
                    commandsRef.current.onAnalyze(referenceNode)
                  else if (external)
                    commandsRef.current.onAnalyzeReference(external)
                })()
              })
              // The caret decides which statement "Show Instructions in Hex Editor" acts on, so the store
              // is told where it is — but only while this editor is the one the user is working in; a
              // background tab moving its own caret is not a change of the current position.
              const reportCaret = (): void => {
                if (!isActiveDocumentEditor(viewId)) return
                const position = editor.getPosition()
                void useAppStore.getState().setCodeCaret(position ? { documentId, line: position.lineNumber, column: position.column } : undefined)
              }
              editor.onDidChangeCursorPosition(reportCaret)
              editor.onDidFocusEditorText(reportCaret)
              // F9 in the editor sets a line breakpoint at the cursor; the window-level handler in App.tsx only sees
              // F9 when the focus is outside the editor, so the two never both fire.
              editor.addCommand(monaco.KeyCode.F9, () => {
                const position = editor.getPosition()
                if (position)
                  void toggleLineBreakpointRef.current(documentId, position.lineNumber, position.column)
              })
              // dnSpy's Ctrl+F9, ToggleEnableBreakpoint: the breakpoints on the caret's line are disabled when all of
              // them are enabled, and enabled otherwise.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F9, () => {
                const position = editor.getPosition()
                const onLine = position ? lineBreakpointsAt(documentId, statementsRef.current, breakpointsRef.current, position.lineNumber) : []
                if (onLine.length > 0)
                  void useAppStore.getState().setBreakpointsEnabled(onLine.map((breakpoint) => breakpoint.id), !onLine.every((breakpoint) => breakpoint.enabled))
              })
              // The right button puts the caret where it lands, as dnSpy's `OnMouseRightButtonDown` does —
              // unless it lands inside the selection, which then stays for the menu's Copy to act on.
              const placeCaretForMenu = (position: { lineNumber: number; column: number }): void => {
                const selection = editor.getSelection()
                if (!selection || selection.isEmpty() || !selection.containsPosition(position))
                  editor.setPosition(position)
              }
              // Where the last right press landed, which the menu it brings up is about. Chromium on Linux fires
              // `contextmenu` straight after the press, before Monaco has redrawn the caret the press just moved
              // there, and the hit test then lands on the caret's element and reads the position it was last
              // drawn at — the old one, which would take the caret back.
              let rightPress: { position: { lineNumber: number; column: number }; x: number; y: number } | undefined
              // The document viewer's own context menu, in place of Monaco's (which `contextmenu: false`
              // switches off): dnSpy's grouping and order, with the commands this port can run. The caret
              // moves to the click first — the menu is about what it landed on, and the hex statement group
              // is resolved from the caret, so the menu waits for that answer rather than building from
              // wherever the caret happened to be.
              editor.onContextMenu((event) => {
                const screen = { x: event.event.browserEvent.clientX, y: event.event.browserEvent.clientY }
                if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                  event.event.preventDefault()
                  event.event.stopPropagation()
                  rightPress = undefined
                  if (event.target.position)
                    openGlyphMarginMenuRef.current(event.target.position.lineNumber, screen)
                  return
                }
                const press = rightPress
                rightPress = undefined
                const pressed = press && Math.abs(press.x - screen.x) <= 2 && Math.abs(press.y - screen.y) <= 2 ? press.position : undefined
                const position = pressed ?? event.target.position
                if (!position) return
                event.event.preventDefault()
                event.event.stopPropagation()
                // The press has placed the caret already; a menu that came up without one — over the margins,
                // say — places it here.
                if (!pressed)
                  placeCaretForMenu(position)
                void openContextMenuRef.current(position.lineNumber, position.column, screen)
              })
              // Method breakpoints are demoted to the context menu now that a plain gutter click sets a line
              // breakpoint: "Add Method Breakpoint" there is the way left to say "break wherever this method
              // starts", so the action that only fed Monaco's menu is gone.
              // The commands act on the caret of the focused editor, which is this one whenever a chord
              // arrives here, so they can go through the same path the menu and the window use. The keys are
              // dnSpy's document viewer table — its Ctrl+K and Ctrl+B chords and the F2 family, F2 here walking
              // the bookmarks rather than renaming — and only their Monaco menu entries went with the menu.
              const bookmarkActions = new Set<string>()
              const addBookmarkAction = (label: string, run: () => void): void => {
                if (bookmarkActions.has(label))
                  return
                bookmarkActions.add(label)
                editor.addAction({ id: `dnspy.bookmark.${label.replace(/\W+/g, '')}`, label: tRef.current(label), run })
              }
              const letter = (key: string): number => monaco.KeyCode[`Key${key.toUpperCase()}` as keyof typeof monaco.KeyCode]
              for (const chord of bookmarkChords) {
                addBookmarkAction(chord.label, chord.run)
                const prefix = monaco.KeyMod.CtrlCmd | letter(chord.prefix)
                editor.addCommand(monaco.KeyMod.chord(prefix, monaco.KeyMod.CtrlCmd | letter(chord.key)), chord.run)
                if (chord.plain)
                  editor.addCommand(monaco.KeyMod.chord(prefix, letter(chord.key)), chord.run)
              }
              for (const binding of bookmarkFunctionKeys) {
                addBookmarkAction(binding.label, binding.run)
                editor.addCommand((binding.ctrl ? monaco.KeyMod.CtrlCmd : 0) | (binding.shift ? monaco.KeyMod.Shift : 0) | monaco.KeyCode.F2, binding.run)
              }
              // dnSpy's DocumentViewerMouseProcessor: the left button's press only notes the reference under it;
              // the release on the same character follows it — a plain click a member reference into this tab, a
              // Ctrl+click anything into a new one. Any other modifier, or a drag to another character, is no click.
              let leftPress: { lineNumber: number; column: number; span: TextSpan | undefined; ctrl: boolean } | undefined
              editor.onMouseDown((event) => {
                // Monaco leaves the right button to the browser, which takes the focus off the editor and so hides
                // its caret. dnSpy focuses the view and moves the caret on the press, before the menu comes up;
                // the right button never toggles the marks in the margins, which is the left button's job.
                rightPress = undefined
                leftPress = undefined
                if (event.event.rightButton) {
                  const position = event.target.position
                  if (position && (event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT || event.target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY)) {
                    event.event.preventDefault()
                    editor.focus()
                    placeCaretForMenu(position)
                    rightPress = { position, x: event.event.browserEvent.clientX, y: event.event.browserEvent.clientY }
                  }
                  return
                }
                // A click in the margin next to the line numbers toggles a breakpoint on that line. The click does not
                // have to land on a statement — the store snaps it to the nearest one the engine can bind.
                if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                  void toggleLineBreakpointRef.current(documentId, event.target.position?.lineNumber ?? 0)
                  return
                }
                // The bookmark strip is the one to its right, so the two marks never collide.
                if (event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
                  useAppStore.getState().toggleBookmark(documentId, event.target.position?.lineNumber ?? 0)
                  return
                }
                const position = event.target.position
                const browserEvent = event.event
                const modifiersAllowed = !browserEvent.shiftKey && !browserEvent.altKey && !browserEvent.metaKey
                if (!event.event.leftButton || !position || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !modifiersAllowed)
                  return
                // The hit test answers the character boundary nearest the pointer, which is either edge of the
                // character under it; the element under the pointer tells whether that character is in a reference.
                const element = event.target.element
                const onReference = element?.closest('.code-reference, .code-definition, .code-local') !== null && element !== null
                const offset = model.getOffsetAt(position)
                const span = onReference ? spanAtClick(spansRef.current, offset) ?? spanAtClick(spansRef.current, offset - 1) : undefined
                leftPress = { lineNumber: position.lineNumber, column: position.column, span, ctrl: browserEvent.ctrlKey }
              })
              editor.onMouseMove((event) => {
                if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position)
                  hoverGlyphRef.current(event.target.position.lineNumber)
                else
                  leaveGlyphRef.current()
              })
              editor.onMouseLeave(() => leaveGlyphRef.current())
              editor.onMouseUp((event) => {
                const press = leftPress
                leftPress = undefined
                const position = event.target.position
                if (!press?.span || !position || position.lineNumber !== press.lineNumber || position.column !== press.column)
                  return
                const browserEvent = event.event
                if (browserEvent.shiftKey || browserEvent.altKey || browserEvent.metaKey || browserEvent.ctrlKey !== press.ctrl)
                  return
                const span = press.span
                // Without Ctrl a definition and a local only place the caret; with it, every reference is followed.
                if (!press.ctrl && (span.kind === 'definition' || isLocalSpan(span)))
                  return
                goToRef.current(span, press.ctrl, false)
              })
            }}
            options={editorOptions}
          />
        )}
        {glyphPopup && (() => {
          const breakpoint = lineBreakpoints.find((candidate) => candidate.id === glyphPopup.breakpointId)
          return breakpoint ? (
            <BreakpointGlyphPopup
              breakpoint={breakpoint}
              left={glyphPopup.left}
              top={glyphPopup.top}
              lineHeight={glyphPopup.lineHeight}
              toolTip={glyphPopup.toolTip}
              fading={glyphPopup.fading}
              onEnter={enterGlyphPopup}
              onLeave={leaveGlyph}
              onSettings={() => { clearGlyphTimers(); setGlyphPopup(undefined); useAppStore.getState().editBreakpointSettings([breakpoint.id]) }}
              onToggle={() => { clearGlyphTimers(); setGlyphPopup(undefined); void useAppStore.getState().setBreakpointsEnabled([breakpoint.id], !breakpoint.enabled) }}
            />
          ) : null
        })()}
      </div>
      {goToLine && (
        <GoToLineDialog
          currentLine={goToLine.currentLine}
          lineCount={goToLine.lineCount}
          onClose={() => {
            setGoToLine(undefined)
            editorRef.current?.focus()
          }}
          onGo={(line, column) => {
            setGoToLine(undefined)
            applyGoToLine(line, column)
          }}
        />
      )}
    </div>
  )
}
