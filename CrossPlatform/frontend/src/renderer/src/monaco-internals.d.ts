// The Monaco internals the Roslyn code editor draws dnSpy's completion list and signature help with. They are
// not part of the editor API and ship without declarations; only what roslyn-editor-contribs.ts uses is declared.

declare module 'monaco-editor/editor/contrib/suggest/browser/suggestWidgetRenderer' {
  export class ItemRenderer {
    renderElement(element: unknown, index: number, templateData: unknown): void
  }
}

declare module 'monaco-editor/editor/contrib/parameterHints/browser/parameterHintsWidget' {
  export class ParameterHintsWidget {
    render(hints: unknown): void
  }
}
