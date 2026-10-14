import Editor from './CodeEditor'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import type { editor as MonacoEditor } from 'monaco-editor'
// A reference that goes somewhere is decorated and clickable; which spans those are is a rule about the
// spans themselves, so it is asked of them rather than decided here.
import { isNavigableSpan, type CodeStatement, type TextSpan, type TreeNode } from '../../../shared/protocol'
import { bookmarkMarkers, breakpointStatementsOf, codeStatementAt, findNode, lineBreakpointAt, lineBreakpointMarkers, useAppStore } from '../app-store'
import { bookmarkChords, bookmarkFunctionKeys } from '../bookmark-commands'
import type { Bookmark, BookmarkDocument, HexBodyKind, LineBreakpoint } from '../app-store'
import { isActiveDocumentEditor, registerDocumentEditor, unregisterDocumentEditor } from '../editor-registry'
import { useLanguage } from '../localization'
import { monacoThemeName } from '../monaco'
import { useAppOptions } from './app-options'
import { externalMemberTarget, isAnalyzableNode, showCodeEditorContextMenu } from './CodeEditorContextMenu'
import type { CreatedKind, HexShowKind } from './edit-menu'

// One decoration per breakpoint that has a line in this document. A disabled breakpoint keeps its dot but draws it
// hollow; one the engine has not bound (module not loaded yet, or no sequence point at that offset) draws it grey.
const breakpointDecorations = (
  nodeId: string,
  statements: CodeStatement[] | undefined,
  breakpoints: LineBreakpoint[],
  translate: (message: string) => string,
): MonacoEditor.IModelDeltaDecoration[] =>
  lineBreakpointMarkers(nodeId, statements, breakpoints).map((marker) => ({
    range: { startLineNumber: marker.line, startColumn: 1, endLineNumber: marker.line, endColumn: 1 },
    options: {
      glyphMarginClassName: !marker.enabled ? 'breakpoint-glyph-disabled' : marker.state === 'unbound' ? 'breakpoint-glyph-unbound' : 'breakpoint-glyph',
      hoverMessage: {
        value: [
          marker.description ?? '',
          marker.enabled ? translate('Enabled') : translate('Disabled'),
          marker.state === 'bound' ? '' : marker.message ?? (marker.state === 'pending' ? translate('Module not loaded yet.') : ''),
        ].filter(Boolean).join('\n'),
      },
    },
  }))

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

/**
 * The context menu commands only the shell can run: everything that opens a tab, a dialog or a tool
 * window, plus the hex commands, which are the same ones the Edit menu carries. The viewer answers the
 * rest itself, from the caret, the document on screen and the breakpoints on it.
 */
export interface DocumentViewCommands {
  /** Follows a reference in a new tab — dnSpy's document viewer "Open in New Tab". */
  onOpenInNewTab(target: TextSpan): void
  onStartDebug(): void
  /** Whether a debug target is configured, so "Start Debugging..." has something to run. */
  canStartDebug: boolean
  onShowDisassembly(): void
  onDeleteNode(node: TreeNode): void
  onEditNode(node: TreeNode): void
  /** Opens the create dialog for a node of this kind inside the type the node belongs to. */
  onCreateMember(kind: CreatedKind, nested: boolean, node: TreeNode): void
  onEditMethodBody(node: TreeNode): void
  onReplaceMethodBodyWithStub(node: TreeNode): void
  onAnalyze(node: TreeNode): void
  /** dnSpy's class breakpoint and class tracepoint for the type a reference names. */
  onAddClassBreakpoint(node: TreeNode): void
  onAddClassTracepoint(node: TreeNode): void
  /** Analyzes a reference into a module the workspace does not hold, opening that module to do it. */
  onAnalyzeReference(target: TextSpan): void
  /** Opens an address in the browser, which is how the menu's "Search MSDN" runs. */
  onOpenUrl(url: string): void
  /** dnSpy's Go to Resource for the member the reference names: selects and opens the entry it reads. */
  onGoToResource(node: TreeNode): void
  onOpenHex(): void
  onShowHexAt(kind: HexShowKind): void
  onHexWriteBody(kind: HexBodyKind): void
  onHexCopyBody(): void
  onHexPasteBody(): void
}

export const DocumentView = ({ documentId, viewId, theme, transparentBackground, onNavigate, commands }: { documentId: string; viewId: string; theme: string; transparentBackground: boolean; onNavigate(target: TextSpan): void; commands: DocumentViewCommands }): React.JSX.Element => {
  const wordWrap = useAppStore((state) => state.wordWrap)
  const highlightCurrentLine = useAppStore((state) => state.highlightCurrentLine)
  const document = useAppStore((state) => state.documents[documentId])
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const bookmarks = useAppStore((state) => state.bookmarks)
  const caretReveal = useAppStore((state) => state.caretReveal)
  const toggleLineBreakpoint = useAppStore((state) => state.toggleLineBreakpoint)
  const stoppedLocation = useAppStore((state) => state.stoppedLocation)
  const activeDocumentId = useAppStore((state) => state.activeDocumentId)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | undefined>(undefined)
  // Monaco is created asynchronously, so the effects below can find no editor on their first run. This
  // makes the mount a dependency of theirs: a document that arrives already decompiled — which is what a
  // frame navigation produces — has no later store change to run them again on.
  const [editorReady, setEditorReady] = useState(false)
  // Whether this view's context menu is open, which styles.css reads to keep the caret drawn while the menu has
  // the focus. It marks the host rather than Monaco's own node, whose class list Monaco rewrites on every blur.
  const [menuOpen, setMenuOpen] = useState(false)
  // The stopped-location request whose line this view already moved the caret to.
  const revealedTokenRef = useRef(0)
  // The caret request — a bookmark's, the analyzer's — this view already carried out.
  const appliedCaretRevealRef = useRef(0)
  // The reveal that has not landed yet. A frame navigation opens its document while the tab is still being
  // laid out, so the scroll it asks for finds an editor with no height and moves nowhere; keeping the
  // request until the line is really on screen is what makes the second attempt (on a layout change) work.
  const pendingRevealRef = useRef<{ line: number; column?: number } | undefined>(undefined)
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const breakpointDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const bookmarkDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  const stoppedDecorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | undefined>(undefined)
  // onMount registers the mouse handler once, so it reads the current values through refs instead of the closure.
  const spansRef = useRef(document?.spans ?? [])
  const documentRef = useRef(document)
  // The statements the breakpoint commands work off — the C# view's alone, see `breakpointStatementsOf`.
  const statementsRef = useRef(breakpointStatementsOf(document))
  const breakpointsRef = useRef(lineBreakpoints)
  const bookmarksRef = useRef(bookmarks)
  const toggleLineBreakpointRef = useRef(toggleLineBreakpoint)
  const { locale, t } = useLanguage()
  const tRef = useRef(t)
  tRef.current = t
  spansRef.current = document?.spans ?? []
  documentRef.current = document
  statementsRef.current = breakpointStatementsOf(document)
  breakpointsRef.current = lineBreakpoints
  bookmarksRef.current = bookmarks
  toggleLineBreakpointRef.current = toggleLineBreakpoint

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
  // the request has no height yet when the caret is placed, so the scroll is tried again on its layout.
  const pendingCaretLineRef = useRef<number | undefined>(undefined)
  const scrollToPendingCaret = (): void => {
    const line = pendingCaretLineRef.current
    const editor = editorRef.current
    if (line === undefined || !editor)
      return
    editor.revealLineInCenterIfOutsideViewport(line)
    if (editor.getVisibleRanges().some((range) => line >= range.startLineNumber && line <= range.endLineNumber))
      pendingCaretLineRef.current = undefined
  }
  const scrollToPendingCaretRef = useRef(scrollToPendingCaret)
  scrollToPendingCaretRef.current = scrollToPendingCaret

  // The mount-time mouse handler cannot see this render's props, and the menu has to be built from the
  // state the click lands in — so the builder is kept in a ref, like the reveal above.
  const commandsRef = useRef(commands)
  commandsRef.current = commands

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
    // A reference under the caret is a span, and only a C# document has them: VB and IL decompile without
    // any, which is why their menus carry no command that needs a reference to act on.
    const span = offset >= 0
      ? spansRef.current.find((candidate) => isNavigableSpan(candidate) && offset >= candidate.start && offset <= candidate.start + candidate.length)
      : undefined
    // The hex statement group is resolved from the caret, so the menu waits for the store to have it rather
    // than building from wherever the caret was before. The node the reference names is looked up alongside:
    // the tree lists a member only once its type has been expanded, and dnSpy's commands act on whatever the
    // reference is, not on what the tree happens to show.
    const [referenceNode, readsResource] = await Promise.all([
      span?.targetNodeId !== undefined ? referenceNodeOf(span.targetNodeId) : undefined,
      // Go to Resource shows only on a member that reads a .resources entry, which only the backend can tell
      // — ResourceRef.TryCreate reads the member's IL — so it is asked alongside the rest.
      span?.targetNodeId !== undefined ? useAppStore.getState().findResource(span.targetNodeId).then((id) => id !== null) : false,
      useAppStore.getState().setCodeCaret({ documentId, line, column }),
    ])
    const state = useAppStore.getState()
    const statements = statementsRef.current
    const statement = codeStatementAt(statements, line, column)
    const breakpoint = lineBreakpointAt(documentId, statements, breakpointsRef.current, line)
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
      documentNode: findNode(state, current.nodeId),
      referenceNode,
      // "Open in New Tab" acts on the reference itself, not the node it names: dnSpy follows the
      // TextReference under the caret, and a reference into a module the workspace does not hold has no
      // node here to name.
      referenceTarget: span,
      statement,
      hasSelection: selection ? !selection.isEmpty() : false,
      breakpoint,
      selectionKind: state.selectedNode?.kind,
      // A code document is open in a viewer, which is what dnSpy's file command reads the file from.
      documentAvailable: true,
      hexTarget: state.hexTarget,
      hexStatement: state.hexStatement,
      debugState: state.debugState,
      stopped: state.debugState === 'stopped' && state.stoppedLocation !== undefined,
      canStartDebug: commandsRef.current.canStartDebug,
      onOpenInNewTab: (target) => commandsRef.current.onOpenInNewTab(target),
      onStartDebug: () => commandsRef.current.onStartDebug(),
      onShowDisassembly: () => commandsRef.current.onShowDisassembly(),
      onToggleBreakpoint: () => void toggleLineBreakpointRef.current(documentId, line, column),
      onSetBreakpointEnabled: (enabled) => {
        if (breakpoint)
          void useAppStore.getState().setLineBreakpointEnabled(breakpoint.id, enabled)
      },
      onShowNextStatement: () => void useAppStore.getState().revealStoppedLocation(),
      onAddMethodBreakpoints: (targets) => void useAppStore.getState().addMethodBreakpoints(targets),
      onAddClassBreakpoint: (node) => commandsRef.current.onAddClassBreakpoint(node),
      onAddClassTracepoint: (node) => commandsRef.current.onAddClassTracepoint(node),
      onDeleteNode: (node) => commandsRef.current.onDeleteNode(node),
      onEditNode: (node) => commandsRef.current.onEditNode(node),
      onCreateMember: (kind, nested, node) => commandsRef.current.onCreateMember(kind, nested, node),
      onEditMethodBody: (node) => commandsRef.current.onEditMethodBody(node),
      onReplaceMethodBodyWithStub: (node) => commandsRef.current.onReplaceMethodBodyWithStub(node),
      onAnalyze: (node) => commandsRef.current.onAnalyze(node),
      onAnalyzeReference: (target) => commandsRef.current.onAnalyzeReference(target),
      onOpenUrl: (url) => commandsRef.current.onOpenUrl(url),
      readsResource,
      onGoToResource: (node) => commandsRef.current.onGoToResource(node),
      copyText,
      // Monaco's copy is a command rather than one of the editor's actions, so `getAction` has nothing to run:
      // the selected text is written out here, one selection per line as Monaco would.
      onCopy: () => {
        const model = editor?.getModel()
        const selections = editor?.getSelections()?.filter((range) => !range.isEmpty())
        if (model && selections?.length)
          copyText(selections.map((range) => model.getValueInRange(range)).join(model.getEOL()))
      },
      onFind: () => void editor?.getAction('actions.find')?.run(),
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

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !decorationsRef.current) return
    decorationsRef.current.set(spansRef.current.filter(isNavigableSpan).map((span) => {
      const start = model.getPositionAt(span.start)
      const end = model.getPositionAt(span.start + span.length)
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        options: {
          inlineClassName: span.kind === 'definition' ? 'code-definition' : 'code-reference',
          hoverMessage: { value: span.kind === 'definition' ? t('Definition') : t('Go to definition (F12)') },
        },
      }
    }))
  }, [document?.spans, document?.text, locale, editorReady])

  useEffect(() => {
    breakpointDecorationsRef.current?.set(breakpointDecorations(documentId, breakpointStatementsOf(document), lineBreakpoints, t))
  }, [documentId, lineBreakpoints, document?.codeStatements, document?.language, document?.text, locale, editorReady])

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

  // "Go to bookmark" and the analyzer's "Show Reference in Method" are answered here rather than in the
  // action itself: the place has to be shown in an editor that is mounted, and only the mounted view knows
  // its own model. A request is carried out once: the document it names may be decompiled again as it is
  // opened, and the editor that comes back is where the caret goes — later reloads leave the caret alone.
  useEffect(() => {
    if (!caretReveal || caretReveal.documentId !== documentId || (caretReveal.viewId !== undefined && caretReveal.viewId !== viewId))
      return
    if (caretReveal.token === appliedCaretRevealRef.current)
      return
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model)
      return
    const line = Math.min(Math.max(caretReveal.line, 1), model.getLineCount())
    editor.setPosition({ lineNumber: line, column: Math.min(caretReveal.column, model.getLineMaxColumn(line)) })
    editor.focus()
    appliedCaretRevealRef.current = caretReveal.token
    pendingCaretLineRef.current = line
    scrollToPendingCaret()
  }, [caretReveal, documentId, viewId, document?.text, editorReady])

  // The line the active frame is stopped at, in the document that frame decompiles to. Stepping moves it one
  // statement at a time, so the view follows it — otherwise the marker would advance off-screen and the step
  // would look like nothing happened.
  useEffect(() => {
    const line = stoppedLocation?.nodeId === documentId ? stoppedLocation.line : 0
    stoppedDecorationsRef.current?.set(line > 0
      ? [{
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: 'debug-stopped-line',
            glyphMarginClassName: 'debug-stopped-glyph',
            hoverMessage: { value: `${t('Stopped here')}: ${stoppedLocation?.name ?? ''}` },
          },
        }]
      : [])
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
      pendingRevealRef.current = { line, column: stoppedLocation.column }
      // A step scrolls but leaves the keyboard where the user put it; a frame switch or Show Next
      // Statement is a navigation, and there the caret follows into the editor.
      if (stoppedLocation.caret)
        editorRef.current?.focus()
    }
    applyPendingReveal()
  }, [documentId, stoppedLocation, activeDocumentId, document?.text, locale, editorReady])

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
  const font = useAppOptions().environmentFont
  const editorFontFamily = `'${font.fontFamily}', 'JetBrains Mono', monospace`
  const editorFontSize = font.fontSize

  return (
    <div className="document-view" data-reference-count={document.spans.filter(isNavigableSpan).length}>
      <div className="document-toolbar">
        {!['csharp', 'visual-basic', 'il'].includes(document.language) && <span className="document-language-label">{document.language === 'xml' ? 'XAML/XML' : document.language}</span>}
        {document.diagnostics.length > 0 && (
          <span className="document-diagnostic" title={document.diagnostics.map((diagnostic) => diagnostic.message).join('\n')}>
            <AlertTriangle size={14} /> {document.diagnostics.length}
          </span>
        )}
      </div>
      <div className={menuOpen ? 'editor-host code-menu-open' : 'editor-host'}>
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
              })

              // Save scroll position changes
              editor.onDidScrollChange(() => {
                const position = editor.getPosition()
                if (position) {
                  useAppStore.getState().updateDocumentEditorState(
                    documentId,
                    position.lineNumber,
                    position.column,
                    editor.getScrollTop()
                  )
                }
              })

              // A frame navigation opens its document while the tab is still being laid out, so the reveal
              // it asks for finds an editor without a height; this is where that request is tried again.
              editor.onDidLayoutChange(() => {
                applyPendingRevealRef.current()
                scrollToPendingCaretRef.current()
              })
              const updateLanguageId = (): void => {
                const languageId = editor.getModel()?.getLanguageId()
                if (languageId)
                  editor.getDomNode()?.setAttribute('data-language-id', languageId)
              }
              updateLanguageId()
              editor.onDidChangeModel(updateLanguageId)
              decorationsRef.current = editor.createDecorationsCollection()
              breakpointDecorationsRef.current = editor.createDecorationsCollection()
              breakpointDecorationsRef.current.set(breakpointDecorations(documentId, statementsRef.current, breakpointsRef.current, tRef.current))
              bookmarkDecorationsRef.current = editor.createDecorationsCollection()
              bookmarkDecorationsRef.current.set(bookmarkDecorations(documentId, documentRef.current, bookmarksRef.current, tRef.current))
              stoppedDecorationsRef.current = editor.createDecorationsCollection()
              const model = editor.getModel()
              if (!model) return
              decorationsRef.current.set(spansRef.current.filter(isNavigableSpan).map((span) => {
                const start = model.getPositionAt(span.start)
                const end = model.getPositionAt(span.start + span.length)
                return {
                  range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                  options: {
                    inlineClassName: span.kind === 'definition' ? 'code-definition' : 'code-reference',
                    hoverMessage: { value: span.kind === 'definition' ? t('Definition') : t('Go to definition (F12)') },
                  },
                }
              }))
              const navigateAtCursor = (): void => {
                const position = editor.getPosition()
                if (!position) return
                const offset = model.getOffsetAt(position)
                const span = spansRef.current.find((candidate) => isNavigableSpan(candidate) && offset >= candidate.start && offset <= candidate.start + candidate.length)
                if (span) onNavigate(span)
              }
              editor.addCommand(monaco.KeyCode.F12, navigateAtCursor)
              // dnSpy's Ctrl+Shift+R in the code viewer analyzes the reference under the caret — what the
              // context menu's Analyze would, a member of a module the workspace does not hold included.
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR, () => {
                const position = editor.getPosition()
                if (!position) return
                const offset = model.getOffsetAt(position)
                const span = spansRef.current.find((candidate) => isNavigableSpan(candidate) && offset >= candidate.start && offset <= candidate.start + candidate.length)
                if (!span) return
                void (async () => {
                  const referenceNode = span.targetNodeId !== undefined ? await referenceNodeOf(span.targetNodeId) : undefined
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
              editor.onMouseDown((event) => {
                // Monaco leaves the right button to the browser, which takes the focus off the editor and so hides
                // its caret. dnSpy focuses the view and moves the caret on the press, before the menu comes up;
                // the right button never toggles the marks in the margins, which is the left button's job.
                rightPress = undefined
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
                if (event.event.ctrlKey && event.target.position) {
                  editor.setPosition(event.target.position)
                  navigateAtCursor()
                }
              })
            }}
            options={{
              readOnly: true,
              automaticLayout: true,
              // The viewer draws dnSpy's menu instead (CodeEditorContextMenu.tsx), so Monaco's own — and
              // the browser's, which Monaco only suppresses to put its own up — is switched off.
              contextmenu: false,
              glyphMargin: true,
              lineDecorationsWidth: 14,
              wordWrap: wordWrap ? 'on' : 'off',
              renderLineHighlight: highlightCurrentLine ? 'all' : 'none',
              fontFamily: editorFontFamily,
              fontSize: editorFontSize,
              // dnSpy's text view keeps its lines a fifth taller than the font, which is what the editor
              // was drawing before the font became an option.
              lineHeight: Math.round(editorFontSize * 1.55),
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              smoothScrolling: true,
              tabSize: 4,
              padding: { top: 8, bottom: 8 },
            }}
          />
        )}
      </div>
    </div>
  )
}
