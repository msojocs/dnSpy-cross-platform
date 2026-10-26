// The Monaco contributions a Roslyn code editor uses and the bare editor API leaves out: the suggest widget,
// the hover, parameter hints and on-type formatting. They have to be loaded before Monaco's first editor is created
// — the suggest widget registers services, which Monaco only takes until then — so monaco.ts loads them. Monaco's
// smart select stays out: dnSpy binds no key to its text structure navigator's enclosing spans.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints'
import 'monaco-editor/editor/contrib/format/browser/formatActions'
import { ItemRenderer } from 'monaco-editor/editor/contrib/suggest/browser/suggestWidgetRenderer'
import { ParameterHintsWidget } from 'monaco-editor/editor/contrib/parameterHints/browser/parameterHintsWidget'
import type { TextPart } from '../../shared/protocol'
import { dsImageUrl, parseCssColor } from './ds-image'

/**
 * What a Roslyn completion item carries for dnSpy's completion list (<c>CompletionPresenter</c>): the image of its
 * kind, its text in the colors of <c>CompletionClassifier</c>, and the warning icon some items get beside them.
 */
export interface DnSpyCompletionPresentation {
  glyph: string | null
  displayParts: readonly TextPart[]
  warning: boolean
}

/**
 * What a Roslyn signature carries for dnSpy's signature help presenter: the signature in color with each
 * parameter's place in it, what follows it while a parameter is current (that parameter's selected text and the
 * signature's description), the signature's documentation on a line of its own, and each parameter's name and
 * documentation for the line under it.
 */
export interface DnSpySignaturePresentation {
  parts: readonly TextPart[]
  parameters: readonly { name: string; start: number; end: number; selectedDisplay: readonly TextPart[]; documentation: readonly TextPart[] }[]
  description: readonly TextPart[]
  documentation: readonly TextPart[]
}

/** The colored parts as spans in the `tc-*` classes the theme service writes for code. */
const appendParts = (parent: HTMLElement, parts: readonly TextPart[]): void => {
  for (const part of parts) {
    const span = document.createElement('span')
    if (part.color !== 'text')
      span.className = `tc-${part.color}`
    span.textContent = part.text
    parent.appendChild(span)
  }
}

/**
 * Colors the text nodes under `element` by `parts`, which spell the same text: each run of a node that falls in
 * one part goes into a span of that part's class. The nodes keep their place, so Monaco's match highlights stay.
 */
const colorTextNodes = (element: Element, parts: readonly TextPart[]): void => {
  const boundaries: { end: number; color: string }[] = []
  let offset = 0
  for (const part of parts) {
    offset += part.text.length
    boundaries.push({ end: offset, color: part.color })
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text)
  let position = 0
  for (const node of nodes) {
    const text = node.data
    const fragment = document.createDocumentFragment()
    let index = 0
    while (index < text.length) {
      const boundary = boundaries.find((b) => b.end > position) ?? { end: Number.MAX_SAFE_INTEGER, color: 'text' }
      const length = Math.min(text.length - index, boundary.end - position)
      const span = document.createElement('span')
      span.className = boundary.color === 'text' ? 'ds-completion-text' : `ds-completion-text tc-${boundary.color}`
      span.textContent = text.slice(index, index + length)
      fragment.appendChild(span)
      index += length
      position += length
    }
    node.replaceWith(fragment)
  }
}

/** The background images are drawn over, for dnSpy's theming of them. */
const backgroundOf = (element: Element, variable: string): [number, number, number] =>
  parseCssColor(getComputedStyle(element).getPropertyValue(variable)) ?? [255, 255, 255]

const imageUrl = (name: string, element: Element, variable: string): string | undefined =>
  dsImageUrl(name, backgroundOf(element, variable), document.documentElement.dataset.themeKind === 'hc')

interface ItemTemplate {
  root: HTMLElement
  right: HTMLElement
  iconContainer: HTMLElement
}

// dnSpy's completion list draws each item with the image of its kind and its text in the kind's colors; Monaco
// draws a codicon and plain text. Items that carry dnSpy's presentation are drawn dnSpy's way.
const renderItem = ItemRenderer.prototype.renderElement
ItemRenderer.prototype.renderElement = function (this: unknown, element: { completion: { dnSpy?: DnSpyCompletionPresentation } }, index: number, data: ItemTemplate) {
  renderItem.call(this, element, index, data)
  data.iconContainer.style.backgroundImage = ''
  data.root.querySelector(':scope .ds-completion-warning')?.remove()
  const presentation = element.completion.dnSpy
  data.root.classList.toggle('ds-completion', presentation !== undefined)
  if (!presentation)
    return
  data.iconContainer.className = 'icon-label suggest-icon ds-completion-icon'
  const url = presentation.glyph ? imageUrl(presentation.glyph, data.root, '--vscode-editorSuggestWidget-background') : undefined
  if (url)
    data.iconContainer.style.backgroundImage = `url("${url}")`
  const name = data.root.querySelector('.label-name')
  if (name)
    colorTextNodes(name, presentation.displayParts)
  if (presentation.warning) {
    const warning = document.createElement('span')
    warning.className = 'ds-completion-warning'
    const warningUrl = imageUrl('StatusWarning', data.root, '--vscode-editorSuggestWidget-background')
    if (warningUrl)
      warning.style.backgroundImage = `url("${warningUrl}")`
    data.right.prepend(warning)
  }
}

interface HintsSignature {
  activeParameter?: number
  dnSpy?: DnSpySignaturePresentation
}

interface HintsWidget {
  domNodes?: { element: HTMLElement; signature: HTMLElement; docs: HTMLElement; scrollbar: { scanDomNode(): void } }
  editor: { layoutContentWidget(widget: unknown): void }
}

// dnSpy's signature help shows the signature in color with the current parameter in bold, then what the
// parameter and the signature add after it and the signature's documentation, and under it the current
// parameter's name and documentation; Monaco shows the signature as plain text with its documentation below.
const renderHints = ParameterHintsWidget.prototype.render
ParameterHintsWidget.prototype.render = function (this: HintsWidget, hints: { signatures: HintsSignature[]; activeSignature: number; activeParameter: number }) {
  renderHints.call(this, hints)
  const signature = hints.signatures[hints.activeSignature]
  const presentation = signature?.dnSpy
  const nodes = this.domNodes
  if (!presentation || !nodes)
    return
  const active = signature.activeParameter ?? hints.activeParameter
  const parameter = presentation.parameters[active] as DnSpySignaturePresentation['parameters'][number] | undefined

  nodes.signature.textContent = ''
  const code = document.createElement('div')
  code.className = 'code ds-signature'
  // The current parameter is drawn in a span of its own, the way Monaco marks it.
  const activeSpan = parameter && parameter.end > parameter.start ? document.createElement('span') : undefined
  if (activeSpan)
    activeSpan.className = 'parameter active'
  let offset = 0
  for (const part of presentation.parts) {
    const cuts = new Set([0, part.text.length])
    if (parameter && activeSpan) {
      for (const cut of [parameter.start - offset, parameter.end - offset]) {
        if (cut > 0 && cut < part.text.length)
          cuts.add(cut)
      }
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let i = 0; i + 1 < points.length; i++) {
      const at = offset + points[i]
      const inParameter = parameter !== undefined && activeSpan !== undefined && at >= parameter.start && at < parameter.end
      const target = inParameter ? activeSpan : code
      if (inParameter && !activeSpan.isConnected)
        code.appendChild(activeSpan)
      appendParts(target, [{ text: part.text.slice(points[i], points[i + 1]), color: part.color }])
    }
    offset += part.text.length
  }
  appendParts(code, parameter?.selectedDisplay ?? [])
  appendParts(code, presentation.description)
  if (presentation.documentation.length > 0) {
    const documentation = document.createElement('div')
    documentation.className = 'ds-signature-documentation'
    appendParts(documentation, presentation.documentation)
    code.appendChild(documentation)
  }
  nodes.signature.appendChild(code)

  nodes.docs.textContent = ''
  const hasDocs = parameter !== undefined && parameter.documentation.length > 0
  if (parameter && hasDocs) {
    const line = document.createElement('p')
    const name = document.createElement('span')
    name.className = 'ds-parameter-name tc-parameter'
    name.textContent = parameter.name
    line.appendChild(name)
    line.appendChild(document.createTextNode(': '))
    appendParts(line, parameter.documentation)
    nodes.docs.appendChild(line)
  }
  nodes.signature.classList.toggle('has-docs', hasDocs)
  nodes.docs.classList.toggle('empty', !hasDocs)
  this.editor.layoutContentWidget(this)
  nodes.scrollbar.scanDomNode()
}
