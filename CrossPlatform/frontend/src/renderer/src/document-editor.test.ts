import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { TextSpan } from '../../shared/protocol'
import { FakeModel, FakeRange } from './roslyn-test-fakes'
import { dsImageUrl } from './ds-image'

type Module = typeof import('./document-editor')

/** The hover draws its image as a data URL, so the test compares the URL the image service gives. */
const imageOf = (name: string): string => dsImageUrl(name, [255, 255, 255], false) ?? `!!${name}!!`

/** A Monaco that records the hover provider registered with it. */
const fakeMonaco = () => {
  const providers: Record<string, any> = {}
  const monaco = {
    Range: FakeRange,
    languages: {
      registerHoverProvider: vi.fn((_language: string[], provider: unknown) => {
        providers.hover = provider
        return { dispose: () => {} }
      }),
    },
  }
  return { monaco: monaco as unknown as typeof Monaco, providers }
}

const hoverAt = async (provider: any, model: FakeModel, column: number) =>
  provider.provideHover(model, { lineNumber: 1, column }, { isCancellationRequested: false })

describe('the decompiled document hover', () => {
  let editor: Module
  let providers: Record<string, any>

  beforeEach(async () => {
    vi.resetModules()
    editor = await import('./document-editor')
    const fake = fakeMonaco()
    providers = fake.providers
    editor.registerDocumentEditorProviders(fake.monaco, { languages: ['csharp', 'baml'] })
  })

  const modelWith = (text: string, spans: TextSpan[]): FakeModel => {
    const model = new FakeModel(text)
    editor.setDocumentEditorData(model as unknown as Monaco.editor.ITextModel, { language: 'cSharp', spans })
    return model
  }

  it('draws the image a local tooltip carries, from the span that carries it', async () => {
    const model = modelWith('x = y', [
      { start: 0, length: 1, kind: 'definition', localId: 'L0', toolTip: [{ text: '"abc"', color: 'string' }], toolTipImage: 'String' },
      { start: 4, length: 1, kind: 'reference', localId: 'L0' },
    ])

    const hover = await hoverAt(providers.hover, model, 5)

    expect(hover.contents[0].value).toContain(imageOf('String'))
    expect(hover.contents[0].value).toContain('&quot;abc&quot;')
  })

  it('falls back to the local variable image when the tooltip has none', async () => {
    const model = modelWith('num', [
      { start: 0, length: 3, kind: 'definition', localId: 'L0', toolTip: [{ text: '(local variable) int num', color: 'text' }] },
    ])

    expect((await hoverAt(providers.hover, model, 2)).contents[0].value).toContain(imageOf('LocalVariable'))
  })

  it('puts a tooltip newline on a new hover line', async () => {
    const model = modelWith('DocumentStart', [
      { start: 0, length: 13, kind: 'definition', localId: 'L0', toolTip: [{ text: 'DocumentStart\nPosition: 0x10', color: 'keyword' }] },
    ])

    const value = (await hoverAt(providers.hover, model, 2)).contents[0].value

    expect(value).toContain('DocumentStart<br/>Position: 0x10')
  })

  it('draws no image for a tooltip whose provider has none', async () => {
    const model = modelWith('DocumentStart', [
      { start: 0, length: 13, kind: 'definition', localId: 'L0', toolTip: [{ text: 'DocumentStart', color: 'keyword' }], toolTipImage: '' },
    ])

    const value = (await hoverAt(providers.hover, model, 2)).contents[0].value

    expect(value).not.toContain('<img')
    expect(value).toContain('DocumentStart')
  })

  it('gives a local reference with no tooltip the number tooltip', async () => {
    const model = modelWith('0x0010', [
      { start: 0, length: 6, kind: 'reference', localId: 'L1', color: 'number' },
    ])

    const value = (await hoverAt(providers.hover, model, 2)).contents[0].value

    expect(value).toContain(imageOf('ConstantPublic'))
    expect(value).toContain('Base 10: 16')
    expect(value).toContain('Base 16: 10')
  })

  it('answers nothing for a local reference that is neither a tooltip nor a number', async () => {
    const model = modelWith('IL_0000', [
      { start: 0, length: 7, kind: 'reference', localId: 'L2' },
    ])

    expect(await hoverAt(providers.hover, model, 2)).toBeUndefined()
  })
})
