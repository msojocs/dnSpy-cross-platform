import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import type { AnalyzerSource } from '../../../shared/protocol'
import { analyzerCopyText, composeAnalyzerParts, composeAnalyzerText, findReferenceCaret, flattenAnalyzerTree, type AnalyzerLine, type AnalyzerRow } from '../analyzer-model'
import { useAnalyzerStore } from '../analyzer-store'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { loadAppOptions, saveAppOptions, useAppOptions } from './app-options'
import { iconFamily, NodeIcon } from './AssemblyExplorer'
import { ColoredText } from './ColoredText'
import { showAnalyzerContextMenu, type AnalyzerMenuContext } from './AnalyzerContextMenu'

/** What the analyzer needs from the shell, which owns the document tabs and the clipboard. */
export interface AnalyzerPaneCommands {
  /** Opens a node's document — in a tab of its own when asked to — and names the document and the tab. */
  openNode(nodeId: string, newTab: boolean): Promise<{ documentId: string; viewId: string } | undefined>
  copyText(text: string): void
  openUrl(url: string): void
  /** Breaks on every method of the type a node names — dnSpy's Add Class Breakpoint. */
  addClassBreakpoint?(nodeId: string): void
  /** The same as tracepoints, once their settings are asked for — dnSpy's Add Class Tracepoint. */
  addClassTracepoint?(nodeId: string): void
  /** Breaks on the methods the nodes name, a property's or an event's accessors for one of those. */
  addMethodBreakpoints?(nodeIds: string[]): void
}

interface RowProps {
  line: Extract<AnalyzerLine, { kind: 'row' }>
  selected: boolean
  focused: boolean
  expanded: boolean
  loading: boolean
  /** The settings the row's text is written with, which the line's own text was composed with too. */
  showToken: boolean
  syntaxHighlight: boolean
  onMouseDown(line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void
  onClick(line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void
  onDoubleClick(line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void
  onToggle(key: string): void
  onContextMenu(line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent<HTMLElement>): void
}

const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${6 + depth * 16}px` })

// The tree draws only the lines in sight, and a margin of them on either side: a search can find tens of
// thousands of rows. Every line is one `.tree-row` high.
const ROW_HEIGHT = 22
const OVERSCAN = 20
// What is drawn before the window has been measured — and in a layout that measures nothing, like jsdom's.
const FALLBACK_HEIGHT = 600

/** The lines to draw, end excluded, for a window scrolled to `top` that is `height` high. */
export const visibleLineRange = (count: number, top: number, height: number): { first: number; last: number } => ({
  first: Math.max(0, Math.min(count, Math.floor(top / ROW_HEIGHT) - OVERSCAN)),
  last: Math.min(count, Math.ceil((top + (height > 0 ? height : FALLBACK_HEIGHT)) / ROW_HEIGHT) + OVERSCAN),
})

const AnalyzerTreeRow = memo(({ line, selected, focused, expanded, loading, showToken, syntaxHighlight, onMouseDown, onClick, onDoubleClick, onToggle, onContextMenu }: RowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const { node } = line.row
  const icon = node.icon ?? 'item'
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      data-kind={node.kind}
      data-row-key={line.key}
      style={indent(line.depth)}
      role="treeitem"
      aria-level={line.depth + 1}
      aria-expanded={node.hasChildren ? expanded : undefined}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      title={node.fullName ?? line.text}
      onMouseDown={(event) => onMouseDown(line, event)}
      onClick={(event) => onClick(line, event)}
      onDoubleClick={(event) => onDoubleClick(line, event)}
      onContextMenu={(event) => onContextMenu(line, event)}
    >
      <button
        className="tree-expander"
        aria-label={expanded ? t('Collapse') : t('Expand')}
        disabled={!node.hasChildren}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(line.key)
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {loading ? <LoaderCircle className="spin" size={13} /> : node.hasChildren ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      <span className={`tree-icon kind-${node.kind} icon-${iconFamily(icon)}`}><NodeIcon icon={icon} expanded={expanded} /></span>
      {/* A row the backend sent no colors for — a search's header — is plain text in dnSpy too. */}
      <span className="tree-label">{syntaxHighlight && node.labelParts ? <ColoredText parts={composeAnalyzerParts(node, t, showToken)} /> : line.text}</span>
    </div>
  )
})

/**
 * dnSpy's Analyzer window: one root per analyzed member, each opening into the searches dnSpy offers for
 * it, each search into what it found — members that can be analyzed further in turn. Double-clicking a
 * result goes to where it was found, in the method that uses the member; a result found nowhere in a body
 * goes to its own definition.
 */
export const AnalyzerPane = ({ commands }: { commands: AnalyzerPaneCommands }): React.JSX.Element => {
  const rootKeys = useAnalyzerStore((state) => state.rootKeys)
  const rows = useAnalyzerStore((state) => state.rows)
  const children = useAnalyzerStore((state) => state.children)
  const expanded = useAnalyzerStore((state) => state.expanded)
  const selection = useAnalyzerStore((state) => state.selection)
  const anchorKey = useAnalyzerStore((state) => state.anchorKey)
  const focusKey = useAnalyzerStore((state) => state.focusKey)
  const focusToken = useAnalyzerStore((state) => state.focusToken)
  const settings = useAppOptions().analyzer
  // `t` keeps one identity across languages, so the locale is what says the search rows need new words.
  const { t, locale } = useLanguage()
  const treeRef = useRef<HTMLDivElement>(null)
  // Set when the keyboard moved the focus row, so the row is given the DOM focus once it is drawn.
  const moveFocusRef = useRef(false)
  // The row to give the DOM focus to once it is drawn, which for one outside the window means scrolling first.
  const pendingFocusRef = useRef<string | undefined>(undefined)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  const lines = useMemo(
    () => flattenAnalyzerTree({ rootKeys, rows, children, expanded }, (node) => composeAnalyzerText(node, t, settings.showToken)),
    [rootKeys, rows, children, expanded, t, locale, settings.showToken],
  )
  const rowLines = useMemo(() => lines.filter((line): line is Extract<AnalyzerLine, { kind: 'row' }> => line.kind === 'row'), [lines])
  const selected = useMemo(() => new Set(selection), [selection])
  // The tab stop: the focus row while it is in the tree, the first row otherwise.
  const tabStop = rowLines.some((line) => line.key === focusKey) ? focusKey : rowLines[0]?.key
  const { first, last } = visibleLineRange(lines.length, viewport.top, viewport.height)
  const tabStopIndex = lines.findIndex((line) => line.key === tabStop)
  const tabStopDrawn = tabStopIndex >= first && tabStopIndex < last

  const measure = useCallback((): void => {
    const element = treeRef.current
    if (element)
      setViewport((current) => current.top === element.scrollTop && current.height === element.clientHeight
        ? current
        : { top: element.scrollTop, height: element.clientHeight })
  }, [])

  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !treeRef.current)
      return
    const observer = new ResizeObserver(measure)
    observer.observe(treeRef.current)
    return () => observer.disconnect()
  }, [measure])

  /**
   * Gives the DOM focus to the row asked for once it is drawn. A row outside the drawn lines is scrolled to
   * first, which draws it on the next pass, and that pass finishes the job.
   */
  const flushPendingFocus = (): void => {
    const key = pendingFocusRef.current
    const element = treeRef.current
    if (!key || !element)
      return
    const drawn = element.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
    if (drawn) {
      pendingFocusRef.current = undefined
      drawn.focus()
      return
    }
    const index = lines.findIndex((line) => line.key === key)
    const top = index * ROW_HEIGHT
    if (index >= 0)
      element.scrollTop = top < element.scrollTop ? top : Math.max(top + ROW_HEIGHT - element.clientHeight, 0)
    // A tree that cannot scroll there — one that is not on screen — leaves the row be.
    const range = visibleLineRange(lines.length, element.scrollTop, element.clientHeight)
    if (index < range.first || index >= range.last) {
      pendingFocusRef.current = undefined
      return
    }
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  }

  // Analyze hands the window the focus, as dnSpy's AnalyzerService.Add does.
  useLayoutEffect(() => {
    if (focusToken > 0)
      pendingFocusRef.current = useAnalyzerStore.getState().focusKey
  }, [focusToken])

  useLayoutEffect(() => {
    if (moveFocusRef.current) {
      moveFocusRef.current = false
      pendingFocusRef.current = focusKey
    }
  }, [focusKey, lines])

  // Runs after the two above in every pass, so what they ask for is done in the pass that asked.
  useLayoutEffect(flushPendingFocus)

  const store = useAnalyzerStore.getState

  const setShowToken = (value: boolean): void => {
    const options = loadAppOptions()
    saveAppOptions({ ...options, analyzer: { ...options.analyzer, showToken: value } })
  }

  const setSyntaxHighlight = (value: boolean): void => {
    const options = loadAppOptions()
    saveAppOptions({ ...options, analyzer: { ...options.analyzer, syntaxHighlight: value } })
  }

  const setSingleClickExpandsChildren = (value: boolean): void => {
    const options = loadAppOptions()
    saveAppOptions({ ...options, analyzer: { ...options.analyzer, singleClickExpandsChildren: value } })
  }

  /** dnSpy's "Show Reference in Method": the method that uses the member, with the caret on the use. */
  const showReference = async (source: AnalyzerSource, newTab: boolean): Promise<void> => {
    const opened = await commandsRef.current.openNode(source.methodNodeId, newTab)
    if (!opened)
      return
    const appStore = useAppStore.getState()
    const document = appStore.documents[opened.documentId]
    const caret = document && findReferenceCaret(document, source)
    if (caret)
      appStore.revealCaret(opened.documentId, caret.line, caret.column, opened.viewId)
  }

  /**
   * dnSpy's FollowNode. `useCodeRef` picks "Show Reference in Method" over "Go to Reference"; activating a
   * row — a double click, Enter — picks the first for a row found in a body and the second for any other.
   */
  const follow = (row: AnalyzerRow, newTab: boolean, useCodeRef?: boolean): void => {
    const { node } = row
    if (node.kind === 'search')
      return
    if (useCodeRef ?? !!node.source) {
      if (node.source)
        void showReference(node.source, newTab)
    } else if (node.nodeId)
      void commandsRef.current.openNode(node.nodeId, newTab)
  }

  const analyze = (targets: AnalyzerRow[]): void => {
    void (async () => {
      for (const row of targets) {
        if (row.node.nodeId)
          await store().analyze(row.node.nodeId)
      }
    })()
  }

  const selectedRows = (): AnalyzerRow[] => {
    const current = new Set(store().selection)
    return rowLines.filter((line) => current.has(line.key)).map((line) => line.row)
  }

  const copySelection = (): void => {
    const text = analyzerCopyText(lines, new Set(store().selection))
    if (text)
      commandsRef.current.copyText(text)
  }

  const isRoot = (key: string): boolean => store().rootKeys.includes(key)

  const menuContext = (): AnalyzerMenuContext => ({
    t,
    selection: selectedRows(),
    isRoot,
    showToken: settings.showToken,
    syntaxHighlight: settings.syntaxHighlight,
    singleClickExpandsChildren: settings.singleClickExpandsChildren,
    follow,
    copySelection,
    copyText: (text) => commandsRef.current.copyText(text),
    openUrl: (url) => commandsRef.current.openUrl(url),
    analyze,
    removeRoots: (targets) => store().removeRoots(targets.map((row) => row.key)),
    setShowToken,
    setSyntaxHighlight,
    setSingleClickExpandsChildren,
    addClassBreakpoint: commandsRef.current.addClassBreakpoint
      ? (row) => { if (row.node.nodeId) commandsRef.current.addClassBreakpoint?.(row.node.nodeId) }
      : undefined,
    addClassTracepoint: commandsRef.current.addClassTracepoint
      ? (row) => { if (row.node.nodeId) commandsRef.current.addClassTracepoint?.(row.node.nodeId) }
      : undefined,
    addMethodBreakpoints: commandsRef.current.addMethodBreakpoints
      ? (targets) => commandsRef.current.addMethodBreakpoints?.(targets.flatMap((row) => row.node.nodeId ? [row.node.nodeId] : []))
      : undefined,
  })

  /** Selects the rows between the anchor and `key`, both included, in the order the tree shows them. */
  const rangeTo = (key: string): string[] => {
    const anchor = rowLines.findIndex((line) => line.key === (store().anchorKey ?? key))
    const target = rowLines.findIndex((line) => line.key === key)
    if (anchor < 0 || target < 0)
      return [key]
    const [from, to] = anchor <= target ? [anchor, target] : [target, anchor]
    return rowLines.slice(from, to + 1).map((line) => line.key)
  }

  const onRowMouseDown = (line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void => {
    if (event.button === 2) {
      // A right click keeps a selection it lands in, the way a tree's context menu acts on what is selected.
      if (!store().selection.includes(line.key))
        store().select([line.key], { anchorKey: line.key, focusKey: line.key })
      return
    }
    if (event.button !== 0)
      return
    if (event.shiftKey)
      store().select(rangeTo(line.key), { focusKey: line.key })
    else if (event.ctrlKey || event.metaKey) {
      const current = store().selection
      store().select(current.includes(line.key) ? current.filter((key) => key !== line.key) : [...current, line.key], { anchorKey: line.key, focusKey: line.key })
    } else
      store().select([line.key], { anchorKey: line.key, focusKey: line.key })
  }

  const onRowClick = (line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void => {
    // The first click of a double click only; the second one activates.
    if (event.detail === 1 && settings.singleClickExpandsChildren && line.row.node.hasChildren && !event.shiftKey && !event.ctrlKey && !event.metaKey)
      store().toggle(line.key)
  }

  const onRowDoubleClick = (line: Extract<AnalyzerLine, { kind: 'row' }>, event: React.MouseEvent): void => {
    if (line.row.node.kind === 'search') {
      // A search row is not something to go to: a double click opens or closes it — unless the first click
      // already did, which it does when a single click expands.
      if (!settings.singleClickExpandsChildren)
        store().toggle(line.key)
      return
    }
    follow(line.row, event.ctrlKey || event.shiftKey)
  }

  const onRowContextMenu = (line: Extract<AnalyzerLine, { kind: 'row' }> | undefined, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (line && !store().selection.includes(line.key))
      store().select([line.key], { anchorKey: line.key, focusKey: line.key })
    showAnalyzerContextMenu(menuContext(), { x: event.clientX, y: event.clientY }, event.currentTarget)
  }

  const moveTo = (key: string | undefined, extend: boolean): void => {
    if (!key)
      return
    moveFocusRef.current = true
    if (extend)
      store().select(rangeTo(key), { focusKey: key })
    else
      store().select([key], { anchorKey: key, focusKey: key })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The keys the analyzer answers stay in it: the window-level bindings would act on the assembly
    // tree's selection instead — Delete and F2 would delete or rename the node selected there.
    if (handleKey(event) || event.key === 'Delete' || event.key === 'F2')
      event.stopPropagation()
  }

  /** Runs the analyzer's own binding for a key, and says whether there was one. */
  const handleKey = (event: React.KeyboardEvent): boolean => {
    const focusIndex = rowLines.findIndex((line) => line.key === (store().focusKey ?? anchorKey))
    const current = focusIndex >= 0 ? rowLines[focusIndex] : undefined
    const key = event.key
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.shiftKey && key.toLowerCase() === 'r') {
      // Ctrl+Shift+R analyzes the row selected first, as dnSpy's binding reads TopLevelSelection[0]; with none
      // it can analyze, it brings the window forward, which is where the focus already is. The shell's own
      // binding stays out of it.
      event.preventDefault()
      const first = store().rows[store().selection[0]]
      if (first?.node.nodeId && ['type', 'method', 'field', 'property', 'event'].includes(first.node.kind))
        analyze([first])
      return true
    }
    if (ctrl && key.toLowerCase() === 'c') {
      event.preventDefault()
      copySelection()
      return true
    }
    if (ctrl && key.toLowerCase() === 'a') {
      event.preventDefault()
      store().select(rowLines.map((line) => line.key))
      return true
    }
    switch (key) {
      case 'ArrowDown':
        event.preventDefault()
        moveTo(rowLines[Math.min(focusIndex + 1, rowLines.length - 1)]?.key, event.shiftKey)
        return true
      case 'ArrowUp':
        event.preventDefault()
        moveTo(rowLines[Math.max(focusIndex - 1, 0)]?.key, event.shiftKey)
        return true
      case 'Home':
        event.preventDefault()
        moveTo(rowLines[0]?.key, event.shiftKey)
        return true
      case 'End':
        event.preventDefault()
        moveTo(rowLines[rowLines.length - 1]?.key, event.shiftKey)
        return true
      case 'ArrowRight':
        if (!current)
          return false
        event.preventDefault()
        if (current.row.node.hasChildren && !store().expanded[current.key])
          void store().expand(current.key)
        else if (rowLines[focusIndex + 1]?.depth === current.depth + 1)
          moveTo(rowLines[focusIndex + 1].key, false)
        return true
      case 'ArrowLeft':
        if (!current)
          return false
        event.preventDefault()
        if (store().expanded[current.key])
          store().collapse(current.key)
        else if (current.row.parentKey)
          moveTo(current.row.parentKey, false)
        return true
      case 'Enter':
        if (!current)
          return false
        event.preventDefault()
        if (current.row.node.kind === 'search')
          store().toggle(current.key)
        else
          follow(current.row, ctrl || event.shiftKey)
        return true
      case 'Delete': {
        const chosen = store().selection
        if (chosen.length > 0 && chosen.every(isRoot)) {
          event.preventDefault()
          moveFocusRef.current = true
          store().removeRoots(chosen)
        }
        return true
      }
    }
    return false
  }

  // The rows are memoized, so the handlers they get keep one identity and read the newest ones through a ref.
  const handlersRef = useRef({ onRowMouseDown, onRowClick, onRowDoubleClick, onRowContextMenu })
  handlersRef.current = { onRowMouseDown, onRowClick, onRowDoubleClick, onRowContextMenu }
  const rowMouseDown = useCallback<RowProps['onMouseDown']>((line, event) => handlersRef.current.onRowMouseDown(line, event), [])
  const rowClick = useCallback<RowProps['onClick']>((line, event) => handlersRef.current.onRowClick(line, event), [])
  const rowDoubleClick = useCallback<RowProps['onDoubleClick']>((line, event) => handlersRef.current.onRowDoubleClick(line, event), [])
  const rowContextMenu = useCallback<RowProps['onContextMenu']>((line, event) => handlersRef.current.onRowContextMenu(line, event), [])
  const rowToggle = useCallback((key: string) => useAnalyzerStore.getState().toggle(key), [])

  return (
    <div
      ref={treeRef}
      className="assembly-tree analyzer-tree"
      role="tree"
      aria-label={t('Analyzer')}
      aria-multiselectable
      // The tab stop row may be scrolled out of the drawn lines; the tree takes Tab for it then.
      tabIndex={tabStop && !tabStopDrawn ? 0 : undefined}
      onFocus={(event) => {
        if (event.target === event.currentTarget && tabStop && !tabStopDrawn) {
          pendingFocusRef.current = tabStop
          flushPendingFocus()
        }
      }}
      onScroll={measure}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => onRowContextMenu(undefined, event)}
    >
      {first > 0 && <div className="analyzer-spacer" role="none" style={{ height: first * ROW_HEIGHT }} />}
      {lines.slice(first, last).map((line) => line.kind === 'searching' ? (
        <div key={line.key} className="tree-row analyzer-searching" style={indent(line.depth)} role="treeitem" aria-level={line.depth + 1}>
          <span className="tree-expander" />
          <span className="tree-icon icon-search"><Search size={15} strokeWidth={1.6} aria-hidden /></span>
          <span className="tree-label">{t('Searching...')}</span>
        </div>
      ) : (
        <AnalyzerTreeRow
          key={line.key}
          line={line}
          selected={selected.has(line.key)}
          focused={line.key === tabStop}
          expanded={expanded[line.key] ?? false}
          loading={children[line.key]?.status === 'loading'}
          showToken={settings.showToken}
          syntaxHighlight={settings.syntaxHighlight}
          onMouseDown={rowMouseDown}
          onClick={rowClick}
          onDoubleClick={rowDoubleClick}
          onToggle={rowToggle}
          onContextMenu={rowContextMenu}
        />
      ))}
      {last < lines.length && <div className="analyzer-spacer" role="none" style={{ height: (lines.length - last) * ROW_HEIGHT }} />}
    </div>
  )
}
