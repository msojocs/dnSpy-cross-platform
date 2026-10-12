import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { buildSearchMenuItems, type SearchMenuContext } from './SearchContextMenu'
import { SearchPane, type SearchPaneCommands } from './ToolWindows'

const results: SearchResult[] = [
  { nodeId: 'n-type', kind: 'type', name: 'Ns.Type', location: 'App.dll' },
  { nodeId: 'n-run', kind: 'method', name: 'Run() : void', location: 'Ns.Type' },
  { nodeId: 'n-res', kind: 'resource', name: 'logo.png', location: 'App.dll' },
]

const nodes: Record<string, TreeNode> = {
  'n-type': { id: 'n-type', kind: 'type', label: 'Type', hasChildren: true, metadataToken: 0x02000002, description: 'Ns.Type' },
  'n-run': { id: 'n-run', kind: 'method', label: 'Run()', hasChildren: false, metadataToken: 0x06000004, description: 'System.Void Ns.Type::Run()' },
  'n-res': { id: 'n-res', kind: 'resource', label: 'logo.png', hasChildren: false },
}

const commands = (): SearchPaneCommands => ({
  openNode: vi.fn(),
  getNode: vi.fn(async (nodeId: string) => nodes[nodeId]),
  analyze: vi.fn(),
  copyText: vi.fn(),
  openUrl: vi.fn(),
  addClassBreakpoint: vi.fn(),
  addMethodBreakpoints: vi.fn(),
})

const option = (name: string): HTMLElement => {
  const found = screen.getAllByRole('option').find((item) => item.textContent?.startsWith(name))
  if (!found)
    throw new Error(`No result ${name}.`)
  return found
}

beforeEach(() => {
  useAppStore.setState({ workspaceId: 'ws', searchResults: results })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ searchResults: [] })
})

describe('SearchPane', () => {
  it('follows a result on a double click, and into a tab of its own with Shift', () => {
    const pane = commands()
    render(<SearchPane commands={pane} />)
    fireEvent.doubleClick(option('Run()'))
    expect(pane.openNode).toHaveBeenLastCalledWith('n-run', false)
    fireEvent.doubleClick(option('Ns.Type'), { shiftKey: true })
    expect(pane.openNode).toHaveBeenLastCalledWith('n-type', true)
  })

  it('moves through the results with the keyboard and follows one with Enter', () => {
    const pane = commands()
    render(<SearchPane commands={pane} />)
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(option('Run()')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(pane.openNode).toHaveBeenCalledWith('n-run', false)
  })

  it('analyzes the selected result with Ctrl+Shift+R, and keeps the key from the window\'s own binding', async () => {
    const pane = commands()
    const windowKeys = vi.fn()
    window.addEventListener('keydown', windowKeys)
    try {
      render(<SearchPane commands={pane} />)
      fireEvent.mouseDown(option('Run()'), { button: 0 })
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'R', ctrlKey: true, shiftKey: true })
      await vi.waitFor(() => expect(pane.analyze).toHaveBeenCalledWith(nodes['n-run']))
      expect(windowKeys).not.toHaveBeenCalled()

      // A result that is not a member has nothing to analyze.
      fireEvent.mouseDown(option('logo.png'), { button: 0 })
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'R', ctrlKey: true, shiftKey: true })
      await vi.waitFor(() => expect(pane.getNode).toHaveBeenLastCalledWith('n-res'))
      expect(pane.analyze).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeys)
    }
  })
})

describe('buildSearchMenuItems', () => {
  const context = (index: number, extra: Partial<SearchMenuContext> = {}): SearchMenuContext => {
    const pane = commands()
    return {
      t: (message) => message,
      result: results[index],
      node: nodes[results[index].nodeId],
      open: vi.fn(),
      copyText: pane.copyText,
      openUrl: pane.openUrl,
      analyze: pane.analyze,
      addClassBreakpoint: pane.addClassBreakpoint,
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

  it('lays a member\'s menu out the way dnSpy\'s search list does', () => {
    expect(keys(context(1))).toEqual([
      'go-to-reference', 'open-in-new-tab', '|',
      'copy-md-token', 'copy-full-name', '|',
      'add-method-breakpoint', '|',
      'analyze', 'search-msdn',
    ])
    expect(keys(context(0))).toContain('add-class-breakpoint')
    expect(keys(context(0))).not.toContain('add-method-breakpoint')
  })

  it('keeps to following a result whose node it could not read, or that is no member', () => {
    expect(keys(context(1, { node: undefined }))).toEqual(['go-to-reference', 'open-in-new-tab'])
    expect(keys(context(2))).toEqual(['go-to-reference', 'open-in-new-tab'])
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
})
