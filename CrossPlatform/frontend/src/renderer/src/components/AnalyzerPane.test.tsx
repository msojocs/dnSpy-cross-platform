import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzerNode } from '../../../shared/protocol'
import { useAnalyzerStore } from '../analyzer-store'
import { useAppStore } from '../app-store'
import { AnalyzerPane, visibleLineRange, type AnalyzerPaneCommands } from './AnalyzerPane'
import { loadAppOptions, resetAppOptions, saveAppOptions } from './app-options'

const node = (extra: Partial<AnalyzerNode>): AnalyzerNode => ({
  kind: 'method',
  label: 'NS.Type.M() : void',
  hasChildren: true,
  isSetter: false,
  hidesParent: false,
  isPublic: true,
  ...extra,
})

const source = { methodNodeId: 'caller', modulePath: '/app/A.dll', methodToken: 0x06000002, ilOffset: 1, targets: [{ nodeId: 'callee' }] }

const commands = (): AnalyzerPaneCommands => ({
  openNode: vi.fn(async (nodeId: string) => ({ documentId: nodeId, viewId: `doc:${nodeId}` })),
  copyText: vi.fn(),
  openUrl: vi.fn(),
})

// Two analyzed members: the first opened onto its two searches, the first search onto what it found.
const seed = (): void => {
  useAnalyzerStore.setState({
    rootKeys: ['root1', 'root2'],
    rows: {
      root1: { key: 'root1', node: node({ nodeId: 'callee', label: 'NS.Type.Callee() : void', metadataToken: 0x06000001 }) },
      root2: { key: 'root2', node: node({ nodeId: 'other', label: 'NS.Type.Other() : void', metadataToken: 0x06000003 }) },
      uses: { key: 'uses', parentKey: 'root1', node: node({ kind: 'search', label: 'Uses', search: 'uses', nodeId: 'callee', icon: 'search' }) },
      usedBy: { key: 'usedBy', parentKey: 'root1', node: node({ kind: 'search', label: 'Used By', search: 'usedBy', nodeId: 'callee', icon: 'search' }) },
      hit: { key: 'hit', parentKey: 'usedBy', node: node({ nodeId: 'caller', label: 'NS.Type.Caller() : void', metadataToken: 0x06000002, source }) },
    },
    children: {
      root1: { status: 'loaded', keys: ['uses', 'usedBy'], truncated: false },
      usedBy: { status: 'loaded', keys: ['hit'], truncated: false },
    },
    expanded: { root1: true, usedBy: true },
    selection: [],
    anchorKey: undefined,
    focusKey: undefined,
  })
}

const rowNamed = (name: string): HTMLElement => {
  const row = screen.getAllByRole('treeitem').find((item) => item.textContent?.startsWith(name))
  if (!row)
    throw new Error(`No row ${name}.`)
  return row
}

beforeEach(() => {
  localStorage.clear()
  Object.assign(window.dnSpy, {
    analyzeChildren: vi.fn(async () => ({ children: [], truncated: false })),
    cancelAnalyze: vi.fn(async () => undefined),
  })
  useAppStore.setState({ workspaceId: 'ws', documents: {} })
  seed()
})

afterEach(() => {
  // The options go back while the pane still listens: the snapshot it reads is shared with later tests.
  act(() => saveAppOptions(resetAppOptions()))
  cleanup()
  useAnalyzerStore.getState().clear()
})

describe('AnalyzerPane', () => {
  it('draws the roots in order and every level under them sorted, with tokens', () => {
    render(<AnalyzerPane commands={commands()} />)
    expect(screen.getAllByRole('treeitem').map((item) => item.textContent)).toEqual([
      'NS.Type.Callee() : void @06000001',
      'Used By',
      'NS.Type.Caller() : void @06000002',
      'Uses',
      'NS.Type.Other() : void @06000003',
    ])
  })

  it('leaves the tokens off when the option is off', () => {
    render(<AnalyzerPane commands={commands()} />)
    act(() => saveAppOptions({ ...loadAppOptions(), analyzer: { showToken: false, syntaxHighlight: true, singleClickExpandsChildren: true } }))
    expect(screen.getAllByRole('treeitem')[0].textContent).toBe('NS.Type.Callee() : void')
  })

  it('writes a row the backend colored in its colors, until syntax highlighting is turned off', () => {
    useAnalyzerStore.setState((state) => ({
      rows: {
        ...state.rows,
        root2: { key: 'root2', node: node({ nodeId: 'other', label: 'NS.Type.Other() : void', metadataToken: 0x06000003, hidesParent: true, labelParts: [
          { text: 'NS', color: 'namespace' }, { text: '.', color: 'operator' }, { text: 'Type', color: 'type' }, { text: '.', color: 'operator' },
          { text: 'Other', color: 'instanceMethod' }, { text: '()', color: 'punctuation' }, { text: ' ', color: 'text' }, { text: ':', color: 'punctuation' },
          { text: ' ', color: 'text' }, { text: 'void', color: 'keyword' },
        ] }) },
      },
    }))
    render(<AnalyzerPane commands={commands()} />)
    const label = rowNamed('(hides) NS.Type.Other').querySelector('.tree-label')!
    expect(label.textContent).toBe('(hides) NS.Type.Other() : void @06000003')
    expect([...label.querySelectorAll('span')].map((span) => [span.textContent, span.className])).toEqual([
      ['(', 'tc-punctuation'], ['hides', 'tc-text'], [')', 'tc-punctuation'], [' ', 'tc-text'],
      ['NS', 'tc-namespace'], ['.', 'tc-operator'], ['Type', 'tc-type'], ['.', 'tc-operator'], ['Other', 'tc-instanceMethod'], ['()', 'tc-punctuation'],
      [' ', 'tc-text'], [':', 'tc-punctuation'], [' ', 'tc-text'], ['void', 'tc-keyword'],
      [' ', 'tc-text'], ['@', 'tc-operator'], ['06000003', 'tc-number'],
    ])
    // A row it sent no colors for stays plain text.
    expect(rowNamed('Used By').querySelector('.tree-label span')).toBeNull()

    act(() => saveAppOptions({ ...loadAppOptions(), analyzer: { showToken: true, syntaxHighlight: false, singleClickExpandsChildren: true } }))
    expect(rowNamed('(hides) NS.Type.Other').querySelector('.tree-label span')).toBeNull()
    expect(rowNamed('(hides) NS.Type.Other').textContent).toBe('(hides) NS.Type.Other() : void @06000003')
  })

  it('goes to where a result was found on a double click, in a new tab with Shift', async () => {
    const pane = commands()
    useAppStore.setState({
      documents: {
        caller: {
          nodeId: 'caller', title: 'Caller', language: 'csharp', text: 'void Caller() {\n  Callee();\n}', diagnostics: [], loading: false, requestedLanguage: 'cSharp',
          spans: [{ start: 18, length: 6, kind: 'reference', targetNodeId: 'callee' }],
          codeStatements: [{ startLine: 2, endLine: 2, startColumn: 3, endColumn: 12, ilOffset: 0, ilEndOffset: 6, sequencePointIlOffset: 0, modulePath: '/app/A.dll', metadataToken: 0x06000002, sourceMethodToken: 0x06000002, description: '', isHidden: false }],
        },
      },
    })
    render(<AnalyzerPane commands={pane} />)

    fireEvent.doubleClick(rowNamed('NS.Type.Caller'), { shiftKey: true })

    await vi.waitFor(() => expect(useAppStore.getState().caretReveal).toMatchObject({ documentId: 'caller', viewId: 'doc:caller', line: 2, column: 3 }))
    expect(pane.openNode).toHaveBeenCalledWith('caller', true)
  })

  it('goes to the member itself for a row that was not found in a body', () => {
    const pane = commands()
    render(<AnalyzerPane commands={pane} />)
    fireEvent.doubleClick(rowNamed('NS.Type.Other'))
    expect(pane.openNode).toHaveBeenCalledWith('other', false)
  })

  it('opens and closes a row with a single click while that option is on, and only with the expander when it is off', () => {
    render(<AnalyzerPane commands={commands()} />)
    fireEvent.click(rowNamed('Used By'), { detail: 1 })
    expect(useAnalyzerStore.getState().expanded.usedBy).toBe(false)

    act(() => saveAppOptions({ ...loadAppOptions(), analyzer: { showToken: true, syntaxHighlight: true, singleClickExpandsChildren: false } }))
    fireEvent.click(rowNamed('NS.Type.Callee'), { detail: 1 })
    expect(useAnalyzerStore.getState().expanded.root1).toBe(true)
  })

  it('moves through the rows with the arrow keys and opens and closes them with left and right', () => {
    render(<AnalyzerPane commands={commands()} />)
    const tree = screen.getByRole('tree')
    fireEvent.mouseDown(rowNamed('NS.Type.Callee'), { button: 0 })
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    expect(useAnalyzerStore.getState().selection).toEqual(['usedBy'])
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(useAnalyzerStore.getState().expanded.usedBy).toBe(false)
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(useAnalyzerStore.getState().selection).toEqual(['root1'])
    fireEvent.keyDown(tree, { key: 'End' })
    expect(useAnalyzerStore.getState().selection).toEqual(['root2'])
  })

  it('removes the selected roots with Delete, and nothing when a selected row is not one', () => {
    render(<AnalyzerPane commands={commands()} />)
    const tree = screen.getByRole('tree')
    fireEvent.mouseDown(rowNamed('Used By'), { button: 0 })
    fireEvent.keyDown(tree, { key: 'Delete' })
    expect(useAnalyzerStore.getState().rootKeys).toEqual(['root1', 'root2'])

    fireEvent.mouseDown(rowNamed('NS.Type.Other'), { button: 0 })
    fireEvent.keyDown(tree, { key: 'Delete' })
    expect(useAnalyzerStore.getState().rootKeys).toEqual(['root1'])
  })

  it('keeps Delete from reaching the window, where it would delete the tree\'s selection', () => {
    const windowKeys = vi.fn()
    window.addEventListener('keydown', windowKeys)
    try {
      render(<AnalyzerPane commands={commands()} />)
      fireEvent.mouseDown(rowNamed('Used By'), { button: 0 })
      fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
      expect(windowKeys).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeys)
    }
  })

  it('draws only the rows in sight of a long list, and keeps the height of the rest for the scroll bar', () => {
    const hits = Array.from({ length: 1000 }, (_, index) => `hit${String(index).padStart(4, '0')}`)
    useAnalyzerStore.setState((state) => ({
      rows: { ...state.rows, ...Object.fromEntries(hits.map((key) => [key, { key, parentKey: 'usedBy', node: node({ nodeId: key, label: `NS.Found.${key}() : void` }) }])) },
      children: { ...state.children, usedBy: { status: 'loaded', keys: hits, truncated: false } },
    }))
    const { container } = render(<AnalyzerPane commands={commands()} />)
    const tree = screen.getByRole('tree')
    // The two roots, the two searches and the thousand rows found in place of the one the seed has.
    const total = 1004
    const drawn = (): string[] => screen.getAllByRole('treeitem').map((item) => item.textContent ?? '')
    expect(drawn().length).toBeLessThan(60)
    expect(drawn()[0]).toBe('NS.Type.Callee() : void @06000001')
    const spacers = (): number[] => [...container.querySelectorAll<HTMLElement>('.analyzer-spacer')].map((spacer) => Number.parseInt(spacer.style.height, 10))
    expect(spacers()).toEqual([(total - drawn().length) * 22])

    // Scrolled down, the window moves with it; what is above it is kept as height too.
    Object.defineProperty(tree, 'scrollTop', { configurable: true, value: 22 * 500 })
    Object.defineProperty(tree, 'clientHeight', { configurable: true, value: 22 * 10 })
    fireEvent.scroll(tree)
    expect(drawn()[0]).toBe('NS.Found.hit0478() : void')
    expect(drawn()).toHaveLength(50)
    expect(spacers()).toEqual([480 * 22, (total - 530) * 22])
  })

  it('works out the lines a window draws, with a margin either side', () => {
    expect(visibleLineRange(1000, 0, 220)).toEqual({ first: 0, last: 30 })
    expect(visibleLineRange(1000, 2200, 220)).toEqual({ first: 80, last: 130 })
    expect(visibleLineRange(10, 0, 220)).toEqual({ first: 0, last: 10 })
    // A window not measured yet is taken to be a usual size rather than none at all.
    expect(visibleLineRange(1000, 0, 0).last).toBeGreaterThan(40)
  })

  it('copies the selected rows indented by level', () => {
    const pane = commands()
    render(<AnalyzerPane commands={pane} />)
    fireEvent.mouseDown(rowNamed('NS.Type.Callee'), { button: 0 })
    fireEvent.mouseDown(rowNamed('NS.Type.Caller'), { button: 0, ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'c', ctrlKey: true })
    expect(pane.copyText).toHaveBeenCalledWith('NS.Type.Callee() : void @06000001\n\t\tNS.Type.Caller() : void @06000002\n')
  })

  it('analyzes the row selected first with Ctrl+Shift+R, as dnSpy reads the first of its selection', async () => {
    const analyze = vi.spyOn(useAnalyzerStore.getState(), 'analyze').mockResolvedValue(undefined)
    render(<AnalyzerPane commands={commands()} />)
    fireEvent.mouseDown(rowNamed('NS.Type.Caller'), { button: 0 })
    fireEvent.mouseDown(rowNamed('NS.Type.Other'), { button: 0, ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'R', ctrlKey: true, shiftKey: true })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1))
    expect(analyze).toHaveBeenCalledWith('caller')

    // A search row names nothing to analyze.
    analyze.mockClear()
    fireEvent.mouseDown(rowNamed('Used By'), { button: 0 })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'R', ctrlKey: true, shiftKey: true })
    await Promise.resolve()
    expect(analyze).not.toHaveBeenCalled()
  })
})
