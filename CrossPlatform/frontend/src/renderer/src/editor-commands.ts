import type * as Monaco from 'monaco-editor'

let nextEditor = 0

/** Binds a key to a handler in one editor; `when` narrows it further with Monaco's context keys. */
export type EditorCommand = (keybinding: number, handler: () => void, when?: string) => void

/**
 * The keyboard commands of one Monaco editor. Monaco's standalone editors share one keybinding service, so a command
 * an editor adds with `addCommand` fires in whichever editor has the focus — the one added last wins, and a code
 * editor opened over a document tab would have its Enter, Tab and Ctrl+C taken by the tab's. Each editor gets a
 * context key of its own here, and its commands are bound under it, the way dnSpy's command targets are its views'.
 */
export const editorCommands = (editor: Monaco.editor.IStandaloneCodeEditor): EditorCommand => {
  const key = `dnSpyEditor${++nextEditor}`
  editor.createContextKey(key, true)
  return (keybinding, handler, when) => {
    editor.addCommand(keybinding, handler, when ? `${key} && (${when})` : key)
  }
}
