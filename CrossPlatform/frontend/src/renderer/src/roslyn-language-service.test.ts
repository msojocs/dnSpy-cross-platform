import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { CodeCompletionList, CodeSignature } from '../../shared/protocol'
import { FakeModel, FakeRange, fakeEditor } from './roslyn-test-fakes'

// The real Monaco contributions need a browser; the providers under test do not.
vi.mock('./roslyn-editor-contribs', () => ({}))

type Module = typeof import('./roslyn-language-service')

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A Monaco that records the providers registered with it. */
const fakeMonaco = () => {
  const providers: Record<string, any> = {}
  const register = (name: string) => vi.fn((_language: string, provider: unknown) => {
    providers[name] = provider
    return { dispose: () => {} }
  })
  const monaco = {
    Range: FakeRange,
    Uri: { parse: (value: string) => ({ value }) },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: { setModelMarkers: vi.fn() },
    languages: {
      CompletionItemKind: { Method: 0, Function: 1, Field: 3, Variable: 4, Class: 5, Struct: 6, Interface: 7, Module: 8, Property: 9, Event: 10, Operator: 11, Enum: 15, EnumMember: 16, Keyword: 17, Constant: 14, Snippet: 27, Text: 18, Reference: 21, TypeParameter: 24 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
      registerCompletionItemProvider: register('completion'),
      registerHoverProvider: register('hover'),
      registerSignatureHelpProvider: register('signatureHelp'),
      registerOnTypeFormattingEditProvider: register('onTypeFormatting'),
      registerSelectionRangeProvider: register('selectionRange'),
    },
  }
  return { monaco: monaco as unknown as typeof Monaco, providers, setModelMarkers: monaco.editor.setModelMarkers }
}

describe('the Roslyn language service binding', () => {
  let service: Module
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(async () => {
    vi.resetModules()
    service = await import('./roslyn-language-service')
    api = {
      openCodeDocument: vi.fn(async () => ({ documentId: 'code-1' })),
      updateCodeDocument: vi.fn(async () => undefined),
      closeCodeDocument: vi.fn(async () => undefined),
      classifyCodeDocument: vi.fn(async () => ({ spans: [] })),
      getCodeCompletion: vi.fn(),
      getCodeCompletionDescription: vi.fn(),
      getCodeQuickInfo: vi.fn(),
      getCodeSignatureHelp: vi.fn(),
      getCodeDiagnostics: vi.fn(),
      getCodeIndentation: vi.fn(),
      getCodeSelectionRanges: vi.fn(),
    }
    Object.assign(window.dnSpy, api)
  })

  afterEach(() => vi.restoreAllMocks())

  const setUp = (text: string) => {
    const { monaco, providers, setModelMarkers } = fakeMonaco()
    service.registerRoslynLanguageService(monaco)
    const model = new FakeModel(text)
    const { editor, decorations, container } = fakeEditor(model)
    return { monaco, providers, setModelMarkers, model, editor, decorations, container }
  }

  it('answers nothing for a model no editor attached, without asking the backend', async () => {
    const { providers, model } = setUp('class C { }')

    const position = { lineNumber: 1, column: 3 }
    expect(await providers.completion.provideCompletionItems(model, position, { triggerKind: 0 })).toBeUndefined()
    expect(await providers.hover.provideHover(model, position)).toBeUndefined()
    expect(await providers.signatureHelp.provideSignatureHelp(model, position, {}, {})).toBeUndefined()
    expect(await providers.selectionRange.provideSelectionRanges(model, [position])).toBeUndefined()
    expect(api.getCodeCompletion).not.toHaveBeenCalled()
    expect(api.getCodeQuickInfo).not.toHaveBeenCalled()
  })

  it('registers its providers once', () => {
    const { monaco } = fakeMonaco()
    service.registerRoslynLanguageService(monaco)
    service.registerRoslynLanguageService(monaco)

    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(1)
  })

  it('opens a document, colors it, and sends every edit before the request that follows it', async () => {
    const { monaco, providers, model, editor, decorations, container } = setUp('class C { }')
    api.classifyCodeDocument.mockResolvedValue({ spans: [{ start: 0, length: 5, color: 'keyword' }] })

    service.attachRoslynDocument(monaco, editor)
    await flush()

    expect(api.openCodeDocument).toHaveBeenCalledWith({ text: 'class C { }' })
    expect(decorations.set).toHaveBeenCalledWith([{ range: new FakeRange(1, 1, 1, 6), options: { inlineClassName: 'tc-keyword' } }])
    expect(container.classList.contains('code-colors')).toBe(true)
    expect(editor.updateOptions).toHaveBeenCalledWith({ formatOnType: true })

    api.getCodeQuickInfo.mockResolvedValue({ quickInfo: null })
    model.text = 'class D { }'
    await providers.hover.provideHover(model, { lineNumber: 1, column: 8 })

    expect(api.updateCodeDocument).toHaveBeenCalledWith('code-1', 'class D { }')
    expect(api.updateCodeDocument.mock.invocationCallOrder[0]).toBeLessThan(api.getCodeQuickInfo.mock.invocationCallOrder[0])
    expect(api.getCodeQuickInfo).toHaveBeenCalledWith('code-1', 7)
  })

  it('maps a completion list onto Monaco items and resolves their tooltips', async () => {
    const text = 'class C { void M() { System.Console.Wr } }'
    const { monaco, providers, model, editor } = setUp(text)
    service.attachRoslynDocument(monaco, editor)
    const start = text.indexOf('Wr')
    const list: CodeCompletionList = {
      resultId: 3,
      span: { start, length: 2 },
      suggestionMode: false,
      items: [
        { index: 0, displayText: 'WriteLine', displayTextPrefix: '', displayTextSuffix: '', inlineDescription: '', filterText: 'WriteLine', sortText: 'WriteLine', insertText: 'WriteLine', tags: ['Method', 'Public'], matchPriority: 0, preselect: true, commitCharacters: '(.', edit: null },
        { index: 1, displayText: 'List', displayTextPrefix: '', displayTextSuffix: '<>', inlineDescription: 'System.Collections.Generic', filterText: 'List', sortText: 'List', insertText: 'List', tags: ['Class'], matchPriority: 0, preselect: false, commitCharacters: '', edit: { start, length: 2, newText: 'List<int>' } },
      ],
    }
    api.getCodeCompletion.mockResolvedValue({ list })
    api.getCodeCompletionDescription.mockResolvedValue({ parts: [{ text: 'void', color: 'text' }, { text: ' Console.WriteLine()', color: 'text' }] })

    const position = { lineNumber: 1, column: start + 3 }
    const result = await providers.completion.provideCompletionItems(model, position, { triggerKind: 1, triggerCharacter: 'r' })

    expect(api.getCodeCompletion).toHaveBeenCalledWith('code-1', start + 2, 'r')
    const [writeLine, generic] = result.suggestions
    expect(writeLine.label).toEqual({ label: 'WriteLine', description: undefined })
    expect(writeLine.kind).toBe(0)
    expect(writeLine.insertText).toBe('WriteLine')
    expect(writeLine.range).toEqual({ insert: new FakeRange(1, start + 1, 1, start + 3), replace: new FakeRange(1, start + 1, 1, start + 3) })
    expect(writeLine.commitCharacters).toEqual(['(', '.'])
    expect(writeLine.preselect).toBe(true)
    expect(generic.label).toEqual({ label: 'List<>', description: 'System.Collections.Generic' })
    // A complex edit on the caret's line replaces its own range.
    expect(generic.insertText).toBe('List<int>')
    expect(generic.range).toEqual(new FakeRange(1, start + 1, 1, start + 3))

    const resolved = await providers.completion.resolveCompletionItem(writeLine)
    expect(api.getCodeCompletionDescription).toHaveBeenCalledWith('code-1', 3, 0)
    expect(resolved.documentation.value).toContain('Console.WriteLine()')
    expect(resolved.documentation.supportHtml).toBe(true)
  })

  it('never commits by typing in suggestion mode', async () => {
    const { monaco, providers, model, editor } = setUp('x')
    service.attachRoslynDocument(monaco, editor)
    api.getCodeCompletion.mockResolvedValue({
      list: { resultId: 1, span: { start: 0, length: 1 }, suggestionMode: true, items: [{ index: 0, displayText: 'x', displayTextPrefix: '', displayTextSuffix: '', inlineDescription: '', filterText: 'x', sortText: 'x', insertText: 'x', tags: ['Local'], matchPriority: 0, preselect: false, commitCharacters: ' (', edit: null }] },
    })

    const result = await providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 })

    expect(api.getCodeCompletion).toHaveBeenCalledWith('code-1', 1, null)
    expect(result.suggestions[0].commitCharacters).toEqual([])
    expect(result.suggestions[0].kind).toBe(4)
  })

  it('shows each Quick Info section over the symbol', async () => {
    const { monaco, providers, model, editor } = setUp('int x;')
    service.attachRoslynDocument(monaco, editor)
    api.getCodeQuickInfo.mockResolvedValue({
      quickInfo: {
        span: { start: 4, length: 1 },
        glyph: 'LocalVariable',
        warning: false,
        sections: [
          { kind: 'Description', parts: [{ text: '(local) ', color: 'text' }, { text: 'int', color: 'keyword' }, { text: ' x<y>', color: 'local' }] },
          { kind: 'DocumentationComments', parts: [{ text: 'A count.', color: 'text' }] },
        ],
      },
    })

    const hover = await providers.hover.provideHover(model, { lineNumber: 1, column: 5 })

    expect(hover.range).toEqual(new FakeRange(1, 5, 1, 6))
    expect(hover.contents).toHaveLength(2)
    expect(hover.contents[0].value).toContain('(local) ')
    // Code is escaped: the markdown carries it as text, not as tags.
    expect(hover.contents[0].value).toContain('x&lt;y&gt;')
    expect(hover.contents[1].value).toBe('A count.')
  })

  it('lays a signature out as one label with each parameter\'s place in it', () => {
    const signature: CodeSignature = {
      prefix: [{ text: 'int', color: 'keyword' }, { text: ' C.Add(', color: 'text' }],
      separator: [{ text: ',', color: 'punctuation' }, { text: ' ', color: 'text' }],
      suffix: [{ text: ')', color: 'punctuation' }],
      parameters: [
        { name: 'a', display: [{ text: 'int a', color: 'text' }], documentation: [], isOptional: false },
        { name: 'b', display: [{ text: 'int b = 0', color: 'text' }], documentation: [{ text: 'The second.', color: 'text' }], isOptional: true },
      ],
      documentation: [{ text: 'Adds.', color: 'text' }],
      isVariadic: false,
    }

    const information = service.toSignatureInformation(signature)

    expect(information.label).toBe('int C.Add(int a, int b = 0)')
    expect(information.parameters.map((p) => p.label)).toEqual([[10, 15], [17, 26]])
    expect(information.parameters[0].documentation).toBeUndefined()
    expect((information.parameters[1].documentation as Monaco.IMarkdownString).value).toBe('The second.')
    expect((information.documentation as Monaco.IMarkdownString).value).toBe('Adds.')
  })

  it('points signature help at the named argument, or the params array past its end', async () => {
    const { monaco, providers, model, editor } = setUp('F(1, 2, 3)')
    service.attachRoslynDocument(monaco, editor)
    const parameter = (name: string) => ({ name, display: [{ text: name, color: 'parameter' }], documentation: [], isOptional: false })
    const item = (isVariadic: boolean, ...names: string[]): CodeSignature => ({ prefix: [{ text: 'F(', color: 'text' }], separator: [{ text: ', ', color: 'text' }], suffix: [{ text: ')', color: 'text' }], parameters: names.map(parameter), documentation: [], isVariadic })
    api.getCodeSignatureHelp.mockResolvedValueOnce({ help: { applicableSpan: { start: 2, length: 7 }, argumentIndex: 2, argumentCount: 3, argumentName: null, selectedItem: 0, items: [item(true, 'a', 'rest')] } })
    api.getCodeSignatureHelp.mockResolvedValueOnce({ help: { applicableSpan: { start: 2, length: 7 }, argumentIndex: 0, argumentCount: 1, argumentName: 'b', selectedItem: 0, items: [item(false, 'a', 'b')] } })

    const variadic = await providers.signatureHelp.provideSignatureHelp(model, { lineNumber: 1, column: 9 }, {}, { triggerCharacter: ',' })
    const named = await providers.signatureHelp.provideSignatureHelp(model, { lineNumber: 1, column: 3 }, {}, {})

    expect(api.getCodeSignatureHelp).toHaveBeenNthCalledWith(1, 'code-1', 8, ',')
    expect(variadic.value.activeParameter).toBe(1)
    expect(variadic.value.signatures[0].label).toBe('F(a, rest)')
    expect(named.value.activeParameter).toBe(1)
  })

  it('re-indents a new line to where Roslyn puts it', async () => {
    const { monaco, providers, model, editor } = setUp('class C\n{\n\n}')
    service.attachRoslynDocument(monaco, editor)
    api.getCodeIndentation.mockResolvedValue({ indentation: 4 })

    const edits = await providers.onTypeFormatting.provideOnTypeFormattingEdits(model, { lineNumber: 3, column: 1 }, '\n', { tabSize: 4, insertSpaces: true })

    expect(api.getCodeIndentation).toHaveBeenCalledWith({ documentId: 'code-1', line: 2, indentSize: 4, tabSize: 4, useTabs: false })
    expect(edits).toEqual([{ range: new FakeRange(3, 1, 3, 1), text: '    ' }])

    api.getCodeIndentation.mockResolvedValue({ indentation: null })
    expect(await providers.onTypeFormatting.provideOnTypeFormattingEdits(model, { lineNumber: 3, column: 1 }, '\n', { tabSize: 4, insertSpaces: true })).toEqual([])
  })

  it('indents with tabs when the editor does', async () => {
    const { monaco, providers, model, editor } = setUp('class C\n{\n  \n}')
    service.attachRoslynDocument(monaco, editor)
    api.getCodeIndentation.mockResolvedValue({ indentation: 6 })

    const edits = await providers.onTypeFormatting.provideOnTypeFormattingEdits(model, { lineNumber: 3, column: 3 }, '\n', { tabSize: 4, insertSpaces: false })

    expect(edits).toEqual([{ range: new FakeRange(3, 1, 3, 3), text: '\t  ' }])
  })

  it('turns the spans around each caret into nested selection ranges', async () => {
    const { monaco, providers, model, editor } = setUp('a.b')
    service.attachRoslynDocument(monaco, editor)
    api.getCodeSelectionRanges.mockResolvedValue({ ranges: [[{ start: 2, length: 1 }, { start: 0, length: 3 }]] })

    const ranges = await providers.selectionRange.provideSelectionRanges(model, [{ lineNumber: 1, column: 3 }])

    expect(api.getCodeSelectionRanges).toHaveBeenCalledWith('code-1', [2])
    expect(ranges).toEqual([[{ range: new FakeRange(1, 3, 1, 4) }, { range: new FakeRange(1, 1, 1, 4) }]])
  })

  it('marks what compiling reports, and clears the marks and closes the document when detached', async () => {
    const { monaco, setModelMarkers, model, editor } = setUp('class C { int x = "s"; }')
    const document = service.attachRoslynDocument(monaco, editor)
    api.getCodeDiagnostics.mockResolvedValue({
      diagnostics: [{ id: 'CS0029', severity: 'error', message: 'Cannot convert', helpUri: 'https://docs/cs0029', start: 18, length: 3, startLine: 0, startColumn: 18, endLine: 0, endColumn: 21 }],
    })

    const diagnostics = await document.compile()

    expect(diagnostics).toHaveLength(1)
    expect(setModelMarkers).toHaveBeenCalledWith(model, 'roslyn', [{
      severity: 8,
      message: 'Cannot convert',
      code: { value: 'CS0029', target: { value: 'https://docs/cs0029' } },
      startLineNumber: 1,
      startColumn: 19,
      endLineNumber: 1,
      endColumn: 22,
    }])

    document.dispose()
    await flush()
    expect(setModelMarkers).toHaveBeenLastCalledWith(model, 'roslyn', [])
    expect(api.closeCodeDocument).toHaveBeenCalledWith('code-1')
  })

  it('maps Roslyn\'s tags to Monaco\'s kinds', () => {
    const { monaco } = fakeMonaco()
    const kinds = monaco.languages.CompletionItemKind

    expect(service.completionKindOf(monaco, ['Public', 'Structure'])).toBe(kinds.Struct)
    expect(service.completionKindOf(monaco, ['ExtensionMethod'])).toBe(kinds.Method)
    expect(service.completionKindOf(monaco, ['Keyword'])).toBe(kinds.Keyword)
    expect(service.completionKindOf(monaco, ['Something'])).toBe(kinds.Text)
  })
})
