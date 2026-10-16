import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { SearchLocation, SearchResult, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { MAX_SEARCH_RESULTS, SEARCH_LOCATIONS, SEARCH_TYPES, findSearchResultCaret, searchResultOrder } from '../search-model'
import { updateSearchSettings, useSearchStore } from '../search-store'
import { useAppOptions, type SearchSettings } from './app-options'
import { NodeIcon } from './AssemblyExplorer'
import { isAnalyzableNode } from './CodeEditorContextMenu'
import { ColoredText } from './ColoredText'
import { showSearchContextMenu } from './SearchContextMenu'
import { SearchResultToolTip, SearchTypeBox, useHoverToolTip } from './SearchPaneParts'

/** What the search window needs from the shell, which owns the document tabs, the analyzer and the debugger. */
export interface SearchPaneCommands {
  /** Opens a result's node — in a tab of its own when asked to — and names the tab the document landed in. */
  openNode(nodeId: string, newTab: boolean): Promise<{ documentId: string; viewId: string } | undefined>
  /** The tree node a result names, which the commands that need its kind, token or full name read. */
  getNode(nodeId: string): Promise<TreeNode | undefined>
  analyze(node: TreeNode): void
  copyText(text: string): void
  openUrl(url: string): void
  addClassBreakpoint?(node: TreeNode): void
  addClassTracepoint?(node: TreeNode): void
  addMethodBreakpoints?(nodes: TreeNode[]): void
}

/** The six check boxes under the expander, in dnSpy's order. */
export const SEARCH_OPTIONS: readonly { key: keyof SearchSettings; label: string }[] = [
  { key: 'matchWholeWords', label: 'Match Whole Words' },
  { key: 'caseSensitive', label: 'Case Sensitive Search' },
  { key: 'matchAnySearchTerm', label: 'Match Any Search Term' },
  { key: 'searchDecompiledData', label: 'Decompile Resources (eg. XAML)' },
  { key: 'searchFrameworkAssemblies', label: 'Search in framework assemblies' },
  { key: 'searchCompilerGeneratedMembers', label: 'Search compiler generated members' },
]

// The list draws only the rows in sight and a margin of them either side: a search lists up to ten thousand.
const ROW_HEIGHT = 22
const OVERSCAN = 20
// What is drawn before the list has been measured — and in a layout that measures nothing, like jsdom's.
const FALLBACK_HEIGHT = 600

/** One line of the list: a result, or one of the two messages dnSpy puts above them. */
type SearchLine =
  | { kind: 'result'; result: SearchResult; index: number; foundIndex: number }
  | { kind: 'message'; key: 'searching' | 'aborted'; text: string }

/**
 * dnSpy's search window: a query, the "Search For" and location boxes and the options under the expander,
 * searched for as the user types; and the list of what was found, sorted by name. A result is followed with a
 * double click or Enter — into a tab of its own with Ctrl or Shift — and a match in a method body puts the
 * caret on the statement it was found in. Ctrl and a letter picks the kind of thing to search for or where.
 */
export const SearchPane = ({ commands }: { commands: SearchPaneCommands }): React.JSX.Element => {
  const query = useSearchStore((state) => state.query)
  const found = useSearchStore((state) => state.results)
  const searching = useSearchStore((state) => state.searching)
  const tooManyResults = useSearchStore((state) => state.tooManyResults)
  const focusRequested = useSearchStore((state) => state.focusRequested)
  const generation = useSearchStore((state) => state.generation)
  const workspaceId = useAppStore((state) => state.workspaceId)
  const settings = useAppOptions().search
  const { t, locale } = useLanguage()
  const [expanded, setExpanded] = useState(false)
  // The selection is the position of a result among those found: writing the list again through another
  // language replaces the results, not the rows.
  const [selection, setSelection] = useState<{ generation: number; foundIndex: number }>()
  const toolTip = useHoverToolTip<number>()
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  const order = useMemo(() => searchResultOrder(found), [found])
  const results = useMemo(() => order.map((index) => found[index]), [order, found])
  const lines = useMemo((): SearchLine[] => {
    const messages: SearchLine[] = []
    if (searching)
      messages.push({ kind: 'message', key: 'searching', text: t('Searching...') })
    if (tooManyResults)
      messages.push({ kind: 'message', key: 'aborted', text: t('Search aborted, more than {count} results found.', { count: MAX_SEARCH_RESULTS.toLocaleString(locale) }) })
    return [...messages, ...results.map((result, index): SearchLine => ({ kind: 'result', result, index, foundIndex: order[index] }))]
  }, [results, order, searching, tooManyResults, t, locale])
  // A new search starts with nothing selected; a batch arriving keeps the selection where it is.
  const selectedFound = selection?.generation === generation && selection.foundIndex < found.length ? selection.foundIndex : undefined
  const selected = selectedFound === undefined ? undefined : found[selectedFound]
  const selectedIndex = selectedFound === undefined ? -1 : order.indexOf(selectedFound)
  const setSelected = (foundIndex: number | undefined): void =>
    setSelection(foundIndex === undefined ? undefined : { generation: useSearchStore.getState().generation, foundIndex })
  // A list started over has nothing under the mouse to explain.
  const hideToolTip = toolTip.hide
  useEffect(() => hideToolTip(), [generation, hideToolTip])

  const first = Math.max(0, Math.min(lines.length, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN))
  const last = Math.min(lines.length, Math.ceil((viewport.top + (viewport.height > 0 ? viewport.height : FALLBACK_HEIGHT)) / ROW_HEIGHT) + OVERSCAN)
  const messageCount = lines.length - results.length

  const measure = useCallback((): void => {
    const element = listRef.current
    if (element)
      setViewport((current) => current.top === element.scrollTop && current.height === element.clientHeight
        ? current
        : { top: element.scrollTop, height: element.clientHeight })
  }, [])

  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !listRef.current)
      return
    const observer = new ResizeObserver(measure)
    observer.observe(listRef.current)
    return () => observer.disconnect()
  }, [measure])

  // Ctrl+Shift+K and the toolbar's Search hand the window the focus, its text selected. The request can come
  // before the layout has brought the window's tab to the front, so it waits a few frames for it to show.
  useLayoutEffect(() => {
    if (!focusRequested)
      return
    let frame = 0
    let handle: number | undefined
    const attempt = (): void => {
      const input = inputRef.current
      const shown = input && (typeof input.checkVisibility !== 'function' || input.checkVisibility())
      if (input && shown) {
        input.select()
        input.focus()
        useSearchStore.getState().focusHandled()
      } else if (++frame < 30)
        handle = requestAnimationFrame(attempt)
      else
        useSearchStore.getState().focusHandled()
    }
    attempt()
    return () => {
      if (handle !== undefined)
        cancelAnimationFrame(handle)
    }
  }, [focusRequested])

  const focusInput = (): void => {
    const input = inputRef.current
    if (!input)
      return
    // dnSpy selects the text only when the focus comes from elsewhere.
    if (document.activeElement !== input)
      input.select()
    input.focus()
  }

  /** dnSpy's FollowResult: the result's node, and for a match in a body the statement it was found in. */
  const open = (result: SearchResult | undefined, newTab: boolean): void => {
    const nodeId = result?.nodeId
    if (!nodeId)
      return
    void (async () => {
      const opened = await commandsRef.current.openNode(nodeId, newTab)
      if (!opened || result.ilOffset == null)
        return
      const node = await commandsRef.current.getNode(nodeId)
      const appStore = useAppStore.getState()
      const decompiled = appStore.documents[opened.documentId]
      const caret = decompiled && node?.metadataToken != null && findSearchResultCaret(decompiled, node.metadataToken, result.ilOffset)
      if (caret)
        appStore.revealCaret(opened.documentId, caret.line, caret.column, opened.viewId)
    })()
  }

  const analyze = (result: SearchResult | undefined): void => {
    const nodeId = result?.nodeId
    if (!nodeId)
      return
    void (async () => {
      const node = await commandsRef.current.getNode(nodeId)
      if (isAnalyzableNode(node))
        commandsRef.current.analyze(node)
    })()
  }

  /** Selects a result and, from the keyboard, scrolls it into sight and gives it the focus. */
  const select = (index: number, focus: boolean): void => {
    if (!results[index])
      return
    setSelected(order[index])
    if (!focus)
      return
    const element = listRef.current
    if (!element)
      return
    const top = (index + messageCount) * ROW_HEIGHT
    if (top < element.scrollTop)
      element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(top + ROW_HEIGHT - element.clientHeight, 0)
    measure()
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus())
  }

  const openMenu = (result: SearchResult, foundIndex: number, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    toolTip.hide()
    setSelected(foundIndex)
    // `currentTarget` is only readable while the event is dispatched, and the menu waits for the node.
    const returnFocusTo = event.currentTarget
    const position = { x: event.clientX, y: event.clientY }
    void (async () => {
      const node = result.nodeId ? await commandsRef.current.getNode(result.nodeId) : undefined
      const current = commandsRef.current
      showSearchContextMenu({
        t,
        result,
        node,
        settings,
        open: (newTab) => open(result, newTab),
        copyText: (text) => current.copyText(text),
        openUrl: (url) => current.openUrl(url),
        analyze: (target) => current.analyze(target),
        addClassBreakpoint: current.addClassBreakpoint,
        addClassTracepoint: current.addClassTracepoint,
        addMethodBreakpoints: current.addMethodBreakpoints,
        setOption: (key, value) => updateSearchSettings({ [key]: value }),
      }, position, returnFocusTo)
    })()
  }

  /** The window's own Ctrl bindings: a letter for each "Search For" entry and each location. */
  const onPaneKeyDown = (event: React.KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey)
      return
    const letter = event.key.toLowerCase()
    const type = SEARCH_TYPES.find((entry) => entry.key === letter)
    const location = SEARCH_LOCATIONS.find((entry) => entry.key === letter)
    if (!type && !location)
      return
    event.preventDefault()
    event.stopPropagation()
    updateSearchSettings(type ? { searchType: type.type } : { location: location!.location })
    focusInput()
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    const ctrl = event.ctrlKey || event.metaKey
    const lastIndex = results.length - 1
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? FALLBACK_HEIGHT) / ROW_HEIGHT) - 1)
    let handled = true
    if (ctrl && event.shiftKey && event.key.toLowerCase() === 'r') {
      // The shell's own binding would analyze the assembly tree's selection instead.
      analyze(selected)
    } else if (lastIndex < 0)
      handled = false
    else if (event.key === 'ArrowDown')
      select(Math.min(selectedIndex + 1, lastIndex), true)
    else if (event.key === 'ArrowUp')
      select(Math.max(selectedIndex - 1, 0), true)
    else if (event.key === 'PageDown')
      select(Math.min(Math.max(selectedIndex, 0) + page, lastIndex), true)
    else if (event.key === 'PageUp')
      select(Math.max(selectedIndex - page, 0), true)
    else if (event.key === 'Home')
      select(0, true)
    else if (event.key === 'End')
      select(lastIndex, true)
    else if (event.key === 'Enter' && selected)
      open(selected, event.shiftKey || ctrl)
    else
      handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const tabStop = selectedIndex >= 0 ? selectedIndex : 0
  return (
    <div className="search-pane" onKeyDown={onPaneKeyDown}>
      <div className="search-controls">
        <input
          ref={inputRef}
          value={query}
          aria-label={t('Search assemblies')}
          disabled={!workspaceId}
          spellCheck={false}
          onChange={(event) => useSearchStore.getState().setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              useSearchStore.getState().restart()
            } else if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault()
              select(Math.max(selectedIndex, 0), true)
            }
          }}
        />
        <button
          className="search-options-toggle"
          aria-expanded={expanded}
          aria-controls="search-options"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          {t('Options')}
        </button>
        <div className="search-for">
          <span>{t('Search For:')}</span>
          <SearchTypeBox value={settings.searchType} label={t('Search For:')} onChange={(searchType) => updateSearchSettings({ searchType })} />
        </div>
        <select
          className="search-location"
          aria-label={t('Search location')}
          value={settings.location}
          onChange={(event) => updateSearchSettings({ location: event.target.value as SearchLocation })}
        >
          {SEARCH_LOCATIONS.map((entry) => <option key={entry.location} value={entry.location}>{t(entry.label)}</option>)}
        </select>
      </div>
      {expanded && (
        <div id="search-options" className="search-options" role="group" aria-label={t('Options')}>
          {SEARCH_OPTIONS.map((option) => (
            <label key={option.key}>
              <input
                type="checkbox"
                checked={settings[option.key] as boolean}
                onChange={(event) => updateSearchSettings({ [option.key]: event.target.checked })}
              />
              {t(option.label)}
            </label>
          ))}
        </div>
      )}
      <div
        ref={listRef}
        className={`result-list search-results${tooManyResults ? ' too-many' : ''}`}
        role="listbox"
        aria-label={t('Search results')}
        aria-busy={searching}
        onKeyDown={onListKeyDown}
        onScroll={() => { toolTip.hide(); measure() }}
      >
        {first > 0 && <div role="none" style={{ height: first * ROW_HEIGHT }} />}
        {lines.slice(first, last).map((line) => line.kind === 'message'
          ? <div key={line.key} className={`search-message search-message-${line.key}`} role="none">{line.text}</div>
          : (
            <div
              key={`${line.result.nodeId ?? line.result.kind}:${line.foundIndex}`}
              className={`result-row search-result${line.foundIndex === selectedFound ? ' selected' : ''}`}
              role="option"
              aria-selected={line.foundIndex === selectedFound}
              tabIndex={line.index === tabStop ? 0 : -1}
              data-index={line.index}
              data-kind={line.result.kind}
              onMouseEnter={(event) => toolTip.enter(line.foundIndex, event)}
              onMouseMove={toolTip.move}
              onMouseLeave={toolTip.hide}
              onMouseDown={(event) => { toolTip.hide(); if (event.button === 0 || event.button === 2) setSelected(line.foundIndex) }}
              onDoubleClick={(event) => open(line.result, event.shiftKey || event.ctrlKey)}
              onContextMenu={(event) => openMenu(line.result, line.foundIndex, event)}
            >
              <span className="result-icon"><NodeIcon icon={line.result.icon ?? undefined} /></span>
              <span className="result-name">{settings.syntaxHighlight && line.result.nameParts ? <ColoredText parts={line.result.nameParts} /> : line.result.name}</span>
              <span className="result-location">
                {line.result.locationIcon && <span className="result-icon"><NodeIcon icon={line.result.locationIcon} /></span>}
                <span className="result-location-text">{settings.syntaxHighlight && line.result.locationParts ? <ColoredText parts={line.result.locationParts} /> : line.result.location}</span>
              </span>
            </div>
          ))}
        {last < lines.length && <div role="none" style={{ height: (lines.length - last) * ROW_HEIGHT }} />}
      </div>
      {toolTip.shown && found[toolTip.shown.target] && (
        <SearchResultToolTip result={found[toolTip.shown.target]} syntaxHighlight={settings.syntaxHighlight} x={toolTip.shown.x} y={toolTip.shown.y} />
      )}
    </div>
  )
}
