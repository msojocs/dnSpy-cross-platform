import { describe, expect, it } from 'vitest'
import type { ScriptOutputEntry } from '../../../shared/protocol'
import { scriptCodeText, scriptLineNumbers, scriptLines, scriptText } from '../script-lines'

describe('scriptLines', () => {
  it('joins the fragments a submission prints onto one line until the newline', () => {
    const entries: ScriptOutputEntry[] = [
      { kind: 'echo', text: 'Print("a"); PrintLine("b");' },
      { kind: 'output', text: 'a' },
      { kind: 'output', text: 'b\n' },
      { kind: 'result', text: '2\n', color: 'replOutputText' },
    ]

    expect(scriptLines(entries)).toEqual([
      { kind: 'echo', parts: [{ text: '> ', color: 'replPrompt1' }, { text: 'Print("a"); PrintLine("b");' }], code: 'Print("a"); PrintLine("b");' },
      { kind: 'output', parts: [{ text: 'a' }, { text: 'b' }] },
      { kind: 'result', parts: [{ text: '2', color: 'replOutputText' }] },
    ])
  })

  it('splits an entry that carries several lines and ends terminal kinds without a newline', () => {
    const entries: ScriptOutputEntry[] = [
      { kind: 'error', text: 'CS0103: first\nsecond\n', color: 'error' },
      { kind: 'help', text: 'Keyboard shortcuts:' },
    ]

    expect(scriptLines(entries)).toEqual([
      { kind: 'error', parts: [{ text: 'CS0103: first', color: 'error' }] },
      { kind: 'error', parts: [{ text: 'second', color: 'error' }] },
      { kind: 'help', parts: [{ text: 'Keyboard shortcuts:' }] },
    ])
  })

  it('writes a multi-line echo with the secondary prompt and its own colors per line', () => {
    const entries: ScriptOutputEntry[] = [{
      kind: 'echo',
      text: 'if (true) {\n  Missing();\n}',
      colors: [
        { start: 0, length: 2, color: 'keyword' },
        { start: 14, length: 7, color: 'error' },
      ],
    }]

    const [first, second, third] = scriptLines(entries)
    expect(first.parts).toEqual([{ text: '> ', color: 'replPrompt1' }, { text: 'if (true) {', colors: [{ start: 0, length: 2, color: 'keyword' }] }])
    expect(second.parts).toEqual([{ text: '. ', color: 'replPrompt2' }, { text: '  Missing();', colors: [{ start: 2, length: 7, color: 'error' }] }])
    expect(third.parts).toEqual([{ text: '. ', color: 'replPrompt2' }, { text: '}' }])
  })

  it('keeps an empty line that two newlines make', () => {
    expect(scriptLines([{ kind: 'output', text: 'one\n\ntwo\n' }])).toEqual([
      { kind: 'output', parts: [{ text: 'one' }] },
      { kind: 'output', parts: [{ text: '' }] },
      { kind: 'output', parts: [{ text: 'two' }] },
    ])
  })

  it('carries the colors of a line whose parts are colored, like a #help row', () => {
    expect(scriptLines([{
      kind: 'output',
      text: '  #r   Add a reference',
      color: 'replOutputText',
      colors: [{ start: 2, length: 2, color: 'preprocessorKeyword' }],
    }])).toEqual([{
      kind: 'output',
      parts: [{ text: '  #r   Add a reference', color: 'replOutputText', colors: [{ start: 2, length: 2, color: 'preprocessorKeyword' }] }],
    }])
  })
})

describe('scriptLineNumbers', () => {
  it('numbers every output block and submission from one, alternating the input colors', () => {
    const lines = scriptLines([
      { kind: 'banner', text: 'banner\n' },
      { kind: 'output', text: 'loading\n' },
      { kind: 'echo', text: 'var x = 1;\nvar y = 2;' },
      { kind: 'echo', text: 'x + y' },
      { kind: 'result', text: '3\n' },
      { kind: 'echo', text: 'x' },
      { kind: 'result', text: '1\n' },
    ])

    expect(scriptLineNumbers(lines)).toEqual([
      { lineNumber: 1, color: 'replLineNumberOutput' },
      { lineNumber: 2, color: 'replLineNumberOutput' },
      { lineNumber: 1, color: 'replLineNumberInput1' },
      { lineNumber: 2, color: 'replLineNumberInput1' },
      { lineNumber: 1, color: 'replLineNumberInput2' },
      { lineNumber: 1, color: 'replLineNumberOutput' },
      { lineNumber: 1, color: 'replLineNumberInput1' },
      { lineNumber: 1, color: 'replLineNumberOutput' },
    ])
  })
})

describe('scriptText and scriptCodeText', () => {
  const entries: ScriptOutputEntry[] = [
    { kind: 'echo', text: 'var x = 1;' },
    { kind: 'output', text: 'hello\n' },
    { kind: 'echo', text: 'x + 1' },
    { kind: 'result', text: '2\n' },
  ]

  it('writes the whole window with its prompts', () => {
    expect(scriptText(entries, 'x + 2')).toBe('> var x = 1;\nhello\n> x + 1\n2\n> x + 2')
  })

  it('writes only the submitted code, leaving output and prompts out', () => {
    expect(scriptCodeText(entries, 'x + 2')).toBe('var x = 1;\nx + 1\nx + 2')
  })

  it('leaves a blank pending input out', () => {
    expect(scriptCodeText(entries, '  ')).toBe('var x = 1;\nx + 1')
  })
})
