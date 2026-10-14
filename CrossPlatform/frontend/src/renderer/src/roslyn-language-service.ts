import type * as Monaco from 'monaco-editor'
import type { CodeCompilerOptions, CodeDiagnostic, CodeSignature, TextPart } from '../../shared/protocol'
import { attachClassifier, type Classifier } from './roslyn-classification'
import './roslyn-editor-contribs'

/**
 * The Roslyn language service of a C# code editor, wired into Monaco: what dnSpy's Edit Code editor gets from
 * `dnSpy.Roslyn` — semantic colors, completion with tooltips, Quick Info, signature help, compiler messages,
 * smart indentation and syntax-tree selection. Each attached editor has a document of its own in the backend.
 *
 * The providers are registered for the `csharp` language the first time an editor is attached, and answer only
 * for models an editor attached with {@link attachRoslynDocument}; the decompiled documents and the C#
 * Interactive window are never asked about, the way dnSpy's providers only work on a buffer that is a document
 * of a Roslyn workspace. Importing this module loads the Monaco contributions those providers draw with, so a
 * host imports it before it creates its editor.
 */

interface Binding {
  /** The backend document, once it is open and holds the model's current text. */
  synced(): Promise<string>
}

const bindings = new Map<string, Binding>()

/** The binding of a model, or undefined for every model no editor attached. */
const bindingOf = (model: Monaco.editor.ITextModel): Binding | undefined => bindings.get(model.uri.toString())

export interface RoslynDocumentOptions {
  /** The assemblies the code compiles against; absent means the framework the backend runs on. */
  references?: string[]
  options?: CodeCompilerOptions
}

export interface RoslynDocument extends Monaco.IDisposable {
  /** Compiles the document and marks what the compiler reports, the way the Edit Code dialog's Compile does. */
  compile(): Promise<CodeDiagnostic[]>
}

/** The id the binding keeps on the completion items it hands Monaco, to ask for their tooltips. */
interface RoslynCompletionItem extends Monaco.languages.CompletionItem {
  roslyn: { documentId: string; resultId: number; index: number }
}

/**
 * Opens a backend document for the editor's model and keeps it in step with the text: every edit is sent before
 * any request that follows it, so a provider never asks about text the backend has not seen.
 */
export const attachRoslynDocument = (
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  documentOptions: RoslynDocumentOptions = {},
): RoslynDocument => {
  const model = editor.getModel()
  if (!model) throw new Error('The editor has no model to attach.')
  registerRoslynLanguageService(monaco)
  const key = model.uri.toString()
  const opened = window.dnSpy.openCodeDocument({ text: model.getValue(), ...documentOptions }).then((response) => response.documentId)
  let pending: Promise<string> = opened
  let queuedText = model.getValue()
  // Queues the model's text when it is not what was sent last. Every request goes through this, so even one
  // made from a change listener that runs before this binding's own sees the text it is about.
  const sync = (): Promise<string> => {
    const text = model.getValue()
    if (text !== queuedText) {
      queuedText = text
      pending = pending.then(async (documentId) => {
        await window.dnSpy.updateCodeDocument(documentId, text)
        return documentId
      })
    }
    return pending
  }
  const binding: Binding = { synced: sync }
  bindings.set(key, binding)
  const changed = model.onDidChangeContent(() => void sync().catch(() => undefined))
  // The theme's code-only colors (comments, strings, punctuation) are scoped to Roslyn-colored code.
  editor.getContainerDomNode().classList.add('code-colors')
  // Smart indentation runs as an on-type format of the new line, which Monaco only asks for with this on.
  editor.updateOptions({ formatOnType: true })
  const classifier: Classifier = attachClassifier(monaco, editor, async () => {
    const documentId = await binding.synced()
    return window.dnSpy.classifyCodeDocument(documentId)
  })

  return {
    compile: async () => {
      const documentId = await binding.synced()
      const { diagnostics } = await window.dnSpy.getCodeDiagnostics(documentId)
      monaco.editor.setModelMarkers(model, 'roslyn', diagnostics.map((diagnostic) => toMarker(monaco, diagnostic)))
      return diagnostics
    },
    dispose: () => {
      changed.dispose()
      classifier.dispose()
      if (bindings.get(key) === binding) bindings.delete(key)
      monaco.editor.setModelMarkers(model, 'roslyn', [])
      void pending.then((documentId) => window.dnSpy.closeCodeDocument(documentId)).catch(() => undefined)
    },
  }
}

const toMarker = (monaco: typeof Monaco, diagnostic: CodeDiagnostic): Monaco.editor.IMarkerData => ({
  severity: diagnostic.severity === 'error' ? monaco.MarkerSeverity.Error
    : diagnostic.severity === 'warning' ? monaco.MarkerSeverity.Warning
      : monaco.MarkerSeverity.Info,
  message: diagnostic.message,
  code: { value: diagnostic.id, target: monaco.Uri.parse(diagnostic.helpUri) },
  startLineNumber: diagnostic.startLine + 1,
  startColumn: diagnostic.startColumn + 1,
  endLineNumber: diagnostic.endLine + 1,
  endColumn: diagnostic.endColumn + 1,
})

/** The Monaco kind of a completion item, from the kind among Roslyn's tags. */
export const completionKindOf = (monaco: typeof Monaco, tags: readonly string[]): Monaco.languages.CompletionItemKind => {
  const kinds = monaco.languages.CompletionItemKind
  for (const tag of tags) {
    switch (tag) {
      case 'Class': return kinds.Class
      case 'Structure': return kinds.Struct
      case 'Interface': return kinds.Interface
      case 'Enum': return kinds.Enum
      case 'EnumMember': return kinds.EnumMember
      case 'Delegate': return kinds.Function
      case 'Method': return kinds.Method
      case 'ExtensionMethod': return kinds.Method
      case 'Property': return kinds.Property
      case 'Field': return kinds.Field
      case 'Constant': return kinds.Constant
      case 'Event': return kinds.Event
      case 'Namespace': return kinds.Module
      case 'Module': return kinds.Module
      case 'Keyword': return kinds.Keyword
      case 'Intrinsic': return kinds.Keyword
      case 'Local': return kinds.Variable
      case 'Parameter': return kinds.Variable
      case 'RangeVariable': return kinds.Variable
      case 'TypeParameter': return kinds.TypeParameter
      case 'Operator': return kinds.Operator
      case 'Snippet': return kinds.Snippet
      case 'Label': return kinds.Reference
    }
  }
  return kinds.Text
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The theme's color of a `tc-<color>` class as `#rrggbb`, or undefined outside a browser. */
const themeColor = (() => {
  let probe: HTMLSpanElement | undefined
  return (color: string): string | undefined => {
    if (typeof document === 'undefined') return undefined
    if (!probe) {
      const host = document.createElement('div')
      host.className = 'code-colors'
      host.style.display = 'none'
      probe = document.createElement('span')
      host.appendChild(probe)
      document.body.appendChild(host)
    }
    probe.className = `tc-${color}`
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color)
    if (!match) return undefined
    return `#${match.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
  }
})()

/**
 * Colored tagged text as Monaco markdown — the classified text of dnSpy's tooltips. Monaco's sanitizer keeps a
 * span's `color` only as a hex value, so the theme's colors are read off the stylesheet.
 */
export const partsToMarkdown = (parts: readonly TextPart[]): string =>
  parts.map((part) => {
    const text = escapeHtml(part.text).replace(/\n/g, '<br>')
    const color = part.color === 'text' ? undefined : themeColor(part.color)
    const bold = part.color === 'parameter' ? `<b>${text}</b>` : text
    return color ? `<span style="color:${color};">${bold}</span>` : bold
  }).join('')

const markdown = (value: string): Monaco.IMarkdownString => ({ value, supportHtml: true, isTrusted: false })

const plain = (parts: readonly TextPart[]): string => parts.map((part) => part.text).join('')

/** A signature as Monaco's parameter hints want it: one label, and each parameter's offsets in it. */
export const toSignatureInformation = (signature: CodeSignature): Monaco.languages.SignatureInformation => {
  let label = plain(signature.prefix)
  const parameters: Monaco.languages.ParameterInformation[] = []
  signature.parameters.forEach((parameter, index) => {
    if (index > 0) label += plain(signature.separator)
    const start = label.length
    label += plain(parameter.display)
    parameters.push({
      label: [start, label.length],
      documentation: parameter.documentation.length > 0 ? markdown(partsToMarkdown(parameter.documentation)) : undefined,
    })
  })
  label += plain(signature.suffix)
  return {
    label,
    parameters,
    documentation: signature.documentation.length > 0 ? markdown(partsToMarkdown(signature.documentation)) : undefined,
  }
}

const rangeOf = (monaco: typeof Monaco, model: Monaco.editor.ITextModel, start: number, length: number): Monaco.Range => {
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(start + length)
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column)
}

let registered = false

/** Registers the providers, once; they stay silent for every model no editor attached. */
export function registerRoslynLanguageService(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('csharp', {
    // The characters Roslyn's C# providers open a list on; letters reach the provider through Monaco's quick
    // suggestions, and the backend asks Roslyn whether a typed character opens one at all.
    triggerCharacters: ['.', ' ', '#', '<', '>', '"', ':', '[', '(', '~', '/', '@', '{', ','],
    async provideCompletionItems(model, position, context) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const offset = model.getOffsetAt(position)
      const trigger = context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? context.triggerCharacter ?? null : null
      const { list } = await window.dnSpy.getCodeCompletion(documentId, offset, trigger)
      if (!list) return { suggestions: [] }
      const replace = rangeOf(monaco, model, list.span.start, list.span.length)
      const insert = new monaco.Range(replace.startLineNumber, replace.startColumn, position.lineNumber, position.column)
      const suggestions = list.items.map((item): RoslynCompletionItem => {
        let range: Monaco.languages.CompletionItemRanges | Monaco.IRange = { insert, replace }
        let insertText = item.insertText
        let additionalTextEdits: Monaco.languages.TextEdit[] | undefined
        if (item.edit) {
          const editRange = rangeOf(monaco, model, item.edit.start, item.edit.length)
          // Monaco replaces one line around the caret; an edit elsewhere is applied beside it.
          if (editRange.startLineNumber === position.lineNumber && editRange.endLineNumber === position.lineNumber && editRange.containsPosition(position)) {
            range = editRange
            insertText = item.edit.newText
          }
          else
            additionalTextEdits = [{ range: editRange, text: item.edit.newText }]
        }
        return {
          label: { label: `${item.displayTextPrefix}${item.displayText}${item.displayTextSuffix}`, description: item.inlineDescription || undefined },
          kind: completionKindOf(monaco, item.tags),
          insertText,
          filterText: item.filterText,
          sortText: item.sortText,
          range,
          additionalTextEdits,
          preselect: item.preselect,
          commitCharacters: list.suggestionMode ? [] : [...item.commitCharacters],
          roslyn: { documentId, resultId: list.resultId, index: item.index },
        }
      })
      return { suggestions }
    },
    async resolveCompletionItem(item) {
      const roslyn = (item as Partial<RoslynCompletionItem>).roslyn
      if (!roslyn) return item
      const { parts } = await window.dnSpy.getCodeCompletionDescription(roslyn.documentId, roslyn.resultId, roslyn.index)
      return parts.length > 0 ? { ...item, documentation: markdown(partsToMarkdown(parts)) } : item
    },
  })

  monaco.languages.registerHoverProvider('csharp', {
    async provideHover(model, position) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { quickInfo } = await window.dnSpy.getCodeQuickInfo(documentId, model.getOffsetAt(position))
      if (!quickInfo) return undefined
      return {
        range: rangeOf(monaco, model, quickInfo.span.start, quickInfo.span.length),
        contents: quickInfo.sections.map((section) => markdown(partsToMarkdown(section.parts))),
      }
    },
  })

  monaco.languages.registerSignatureHelpProvider('csharp', {
    signatureHelpTriggerCharacters: ['(', ',', '[', '<'],
    signatureHelpRetriggerCharacters: [')', ']', '>'],
    async provideSignatureHelp(model, position, _token, context) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { help } = await window.dnSpy.getCodeSignatureHelp(documentId, model.getOffsetAt(position), context.triggerCharacter ?? null)
      if (!help || help.items.length === 0) return undefined
      const selected = help.items[help.selectedItem]
      // A named argument is the parameter of that name, wherever it stands.
      const named = help.argumentName === null ? -1 : selected.parameters.findIndex((parameter) => parameter.name === help.argumentName)
      const variadicLast = selected.isVariadic ? selected.parameters.length - 1 : help.argumentIndex
      return {
        value: {
          signatures: help.items.map(toSignatureInformation),
          activeSignature: help.selectedItem,
          activeParameter: named >= 0 ? named : Math.min(help.argumentIndex, variadicLast),
        },
        dispose: () => {},
      }
    },
  })

  monaco.languages.registerOnTypeFormattingEditProvider('csharp', {
    autoFormatTriggerCharacters: ['\n'],
    async provideOnTypeFormattingEdits(model, position, _ch, options) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { indentation } = await window.dnSpy.getCodeIndentation({
        documentId,
        line: position.lineNumber - 1,
        indentSize: options.tabSize,
        tabSize: options.tabSize,
        useTabs: !options.insertSpaces,
      })
      if (indentation === null) return []
      const line = model.getLineContent(position.lineNumber)
      const current = line.length - line.trimStart().length
      const whitespace = options.insertSpaces
        ? ' '.repeat(indentation)
        : '\t'.repeat(Math.floor(indentation / options.tabSize)) + ' '.repeat(indentation % options.tabSize)
      if (line.slice(0, current) === whitespace) return []
      return [{ range: new monaco.Range(position.lineNumber, 1, position.lineNumber, current + 1), text: whitespace }]
    },
  })

  monaco.languages.registerSelectionRangeProvider('csharp', {
    async provideSelectionRanges(model, positions) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { ranges } = await window.dnSpy.getCodeSelectionRanges(documentId, positions.map((position) => model.getOffsetAt(position)))
      return ranges.map((spans) => spans.map((span) => ({ range: rangeOf(monaco, model, span.start, span.length) })))
    },
  })
}
