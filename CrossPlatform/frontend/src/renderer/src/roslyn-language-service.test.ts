import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { CodeCompletionList, CodeSignature } from '../../shared/protocol'
import { FakeModel, FakeRange, FakeSelection, fakeCommandEditor, fakeEditor } from './roslyn-test-fakes'

// The real Monaco contributions need a browser; the providers under test do not.
vi.mock('./roslyn-editor-contribs', () => ({}))

type Module = typeof import('./roslyn-language-service')

/** Lets every queued promise and timer run, for chains longer than a few microtasks. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
    Selection: FakeSelection,
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, chord: (first: number, second: number) => first * 65536 + second },
    KeyCode: { Space: 10, Enter: 3, RightArrow: 17, LeftArrow: 15, Backspace: 1, Delete: 20, KeyW: 53, KeyJ: 40, KeyT: 50, KeyK: 41, KeyI: 39, KeyP: 46 },
    Uri: { parse: (value: string) => ({ value }) },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: { setModelMarkers: vi.fn(), MouseTargetType: { CONTENT_TEXT: 6, CONTENT_EMPTY: 7 } },
    languages: {
      CompletionItemKind: { Method: 0, Function: 1, Field: 3, Variable: 4, Class: 5, Struct: 6, Interface: 7, Module: 8, Property: 9, Event: 10, Operator: 11, Enum: 15, EnumMember: 16, Keyword: 17, Constant: 14, Snippet: 27, Text: 18, Reference: 21, TypeParameter: 24 },
      CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
      SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
      registerCompletionItemProvider: register('completion'),
      registerHoverProvider: register('hover'),
      registerSignatureHelpProvider: register('signatureHelp'),
      registerOnTypeFormattingEditProvider: register('onTypeFormatting'),
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
      openCodeDocument: vi.fn(async () => ({ documentId: 'code-1', signatureHelpTriggerCharacters: '(,', signatureHelpRetriggerCharacters: ')' })),
      updateCodeDocument: vi.fn(async () => undefined),
      closeCodeDocument: vi.fn(async () => undefined),
      classifyCodeDocument: vi.fn(async () => ({ spans: [] })),
      getCodeCompletion: vi.fn(),
      getCodeCompletionDescription: vi.fn(),
      getCodeQuickInfo: vi.fn(),
      getCodeSignatureHelp: vi.fn(),
      getCodeDiagnostics: vi.fn(),
      getCodeIndentation: vi.fn(),
      getCodeWordNavigation: vi.fn(),
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
    expect(await providers.onTypeFormatting.provideOnTypeFormattingEdits(model, position, '\n', { tabSize: 4, insertSpaces: true })).toBeUndefined()
    expect(api.getCodeCompletion).not.toHaveBeenCalled()
    expect(api.getCodeQuickInfo).not.toHaveBeenCalled()
  })

  it('registers its providers once', () => {
    const { monaco } = fakeMonaco()
    service.registerRoslynLanguageService(monaco)
    service.registerRoslynLanguageService(monaco)

    // Once for C# and once for Visual Basic.
    expect(monaco.languages.registerCompletionItemProvider).toHaveBeenCalledTimes(2)
    expect(vi.mocked(monaco.languages.registerCompletionItemProvider).mock.calls.map(([language]) => language)).toEqual(['csharp', 'vb'])
  })

  it('opens a document, colors it, and sends every edit before the request that follows it', async () => {
    const { monaco, providers, model, editor, decorations, container } = setUp('class C { }')
    api.classifyCodeDocument.mockResolvedValue({ spans: [{ start: 0, length: 5, color: 'keyword' }] })

    service.attachRoslynDocument(monaco, editor)
    await flush()

    expect(api.openCodeDocument).toHaveBeenCalledWith({ text: 'class C { }' })
    expect(decorations.set).toHaveBeenCalledWith([{ range: new FakeRange(1, 1, 1, 6), options: { inlineClassName: 'tc-keyword' } }])
    expect(container.classList.contains('code-colors')).toBe(true)
    expect(editor.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ formatOnType: true, wordBasedSuggestions: 'off' }))

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
        { index: 0, displayText: 'WriteLine', displayTextPrefix: '', displayTextSuffix: '', inlineDescription: '', filterText: 'WriteLine', sortText: 'WriteLine', insertText: 'WriteLine', tags: ['Method', 'Public'], matchPriority: 0, preselect: true, glyph: 'MethodPublic', displayParts: [{ text: 'WriteLine', color: 'instancemethod' }], warning: false, enterKeyRule: 'default', edit: null },
        { index: 1, displayText: 'List', displayTextPrefix: '', displayTextSuffix: '<>', inlineDescription: 'System.Collections.Generic', filterText: 'List', sortText: 'List', insertText: 'List', tags: ['Class'], matchPriority: 0, preselect: false, glyph: 'ClassPublic', displayParts: [{ text: 'List', color: 'type' }, { text: '<>', color: 'punctuation' }], warning: true, enterKeyRule: 'always', edit: { start, length: 2, newText: 'List<int>' } },
      ],
      commitCharacters: '(.',
      defaultEnterKeyRule: 'never',
      filters: ['methods', 'classes'],
    }
    api.getCodeCompletion.mockResolvedValue({ list })
    api.getCodeCompletionDescription.mockResolvedValue({ parts: [{ text: 'void', color: 'text' }, { text: ' Console.WriteLine()', color: 'text' }] })

    const position = { lineNumber: 1, column: start + 3 }
    const result = await providers.completion.provideCompletionItems(model, position, { triggerKind: 1, triggerCharacter: 'r' })

    expect(api.getCodeCompletion).toHaveBeenCalledWith('code-1', start + 2, 'r', 'insertion')
    const [writeLine, generic] = result.suggestions
    expect(writeLine.label).toEqual({ label: 'WriteLine', description: undefined })
    expect(writeLine.kind).toBe(0)
    expect(writeLine.insertText).toBe('WriteLine')
    expect(writeLine.range).toEqual({ insert: new FakeRange(1, start + 1, 1, start + 3), replace: new FakeRange(1, start + 1, 1, start + 3) })
    expect(writeLine.commitCharacters).toEqual(['(', '.'])
    expect(writeLine.preselect).toBe(true)
    // What dnSpy's completion list draws the item with, and the Enter rule it commits by.
    expect(writeLine.dnSpy).toEqual({ glyph: 'MethodPublic', displayParts: [{ text: 'WriteLine', color: 'instancemethod' }], warning: false })
    expect(writeLine.roslyn.enterKeyRule).toBe('never')
    expect(generic.roslyn.enterKeyRule).toBe('always')
    expect(generic.dnSpy.warning).toBe(true)
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
      list: { resultId: 1, span: { start: 0, length: 1 }, suggestionMode: true, items: [{ index: 0, displayText: 'x', displayTextPrefix: '', displayTextSuffix: '', inlineDescription: '', filterText: 'x', sortText: 'x', insertText: 'x', tags: ['Local'], matchPriority: 0, preselect: false, glyph: 'LocalVariable', displayParts: [], warning: false, enterKeyRule: 'default', edit: null }], commitCharacters: ' (', defaultEnterKeyRule: 'never', filters: ['locals'] },
    })

    // Monaco's quick suggestion after a typed letter is dnSpy's insertion trigger of that letter.
    const result = await providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 2 }, { triggerKind: 0 })

    expect(api.getCodeCompletion).toHaveBeenCalledWith('code-1', 1, 'x', 'insertion')
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
    // One block, as dnSpy's Quick Info is: the symbol's image, the description, and the sections under it.
    expect(hover.contents).toHaveLength(1)
    const [image, rest] = hover.contents[0].value.split('(local) ')
    expect(image).toMatch(/^<img src="data:image\/svg\+xml/)
    // Code is escaped: the markdown carries it as text, not as tags.
    expect(rest).toContain('x&lt;y&gt;')
    expect(rest).toMatch(/<br>A count\.$/)
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

    // dnSpy's Signature writes an optional parameter in brackets.
    expect(information.label).toBe('int C.Add(int a, [int b = 0])')
    expect(information.parameters.map((p) => p.label)).toEqual([[10, 15], [17, 28]])
    expect(information.dnSpy.parameters.map((p) => [p.name, p.start, p.end])).toEqual([['a', 10, 15], ['b', 17, 28]])
    expect(information.dnSpy.parts.map((part) => part.text).join('')).toBe(information.label)
    expect(information.dnSpy.documentation).toEqual([{ text: 'Adds.', color: 'text' }])
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

    await flush()
    const variadic = await providers.signatureHelp.provideSignatureHelp(model, { lineNumber: 1, column: 9 }, {}, { triggerKind: 2, triggerCharacter: ',', isRetrigger: false })
    const named = await providers.signatureHelp.provideSignatureHelp(model, { lineNumber: 1, column: 3 }, {}, { triggerKind: 3, isRetrigger: true })

    expect(api.getCodeSignatureHelp).toHaveBeenNthCalledWith(1, 'code-1', 8, ',', 'typeChar')
    expect(api.getCodeSignatureHelp).toHaveBeenNthCalledWith(2, 'code-1', 2, null, 'retrigger')
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
  it('lets through the items of any switched-on filter button, and every item with none on', () => {
    const item = (tags: string[]) => ({ tags }) as unknown as Parameters<Module['passesFilters']>[0]

    expect(service.passesFilters(item(['Method', 'Public']), new Set())).toBe(true)
    expect(service.passesFilters(item(['Method', 'Public']), new Set(['methods']))).toBe(true)
    expect(service.passesFilters(item(['Parameter']), new Set(['fields', 'locals']))).toBe(true)
    expect(service.passesFilters(item(['Field']), new Set(['methods']))).toBe(false)
    // dnSpy's buttons, in its order, with their Alt keys.
    expect(Object.entries(service.COMPLETION_FILTERS).map(([id, filter]) => `${id}:${filter.accessKey}`)).toEqual([
      'locals:L', 'constants:O', 'properties:P', 'events:V', 'fields:F', 'methods:M', 'extensionMethods:X', 'interfaces:I',
      'classes:C', 'modules:U', 'structures:S', 'enums:E', 'delegates:D', 'namespaces:N', 'keywords:K', 'snippets:T',
    ])
  })

  it('opens the document in the language and module it is edited for, and gives signature help the language\'s characters', async () => {
    const { monaco, editor } = setUp('Class C\nEnd Class')
    const settings = { preprocessorSymbols: 'TRACE', optimize: true, checkOverflow: false, allowUnsafe: true, optionExplicit: true, optionInfer: true, optionStrict: false, optionCompareBinary: true, embedVisualBasicRuntime: false }

    service.attachRoslynDocument(monaco, editor, { language: 'visualBasic', workspaceId: 'ws', nodeId: 'n1', settings })
    await flush()

    expect(api.openCodeDocument).toHaveBeenCalledWith({ text: 'Class C\nEnd Class', language: 'visualBasic', workspaceId: 'ws', nodeId: 'n1', settings })
    expect(monaco.languages.registerSignatureHelpProvider).toHaveBeenCalledTimes(1)
    const [language, provider] = vi.mocked(monaco.languages.registerSignatureHelpProvider).mock.calls[0] as unknown as [string, Monaco.languages.SignatureHelpProvider]
    expect(language).toBe('vb')
    expect(provider.signatureHelpTriggerCharacters).toEqual(['(', ','])
    expect(provider.signatureHelpRetriggerCharacters).toEqual([')'])
  })

  it('moves, deletes and selects by Roslyn\'s words, from where the command before left the caret', async () => {
    const { monaco } = fakeMonaco()
    service.registerRoslynLanguageService(monaco)
    const model = new FakeModel('class C { int value; }')
    const { editor, commands, select, selection } = fakeCommandEditor(model)
    service.attachRoslynDocument(monaco, editor)
    await settle()
    const press = (keybinding: number) => commands.get(keybinding)!()
    const { KeyMod, KeyCode } = monaco

    api.getCodeWordNavigation.mockResolvedValueOnce({ start: 6, end: 6 }).mockResolvedValueOnce({ start: 8, end: 8 })
    press(KeyMod.CtrlCmd | KeyCode.RightArrow)
    press(KeyMod.CtrlCmd | KeyCode.RightArrow)
    await settle()
    expect(api.getCodeWordNavigation).toHaveBeenNthCalledWith(1, { documentId: 'code-1', command: 'nextWord', position: 0, selectionStart: 0, selectionEnd: 0 })
    // The second press starts where the first one put the caret.
    expect(api.getCodeWordNavigation).toHaveBeenNthCalledWith(2, { documentId: 'code-1', command: 'nextWord', position: 6, selectionStart: 6, selectionEnd: 6 })
    expect(selection()).toEqual(new FakeSelection(1, 9, 1, 9))

    // Ctrl+Shift+Left keeps the anchor and moves the caret.
    api.getCodeWordNavigation.mockResolvedValueOnce({ start: 6, end: 6 })
    press(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.LeftArrow)
    await settle()
    expect(selection()).toEqual(new FakeSelection(1, 9, 1, 7))

    // Ctrl+W selects the word, the caret after it.
    select(16, 16)
    api.getCodeWordNavigation.mockResolvedValueOnce({ start: 14, end: 19 })
    press(KeyMod.CtrlCmd | KeyCode.KeyW)
    await settle()
    expect(api.getCodeWordNavigation).toHaveBeenLastCalledWith({ documentId: 'code-1', command: 'currentWord', position: 16, selectionStart: 16, selectionEnd: 16 })
    expect(selection()).toEqual(new FakeSelection(1, 15, 1, 20))

    // Ctrl+Backspace deletes back to the start of the word left of the caret.
    select(19, 19)
    api.getCodeWordNavigation.mockResolvedValueOnce({ start: 14, end: 14 })
    press(KeyMod.CtrlCmd | KeyCode.Backspace)
    await settle()
    expect(model.getValue()).toBe('class C { int ; }')
  })
})
