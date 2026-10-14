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

