import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import type { ClassifyResponse } from '../../shared/protocol'
import { attachClassifier, classificationDecorations, spansOfTrimmed } from './roslyn-classification'
import { FakeModel, FakeRange, fakeEditor } from './roslyn-test-fakes'

const monaco = { Range: FakeRange } as unknown as typeof Monaco

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('classificationDecorations', () => {
  it('turns each colored span into a decoration in its color class', () => {
    const model = new FakeModel('int x;\nx++;')

    const decorations = classificationDecorations(monaco, model as unknown as Monaco.editor.ITextModel, [
      { start: 0, length: 3, color: 'keyword' },
      { start: 7, length: 1, color: 'local' },
      { start: 9, length: 0, color: 'text' },
    ])

    expect(decorations).toEqual([
      { range: new FakeRange(1, 1, 1, 4), options: { inlineClassName: 'tc-keyword' } },
      { range: new FakeRange(2, 1, 2, 2), options: { inlineClassName: 'tc-local' } },
    ])
  })
})

describe('spansOfTrimmed', () => {
  it('moves the spans to the trimmed text and clips what lies outside it', () => {
    expect(spansOfTrimmed('  x + 1 \n', [
      { start: 0, length: 2, color: 'text' },
      { start: 2, length: 1, color: 'local' },
      { start: 4, length: 1, color: 'operator' },
      { start: 6, length: 3, color: 'number' },
    ])).toEqual([
      { start: 0, length: 1, color: 'local' },
      { start: 2, length: 1, color: 'operator' },
      { start: 4, length: 1, color: 'number' },
    ])
  })
})

describe('attachClassifier', () => {
  let resolvers: ((response: ClassifyResponse) => void)[]
  let classify: ReturnType<typeof vi.fn<(text: string) => Promise<ClassifyResponse>>>

  beforeEach(() => {
    resolvers = []
    classify = vi.fn((_text: string) => new Promise<ClassifyResponse>((resolve) => resolvers.push(resolve)))
  })

  afterEach(() => vi.restoreAllMocks())

  it('colors the text it starts with and every change after', async () => {
    const model = new FakeModel('a')
    const { editor, decorations } = fakeEditor(model)

    const classifier = attachClassifier(monaco, editor, classify)
    expect(classify).toHaveBeenCalledWith('a')
    resolvers[0]({ spans: [{ start: 0, length: 1, color: 'error' }] })
    await flush()

    expect(decorations.set).toHaveBeenCalledWith([{ range: new FakeRange(1, 1, 1, 2), options: { inlineClassName: 'tc-error' } }])
    expect(classifier.current()).toEqual([{ start: 0, length: 1, color: 'error' }])

    model.setValue('ab')
    expect(classify).toHaveBeenLastCalledWith('ab')
    // The text changed since the last answer, so those colors are no longer the input's.
    expect(classifier.current()).toBeUndefined()
  })

  it('drops an answer for text that has changed since it was asked for', async () => {
    const model = new FakeModel('a')
    const { editor, decorations } = fakeEditor(model)
    const classifier = attachClassifier(monaco, editor, classify)
    model.setValue('ab')

    resolvers[1]({ spans: [{ start: 0, length: 2, color: 'local' }] })
    await flush()
    resolvers[0]({ spans: [{ start: 0, length: 1, color: 'error' }] })
    await flush()

    expect(decorations.set).toHaveBeenCalledTimes(1)
    expect(classifier.current()).toEqual([{ start: 0, length: 2, color: 'local' }])
  })

  it('clears the colors of empty text without asking', () => {
    const model = new FakeModel('')
    const { editor, decorations } = fakeEditor(model)

    const classifier = attachClassifier(monaco, editor, classify)

    expect(classify).not.toHaveBeenCalled()
    expect(decorations.clear).toHaveBeenCalled()
    expect(classifier.current()).toEqual([])
  })

  it('stops listening once disposed', async () => {
    const model = new FakeModel('a')
    const { editor, decorations } = fakeEditor(model)
    const classifier = attachClassifier(monaco, editor, classify)

    classifier.dispose()
    resolvers[0]({ spans: [{ start: 0, length: 1, color: 'local' }] })
    await flush()
    model.setValue('b')

    expect(decorations.set).not.toHaveBeenCalled()
    expect(classify).toHaveBeenCalledTimes(1)
  })
})
