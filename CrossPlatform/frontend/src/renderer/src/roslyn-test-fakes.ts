import { vi } from 'vitest'
import type * as Monaco from 'monaco-editor'

// Just enough of Monaco's models, ranges and editors for the Roslyn bindings' unit tests.

/** A model over a string, enough of Monaco's for offsets and change events. */
export class FakeModel {
  readonly listeners: (() => void)[] = []
  readonly uri: { toString(): string }

  constructor(public text: string, uri = 'inmemory://model/1') {
    this.uri = { toString: () => uri }
  }

  getValue(): string { return this.text }

  setValue(text: string): void {
    this.text = text
    for (const listener of [...this.listeners]) listener()
  }

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.text.split('\n')
    let offset = 0
    for (let i = 0; i < position.lineNumber - 1; i++) offset += lines[i].length + 1
    return offset + position.column - 1
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.text.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
  }

  getLineContent(lineNumber: number): string { return this.text.split('\n')[lineNumber - 1] }

  getValueInRange(range: FakeRange): string {
    const start = this.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn })
    const end = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn })
    return this.text.slice(start, end)
  }

  onDidChangeContent(listener: () => void): Monaco.IDisposable {
    this.listeners.push(listener)
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) }
  }
}

export class FakeRange {
  constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {}

  containsPosition(position: { lineNumber: number; column: number }): boolean {
    const afterStart = position.lineNumber > this.startLineNumber || position.lineNumber === this.startLineNumber && position.column >= this.startColumn
    const beforeEnd = position.lineNumber < this.endLineNumber || position.lineNumber === this.endLineNumber && position.column <= this.endColumn
    return afterStart && beforeEnd
  }
}

export const fakeEditor = (model: FakeModel) => {
  const decorations = { set: vi.fn(), clear: vi.fn() }
  const container = document.createElement('div')
  const editor = {
    getModel: () => model,
    createDecorationsCollection: () => decorations,
    onDidChangeModelContent: (listener: () => void) => model.onDidChangeContent(listener),
    updateOptions: vi.fn(),
    getContainerDomNode: () => container,
  }
  return { editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor, decorations, container }
}


/** A selection as Monaco keeps it: an anchor and the caret, enough for the word commands. */
export class FakeSelection {
  constructor(
    public selectionStartLineNumber: number,
    public selectionStartColumn: number,
    public positionLineNumber: number,
    public positionColumn: number,
  ) {}

  getPosition(): { lineNumber: number; column: number } { return { lineNumber: this.positionLineNumber, column: this.positionColumn } }

  isEmpty(): boolean { return this.selectionStartLineNumber === this.positionLineNumber && this.selectionStartColumn === this.positionColumn }
}

/**
 * An editor that also takes keyboard commands and edits — the commands are kept by their keybinding so a test can
 * press them — for the bindings' word commands.
 */
export const fakeCommandEditor = (model: FakeModel) => {
  const { editor: base, decorations, container } = fakeEditor(model)
  const commands = new Map<number, () => void>()
  let selection = new FakeSelection(1, 1, 1, 1)
  const editor = Object.assign(base as unknown as Record<string, unknown>, {
    createContextKey: vi.fn(),
    addCommand: vi.fn((keybinding: number, handler: () => void) => { commands.set(keybinding, handler) }),
    trigger: vi.fn(),
    getSelection: () => selection,
    setSelection: vi.fn((next: FakeSelection) => { selection = next }),
    getPosition: () => selection.getPosition(),
    revealPosition: vi.fn(),
    pushUndoStop: vi.fn(),
    executeEdits: vi.fn((_source: string, edits: { range: FakeRange; text: string }[]) => {
      for (const edit of edits) {
        const start = model.getOffsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn })
        const end = model.getOffsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn })
        model.setValue(model.text.slice(0, start) + edit.text + model.text.slice(end))
      }
    }),
    onKeyDown: () => ({ dispose: () => {} }),
    onMouseDown: () => ({ dispose: () => {} }),
    onMouseMove: () => ({ dispose: () => {} }),
    onMouseUp: () => ({ dispose: () => {} }),
  })
  ;(model as unknown as { getVersionId(): number }).getVersionId = () => model.text.length
  return {
    editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    decorations,
    container,
    commands,
    select: (anchor: number, active: number) => {
      const from = model.getPositionAt(anchor)
      const to = model.getPositionAt(active)
      selection = new FakeSelection(from.lineNumber, from.column, to.lineNumber, to.column)
    },
    selection: () => selection,
  }
}
