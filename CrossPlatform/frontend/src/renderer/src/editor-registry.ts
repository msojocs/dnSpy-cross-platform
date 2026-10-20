import type { editor as MonacoEditor } from 'monaco-editor'
import type { CaretPosition } from './app-store'
import { virtualSpacesOf } from './virtual-space'

interface DocumentEditor {
  editor: MonacoEditor.IStandaloneCodeEditor
  documentId: string
}

// Keyed by tab id (`viewId`), not documentId: cloned tabs share one documentId, so a documentId map
// would keep only whichever clone mounted last.
const editors = new Map<string, DocumentEditor>()
const pendingFocus = new Set<string>()
// The editor a pane acts on when it has no cursor of its own — the last one the user was typing in,
// which is dnSpy's "current code editor".
let activeViewId: string | undefined

export const registerDocumentEditor = (viewId: string, editor: MonacoEditor.IStandaloneCodeEditor, documentId: string): void => {
  editors.set(viewId, { editor, documentId })
  activeViewId = viewId
  editor.onDidFocusEditorText(() => {
    activeViewId = viewId
  })
  // Switching a document's language unmounts the editor and mounts a fresh one, so a focus request
  // that arrives mid-switch has to wait for the new editor to register.
  if (pendingFocus.delete(viewId))
    editor.focus()
}

export const unregisterDocumentEditor = (viewId: string): void => {
  editors.delete(viewId)
  if (activeViewId === viewId)
    activeViewId = undefined
}

/** Focus the editor of `viewId`, or the one that replaces it if it is mid-remount. */
export const focusDocumentEditor = (viewId: string): void => {
  const entry = editors.get(viewId)
  if (entry) {
    entry.editor.focus()
    return
  }
  pendingFocus.add(viewId)
}

/**
 * Opens Monaco's find widget in the editor the user last worked in — dnSpy's Edit > Find, which acts
 * on the focused text view rather than on the assembly search. Returns false when no editor is open.
 */
export const findInActiveDocumentEditor = (): boolean => {
  const entry = activeViewId === undefined ? undefined : editors.get(activeViewId)
  if (!entry)
    return false
  entry.editor.focus()
  void entry.editor.getAction('actions.find')?.run()
  return true
}

/**
 * Where the caret sits in the editor the user last worked in, with the document it shows. Commands
 * issued from a tool window or the menu have no cursor of their own and mean "here".
 */
export const activeDocumentPosition = (): CaretPosition | undefined => {
  const entry = activeViewId === undefined ? undefined : editors.get(activeViewId)
  const position = entry?.editor.getPosition()
  return entry && position ? { documentId: entry.documentId, line: position.lineNumber, column: position.column } : undefined
}

/**
 * Whether `viewId` is the editor the user last worked in. A caret that moves in a background tab must
 * not be taken for the current position, so a listener reports only when it is the active one.
 */
export const isActiveDocumentEditor = (viewId: string): boolean => activeViewId === viewId

/**
 * Where the caret sits in the editor of `viewId`, or undefined when that view is not open. A caret in virtual
 * space is a column past its line's end, one for each virtual space — what dnSpy's tab history and saved tabs
 * keep as CaretVirtualSpaces.
 */
export const caretPosition = (viewId: string): { line: number; column: number } | undefined => {
  const editor = editors.get(viewId)?.editor
  const position = editor?.getPosition()
  return editor && position ? { line: position.lineNumber, column: position.column + virtualSpacesOf(editor) } : undefined
}

/** How far the editor of `viewId` is scrolled, or undefined when that view is not open. */
export const documentEditorScrollTop = (viewId: string): number | undefined => editors.get(viewId)?.editor.getScrollTop()

/**
 * Puts the caret on `line` and shows it, the way a "go to" command does. Returns false when the view
 * is closed, so the caller can fall back instead of silently doing nothing.
 */
export const revealInDocumentEditor = (viewId: string, line: number, column = 1): boolean => {
  const editor = editors.get(viewId)?.editor
  const model = editor?.getModel()
  if (!editor || !model)
    return false
  const target = Math.min(Math.max(line, 1), model.getLineCount())
  editor.setPosition({ lineNumber: target, column: Math.min(Math.max(column, 1), model.getLineMaxColumn(target)) })
  editor.revealLineInCenterIfOutsideViewport(target)
  editor.focus()
  return true
}
