import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StringReference } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useStringReferencesStore } from '../string-references-store'
import { loadAppOptions } from './app-options'
import { buildStringReferencesMenuItems } from './StringReferencesContextMenu'
import { STRING_REFERENCES_FILTER_DELAY_MS, StringReferencesPane } from './StringReferencesPane'

const reference = (overrides: Partial<StringReference>): StringReference => ({
  kind: 'il',
  literal: 'Hello',
  formattedLiteral: '"Hello"',
  isVerbatim: false,
  referrerParts: [{ text: 'Holder', color: 'type' }, { text: '.', color: 'operator' }, { text: 'Greet', color: 'instanceMethod' }, { text: '()', color: 'punctuation' }],
  referrerIcon: 'method',
  moduleName: 'StringTarget.dll',
  token: 0x06000002,
  nodeId: 'method-node',
  ilOffset: 0,
  ...overrides,
})

const hello = reference({})
const path = reference({ literal: 'C:\\temp', formattedLiteral: '@"C:\\temp"', isVerbatim: true, token: 0x06000003, ilOffset: 2 })
const parameter = reference({
  kind: 'constant',
  literal: 'default name',
  formattedLiteral: '"default name"',
  referrerParts: [{ text: 'Holder.Greet([string])', color: 'text' }, { text: ' ', color: 'text' }, { text: 'parameter', color: 'darkGray' }, { text: ' ', color: 'text' }, { text: 'name', color: 'parameter' }],
  referrerIcon: 'method',
  token: 0x08000001,
  ilOffset: null,
})

const openNode = vi.fn(async () => undefined)
const copyText = vi.fn()

const renderPane = (): void => {
  render(<StringReferencesPane commands={{ openNode, copyText }} />)
}

const rowLiterals = (): string[] =>
  screen.queryAllByRole('row').filter((row) => row.classList.contains('strings-row')).map((row) => row.children[1].textContent ?? '')

describe('StringReferencesPane', () => {
  beforeEach(() => {
    localStorage.clear()
    openNode.mockClear()
    copyText.mockClear()
    useAppStore.setState({ workspaceId: 'ws', selectedNodes: [] })
    useStringReferencesStore.setState({ references: [parameter, path, hello], scanning: false, modulePaths: ['/StringTarget.dll'], requestKey: undefined, focusRequested: false })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('lists kind, literal, referrer and module in dnSpy\'s order of columns and rows', () => {
    renderPane()

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Kind', 'Literal', 'Referrer', 'Module'])
    // IL before constants; within IL by token.
    expect(rowLiterals()).toEqual(['"Hello"', '@"C:\\temp"', '"default name"'])
    const [first, second, third] = screen.getAllByRole('row').filter((row) => row.classList.contains('strings-row'))
    expect(first.children[0].textContent).toBe('IL')
    expect(first.querySelector('.tc-string')?.textContent).toBe('"Hello"')
    expect(second.querySelector('.tc-verbatimString')?.textContent).toBe('@"C:\\temp"')
    expect(first.children[2].textContent).toBe('Holder.Greet()')
    expect(first.querySelector('.tc-instanceMethod')?.textContent).toBe('Greet')
    expect(first.children[3].querySelector('.tc-assemblyModule')?.textContent).toBe('StringTarget.dll')
    expect(third.children[0].textContent).toBe('Constant')
    expect(third.querySelector('.tc-darkGray')?.textContent).toBe('parameter')
  })

  it('filters a tenth of a second after the typing stops', () => {
    vi.useFakeTimers()
    renderPane()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'temp' } })
    expect(rowLiterals()).toHaveLength(3)
    act(() => { vi.advanceTimersByTime(STRING_REFERENCES_FILTER_DELAY_MS) })

    expect(rowLiterals()).toEqual(['@"C:\\temp"'])
  })

  it('keeps the filter it had while the regular expression is invalid, and says so', () => {
    vi.useFakeTimers()
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    expect(loadAppOptions().stringReferences.regex).toBe(true)
    const input = screen.getByRole('textbox', { name: 'Search' })

    fireEvent.change(input, { target: { value: '^Hel' } })
    act(() => { vi.advanceTimersByTime(STRING_REFERENCES_FILTER_DELAY_MS) })
    expect(rowLiterals()).toEqual(['"Hello"'])
    fireEvent.change(input, { target: { value: '^Hel(' } })
    act(() => { vi.advanceTimersByTime(STRING_REFERENCES_FILTER_DELAY_MS) })

    expect(rowLiterals()).toEqual(['"Hello"'])
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('title', 'Invalid regular expression pattern')
  })

  it('sorts by a header up, down, then back to its own order', () => {
    renderPane()
    const literal = screen.getByRole('columnheader', { name: /Literal/ })

    fireEvent.click(literal)
    expect(rowLiterals()).toEqual(['@"C:\\temp"', '"default name"', '"Hello"'])
    fireEvent.click(literal)
    expect(rowLiterals()).toEqual(['"Hello"', '"default name"', '@"C:\\temp"'])
    fireEvent.click(literal)
    expect(rowLiterals()).toEqual(['"Hello"', '@"C:\\temp"', '"default name"'])
  })

  it('moves a column to where its header is dropped', () => {
    renderPane()
    const module = screen.getByRole('columnheader', { name: /Module/ })
    const kind = screen.getByRole('columnheader', { name: /Kind/ })

    fireEvent.dragStart(module, { dataTransfer: { effectAllowed: '' } })
    fireEvent.dragOver(kind)
    fireEvent.drop(kind)

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Module', 'Kind', 'Literal', 'Referrer'])
  })

  it('follows a row with Enter or a double click, in a new tab with Ctrl or Shift, and copies its literal with Ctrl+C', () => {
    renderPane()
    const rows = screen.getAllByRole('row').filter((row) => row.classList.contains('strings-row'))

    fireEvent.mouseDown(rows[0], { button: 0 })
    fireEvent.keyDown(rows[0], { key: 'Enter' })
    expect(openNode).toHaveBeenLastCalledWith('method-node', false)
    fireEvent.keyDown(rows[0], { key: 'Enter', ctrlKey: true })
    expect(openNode).toHaveBeenLastCalledWith('method-node', true)
    fireEvent.doubleClick(rows[2], { button: 0, shiftKey: true })
    expect(openNode).toHaveBeenLastCalledWith('method-node', true)

    fireEvent.keyDown(rows[0], { key: 'c', ctrlKey: true })
    expect(copyText).toHaveBeenCalledWith('"Hello"')
  })

  it('refreshes from its button', () => {
    const refresh = vi.fn()
    const original = useStringReferencesStore.getState().refresh
    useStringReferencesStore.setState({ refresh })
    renderPane()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(refresh).toHaveBeenCalledOnce()
    useStringReferencesStore.setState({ refresh: original })
  })

  it('offers the two copies, then the two ways of following', () => {
    const copy = vi.fn()
    const follow = vi.fn()
    const items = buildStringReferencesMenuItems({ t: (message) => message, reference: path, copyText: copy, follow })

    const entries = items.map((item) => item.key)
    expect(entries).toEqual(['copy-literal', 'copy-raw-literal', 'separator-1000', 'go-to-reference', 'go-to-reference-new-tab'])
    const select = (key: string): void => {
      const item = items.find((entry) => entry.type !== 'divider' && entry.key === key)
      if (!item || item.type === 'divider' || !item.onSelect)
        throw new Error(`Missing entry ${key}`)
      item.onSelect(item)
    }
    select('copy-literal')
    select('copy-raw-literal')
    select('go-to-reference-new-tab')
    expect(copy.mock.calls).toEqual([['@"C:\\temp"'], ['C:\\temp']])
    expect(follow).toHaveBeenCalledWith(true)
  })

  it('takes the focus into its search box when asked', () => {
    renderPane()

    act(() => { useStringReferencesStore.getState().requestFocus() })

    expect(within(document.body).getByRole('textbox', { name: 'Search' })).toHaveFocus()
    expect(useStringReferencesStore.getState().focusRequested).toBe(false)
  })
})
