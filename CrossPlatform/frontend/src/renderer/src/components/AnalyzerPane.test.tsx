import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzerNode } from '../../../shared/protocol'
import { useAnalyzerStore } from '../analyzer-store'
import { useAppStore } from '../app-store'
import { AnalyzerPane, type AnalyzerPaneCommands } from './AnalyzerPane'
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
    act(() => saveAppOptions({ ...loadAppOptions(), analyzer: { showToken: false, singleClickExpandsChildren: true } }))
    expect(screen.getAllByRole('treeitem')[0].textContent).toBe('NS.Type.Callee() : void')
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

    act(() => saveAppOptions({ ...loadAppOptions(), analyzer: { showToken: true, singleClickExpandsChildren: false } }))
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

  it('copies the selected rows indented by level', () => {
    const pane = commands()
    render(<AnalyzerPane commands={pane} />)
    fireEvent.mouseDown(rowNamed('NS.Type.Callee'), { button: 0 })
    fireEvent.mouseDown(rowNamed('NS.Type.Caller'), { button: 0, ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'c', ctrlKey: true })
    expect(pane.copyText).toHaveBeenCalledWith('NS.Type.Callee() : void @06000001\n\t\tNS.Type.Caller() : void @06000002\n')
  })
})
