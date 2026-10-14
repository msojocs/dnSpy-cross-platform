import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ClassifiedText } from './ColoredText'

afterEach(cleanup)

describe('ClassifiedText', () => {
  it('writes each span in its color class and the text between them plain', () => {
    const { container } = render(<ClassifiedText text="var x = 1;" spans={[
      { start: 0, length: 3, color: 'keyword' },
      { start: 4, length: 1, color: 'local' },
      { start: 8, length: 1, color: 'number' },
    ]} />)

    expect(container.textContent).toBe('var x = 1;')
    expect([...container.querySelectorAll('span')].map((span) => [span.textContent, span.className])).toEqual([
      ['var', 'tc-keyword'],
      [' ', ''],
      ['x', 'tc-local'],
      [' = ', ''],
      ['1', 'tc-number'],
      [';', ''],
    ])
  })

  it('skips spans that overlap or run past the text', () => {
    const { container } = render(<ClassifiedText text="ab" spans={[
      { start: 0, length: 2, color: 'local' },
      { start: 1, length: 1, color: 'error' },
      { start: 1, length: 5, color: 'error' },
    ]} />)

    expect(container.textContent).toBe('ab')
    expect(container.querySelectorAll('.tc-error')).toHaveLength(0)
  })
})
