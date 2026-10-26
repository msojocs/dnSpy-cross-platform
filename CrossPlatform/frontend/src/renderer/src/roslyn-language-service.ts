import type * as Monaco from 'monaco-editor'
import type {
  CodeCompletionItem,
  CodeCompletionList,
  CodeCompletionTriggerKind,
  CodeDiagnostic,
  CodeEnterKeyRule,
  CodeSignature,
  CodeSignatureHelpTriggerReason,
  CodeWordNavigationRequest,
  CompilerLanguage,
  CompilerSettings,
  TextPart,
} from '../../shared/protocol'
import { attachClassifier, type Classifier } from './roslyn-classification'
import type { DnSpyCompletionPresentation, DnSpySignaturePresentation } from './roslyn-editor-contribs'
import './roslyn-editor-contribs'
import { dsImageUrl, parseCssColor } from './ds-image'
import { translate } from './localization'
import { editorCommands, type EditorCommand } from './editor-commands'

/**
 * The Roslyn language service of a C# or Visual Basic code editor, wired into Monaco: what dnSpy's Edit Code
 * editor gets from `dnSpy.Roslyn` — semantic colors, completion with dnSpy's images, colors, filter buttons and
 * tooltips, Quick Info, signature help, compiler messages, smart indentation, and the word navigation of its
 * text structure navigator. Each attached editor has a document of its own in the backend.
 *
 * The providers are registered for the `csharp` and `vb` languages the first time an editor is attached, and
 * answer only for models an editor attached with {@link attachRoslynDocument}; the decompiled documents and the
 * C# Interactive window are never asked about, the way dnSpy's providers only work on a buffer that is a document
 * of a Roslyn workspace. Importing this module loads the Monaco contributions those providers draw with, so a
 * host imports it before it creates its editor.
 */

/** The Monaco language of each compiler language. */
const MONACO_LANGUAGES: Record<CompilerLanguage, string> = { csharp: 'csharp', visualBasic: 'vb' }

/** How the next completion list is asked for, when a command rather than typing asks for it. */
interface CompletionRequest {
  kind: CodeCompletionTriggerKind
  character?: string
  /** dnSpy's Complete Word: an only match is committed at once. */
  commitIfUnique?: boolean
  /** A filter button was switched: the list shown is filtered again rather than asked for again. */
  reuse?: boolean
}

interface Binding {
  editor: Monaco.editor.IStandaloneCodeEditor
  /** The backend document, once it is open and holds the model's current text. */
  synced(): Promise<string>
  completion: {
    next?: CompletionRequest
    list?: { documentId: string; list: CodeCompletionList }
    /** The filter buttons switched on in this session; every list the backend gives starts a session. */
    checked: Set<string>
    commitIfUnique: boolean
    /** Counts the lists asked for, so that only the latest answer is taken. */
    requests: number
  }
}

const bindings = new Map<string, Binding>()

/** The binding of a model, or undefined for every model no editor attached. */
const bindingOf = (model: Monaco.editor.ITextModel): Binding | undefined => bindings.get(model.uri.toString())

export interface RoslynDocumentOptions {
  /** The language the code is in; C# when absent. */
  language?: CompilerLanguage
  /** The assemblies the code compiles against; absent means the framework the backend runs on. */
  references?: string[]
  /** The Compiler page's settings; absent means their defaults. */
  settings?: CompilerSettings
  /** The workspace and the node the code is edited for: it compiles against what the Edit Code window compiles against. */
  workspaceId?: string
  nodeId?: string
}

export interface RoslynDocument extends Monaco.IDisposable {
  /** Compiles the document and marks what the compiler reports. */
  compile(): Promise<CodeDiagnostic[]>
}

/** What the binding keeps on the completion items it hands Monaco, to ask for their tooltips and to commit them. */
interface RoslynCompletionItem extends Monaco.languages.CompletionItem {
  roslyn: { documentId: string; resultId: number; index: number; enterKeyRule: CodeEnterKeyRule; filterText: string }
  dnSpy: DnSpyCompletionPresentation
}

/** The parts of the Monaco suggest widget the binding reads: what it shows, and when. */
interface SuggestWidget {
  element: { domNode: HTMLElement }
  getFocusedItem(): { item: { completion: Partial<RoslynCompletionItem> }; model: { items: readonly unknown[] } } | undefined
  onDidShow(listener: () => void): Monaco.IDisposable
  onDidFocus(listener: (event: { model: { items: readonly unknown[] } }) => void): Monaco.IDisposable
}

const suggestWidgetOf = (editor: Monaco.editor.IStandaloneCodeEditor): SuggestWidget | undefined =>
  (editor.getContribution?.('editor.contrib.suggestController') as unknown as { widget?: { value: SuggestWidget } } | null)?.widget?.value

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
  const language = documentOptions.language ?? 'csharp'
  const key = model.uri.toString()
  const opening = window.dnSpy.openCodeDocument({ text: model.getValue(), ...documentOptions })
  const opened = opening.then((response) => response.documentId)
  // The signature help providers' characters come with the document; the provider for a language is registered
  // once the first document in it has said what they are.
  void opening.then((response) => registerSignatureHelp(monaco, MONACO_LANGUAGES[language], response.signatureHelpTriggerCharacters ?? '', response.signatureHelpRetriggerCharacters ?? ''), () => undefined)
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
  const binding: Binding = { editor, synced: sync, completion: { checked: new Set(), commitIfUnique: false, requests: 0 } }
  bindings.set(key, binding)
  const disposables: Monaco.IDisposable[] = []
  disposables.push(model.onDidChangeContent(() => void sync().catch(() => undefined)))
  // The theme's code-only colors (comments, strings, punctuation) are scoped to Roslyn-colored code.
  editor.getContainerDomNode().classList.add('code-colors', 'roslyn-editor')
  editor.updateOptions({
    // Smart indentation runs as an on-type format of the new line, which Monaco only asks for with this on.
    formatOnType: true,
    // Roslyn decides where a typed letter opens a list, inside strings and comments too; Monaco's own word list stays out.
    quickSuggestions: { other: 'on', comments: 'on', strings: 'on' },
    suggestOnTriggerCharacters: true,
    wordBasedSuggestions: 'off',
    suggest: { showStatusBar: false, showIcons: true, filterGraceful: false, snippetsPreventQuickSuggestions: false },
  })
  const classifier: Classifier = attachClassifier(monaco, editor, async () => {
    const documentId = await binding.synced()
    return window.dnSpy.classifyCodeDocument(documentId)
  })
  disposables.push(...attachCommands(monaco, editor, binding))

  return {
    compile: async () => {
      const documentId = await binding.synced()
      const { diagnostics } = await window.dnSpy.getCodeDiagnostics(documentId)
      monaco.editor.setModelMarkers(model, 'roslyn', diagnostics.map((diagnostic) => toMarker(monaco, diagnostic)))
      return diagnostics
    },
    dispose: () => {
      for (const disposable of disposables) disposable.dispose()
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

/** The Monaco kind of a completion item, from the kind among Roslyn's tags — what Monaco sorts and labels by. */
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

/**
 * dnSpy's completion filter buttons (RoslynIntellisenseFilters), by the ids the backend names them with: the
 * image, the tooltip, the Alt key that switches the button, and the tags an item needs to pass it.
 */
export const COMPLETION_FILTERS: Record<string, { image: string; toolTip: string; accessKey: string; tags: readonly string[] }> = {
  locals: { image: 'LocalVariable', toolTip: 'Locals and parameters', accessKey: 'L', tags: ['Local', 'Parameter'] },
  constants: { image: 'ConstantPublic', toolTip: 'Constants', accessKey: 'O', tags: ['Constant'] },
  properties: { image: 'Property', toolTip: 'Properties', accessKey: 'P', tags: ['Property'] },
  events: { image: 'EventPublic', toolTip: 'Events', accessKey: 'V', tags: ['Event'] },
  fields: { image: 'FieldPublic', toolTip: 'Fields', accessKey: 'F', tags: ['Field'] },
  methods: { image: 'MethodPublic', toolTip: 'Methods', accessKey: 'M', tags: ['Method'] },
  extensionMethods: { image: 'ExtensionMethod', toolTip: 'Extension methods', accessKey: 'X', tags: ['ExtensionMethod'] },
  interfaces: { image: 'InterfacePublic', toolTip: 'Interfaces', accessKey: 'I', tags: ['Interface'] },
  classes: { image: 'ClassPublic', toolTip: 'Classes', accessKey: 'C', tags: ['Class'] },
  modules: { image: 'ModulePublic', toolTip: 'Modules', accessKey: 'U', tags: ['Module'] },
  structures: { image: 'StructurePublic', toolTip: 'Structures', accessKey: 'S', tags: ['Structure'] },
  enums: { image: 'EnumerationPublic', toolTip: 'Enums', accessKey: 'E', tags: ['Enum'] },
  delegates: { image: 'DelegatePublic', toolTip: 'Delegates', accessKey: 'D', tags: ['Delegate'] },
  namespaces: { image: 'Namespace', toolTip: 'Namespaces', accessKey: 'N', tags: ['Namespace'] },
  keywords: { image: 'IntellisenseKeyword', toolTip: 'Keywords', accessKey: 'K', tags: ['Keyword'] },
  snippets: { image: 'Snippet', toolTip: 'Snippets', accessKey: 'T', tags: ['Snippet'] },
}

/** Whether an item passes the switched-on filter buttons: any of them, or all items when none is on. */
export const passesFilters = (item: CodeCompletionItem, checked: ReadonlySet<string>): boolean => {
  if (checked.size === 0) return true
  for (const id of checked) {
    if (COMPLETION_FILTERS[id]?.tags.some((tag) => item.tags.includes(tag))) return true
  }
  return false
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

/**
 * One of dnSpy's images as hover markup, themed for the hover's background the way dnSpy's images are for what
 * they are drawn on.
 */
const imageMarkup = (name: string | null | undefined): string => {
  if (!name || typeof document === 'undefined')
    return ''
  const editor = document.querySelector('.monaco-editor')
  const background = (editor && parseCssColor(getComputedStyle(editor).getPropertyValue('--vscode-editorHoverWidget-background'))) || [255, 255, 255]
  const url = dsImageUrl(name, background, document.documentElement.dataset.themeKind === 'hc')
  return url ? `<img src="${url}" width="16" height="16" alt="">` : ''
}

const plain = (parts: readonly TextPart[]): string => parts.map((part) => part.text).join('')

/**
 * A signature as Monaco's parameter hints want it — one label, and each parameter's offsets in it — laid out the
 * way dnSpy's Signature is: an optional parameter in brackets between its prefix and suffix. The colored layout
 * dnSpy's presenter draws rides along for roslyn-editor-contribs to draw.
 */
export const toSignatureInformation = (signature: CodeSignature): Monaco.languages.SignatureInformation & { dnSpy: DnSpySignaturePresentation } => {
  const parts: TextPart[] = []
  let label = ''
  const add = (more: readonly TextPart[] | null | undefined): void => {
    for (const part of more ?? []) {
      parts.push(part)
      label += part.text
    }
  }
  add(signature.prefix)
  const parameters: Monaco.languages.ParameterInformation[] = []
  const presented: DnSpySignaturePresentation['parameters'][number][] = []
  signature.parameters.forEach((parameter, index) => {
    if (index > 0) add(signature.separator)
    add(parameter.prefix)
    const start = label.length
    if (parameter.isOptional) add([{ text: '[', color: 'punctuation' }])
    add(parameter.display)
    if (parameter.isOptional) add([{ text: ']', color: 'punctuation' }])
    const end = label.length
    add(parameter.suffix)
    parameters.push({
      label: [start, end],
      documentation: parameter.documentation.length > 0 ? markdown(partsToMarkdown(parameter.documentation)) : undefined,
    })
    presented.push({ name: parameter.name, start, end, selectedDisplay: parameter.selectedDisplay ?? [], documentation: parameter.documentation })
  })
  add(signature.suffix)
  return {
    label,
    parameters,
    documentation: signature.documentation.length > 0 ? markdown(partsToMarkdown(signature.documentation)) : undefined,
    dnSpy: { parts, parameters: presented, description: signature.description ?? [], documentation: signature.documentation },
  }
}

const rangeOf = (monaco: typeof Monaco, model: Monaco.editor.ITextModel, start: number, length: number): Monaco.Range => {
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(start + length)
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column)
}

/** The character just before a position, which is what a quick suggestion was typed with. */
const characterBefore = (model: Monaco.editor.ITextModel, position: Monaco.IPosition): string | undefined => {
  if (position.column <= 1) return undefined
  return model.getLineContent(position.lineNumber).charAt(position.column - 2) || undefined
}

/** Where the identifier the caret is in ends: what a reused list's items replace. */
const identifierEnd = (model: Monaco.editor.ITextModel, offset: number): number => {
  const text = model.getValue()
  let end = offset
  while (end < text.length && /[\p{L}\p{N}_]/u.test(text[end])) end++
  return end
}

/** The Monaco items of a list, those the switched-on filter buttons let through. */
const toSuggestions = (
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  documentId: string,
  list: CodeCompletionList,
  checked: ReadonlySet<string>,
): RoslynCompletionItem[] => {
  const offset = model.getOffsetAt(position)
  const replace = rangeOf(monaco, model, list.span.start, Math.max(list.span.length, identifierEnd(model, offset) - list.span.start))
  const insert = new monaco.Range(replace.startLineNumber, replace.startColumn, position.lineNumber, position.column)
  const commitCharacters = list.suggestionMode ? [] : [...list.commitCharacters]
  return list.items.filter((item) => passesFilters(item, checked)).map((item): RoslynCompletionItem => {
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
      commitCharacters,
      roslyn: {
        documentId,
        resultId: list.resultId,
        index: item.index,
        enterKeyRule: item.enterKeyRule === 'default' ? list.defaultEnterKeyRule : item.enterKeyRule,
        filterText: item.filterText,
      },
      dnSpy: { glyph: item.glyph, displayParts: item.displayParts, warning: item.warning },
    }
  })
}

/**
 * Draws dnSpy's filter buttons in the suggest widget's status bar, which Monaco sizes the list around: one button
 * for each kind some item of the list is, in dnSpy's order, pressed when it is on. dnSpy shows them only when
 * there are two or more, and so does the status bar.
 */
const renderFilterBar = (binding: Binding, toggle: (id: string) => void): void => {
  const widget = suggestWidgetOf(binding.editor)
  const statusBar = widget?.element.domNode.querySelector('.suggest-status-bar')
  if (!statusBar) return
  let bar = statusBar.querySelector<HTMLElement>(':scope > .ds-completion-filters')
  if (!bar) {
    bar = document.createElement('div')
    bar.className = 'ds-completion-filters'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', translate('Filters'))
    statusBar.prepend(bar)
  }
  bar.textContent = ''
  const filters = binding.completion.list?.list.filters ?? []
  if (filters.length < 2) return
  const background = parseCssColor(getComputedStyle(widget!.element.domNode).getPropertyValue('--vscode-editorSuggestWidget-background')) ?? [255, 255, 255]
  for (const id of filters) {
    const filter = COMPLETION_FILTERS[id]
    if (!filter) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ds-completion-filter'
    const checked = binding.completion.checked.has(id)
    button.setAttribute('aria-pressed', String(checked))
    button.title = translate('{toolTip} (Alt+{key})', { toolTip: translate(filter.toolTip), key: filter.accessKey })
    button.setAttribute('aria-label', translate(filter.toolTip))
    button.dataset.filter = id
    const url = dsImageUrl(filter.image, background, document.documentElement.dataset.themeKind === 'hc')
    if (url) {
      const image = document.createElement('img')
      image.src = url
      image.width = 16
      image.height = 16
      image.alt = ''
      button.appendChild(image)
    }
    // The editor keeps the focus, so the list stays open and keeps taking the keys.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      toggle(id)
    })
    bar.appendChild(button)
  }
}

/** Switches a filter button and shows the list again through it — dnSpy's FilterVM.IsChecked and Refilter. */
const toggleFilter = (binding: Binding, id: string): void => {
  const { checked } = binding.completion
  if (checked.has(id)) checked.delete(id)
  else checked.add(id)
  binding.completion.next = { kind: 'invoke', reuse: true }
  // The Trigger Suggest action does nothing while the list is up; the controller asks the providers again.
  const controller = binding.editor.getContribution?.('editor.contrib.suggestController') as unknown as { triggerSuggest?(onlyFrom: undefined, auto: boolean): void } | null
  if (controller?.triggerSuggest)
    controller.triggerSuggest(undefined, true)
  else
    binding.editor.trigger('dnSpy', 'editor.action.triggerSuggest', { auto: true })
  renderFilterBar(binding, (other) => toggleFilter(binding, other))
}

/**
 * The editor's keys and mouse gestures dnSpy's Roslyn command filters and editor operations handle: Complete Word
 * and Show Member List, the Enter rule of the selected item, a list on a deleted character, Ctrl+K I and Ctrl+K P,
 * and the word commands of the text structure navigator.
 */
const attachCommands = (monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor, binding: Binding): Monaco.IDisposable[] => {
  const disposables: Monaco.IDisposable[] = []
  if (typeof editor.createContextKey !== 'function' || typeof editor.addCommand !== 'function')
    return disposables
  const { KeyMod, KeyCode } = monaco
  const add = editorCommands(editor)
  const chord = (first: number, second: number): number => KeyMod.chord(first, second)

  // Complete Word (Ctrl+Space, Alt+Right) commits an only match; Show Member List (Ctrl+J, Ctrl+Alt+T) does not.
  const showList = (commitIfUnique: boolean): void => {
    binding.completion.next = { kind: 'invoke', commitIfUnique }
    binding.completion.commitIfUnique = commitIfUnique
    editor.trigger('keyboard', 'editor.action.triggerSuggest', {})
  }
  add(KeyMod.CtrlCmd | KeyCode.Space, () => showList(true))
  add(KeyMod.Alt | KeyCode.RightArrow, () => showList(true), '!suggestWidgetVisible')
  add(KeyMod.CtrlCmd | KeyCode.KeyJ, () => showList(false))
  add(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyT, () => showList(false))
  // Quick Info (Ctrl+K I besides Monaco's Ctrl+K Ctrl+I) and Parameter Info (Ctrl+K P, Ctrl+K Ctrl+P).
  add(chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyI), () => editor.trigger('keyboard', 'editor.action.showHover', {}))
  add(chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyP), () => editor.trigger('keyboard', 'editor.action.triggerParameterHints', {}))
  add(chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyP), () => editor.trigger('keyboard', 'editor.action.triggerParameterHints', {}))

  // Enter commits the selected item, and starts a new line too when the item's rule says so.
  add(KeyCode.Enter, () => {
    const focused = suggestWidgetOf(editor)?.getFocusedItem()
    const roslyn = focused?.item.completion.roslyn
    let passThrough = false
    if (roslyn) {
      const model = editor.getModel()
      const position = editor.getPosition()
      const range = focused.item.completion.range
      const start = range && 'insert' in range ? range.insert : range
      if (roslyn.enterKeyRule === 'always')
        passThrough = true
      else if (roslyn.enterKeyRule === 'afterFullyTypedWord' && model && position && start) {
        const typed = model.getValueInRange({ startLineNumber: start.startLineNumber, startColumn: start.startColumn, endLineNumber: position.lineNumber, endColumn: position.column })
        passThrough = typed.toLocaleLowerCase() === roslyn.filterText.toLocaleLowerCase()
      }
    }
    editor.trigger('keyboard', 'acceptSelectedSuggestion', {})
    if (passThrough)
      editor.trigger('keyboard', 'type', { text: '\n' })
  }, 'suggestWidgetVisible')

  // A deleted character opens a list where Roslyn's rules say it does (Visual Basic's do, C#'s do not).
  let deleted: string | undefined
  disposables.push(editor.onKeyDown((event) => {
    deleted = undefined
    if (event.keyCode !== KeyCode.Backspace || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || !model || !selection.isEmpty()) return
    deleted = characterBefore(model, selection.getPosition())
  }))
  disposables.push(editor.onDidChangeModelContent(() => {
    const character = deleted
    deleted = undefined
    // dnSpy starts a session on a deletion only when none is open.
    if (character === undefined || suggestWidgetOf(editor)?.getFocusedItem()) return
    binding.completion.next = { kind: 'deletion', character }
    editor.trigger('dnSpy', 'editor.action.triggerSuggest', { auto: true })
  }))

  // The filter buttons: drawn whenever the list is shown, switched by Alt and their letter while it is.
  const widget = suggestWidgetOf(editor)
  if (widget) {
    disposables.push(widget.onDidShow(() => renderFilterBar(binding, (id) => toggleFilter(binding, id))))
    disposables.push(widget.onDidFocus((event) => {
      if (!binding.completion.commitIfUnique) return
      binding.completion.commitIfUnique = false
      if (event.model.items.length === 1)
        editor.trigger('keyboard', 'acceptSelectedSuggestion', {})
    }))
  }
  disposables.push(editor.onKeyDown((event) => {
    if (!suggestWidgetOf(editor)?.getFocusedItem() || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const letter = /^Key([A-Z])$/.exec(event.code)?.[1]
    const id = letter && binding.completion.list?.list.filters.find((filter) => COMPLETION_FILTERS[filter]?.accessKey === letter)
    if (!id) return
    // Taken, so the menu bar opens neither the menu of the letter nor the first one when Alt is let go.
    event.preventDefault()
    toggleFilter(binding, id)
  }))

  disposables.push(...attachWordCommands(monaco, editor, binding, add))
  return disposables
}

/**
 * dnSpy's word commands, by the words its Roslyn text structure navigator finds: Ctrl+Left/Right (with Shift to
 * extend the selection), Ctrl+Backspace/Delete, Ctrl+W and Ctrl+Shift+W, a double click (or a Ctrl+click) and a
 * drag after one. The backend works out each command's result; they run one after another, each from where the
 * one before left the caret.
 */
const attachWordCommands = (
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  binding: Binding,
  add: EditorCommand,
): Monaco.IDisposable[] => {
  const { KeyMod, KeyCode } = monaco
  let queue: Promise<void> = Promise.resolve()
  const run = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch(() => undefined)
  }
  const ask = async (command: CodeWordNavigationRequest['command'], position: number, selectionStart = position, selectionEnd = position): Promise<{ start: number; end: number } | undefined> => {
    const documentId = await binding.synced()
    return window.dnSpy.getCodeWordNavigation({ documentId, command, position, selectionStart, selectionEnd })
  }
  const offsets = (): { model: Monaco.editor.ITextModel; selection: Monaco.Selection; caret: number; anchor: number; start: number; end: number } | undefined => {
    const model = editor.getModel()
    const selection = editor.getSelection()
    if (!model || !selection) return undefined
    const caret = model.getOffsetAt(selection.getPosition())
    const anchor = model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn })
    return { model, selection, caret, anchor, start: Math.min(caret, anchor), end: Math.max(caret, anchor) }
  }
  const select = (model: Monaco.editor.ITextModel, anchor: number, active: number): void => {
    const from = model.getPositionAt(anchor)
    const to = model.getPositionAt(active)
    editor.setSelection(new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column))
    editor.revealPosition(to)
  }

  const move = (command: 'nextWord' | 'previousWord', extend: boolean): void => run(async () => {
    const state = offsets()
    if (!state) return
    const version = state.model.getVersionId()
    const result = await ask(command, state.caret)
    if (!result || state.model.getVersionId() !== version) return
    select(state.model, extend && !state.selection.isEmpty() ? state.anchor : extend ? state.caret : result.start, result.start)
  })
  add(KeyMod.CtrlCmd | KeyCode.RightArrow, () => move('nextWord', false))
  add(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.RightArrow, () => move('nextWord', true))
  add(KeyMod.CtrlCmd | KeyCode.LeftArrow, () => move('previousWord', false))
  add(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.LeftArrow, () => move('previousWord', true))

  // Deleting a word: a selection made towards the deleted side goes as it is; otherwise from it to the word's edge.
  const deleteWord = (command: 'nextWord' | 'previousWord'): void => run(async () => {
    const state = offsets()
    if (!state) return
    const version = state.model.getVersionId()
    let from = state.start
    let to = state.end
    const towards = command === 'previousWord' ? state.caret > state.anchor : state.caret < state.anchor
    if (state.selection.isEmpty() || !towards) {
      const result = await ask(command, command === 'previousWord' ? state.start : state.end)
      if (!result || state.model.getVersionId() !== version) return
      if (command === 'previousWord') from = result.start
      else to = result.start
    }
    if (to <= from) return
    const start = state.model.getPositionAt(from)
    const end = state.model.getPositionAt(to)
    editor.pushUndoStop()
    editor.executeEdits('dnSpy', [{ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: '' }])
    editor.pushUndoStop()
  })
  add(KeyMod.CtrlCmd | KeyCode.Backspace, () => deleteWord('previousWord'))
  add(KeyMod.CtrlCmd | KeyCode.Delete, () => deleteWord('nextWord'))

  // Ctrl+W selects the current word, with the caret after it.
  const selectWord = (): void => run(async () => {
    const state = offsets()
    if (!state) return
    const version = state.model.getVersionId()
    const result = await ask('currentWord', state.caret, state.start, state.end)
    if (!result || state.model.getVersionId() !== version) return
    select(state.model, result.start, result.end)
  })
  add(KeyMod.CtrlCmd | KeyCode.KeyW, selectWord)
  add(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyW, selectWord)

  // A double click, or a click with Ctrl, selects the word under the mouse; dragging on from it selects whole words.
  let drag: { start: number; end: number } | undefined
  let latest = 0
  const disposables: Monaco.IDisposable[] = []
  disposables.push(editor.onMouseDown((event) => {
    drag = undefined
    const browser = event.event
    const position = event.target.position
    const model = editor.getModel()
    if (!browser.leftButton || !position || !model) return
    if (event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT && event.target.type !== monaco.editor.MouseTargetType.CONTENT_EMPTY) return
    const wordClick = browser.detail === 2 || (browser.detail === 1 && browser.ctrlKey && !browser.shiftKey && !browser.altKey)
    if (!wordClick) return
    if (browser.ctrlKey && browser.detail === 1)
      browser.preventDefault()
    const offset = model.getOffsetAt(position)
    const request = ++latest
    const version = model.getVersionId()
    run(async () => {
      const result = await ask('currentWord', offset)
      if (!result || request !== latest || model.getVersionId() !== version) return
      drag = { start: result.start, end: result.end }
      select(model, result.start, result.end)
    })
  }))
  disposables.push(editor.onMouseMove((event) => {
    const model = editor.getModel()
    const position = event.target.position
    if (!drag || !model || !position || (event.event.browserEvent.buttons & 1) === 0) return
    const anchorWord = drag
    const offset = model.getOffsetAt(position)
    const request = ++latest
    const version = model.getVersionId()
    run(async () => {
      const result = await ask('currentWord', offset)
      if (!result || request !== latest || model.getVersionId() !== version || drag !== anchorWord) return
      // dnSpy's mouse processor: the selection runs from the far end of the first word to the far end of this one.
      if (result.start < anchorWord.start) select(model, anchorWord.end, result.start)
      else select(model, anchorWord.start, Math.max(result.end, anchorWord.end))
    })
  }))
  disposables.push(editor.onMouseUp(() => { drag = undefined }))
  return disposables
}

let registered = false
const signatureHelpLanguages = new Set<string>()

/** Registers the providers, once; they stay silent for every model no editor attached. */
export function registerRoslynLanguageService(monaco: typeof Monaco): void {
  if (registered) return
  registered = true

  for (const language of Object.values(MONACO_LANGUAGES))
    registerLanguage(monaco, language)
}

/** dnSpy asks Roslyn about every typed character; Monaco asks only about these, and letters through its quick suggestions. */
const COMPLETION_TRIGGER_CHARACTERS = [...' !"#$%&\'()*+,-./:;<=>?@[\\]^`{|}~']

const registerLanguage = (monaco: typeof Monaco, language: string): void => {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, context, token) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const state = binding.completion
      const requested = state.next
      state.next = undefined
      if (requested?.reuse && state.list) {
        const { documentId, list } = state.list
        return { suggestions: toSuggestions(monaco, model, position, documentId, list, state.checked) }
      }
      // A typed trigger character, a command's request, or — Monaco's quick suggestions — the letter just typed.
      let kind: CodeCompletionTriggerKind
      let character: string | undefined
      if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter && context.triggerCharacter) {
        kind = 'insertion'
        character = context.triggerCharacter
      }
      else if (requested) {
        kind = requested.kind
        character = requested.character
      }
      else {
        character = characterBefore(model, position)
        kind = character === undefined ? 'invoke' : 'insertion'
      }
      const request = ++state.requests
      const documentId = await binding.synced()
      const { list } = await window.dnSpy.getCodeCompletion(documentId, model.getOffsetAt(position), character ?? null, kind)
      // A list asked for before the one now shown, which Monaco has given up on, must not take its place.
      if (request !== state.requests || token?.isCancellationRequested) return undefined
      // Every list Roslyn gives starts a session, whose filter buttons start switched off.
      state.checked = new Set()
      state.list = list ? { documentId, list } : undefined
      binding.editor.updateOptions({ suggest: { showStatusBar: (list?.filters.length ?? 0) > 1 } })
      setTimeout(() => renderFilterBar(binding, (id) => toggleFilter(binding, id)), 0)
      if (!list) return { suggestions: [] }
      return { suggestions: toSuggestions(monaco, model, position, documentId, list, state.checked) }
    },
    async resolveCompletionItem(item) {
      const roslyn = (item as Partial<RoslynCompletionItem>).roslyn
      if (!roslyn) return item
      const { parts } = await window.dnSpy.getCodeCompletionDescription(roslyn.documentId, roslyn.resultId, roslyn.index)
      return parts.length > 0 ? { ...item, documentation: markdown(partsToMarkdown(parts)) } : item
    },
  })

  monaco.languages.registerHoverProvider(language, {
    async provideHover(model, position) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { quickInfo } = await window.dnSpy.getCodeQuickInfo(documentId, model.getOffsetAt(position))
      if (!quickInfo) return undefined
      // dnSpy's Quick Info: the symbol's image and the warning image before the description, then the other
      // sections under it, one block.
      const images = imageMarkup(quickInfo.glyph) + (quickInfo.warning ? imageMarkup('StatusWarning') : '')
      const sections = quickInfo.sections.map((section, index) => (index === 0 ? images : '') + partsToMarkdown(section.parts))
      return {
        range: rangeOf(monaco, model, quickInfo.span.start, quickInfo.span.length),
        contents: [markdown(sections.join('<br>'))],
      }
    },
  })

  monaco.languages.registerOnTypeFormattingEditProvider(language, {
    autoFormatTriggerCharacters: ['\n'],
    async provideOnTypeFormattingEdits(model, position, _ch, options) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const { indentation } = await window.dnSpy.getCodeIndentation({
        documentId,
        line: position.lineNumber - 1,
        // The Tabs page's indent size is the model's; Monaco hands the provider only the tab size.
        indentSize: model.getOptions?.().indentSize ?? options.tabSize,
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
}

/**
 * Registers a language's signature help provider with the characters Roslyn's providers for it start and update
 * a session on, once. The trigger reason is the one dnSpy's command filter passes: a typed character starts a
 * session, one of the update characters (or a caret move, or an edit) while it is open updates it, and Ctrl+Shift+Space asks.
 */
export const registerSignatureHelp = (monaco: typeof Monaco, language: string, triggerCharacters: string, retriggerCharacters: string): void => {
  if (signatureHelpLanguages.has(language)) return
  signatureHelpLanguages.add(language)
  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: [...triggerCharacters],
    signatureHelpRetriggerCharacters: [...retriggerCharacters],
    async provideSignatureHelp(model, position, _token, context) {
      const binding = bindingOf(model)
      if (!binding) return undefined
      const documentId = await binding.synced()
      const kinds = monaco.languages.SignatureHelpTriggerKind
      let reason: CodeSignatureHelpTriggerReason = 'invoke'
      let character: string | null = null
      if (context.triggerKind === kinds?.TriggerCharacter && context.triggerCharacter) {
        character = context.triggerCharacter
        reason = context.isRetrigger && retriggerCharacters.includes(character) ? 'retrigger' : 'typeChar'
      }
      else if (context.triggerKind === kinds?.ContentChange || context.isRetrigger)
        reason = 'retrigger'
      const { help } = await window.dnSpy.getCodeSignatureHelp(documentId, model.getOffsetAt(position), character, reason)
      if (!help || help.items.length === 0) return undefined
      const selected = help.items[help.selectedItem]
      // Roslyn's choice of parameter; without one, a named argument is the parameter of that name, and an
      // argument past the last parameter of a params signature is that last one.
      const named = help.argumentName === null ? -1 : selected.parameters.findIndex((parameter) => parameter.name === help.argumentName)
      const variadicLast = selected.isVariadic ? selected.parameters.length - 1 : help.argumentIndex
      const activeParameter = help.selectedParameter ?? (named >= 0 ? named : Math.min(help.argumentIndex, variadicLast))
      return {
        value: {
          signatures: help.items.map(toSignatureInformation),
          activeSignature: help.selectedItem,
          activeParameter,
        },
        dispose: () => {},
      }
    },
  })
}
