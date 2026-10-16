import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeStatement, SearchResult, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useSearchStore } from '../search-store'
import { defaultAppOptions, loadAppOptions, saveAppOptions } from './app-options'
import { buildSearchMenuItems, type SearchMenuContext } from './SearchContextMenu'
import { SearchPane, type SearchPaneCommands } from './SearchPane'

// Found in this order; the list shows them by name, case aside.
const results: SearchResult[] = [
  { nodeId: 'n-run', kind: 'method', name: 'void Run()', location: 'Ns.Type', icon: 'method', locationIcon: 'class', ilOffset: 6 },
  { nodeId: 'n-type', kind: 'type', name: 'Type', location: 'Ns', icon: 'class', locationIcon: 'namespace',
    nameParts: [{ text: 'Type', color: 'type' }], locationParts: [{ text: 'Ns', color: 'namespace' }] },
  { nodeId: 'n-res', kind: 'resource', name: 'logo.png', location: 'App.dll', icon: 'resource' },
  { nodeId: null, kind: 'moduleReference', name: 'libc', location: 'App.dll', icon: 'reference' },
]

const nodes: Record<string, TreeNode> = {
  'n-type': { id: 'n-type', kind: 'type', label: 'Type', hasChildren: true, metadataToken: 0x02000002, description: 'Ns.Type' },
  'n-run': { id: 'n-run', kind: 'method', label: 'Run()', hasChildren: false, metadataToken: 0x06000004, description: 'System.Void Ns.Type::Run()' },
  'n-res': { id: 'n-res', kind: 'resource', label: 'logo.png', hasChildren: false },
}

const statement = (extra: Partial<CodeStatement>): CodeStatement => ({
  startLine: 1, endLine: 1, startColumn: 1, endColumn: 2, ilOffset: 0, ilEndOffset: 1, sequencePointIlOffset: 0,
  modulePath: '/app/App.dll', metadataToken: 0x06000004, sourceMethodToken: 0x06000004, description: '', isHidden: false, ...extra,
})

const commands = (): SearchPaneCommands => ({
  openNode: vi.fn(async (nodeId: string) => ({ documentId: nodeId, viewId: `view-${nodeId}` })),
  getNode: vi.fn(async (nodeId: string) => nodes[nodeId]),
  analyze: vi.fn(),
  copyText: vi.fn(),
  openUrl: vi.fn(),
  addClassBreakpoint: vi.fn(),
  addClassTracepoint: vi.fn(),
  addMethodBreakpoints: vi.fn(),
})

// The list's rows — not the options of the two boxes above it.
const rows = (): HTMLElement[] => within(screen.getByRole('listbox', { name: 'Search results' })).getAllByRole('option')

const option = (name: string): HTMLElement => {
  const found = rows().find((item) => item.textContent?.startsWith(name))
  if (!found)
    throw new Error(`No result ${name}.`)
  return found
}

const search = vi.fn(async () => ({ results: [], truncated: false }))
const cancelSearch = vi.fn(async () => undefined)

beforeEach(() => {
  Object.assign(window.dnSpy, { search, cancelSearch })
  search.mockClear()
  saveAppOptions(defaultAppOptions)
  useAppStore.setState({ workspaceId: 'ws', documents: {} })
  useSearchStore.setState({ query: 'x', results, searching: false, tooManyResults: false, requestKey: undefined, focusRequested: false })
})

afterEach(() => {
  cleanup()
  useSearchStore.setState({ query: '', results: [], searching: false, tooManyResults: false })
  localStorage.clear()
})

describe('SearchPane', () => {
  it('lists the results by name, each with its location, the way dnSpy\'s list does', () => {
    render(<SearchPane commands={commands()} />)
    expect(rows().map((item) => item.querySelector('.result-name')?.textContent)).toEqual(['libc', 'logo.png', 'Type', 'void Run()'])
    expect(option('void Run()').querySelector('.result-location')).toHaveTextContent('Ns.Type')
    // A result the backend colored is written in its colors, its location too.
    expect(option('Type').querySelector('.result-name .tc-type')).toHaveTextContent('Type')
    expect(option('Type').querySelector('.result-location .tc-namespace')).toHaveTextContent('Ns')
  })

  it('writes the results plain with syntax highlighting off', () => {
    render(<SearchPane commands={commands()} />)
    act(() => saveAppOptions({ ...loadAppOptions(), search: { ...loadAppOptions().search, syntaxHighlight: false } }))
    expect(option('Type').querySelector('.tc-type')).toBeNull()
    expect(option('Type').querySelector('.result-name')).toHaveTextContent('Type')
  })

  it('puts "Searching..." above the results while it runs, and the limit message when it stopped there', () => {
    useSearchStore.setState({ searching: true })
    const { rerender } = render(<SearchPane commands={commands()} />)
    const list = screen.getByRole('listbox', { name: 'Search results' })
    expect(list.firstElementChild).toHaveTextContent('Searching...')
    act(() => useSearchStore.setState({ searching: false, tooManyResults: true }))
    rerender(<SearchPane commands={commands()} />)
    expect(list.firstElementChild).toHaveTextContent('Search aborted, more than 10,000 results found.')
    expect(list).toHaveClass('too-many')
  })

  it('follows a result on a double click, into a tab of its own with Shift, and onto the statement a body match is in', async () => {
    const pane = commands()
    const revealCaret = vi.fn()
    useAppStore.setState({
      revealCaret,
      documents: { 'n-run': { text: 'line one\n  return;\n', spans: [], codeStatements: [statement({ startLine: 2, startColumn: 3, ilOffset: 4, sequencePointIlOffset: 4, ilEndOffset: 8 })] } as never },
    })
    render(<SearchPane commands={pane} />)
    fireEvent.doubleClick(option('Type'), { shiftKey: true })
    expect(pane.openNode).toHaveBeenLastCalledWith('n-type', true)
    fireEvent.doubleClick(option('void Run()'))
    expect(pane.openNode).toHaveBeenLastCalledWith('n-run', false)
    await vi.waitFor(() => expect(revealCaret).toHaveBeenCalledWith('n-run', 2, 3, 'view-n-run'))
    // A module reference has no node to go to.
    fireEvent.doubleClick(option('libc'))
    expect(pane.openNode).toHaveBeenCalledTimes(2)
  })

  it('moves through the results with the keyboard and follows one with Enter', () => {
    const pane = commands()
    render(<SearchPane commands={pane} />)
    const list = screen.getByRole('listbox', { name: 'Search results' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(option('logo.png')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'End' })
    expect(option('void Run()')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'Enter', ctrlKey: true })
    expect(pane.openNode).toHaveBeenCalledWith('n-run', true)
  })

  it('analyzes the selected result with Ctrl+Shift+R, and keeps the key from the window\'s own binding', async () => {
    const pane = commands()
    const windowKeys = vi.fn()
    window.addEventListener('keydown', windowKeys)
    try {
      render(<SearchPane commands={pane} />)
      fireEvent.mouseDown(option('void Run()'), { button: 0 })
      fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search results' }), { key: 'R', ctrlKey: true, shiftKey: true })
      await vi.waitFor(() => expect(pane.analyze).toHaveBeenCalledWith(nodes['n-run']))
      expect(windowKeys).not.toHaveBeenCalled()

      // A result that is not a member has nothing to analyze.
      fireEvent.mouseDown(option('logo.png'), { button: 0 })
      fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search results' }), { key: 'R', ctrlKey: true, shiftKey: true })
      await vi.waitFor(() => expect(pane.getNode).toHaveBeenLastCalledWith('n-res'))
      expect(pane.analyze).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeys)
    }
  })

  it('picks what to search for and where with Ctrl and a letter, and hands the text box the focus', () => {
    render(<SearchPane commands={commands()} />)
    const input = screen.getByRole('textbox', { name: 'Search assemblies' })
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Search results' }), { key: 't', ctrlKey: true })
    expect(loadAppOptions().search.searchType).toBe('type')
    expect(screen.getByRole('combobox', { name: 'Search For:' })).toHaveAttribute('data-value', 'type')
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'l', ctrlKey: true })
    expect(loadAppOptions().search.searchType).toBe('literal')
    fireEvent.keyDown(input, { key: 'q', ctrlKey: true })
    expect(loadAppOptions().search.location).toBe('selectedType')
    expect(screen.getByRole('combobox', { name: 'Search location' })).toHaveValue('selectedType')
    // Each change searches again.
    expect(search).toHaveBeenCalledTimes(3)
  })

  it('lists what to search for with each entry\'s image, and the Ctrl key that picks it as its tooltip', () => {
    render(<SearchPane commands={commands()} />)
    // The options a test before left behind reach the window only through a subscriber.
    act(() => saveAppOptions(defaultAppOptions))
    const box = screen.getByRole('combobox', { name: 'Search For:' })
    expect(box).toHaveAttribute('data-value', 'any')
    expect(box).toHaveTextContent('All of the Above')
    expect(box).toHaveAttribute('title', 'Ctrl+B')
    fireEvent.click(box)
    const list = screen.getByRole('listbox', { name: 'Search For:' })
    const entries = within(list).getAllByRole('option')
    expect(entries).toHaveLength(24)
    expect(entries[3]).toHaveTextContent('Type')
    expect(entries[3]).toHaveAttribute('title', 'Ctrl+T')
    expect(entries[0]).not.toHaveAttribute('title')
    expect(entries.every((entry) => entry.querySelector('.search-type-icon'))).toBe(true)
    expect(entries[22]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(entries[19])
    expect(loadAppOptions().search.searchType).toBe('struct')
    expect(screen.queryByRole('listbox', { name: 'Search For:' })).toBeNull()
    // Closed, the arrow keys step through the entries; Alt+Down opens the list, Enter takes the entry under the cursor.
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(loadAppOptions().search.searchType).toBe('delegate')
    fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true })
    fireEvent.keyDown(box, { key: 'ArrowUp' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(loadAppOptions().search.searchType).toBe('struct')
    fireEvent.keyDown(box, { key: 'F4' })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Search For:' })).toBeNull()
    expect(loadAppOptions().search.searchType).toBe('struct')
  })

  it('shows a result\'s tooltip once the mouse rests on it, in its colors, and hides it when the mouse leaves', () => {
    vi.useFakeTimers()
    try {
      useSearchStore.setState({ results: [{ ...results[0], toolTip: 'void Ns.Type.Run()\nIL_0006: ldc.i4 42\n/app/App.dll',
        toolTipParts: [{ text: 'void', color: 'keyword' }, { text: ' Ns.Type.Run()\n', color: 'text' }, { text: 'IL_0006', color: 'label' }, { text: ': ', color: 'punctuation' }, { text: 'ldc.i4', color: 'opCode' }, { text: ' 42\n/app/App.dll', color: 'text' }] }] })
      render(<SearchPane commands={commands()} />)
      fireEvent.mouseEnter(option('void Run()'), { clientX: 10, clientY: 10 })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => vi.advanceTimersByTime(400))
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent('void Ns.Type.Run() IL_0006: ldc.i4 42 /app/App.dll', { normalizeWhitespace: true })
      expect(tip.querySelector('.tc-opCode')).toHaveTextContent('ldc.i4')
      fireEvent.mouseLeave(option('void Run()'))
      expect(screen.queryByRole('tooltip')).toBeNull()
      // With the syntax highlighting off the tooltip is plain, as the rows are.
      act(() => saveAppOptions({ ...loadAppOptions(), search: { ...loadAppOptions().search, syntaxHighlight: false } }))
      fireEvent.mouseEnter(option('void Run()'), { clientX: 10, clientY: 10 })
      act(() => vi.advanceTimersByTime(400))
      expect(screen.getByRole('tooltip').querySelector('.tc-opCode')).toBeNull()
      // A click hides it.
      fireEvent.mouseDown(option('void Run()'), { button: 0 })
      expect(screen.queryByRole('tooltip')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the selection on its result when the list is written again through another language', () => {
    render(<SearchPane commands={commands()} />)
    fireEvent.mouseDown(option('void Run()'), { button: 0 })
    act(() => useSearchStore.setState({ results: [{ ...results[0], name: 'Sub Run()' }, ...results.slice(1)] }))
    expect(option('Sub Run()')).toHaveAttribute('aria-selected', 'true')
    // A new search starts with nothing selected.
    act(() => useSearchStore.setState((state) => ({ results: [...results], generation: state.generation + 1 })))
    expect(rows().filter((row) => row.getAttribute('aria-selected') === 'true')).toEqual([])
  })

  it('shows dnSpy\'s six options under the expander, each switching its setting', () => {
    render(<SearchPane commands={commands()} />)
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    const group = screen.getByRole('group', { name: 'Options' })
    expect(within(group).getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
      'Match Whole Words', 'Case Sensitive Search', 'Match Any Search Term',
      'Decompile Resources (eg. XAML)', 'Search in framework assemblies', 'Search compiler generated members',
    ])
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Case Sensitive Search' }))
    expect(loadAppOptions().search.caseSensitive).toBe(true)
    expect(search).toHaveBeenLastCalledWith('ws', expect.objectContaining({ caseSensitive: true }), expect.any(String))
  })

  it('takes the focus with its text selected when the shell asks it to', () => {
    render(<SearchPane commands={commands()} />)
    act(() => useSearchStore.getState().requestFocus())
    const input = screen.getByRole('textbox', { name: 'Search assemblies' })
    expect(input).toHaveFocus()
    expect((input as HTMLInputElement).selectionEnd).toBe(1)
    expect(useSearchStore.getState().focusRequested).toBe(false)
  })
})

describe('buildSearchMenuItems', () => {
  const context = (index: number, extra: Partial<SearchMenuContext> = {}): SearchMenuContext => {
    const pane = commands()
    const result = [results[1], results[0], results[2], results[3]][index]
    return {
      t: (message) => message,
      result,
      node: result.nodeId ? nodes[result.nodeId] : undefined,
      settings: { ...defaultAppOptions.search, caseSensitive: true },
      setOption: vi.fn(),
      open: vi.fn(),
      copyText: pane.copyText,
      openUrl: pane.openUrl,
      analyze: pane.analyze,
      addClassBreakpoint: pane.addClassBreakpoint,
      addClassTracepoint: pane.addClassTracepoint,
      addMethodBreakpoints: pane.addMethodBreakpoints,
      ...extra,
    }
  }
  const keys = (ctx: SearchMenuContext): string[] => buildSearchMenuItems(ctx).map((item) => 'type' in item ? '|' : item.key)
  const run = (ctx: SearchMenuContext, key: string): void => {
    const item = buildSearchMenuItems(ctx).find((entry) => !('type' in entry) && entry.key === key)
    if (!item || 'type' in item)
      throw new Error(`No ${key} entry.`)
    item.onSelect?.(item)
  }
  const options = ['syntax-highlight', 'match-whole-words', 'case-sensitive', 'match-any', 'decompile-resources', 'framework-assemblies', 'compiler-generated']

  it('lays a member\'s menu out the way dnSpy\'s search list does', () => {
    expect(keys(context(1))).toEqual([
      'go-to-reference', 'open-in-new-tab', '|',
      'copy-md-token', 'copy-full-name', '|',
      'add-method-breakpoint', '|',
      'analyze', 'search-msdn', '|',
      ...options,
    ])
    expect(keys(context(0))).toEqual(expect.arrayContaining(['add-class-breakpoint', 'add-class-tracepoint']))
    expect(keys(context(0))).not.toContain('add-method-breakpoint')
    expect(keys(context(1))).not.toContain('add-class-tracepoint')
  })

  it('keeps to following a result and the options for one whose node it could not read, or that is no member', () => {
    expect(keys(context(1, { node: undefined }))).toEqual(['go-to-reference', 'open-in-new-tab', '|', ...options])
    expect(keys(context(2))).toEqual(['go-to-reference', 'open-in-new-tab', '|', ...options])
  })

  it('runs its entries against the result', () => {
    const ctx = context(1)
    run(ctx, 'open-in-new-tab')
    expect(ctx.open).toHaveBeenCalledWith(true)
    run(ctx, 'copy-md-token')
    expect(ctx.copyText).toHaveBeenCalledWith('0x06000004')
    run(ctx, 'copy-full-name')
    expect(ctx.copyText).toHaveBeenCalledWith('System.Void Ns.Type::Run()')
    run(ctx, 'add-method-breakpoint')
    expect(ctx.addMethodBreakpoints).toHaveBeenCalledWith([nodes['n-run']])
    run(ctx, 'analyze')
    expect(ctx.analyze).toHaveBeenCalledWith(nodes['n-run'])
    run(ctx, 'search-msdn')
    expect(ctx.openUrl).toHaveBeenCalledWith(expect.stringContaining('Ns.Type'))
  })

  it('checks the options that are on and switches the one picked', () => {
    const ctx = context(1)
    const checked = buildSearchMenuItems(ctx)
      .filter((item) => !('type' in item) && options.includes(item.key))
      .map((item) => !('type' in item) && render(<>{item.content}</>).container.querySelector('.document-tab-menu-icon svg') !== null)
    // On by default: the syntax highlighting, resources, framework assemblies and compiler generated members.
    expect(checked).toEqual([true, false, true, false, true, true, true])
    run(ctx, 'case-sensitive')
    expect(ctx.setOption).toHaveBeenCalledWith('caseSensitive', false)
    run(ctx, 'match-whole-words')
    expect(ctx.setOption).toHaveBeenCalledWith('matchWholeWords', true)
  })
})
