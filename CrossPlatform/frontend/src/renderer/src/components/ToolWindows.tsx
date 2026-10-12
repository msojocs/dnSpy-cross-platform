import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { isAnalyzableNode } from './CodeEditorContextMenu'
import { showSearchContextMenu } from './SearchContextMenu'

export const OutputPane = (): React.JSX.Element => {
  const output = useAppStore((state) => state.output)
  return (
    <div className="output-pane" role="log">
      {output.map((line, index) => <div key={`${index}:${line}`}>{line}</div>)}
    </div>
  )
}

/** What the search window needs from the shell, which owns the document tabs, the analyzer and the debugger. */
export interface SearchPaneCommands {
  /** Opens a result's node — in a tab of its own when asked to. */
  openNode(nodeId: string, newTab: boolean): void
  /** The tree node a result names, which the commands that need its kind, token or full name read. */
  getNode(nodeId: string): Promise<TreeNode | undefined>
  analyze(node: TreeNode): void
  copyText(text: string): void
  openUrl(url: string): void
  addClassBreakpoint?(node: TreeNode): void
  addMethodBreakpoints?(nodes: TreeNode[]): void
}

/**
 * dnSpy's search window: a query, and the members it matched. A result is followed with a double click or
 * Enter — into a tab of its own with Shift — and its context menu and Ctrl+Shift+R hand it to the analyzer,
 * the way dnSpy's search list does.
 */
export const SearchPane = ({ commands }: { commands: SearchPaneCommands }): React.JSX.Element => {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number>()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const results = useAppStore((state) => state.searchResults)
  const runSearch = useAppStore((state) => state.runSearch)
  const { t } = useLanguage()
  const listRef = useRef<HTMLDivElement>(null)
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  // A new list starts with nothing selected.
  useEffect(() => setSelected(undefined), [results])

  const submit = (): void => {
    if (workspaceId)
      void runSearch(query)
  }

  const open = (index: number, newTab: boolean): void => {
    const result = results[index]
    if (result)
      commandsRef.current.openNode(result.nodeId, newTab)
  }

  const analyze = (index: number): void => {
    const result = results[index]
    if (!result)
      return
    void (async () => {
      const node = await commandsRef.current.getNode(result.nodeId)
      if (isAnalyzableNode(node))
        commandsRef.current.analyze(node)
    })()
  }

  const select = (index: number, focus: boolean): void => {
    setSelected(index)
    if (focus)
      listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus()
  }

  const openMenu = (index: number, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const result = results[index]
    if (!result)
      return
    setSelected(index)
    // `currentTarget` is only readable while the event is dispatched, and the menu waits for the node.
    const returnFocusTo = event.currentTarget
    const position = { x: event.clientX, y: event.clientY }
    void (async () => {
      const node = await commandsRef.current.getNode(result.nodeId)
      const current = commandsRef.current
      showSearchContextMenu({
        t,
        result,
        node,
        open: (newTab) => current.openNode(result.nodeId, newTab),
        copyText: (text) => current.copyText(text),
        openUrl: (url) => current.openUrl(url),
        analyze: (target) => current.analyze(target),
        addClassBreakpoint: current.addClassBreakpoint,
        addMethodBreakpoints: current.addMethodBreakpoints,
      }, position, returnFocusTo)
    })()
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    const ctrl = event.ctrlKey || event.metaKey
    const last = results.length - 1
    if (last < 0)
      return
    const current = selected ?? -1
    let handled = true
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'r') {
      // The shell's own binding would analyze the assembly tree's selection instead.
      if (selected !== undefined)
        analyze(selected)
    } else if (event.key === 'ArrowDown')
      select(Math.min(current + 1, last), true)
    else if (event.key === 'ArrowUp')
      select(Math.max(current - 1, 0), true)
    else if (event.key === 'Home')
      select(0, true)
    else if (event.key === 'End')
      select(last, true)
    else if (event.key === 'Enter' && selected !== undefined)
      open(selected, event.shiftKey || ctrl)
    else
      handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return (
    <div className="tool-pane search-pane">
      <div className="search-controls">
        <input
          value={query}
          placeholder={t('Search assemblies')}
          aria-label={t('Search assemblies')}
          disabled={!workspaceId}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
        />
        <button className="icon-button" title={t('Search')} aria-label={t('Search')} disabled={!workspaceId || !query.trim()} onClick={submit}>
          <Search size={15} />
        </button>
      </div>
      <div ref={listRef} className="result-list" role="listbox" aria-label={t('Search results')} onKeyDown={onListKeyDown}>
        {results.map((result, index) => (
          <div
            key={`${result.nodeId}:${index}`}
            className={`result-row search-result${index === selected ? ' selected' : ''}`}
            role="option"
            aria-selected={index === selected}
            tabIndex={index === (selected ?? 0) ? 0 : -1}
            data-index={index}
            onMouseDown={(event) => { if (event.button === 0 || event.button === 2) setSelected(index) }}
            onDoubleClick={(event) => open(index, event.shiftKey || event.ctrlKey)}
            onContextMenu={(event) => openMenu(index, event)}
          >
            <span className="result-name">{result.name}</span>
            <span className="result-location">{result.location}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const DebugPlaceholder = ({ label }: { label: string }): React.JSX.Element => (
  <div className="pane-empty">{label}</div>
)
