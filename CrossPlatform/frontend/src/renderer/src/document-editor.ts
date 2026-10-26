import type * as Monaco from 'monaco-editor/editor/editor.api'
import type { DecompilerLanguage, TextPart, TextSpan } from '../../shared/protocol'
import { escapeHtml, integerLiteralValue, numberToolTip, spanAtClick } from './document-viewer'
import { dsImageUrl, parseCssColor } from './ds-image'

/**
 * What the hover needs to know about one decompiled document. The text itself lives in the Monaco model; this
 * is the part dnSpy's decompiler gives the viewer beside the text — the references a tooltip describes.
 */
export interface DocumentEditorData {
  workspaceId?: string
  /** The language the document is written in, which is the language its Quick Info is written in. */
  language: DecompilerLanguage
  spans: readonly TextSpan[]
}

const dataByModel = new Map<string, DocumentEditorData>()

/** Records what the hover reads for a model, or forgets it when the view lets the model go. */
export const setDocumentEditorData = (model: Monaco.editor.ITextModel, data: DocumentEditorData | undefined): void => {
  const key = model.uri.toString()
  if (data === undefined)
    dataByModel.delete(key)
  else
    dataByModel.set(key, data)
}

export const documentEditorData = (model: Monaco.editor.ITextModel): DocumentEditorData | undefined =>
  dataByModel.get(model.uri.toString())

// A theme color as the hover's sanitizer accepts it: `#rrggbb`, nothing else.
const colorProbe = typeof document === 'undefined' ? undefined : document.createElement('span')
const hexColor = (cssColor: string): string | undefined => {
  if (!colorProbe || !cssColor)
    return undefined
  colorProbe.style.color = ''
  colorProbe.style.color = cssColor
  if (!colorProbe.style.color)
    return undefined
  document.body.appendChild(colorProbe)
  const computed = getComputedStyle(colorProbe).color
  colorProbe.remove()
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed)
  return match ? `#${match.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, '0')).join('')}` : undefined
}

/** The theme's color for one of dnSpy's color classes, read off the variables the theme service writes. */
export const textColorValue = (color: string): string | undefined => {
  if (typeof document === 'undefined')
    return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--tc-${color.toLowerCase()}`).trim()
  return value ? hexColor(value) : undefined
}

/** Colored text parts as hover markdown: each part in its theme color, in the editor's monospace face. */
const partsMarkdown = (parts: readonly TextPart[]): string =>
  `<code>${parts.map((part) => {
    const color = textColorValue(part.color)
    // A tooltip's own newline — the BAML record tooltip puts its position on a second line.
    const text = escapeHtml(part.text).replace(/\r?\n/g, '<br/>')
    return color ? `<span style="color:${color};">${text}</span>` : text
  }).join('')}</code>`

const markdown = (value: string): Monaco.IMarkdownString => ({ value, supportHtml: true, isTrusted: false })

/**
 * The image CodeToolTipProvider draws before the signature, as hover markup: themed for the hover's background
 * the way dnSpy's images are for whatever they are drawn on. The sanitizer keeps no style, so its spacing is the
 * stylesheet's.
 */
const imageMarkup = (name: string | null | undefined): string => {
  if (!name || typeof document === 'undefined')
    return ''
  const editor = document.querySelector('.monaco-editor')
  const background = (editor && parseCssColor(getComputedStyle(editor).getPropertyValue('--vscode-editorHoverWidget-background'))) || [255, 255, 255]
  const url = dsImageUrl(name, background, document.documentElement.dataset.themeKind === 'hc')
  return url ? `<img src="${url}" width="16" height="16" alt="">` : ''
}

/** The images dnSpy's tooltips give what is not a member: a local, a parameter, a number. */
const LOCAL_IMAGE = 'LocalVariable'
const PARAMETER_IMAGE = 'Parameter'
const NUMBER_IMAGE = 'ConstantPublic'

export interface DocumentEditorProviders {
  /** The languages the decompiled documents are shown in. */
  readonly languages: readonly string[]
}

/**
 * dnSpy's tooltips for a decompiled document, from the data `setDocumentEditorData` records for its model: a
 * local's from its declaration, a member's and an opcode's from the backend in the document's language, and a
 * number's in the four bases. One registration serves every tab.
 */
export const registerDocumentEditorProviders = (monaco: typeof Monaco, provider: DocumentEditorProviders): void => {
  monaco.languages.registerHoverProvider([...provider.languages], {
    provideHover: async (model, position, token) => {
      const data = documentEditorData(model)
      if (!data)
        return undefined
      // The mouse is over a character, so it is hit-tested the way a click is.
      const span = spanAtClick(data.spans, model.getOffsetAt(position))
      if (!span) {
        const word = model.getWordAtPosition(position)
        const value = word ? integerLiteralValue(word.word) : undefined
        if (!word || value === undefined)
          return undefined
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [markdown(imageMarkup(NUMBER_IMAGE) + numberToolTip(value).map(escapeHtml).join('<br/>'))],
        }
      }
      const start = model.getPositionAt(span.start)
      const end = model.getPositionAt(span.start + span.length)
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
      if (span.localId) {
        const toolTipSpan = data.spans.find((candidate) => candidate.localId === span.localId && candidate.toolTip)
        const parts = toolTipSpan?.toolTip
        if (parts) {
          // The provider's own image wins: a BAML string is not a local, and says so with its icon. An empty
          // name is a tooltip its provider draws without an image (a BAML record, a resource).
          const image = toolTipSpan.toolTipImage === ''
            ? null
            : toolTipSpan.toolTipImage ?? (span.color?.toLowerCase() === 'parameter' ? PARAMETER_IMAGE : LOCAL_IMAGE)
          return { range, contents: [markdown(imageMarkup(image) + partsMarkdown(parts))] }
        }
        // A local reference the provider has nothing to say about — a BAML id, a record's numbers — still gets
        // the number tooltip dnSpy gives every integer literal, in its four bases.
        const value = integerLiteralValue(model.getValueInRange(range))
        return value === undefined
          ? undefined
          : { range, contents: [markdown(imageMarkup(NUMBER_IMAGE) + numberToolTip(value).map(escapeHtml).join('<br/>'))] }
      }
      if (!data.workspaceId)
        return undefined
      try {
        const info = await window.dnSpy.quickInfo(data.workspaceId, {
          targetNodeId: span.targetNodeId ?? null,
          modulePath: span.targetModulePath ?? null,
          metadataToken: span.targetMetadataToken ?? null,
          language: data.language,
          opCode: span.opCode ?? null,
        })
        if (token.isCancellationRequested || info.parts.length === 0)
          return undefined
        const contents = [markdown(imageMarkup(info.image) + partsMarkdown(info.parts))]
        if (info.documentation)
          contents.push(markdown(info.documentation.split('\n').map(escapeHtml).join('<br/>')))
        return { range, contents }
      } catch {
        // A reference the backend cannot describe simply has no tooltip, as one it cannot resolve has none.
        return undefined
      }
    },
  })
}
