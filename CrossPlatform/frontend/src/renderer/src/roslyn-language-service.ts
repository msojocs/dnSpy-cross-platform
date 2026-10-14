import type * as Monaco from 'monaco-editor'

/**
 * Roslyn-based language service provider for C# code intelligence.
 * This integrates Monaco Editor with the backend Roslyn workspace to provide
 * completions, hover information, signature help, and diagnostics.
 */

interface CompletionDto {
  label: string
  kind: string
  detail?: string
  documentation?: string
  insertText: string
  sortText: string
  filterText: string
}

interface HoverDto {
  contents: string
  range: RangeDto
}

interface SignatureHelpDto {
  signatures: SignatureInformationDto[]
  activeSignature: number
  activeParameter: number
}

interface SignatureInformationDto {
  label: string
  documentation: string
  parameters: ParameterInformationDto[]
}

interface ParameterInformationDto {
  label: string
  documentation: string
}

interface DiagnosticDto {
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  range: RangeDto
  code: string
}

interface RangeDto {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/**
 * Registers Roslyn-based language service providers for C# in Monaco Editor.
 */
export function registerRoslynLanguageService(monaco: typeof Monaco): void {
  // Register completion provider
  monaco.languages.registerCompletionItemProvider('csharp', {
    triggerCharacters: ['.', '(', '<', '"', ' '],
    async provideCompletionItems(model, position, context, token) {
      try {
        const content = model.getValue()
        const offset = model.getOffsetAt(position)

        // Update document in backend
        await window.dnSpy.updateDocument(model.uri.toString(), content)

        // Get completions from backend
        const completions = await window.dnSpy.getCompletions(model.uri.toString(), offset)

        return {
          suggestions: completions.map((item: CompletionDto) => ({
            label: item.label,
            kind: mapCompletionKind(monaco, item.kind),
            detail: item.detail,
            documentation: item.documentation,
            insertText: item.insertText,
            sortText: item.sortText,
            filterText: item.filterText,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            ),
          })),
        }
      } catch (error) {
        console.warn('Completion provider failed:', error)
        return { suggestions: [] }
      }
    },
  })

  // Register hover provider
  monaco.languages.registerHoverProvider('csharp', {
    async provideHover(model, position, token) {
      try {
        const content = model.getValue()
        const offset = model.getOffsetAt(position)

        await window.dnSpy.updateDocument(model.uri.toString(), content)
        const hover = await window.dnSpy.getHover(model.uri.toString(), offset)

        if (!hover) return null

        return {
          contents: [{ value: hover.contents }],
          range: new monaco.Range(
            hover.range.startLine + 1,
            hover.range.startColumn + 1,
            hover.range.endLine + 1,
            hover.range.endColumn + 1
          ),
        }
      } catch (error) {
        console.warn('Hover provider failed:', error)
        return null
      }
    },
  })

  // Register signature help provider
  monaco.languages.registerSignatureHelpProvider('csharp', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position, token, context) {
      try {
        const content = model.getValue()
        const offset = model.getOffsetAt(position)

        await window.dnSpy.updateDocument(model.uri.toString(), content)
        const signatureHelp = await window.dnSpy.getSignatureHelp(model.uri.toString(), offset)

        if (!signatureHelp) return null

        return {
          value: {
            signatures: signatureHelp.signatures.map((sig: SignatureInformationDto) => ({
              label: sig.label,
              documentation: sig.documentation,
              parameters: sig.parameters.map((param: ParameterInformationDto) => ({
                label: param.label,
                documentation: param.documentation,
              })),
            })),
            activeSignature: signatureHelp.activeSignature,
            activeParameter: signatureHelp.activeParameter,
          },
          dispose: () => {},
        }
      } catch (error) {
        console.warn('Signature help provider failed:', error)
        return null
      }
    },
  })

  // Register code action provider for diagnostics
  let diagnosticsCollection: Monaco.editor.IMarkerData[] = []

  monaco.languages.registerCodeActionProvider('csharp', {
    async provideCodeActions(model, range, context, token) {
      // This would handle quick fixes based on diagnostics
      return { actions: [], dispose: () => {} }
    },
  })
}

/**
 * Updates diagnostics for a model by querying the backend Roslyn workspace.
 */
export async function updateDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel
): Promise<void> {
  try {
    const content = model.getValue()
    await window.dnSpy.updateDocument(model.uri.toString(), content)
    const diagnostics = await window.dnSpy.getDiagnostics(model.uri.toString())

    const markers = diagnostics.map((diag: DiagnosticDto) => ({
      severity: mapDiagnosticSeverity(monaco, diag.severity),
      message: diag.message,
      startLineNumber: diag.range.startLine + 1,
      startColumn: diag.range.startColumn + 1,
      endLineNumber: diag.range.endLine + 1,
      endColumn: diag.range.endColumn + 1,
      code: diag.code,
    }))

    monaco.editor.setModelMarkers(model, 'roslyn', markers)
  } catch (error) {
    console.warn('Failed to update diagnostics:', error)
  }
}

function mapCompletionKind(monaco: typeof Monaco, kind: string): Monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'class': return monaco.languages.CompletionItemKind.Class
    case 'interface': return monaco.languages.CompletionItemKind.Interface
    case 'struct': return monaco.languages.CompletionItemKind.Struct
    case 'enum': return monaco.languages.CompletionItemKind.Enum
    case 'method': return monaco.languages.CompletionItemKind.Method
    case 'property': return monaco.languages.CompletionItemKind.Property
    case 'field': return monaco.languages.CompletionItemKind.Field
    case 'event': return monaco.languages.CompletionItemKind.Event
    case 'namespace': return monaco.languages.CompletionItemKind.Module
    case 'keyword': return monaco.languages.CompletionItemKind.Keyword
    case 'variable': return monaco.languages.CompletionItemKind.Variable
    default: return monaco.languages.CompletionItemKind.Text
  }
}

function mapDiagnosticSeverity(monaco: typeof Monaco, severity: string): Monaco.MarkerSeverity {
  switch (severity) {
    case 'error': return monaco.MarkerSeverity.Error
    case 'warning': return monaco.MarkerSeverity.Warning
    case 'info': return monaco.MarkerSeverity.Info
    default: return monaco.MarkerSeverity.Hint
  }
}

// Extend window.dnSpy with language service methods
declare global {
  interface DnSpyApi {
    updateDocument(filePath: string, content: string): Promise<string>
    getCompletions(filePath: string, position: number): Promise<CompletionDto[]>
    getHover(filePath: string, position: number): Promise<HoverDto | null>
    getSignatureHelp(filePath: string, position: number): Promise<SignatureHelpDto | null>
    getDiagnostics(filePath: string): Promise<DiagnosticDto[]>
  }
}
