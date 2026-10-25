import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { DebugModule, DebugStackFrame, DebugThread } from '../../../shared/protocol'
import { debugProcessesOf, frameCodeLocation, lineBreakpointsAtLocation, useAppStore, type DebugSessionEntry, type ModuleBreakpoint } from '../app-store'
import { moduleBreakpointsXml, parseModuleBreakpointsXml } from '../module-breakpoints-io'
import { useLanguage } from '../localization'
import { SearchMatcher } from '../tool-window-search'
import { loadAppOptions, saveAppOptions, useAppOptions, type CallStackSettings, type DebuggerOptions } from './app-options'
import { ColoredText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'

export { LocalsPane, WatchPane, AutosPane, StaticFieldsPane } from './DebugVariablesWindows'
export { BreakpointsPane } from './BreakpointsWindow'

type Translate = (message: string, values?: Record<string, string | number>) => string

/** One entry of a debugger window's context menu, in the item styles the other popup menus use. */
interface MenuItem {
  key: string
  label: string
  run(): void
  icon?: string
  checked?: boolean
  shortcut?: string
  disabled?: boolean
}

/** Shows a context menu of entries and dividers (`null`), the way dnSpy's MenuService draws one. */
export const showDebugMenu = (title: string, entries: (MenuItem | null)[], position: { x: number; y: number }): void => {
  const items: PopupMenuEntry[] = []
  entries.forEach((entry, index) => {
    if (!entry) {
      if (items.length > 0 && items[items.length - 1].type !== 'divider')
        items.push({ type: 'divider', key: `divider-${index}` })
      return
    }
    items.push({
      key: entry.key,
      content: (
        <>
          <span className="document-tab-menu-icon">{entry.checked !== undefined ? <MenuEntryIcon checked={entry.checked} name={entry.checked ? undefined : entry.icon} /> : <MenuEntryIcon name={entry.icon} />}</span>
          <span className="document-tab-menu-label">{entry.label}</span>
          {entry.shortcut && <span className="document-tab-menu-shortcut">{entry.shortcut}</span>}
        </>
      ),
      disabled: entry.disabled,
      onSelect: () => entry.run(),
    })
  })
  showPopupMenu({ anchor: position, title, items, onClose: () => undefined })
}

const copyText = (text: string): void => {
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

const toggleDebuggerOption = (key: keyof DebuggerOptions): void => {
  const options = loadAppOptions()
  saveAppOptions({ ...options, debugger: { ...options.debugger, [key]: !options.debugger[key] } })
}

const toggleCallStackOption = (key: keyof CallStackSettings): void => {
  const options = loadAppOptions()
  saveAppOptions({ ...options, callStack: { ...options.callStack, [key]: !options.callStack[key] } })
}

/** The hex toggles every debugger window shares: one setting, so flipping it in one flips it in all. */
const hexEntries = (t: Translate, options: DebuggerOptions): MenuItem[] => [
  { key: 'hex', label: t('Hexadecimal Display'), checked: options.useHexadecimal, run: () => toggleDebuggerOption('useHexadecimal') },
  { key: 'digit-separators', label: t('Digit Separators'), checked: options.useDigitSeparators, run: () => toggleDebuggerOption('useDigitSeparators') },
]

const formatNumber = (value: number | null | undefined, hex: boolean, width = 8): string => {
  if (value === null || value === undefined) return ''
  return hex ? `0x${value.toString(16).toUpperCase().padStart(width, '0')}` : value.toString()
}

/** A column of one of the debugger's grid windows (Threads, Modules, Processes). */
interface GridColumn<T> {
  key: string
  header: string
  width: string
  text(row: T): string
  render?(row: T): ReactNode
  /** The column's SearchColumnDefinition: the short option `-x` names it, and the header the help text shows. */
  search?: { shortOption: string; name: string }
  /** GridViewColumnSorter's comparer for the column; text comparison when absent. */
  compare?(a: T, b: T): number
}

const compareColumnText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

/**
 * dnSpy's ListView windows: a header row and a row per item, selected by click, activated by double click or
 * Enter. Like WPF's ListViews they can be sorted by clicking a header, filtered by the search box, and have
 * several rows selected (Shift for a range, Ctrl to toggle); the commands act on every selected row.
 */
const DebugGrid = <T,>({ label, columns, rows, rowKey, selected, onSelect, onActivate, onMenu, rowClass, search, onKeyDown }: {
  label: string
  columns: GridColumn<T>[]
  rows: T[]
  rowKey(row: T): string
  selected: readonly string[]
  onSelect(keys: string[]): void
  onActivate?(row: T, newTab?: boolean): void
  onMenu(rows: T[], position: { x: number; y: number }): void
  rowClass?(row: T): string
  /** The search box above the list, and the text it currently holds. */
  search?: { value: string; onChange(value: string): void; onReset(): void }
  /** F2 and the other window-specific keys; called after the grid's own keys have had their say. */
  onKeyDown?(event: React.KeyboardEvent, selectedRows: T[]): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const searchRef = useRef<HTMLInputElement>(null)
  const [anchor, setAnchor] = useState<string | undefined>(undefined)
  const [sort, setSort] = useState<{ key: string; descending: boolean } | undefined>(undefined)
  const searchColumns = useMemo(() => columns.filter((column) => column.search).map((column) => ({ id: column.key, shortOption: column.search!.shortOption, name: t(column.search!.name) })), [columns, t])
  const matcher = useMemo(() => new SearchMatcher(searchColumns).setSearchText(search?.value ?? ''), [searchColumns, search?.value])
  const visibleRows = useMemo(() => {
    const filtered = searchColumns.length > 0 && search?.value
      ? rows.filter((row) => matcher.isMatchAll(columns.filter((column) => column.search).map((column) => column.text(row))))
      : [...rows]
    const column = sort ? columns.find((candidate) => candidate.key === sort.key) : undefined
    if (!column)
      return filtered
    filtered.sort((a, b) => {
      const result = column.compare ? column.compare(a, b) : compareColumnText(column.text(a), column.text(b))
      return sort!.descending ? -result : result
    })
    return filtered
  }, [rows, columns, sort, matcher, search?.value, searchColumns.length])
  const selectedRows = useMemo(() => visibleRows.filter((row) => selected.includes(rowKey(row))), [visibleRows, selected, rowKey])
  const primary = selectedRows[0]
  const selectRow = (row: T, event: React.MouseEvent | React.KeyboardEvent): void => {
    const key = rowKey(row)
    if (event.shiftKey && anchor !== undefined) {
      const from = visibleRows.findIndex((candidate) => rowKey(candidate) === anchor)
      const to = visibleRows.findIndex((candidate) => rowKey(candidate) === key)
      if (from >= 0 && to >= 0)
        onSelect(visibleRows.slice(Math.min(from, to), Math.max(from, to) + 1).map(rowKey))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      onSelect(selected.includes(key) ? selected.filter((candidate) => candidate !== key) : [...selected, key])
      setAnchor(key)
      return
    }
    onSelect([key])
    setAnchor(key)
  }
  const move = (delta: number, extend: boolean): void => {
    const index = visibleRows.findIndex((row) => rowKey(row) === rowKey(primary ?? visibleRows[0]))
    const targetIndex = Math.max(0, Math.min(visibleRows.length - 1, index < 0 ? 0 : index + delta))
    const target = visibleRows[targetIndex]
    if (!target) return
    if (extend && anchor !== undefined) {
      const from = visibleRows.findIndex((row) => rowKey(row) === anchor)
      onSelect(visibleRows.slice(Math.min(from, targetIndex), Math.max(from, targetIndex) + 1).map(rowKey))
    } else {
      onSelect([rowKey(target)])
      setAnchor(rowKey(target))
    }
  }
  const copySelected = (): void => {
    if (selectedRows.length === 0) return
    copyText(selectedRows.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n'))
  }
  return (
    <div className="debug-grid-window">
      {search && (
        <div className="debug-grid-filter" role="toolbar">
          <label>{t('Search')}</label>
          <input ref={searchRef} aria-label={t('Search')} value={search.value} onChange={(event) => search.onChange(event.target.value)} />
          <button type="button" className="icon-button" title={t('Help')} aria-label={t('Help')} onClick={() => void window.dnSpy.showMessage(matcher.helpText(t))}><DsIcon name="StatusHelp" /></button>
          <button type="button" className="icon-button" title={t('Reset search settings')} aria-label={t('Reset search settings')} onClick={() => { setSort(undefined); search.onReset() }}><DsIcon name="ClearWindowContent" /></button>
        </div>
      )}
      <div
        className="debug-table debug-grid"
        role="grid"
        aria-label={label}
        aria-multiselectable="true"
        tabIndex={0}
        style={{ gridTemplateColumns: columns.map((column) => column.width).join(' ') }}
        onKeyDown={(event) => {
          // A cell input has its own keys: Ctrl+A/Ctrl+C select and copy its text, not the list.
          if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea'))
            return
          if (event.key === 'ArrowDown') move(1, event.shiftKey)
          else if (event.key === 'ArrowUp') move(-1, event.shiftKey)
          else if (event.key === 'Home') move(-visibleRows.length, event.shiftKey)
          else if (event.key === 'End') move(visibleRows.length, event.shiftKey)
          else if (event.key === 'PageDown') move(10, event.shiftKey)
          else if (event.key === 'PageUp') move(-10, event.shiftKey)
          else if (event.key === 'Enter' && primary) onActivate?.(primary, event.ctrlKey || event.shiftKey)
          else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) onSelect(visibleRows.map(rowKey))
          else if (event.ctrlKey && (event.key === 'f' || event.key === 'e') && search) searchRef.current?.focus()
          else if ((event.key === 'c' && (event.ctrlKey || event.metaKey)) || (event.key === 'Insert' && event.ctrlKey)) copySelected()
          else {
            onKeyDown?.(event, selectedRows)
            return
          }
          event.preventDefault()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onMenu(selectedRows, { x: event.clientX, y: event.clientY })
        }}
      >
        {columns.map((column) => (
          <div
            className="debug-table-header"
            role="columnheader"
            key={column.key}
            aria-sort={sort?.key === column.key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
            onClick={() => setSort((current) => current?.key !== column.key ? { key: column.key, descending: false } : current.descending ? undefined : { key: column.key, descending: true })}
          >
            {column.header}
            {sort?.key === column.key && <span className="bookmarks-sort-arrow" aria-hidden>{sort.descending ? '▼' : '▲'}</span>}
          </div>
        ))}
        {visibleRows.map((row) => {
          const key = rowKey(row)
          const isSelected = selected.includes(key)
          return (
            <div
              className={`debug-table-row${isSelected ? ' selected' : ''}${rowClass ? ` ${rowClass(row)}` : ''}`}
              role="row"
              aria-selected={isSelected}
              key={key}
              onMouseDown={(event) => selectRow(row, event)}
              onDoubleClick={() => onActivate?.(row)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                // A right click inside the selection keeps it — that is how a command reaches several rows — and
                // one outside it selects the row it lands on, as WPF's ListView does.
                if (!selected.includes(key))
                  onSelect([key])
                onMenu(isSelected ? selectedRows : [row], { x: event.clientX, y: event.clientY })
              }}
            >
              {columns.map((column) => <span key={column.key} title={column.text(row)}>{column.render ? column.render(row) : column.text(row)}</span>)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The processes being debugged, the current one's from the top-level fields — dnSpy's DbgManager.Processes. */
const useDebugProcesses = (): DebugSessionEntry[] => {
  const state = useAppStore(useShallow((app) => ({
    debugSessionId: app.debugSessionId,
    debugSessions: app.debugSessions,
    debugState: app.debugState,
    debugProcess: app.debugProcess,
    debugModules: app.debugModules,
    debugThreads: app.debugThreads,
    selectedDebugThreadId: app.selectedDebugThreadId,
  })))
  return useMemo(() => {
    const processes = debugProcessesOf(state)
    // A session whose start has not answered yet has no entry; its process is the current one all the same.
    if (processes.length === 0 && state.debugSessionId)
      return [{ sessionId: state.debugSessionId, state: state.debugState === 'stopped' ? 'stopped' : state.debugState === 'starting' ? 'starting' : 'running', process: state.debugProcess, modules: state.debugModules, threads: state.debugThreads, threadId: state.selectedDebugThreadId, shouldDetach: state.debugProcess?.ownsDebuggee === false }]
    return processes
  }, [state])
}

/** SimpleProcessVM's name: the process id, in the window's number format, and the process's name. */
const processLabel = (entry: DebugSessionEntry, hex: boolean): string =>
  entry.process ? `[${formatNumber(entry.process.id, hex)}]${entry.process.name ? ` ${entry.process.name}` : ''}` : entry.sessionId

/**
 * The "Process" combo of dnSpy's Threads and Modules windows: All, or one of the processes being debugged.
 * It is only there when there is more than one process to choose from.
 */
const ProcessFilter = ({ processes, value, onChange, hex }: { processes: DebugSessionEntry[]; value: string; onChange(value: string): void; hex: boolean }): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <div className="debug-process-filter" role="toolbar">
      <label>
        <span>{t('Process')}</span>
        <select aria-label={t('Process')} value={processes.some((entry) => entry.sessionId === value) ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="">{t('All')}</option>
          {processes.map((entry) => <option key={entry.sessionId} value={entry.sessionId}>{processLabel(entry, hex)}</option>)}
        </select>
      </label>
    </div>
  )
}

/** A Threads or Modules window: the grid, under the process combo once there is more than one process. */
const ProcessWindow = ({ processes, filter, onFilter, hex, children }: { processes: DebugSessionEntry[]; filter: string; onFilter(value: string): void; hex: boolean; children: ReactNode }): React.JSX.Element =>
  processes.length > 1
    ? <div className="debug-process-window"><ProcessFilter processes={processes} value={filter} onChange={onFilter} hex={hex} />{children}</div>
    : <>{children}</>

/** The text of a Call Stack row: the name in the formatter's colours, or plain for a frame from an older engine. */
const frameName = (frame: DebugStackFrame): ReactNode =>
  frame.nameParts?.length ? <ColoredText parts={frame.nameParts} /> : frame.name

export const CallStackPane = (): React.JSX.Element => {
  const frames = useAppStore((state) => state.debugFrames)
  const selectedFrameId = useAppStore((state) => state.selectedDebugFrameId)
  const activeFrameId = useAppStore((state) => state.activeDebugFrameId)
  const selectFrame = useAppStore((state) => state.selectDebugFrame)
  const switchToFrame = useAppStore((state) => state.switchToDebugFrame)
  const runToCursor = useAppStore((state) => state.runToCursor)
  const showDisassembly = useAppStore((state) => state.showDisassembly)
  const options = useAppOptions()
  const { t } = useLanguage()
  // WPF's Call Stack list is an extended-selection list: Copy and Select All act on every selected frame,
  // while the frame commands need exactly one.
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const anchorRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (selectedFrameId !== undefined && !selectedIds.includes(selectedFrameId))
      setSelectedIds([selectedFrameId])
  }, [selectedFrameId]) // eslint-disable-line react-hooks/exhaustive-deps
  const selectedFrames = frames.filter((frame) => selectedIds.includes(frame.id))
  const chooseFrame = (frame: DebugStackFrame, event: React.MouseEvent | React.KeyboardEvent): void => {
    if (event.shiftKey && anchorRef.current !== undefined) {
      const from = frames.findIndex((candidate) => candidate.id === anchorRef.current)
      const to = frames.findIndex((candidate) => candidate.id === frame.id)
      if (from >= 0 && to >= 0)
        setSelectedIds(frames.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.id))
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedIds((current) => current.includes(frame.id) ? current.filter((id) => id !== frame.id) : [...current, frame.id])
      anchorRef.current = frame.id
    } else {
      setSelectedIds([frame.id])
      anchorRef.current = frame.id
    }
    anchorRef.current = frame.id
    void selectFrame(frame.id)
  }
  const copyFrames = (rows: DebugStackFrame[]): void => {
    if (rows.length > 0)
      copyText(rows.map((frame) => frame.name).join('\n'))
  }
  const toggleFrameBreakpoint = (frame: DebugStackFrame | undefined, onlyEnabled: boolean): void => {
    const location = frameCodeLocation(frame)
    if (!location) return
    const store = useAppStore.getState()
    const existing = lineBreakpointsAtLocation(store.lineBreakpoints, location)
    if (existing.length === 0) {
      if (!onlyEnabled)
        void store.addLocationBreakpoint(location)
      return
    }
    void store.setBreakpointsEnabled(existing.map((breakpoint) => breakpoint.id), !existing[0].enabled)
  }
  // dnSpy's Breakpoint submenu: Insert Breakpoint and Insert Tracepoint at a frame's location without one, and the
  // commands of the breakpoints already there for one with. The popup menu has no submenus, so its entries come
  // in a group of their own.
  const breakpointEntries = (frame: DebugStackFrame | undefined): MenuItem[] => {
    const store = useAppStore.getState()
    const location = frameCodeLocation(frame)
    if (!location)
      return []
    const existing = lineBreakpointsAtLocation(store.lineBreakpoints, location)
    if (existing.length === 0) {
      return [
        { key: 'insert-breakpoint', label: t('Insert Breakpoint'), icon: 'CheckDot', shortcut: 'F9', run: () => void store.addLocationBreakpoint(location) },
        { key: 'insert-tracepoint', label: t('Insert Tracepoint'), run: () => store.requestLocationTracepoint(location) },
      ]
    }
    const ids = existing.map((breakpoint) => breakpoint.id)
    const enabled = existing[0].enabled
    return [
      { key: 'delete-breakpoint', label: t('Delete Breakpoint'), icon: 'CheckDot', run: () => void store.removeBreakpoints(ids) },
      { key: 'toggle-breakpoint', label: enabled ? t('Disable Breakpoint') : t('Enable Breakpoint'), icon: 'ToggleAllBreakpoints', shortcut: 'Ctrl+F9', run: () => void store.setBreakpointsEnabled(ids, !enabled) },
      { key: 'breakpoint-settings', label: t('Settings...'), icon: 'Settings', run: () => store.editBreakpointSettings(ids) },
      { key: 'export-breakpoint', label: t('Export...'), icon: 'Open', run: () => void store.exportBreakpoints(ids) },
    ]
  }
  const openMenu = (rows: DebugStackFrame[], position: { x: number; y: number }): void => {
    const frame = rows[0]
    const single = rows.length === 1
    const callStack = options.callStack
    const check = (key: keyof CallStackSettings, label: string): MenuItem => ({ key, label, checked: callStack[key], run: () => toggleCallStackOption(key) })
    const top = frames.find((candidate) => !candidate.isInternal)
    showDebugMenu(t('Call Stack'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: rows.length === 0, run: () => copyFrames(rows) },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', disabled: frames.length === 0, run: () => setSelectedIds(frames.map((candidate) => candidate.id)) },
      null,
      { key: 'switch', label: t('Switch To Frame'), shortcut: t('Enter'), disabled: !single || frame.isInternal === true, run: () => { if (single) void switchToFrame(frame.id) } },
      { key: 'go-to-code', label: t('Go To Code'), icon: 'GoToSourceCode', disabled: !single || frame.isInternal === true, run: () => { if (single) void switchToFrame(frame.id) } },
      { key: 'go-to-disassembly', label: t('Go To Disassembly'), icon: 'DisassemblyWindow', disabled: !single || frame.isInternal === true, run: () => { if (single) void showDisassembly({ frameId: frame.id }) } },
      { key: 'run-to-cursor', label: t('Run To Cursor'), icon: 'Cursor', shortcut: 'Ctrl+F10', disabled: !single || frame.isInternal === true || frame.id === top?.id, run: () => { if (single) void runToCursor(frame.id) } },
      // dnSpy has the command and never enables it: CallStackOperations.CanUnwindToFrame is always false.
      { key: 'unwind', label: t('Unwind To This Frame'), disabled: true, run: () => undefined },
      null,
      ...(single ? breakpointEntries(frame) : []),
      null,
      ...hexEntries(t, options.debugger),
      null,
      check('showModuleNames', t('Show Module Names')),
      check('showParameterTypes', t('Show Parameter Types')),
      check('showParameterNames', t('Show Parameter Names')),
      check('showParameterValues', t('Show Parameter Values')),
      check('showFunctionOffset', t('Show Instruction Pointer')),
      check('showDeclaringTypes', t('Show Declaring Types')),
      check('showNamespaces', t('Show Namespaces')),
      check('showReturnTypes', t('Show Return Types')),
      check('showIntrinsicTypeKeywords', t('Show Intrinsic Type Keywords')),
      check('showTokens', t('Show Tokens')),
    ], position)
  }
  return (
    <div
      className={`result-list${options.debugger.syntaxHighlight ? '' : ' debug-plain'}`}
      role="list"
      aria-label={t('Call Stack')}
      aria-multiselectable="true"
      tabIndex={0}
      onKeyDown={(event) => {
        const index = frames.findIndex((frame) => frame.id === selectedFrameId)
        const target = (delta: number): DebugStackFrame | undefined => frames[Math.max(0, Math.min(frames.length - 1, (index < 0 ? 0 : index) + delta))]
        const moveTo = (frame: DebugStackFrame | undefined): void => {
          if (!frame) return
          if (event.shiftKey && anchorRef.current !== undefined) {
            const from = frames.findIndex((candidate) => candidate.id === anchorRef.current)
            const to = frames.findIndex((candidate) => candidate.id === frame.id)
            setSelectedIds(frames.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.id))
          } else {
            setSelectedIds([frame.id])
            anchorRef.current = frame.id
          }
          void selectFrame(frame.id)
        }
        if (event.key === 'ArrowDown') moveTo(target(1))
        else if (event.key === 'ArrowUp') moveTo(target(-1))
        else if (event.key === 'Home') moveTo(frames[0])
        else if (event.key === 'End') moveTo(frames[frames.length - 1])
        else if (event.key === 'PageDown') moveTo(target(10))
        else if (event.key === 'PageUp') moveTo(target(-10))
        else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) setSelectedIds(frames.map((frame) => frame.id))
        else if ((event.key === 'c' && (event.ctrlKey || event.metaKey)) || (event.key === 'Insert' && event.ctrlKey)) copyFrames(selectedFrames)
        else if (event.key === 'Enter' && selectedFrames.length === 1 && !selectedFrames[0].isInternal) void switchToFrame(selectedFrames[0].id)
        else if (event.key === 'F9' && selectedFrames.length === 1) toggleFrameBreakpoint(selectedFrames[0], event.ctrlKey)
        else return
        event.preventDefault()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu(selectedFrames, { x: event.clientX, y: event.clientY })
      }}
    >
      {frames.map((frame, index) => {
        const active = activeFrameId === frame.id
        // WPF's grid has no location column — the frame's name is the whole row — so the file and line
        // stay reachable through the tooltip instead of taking a column of their own.
        const location = `${frame.source?.name ?? frame.source?.path ?? ''}${frame.line > 0 ? `:${frame.line}` : ''}`
        // dnSpy's frame images: the yellow arrow on the frame the thread is in, the green one on the frame the
        // user switched to, and nothing on the rest.
        const image = index === 0 ? 'CurrentInstructionPointer' : active ? 'CallReturnInstructionPointer' : undefined
        return (
          <button
            key={`${frame.id}:${index}`}
            className={`result-row stack-row${selectedIds.includes(frame.id) ? ' selected' : ''}${active ? ' active' : ''}${frame.isInternal ? ' stack-row-internal' : ''}`}
            title={location || frame.description || undefined}
            aria-current={active ? 'true' : undefined}
            aria-selected={selectedIds.includes(frame.id)}
            onClick={(event) => chooseFrame(frame, event)}
            onDoubleClick={() => { if (!frame.isInternal) void switchToFrame(frame.id) }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!selectedIds.includes(frame.id))
                setSelectedIds([frame.id])
              void selectFrame(frame.id)
              openMenu(selectedIds.includes(frame.id) ? selectedFrames : [frame], { x: event.clientX, y: event.clientY })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (!frame.isInternal) void switchToFrame(frame.id, event.ctrlKey || event.shiftKey)
              } else if (event.key === 'F9') {
                event.preventDefault()
                event.stopPropagation()
                toggleFrameBreakpoint(frame, event.ctrlKey)
              }
            }}
          >
            <span className="stack-marker" aria-hidden="true">{image ? <DsIcon name={image} /> : null}</span>
            <span className="result-name">{frameName(frame)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** dnSpy's ThreadCategory images: only the main thread and the unknown/terminated ones have their own. */
const threadCategoryImage = (category?: string): string => {
  switch (category) {
    case 'Main': return 'Thread'
    case 'Unknown': case 'Terminated': return 'QuestionMark'
    case 'GC': case 'Finalizer': case 'ThreadPool': case 'WorkerThread': return 'Process'
    default: return 'Thread'
  }
}

/** DefaultThreadCategoryProvider's display names. */
const threadCategoryText = (category: string | undefined, t: Translate): string => {
  switch (category) {
    case 'Main': return t('Main Thread')
    case 'ThreadPool': return t('Thread Pool')
    case 'WorkerThread': return t('Worker Thread')
    case 'Unknown': return t('Unknown Thread')
    case 'Terminated': return t('Terminated Thread')
    case 'GC': case 'Finalizer': return category
    default: return category ?? ''
  }
}

/**
 * ThreadFormatter.WriteAffinityMask: the CPUs as a string of bits, the leading zeros dropped but the
 * low 16 always shown. The backend reads the mask from /proc as hexadecimal.
 */
export const affinityMaskText = (mask: string | null | undefined): string => {
  if (!mask) return ''
  let value: bigint
  try {
    value = BigInt(`0x${mask.replace(/[^0-9a-fA-F]/g, '')}`)
  } catch {
    return ''
  }
  let started = false
  let text = ''
  for (let bit = 1n << 63n; bit !== 0n; bit >>= 1n) {
    if (!started && bit === 0x8000n)
      started = true
    if ((value & bit) !== 0n) {
      started = true
      text += '1'
    } else if (started) {
      text += '0'
    }
  }
  return text
}

/** A row of the Threads window: a thread, and the process it is in. */
type ThreadRow = DebugThread & { sessionId: string }

export const ThreadsPane = (): React.JSX.Element => {
  const processes = useDebugProcesses()
  const currentSessionId = useAppStore((state) => state.debugSessionId)
  const selectedThreadId = useAppStore((state) => state.selectedDebugThreadId)
  const selectThread = useAppStore((state) => state.selectDebugThread)
  const setCurrentProcess = useAppStore((state) => state.setCurrentDebugSession)
  const freeze = useAppStore((state) => state.freezeDebugThreads)
  const rename = useAppStore((state) => state.renameDebugThread)
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [processFilter, setProcessFilter] = useState('')
  const [renaming, setRenaming] = useState<{ key: string; text: string }>()
  const { t } = useLanguage()
  // dnSpy's Threads window lists the threads of every process, or of the one the Process combo picks.
  const threads: ThreadRow[] = useMemo(() => processes
    .filter((entry) => !processFilter || entry.sessionId === processFilter)
    .flatMap((entry) => entry.threads.map((thread) => ({ ...thread, sessionId: entry.sessionId }))), [processes, processFilter])
  const rowKey = (thread: ThreadRow): string => `${thread.sessionId}:${thread.id}`
  const isCurrent = (thread: ThreadRow): boolean => thread.sessionId === currentSessionId && thread.id === selectedThreadId
  const stopped = (thread: ThreadRow): boolean => processes.find((entry) => entry.sessionId === thread.sessionId)?.state === 'stopped'
  const finishRename = (thread: ThreadRow, text: string): void => {
    void rename(thread.id, text.trim() || null, thread.sessionId)
    setRenaming(undefined)
  }
  // dnSpy's SwitchToThread: a thread of another paused process makes that process the current one first.
  const switchToThread = async (thread: ThreadRow): Promise<void> => {
    if (!stopped(thread)) return
    if (thread.sessionId !== currentSessionId)
      await setCurrentProcess(thread.sessionId)
    await selectThread(thread.id)
  }
  const columns: GridColumn<ThreadRow>[] = useMemo(() => [
    { key: 'marker', header: '', width: '22px', text: () => '', render: (thread) => isCurrent(thread) ? <DsIcon name="CurrentInstructionPointer" /> : thread.isFrozen ? <DsIcon name="Pause" /> : null },
    { key: 'id', header: t('ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.id, hex), search: { shortOption: 'i', name: 'ID' }, compare: (a, b) => (a.id ?? 0) - (b.id ?? 0) },
    { key: 'managed-id', header: t('Managed ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.managedId, hex), search: { shortOption: 'm', name: 'Managed ID' }, compare: (a, b) => (a.managedId ?? 0) - (b.managedId ?? 0) },
    { key: 'category', header: t('Category'), width: 'minmax(80px, auto)', text: (thread) => threadCategoryText(thread.category, t), render: (thread) => <><DsIcon name={threadCategoryImage(thread.category)} className="debug-variable-image" />{threadCategoryText(thread.category, t)}</>, search: { shortOption: 'cat', name: 'Category' } },
    {
      key: 'name',
      header: t('Name'),
      width: 'minmax(100px, 1fr)',
      text: (thread) => thread.name,
      search: { shortOption: 'n', name: 'Name' },
      render: (thread) => renaming?.key === rowKey(thread) ? (
        <input
          className="debug-value-editor"
          autoFocus
          aria-label={t('Name')}
          value={renaming.text}
          onChange={(event) => setRenaming({ key: rowKey(thread), text: event.target.value })}
          onBlur={() => finishRename(thread, renaming.text)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') finishRename(thread, renaming.text)
            else if (event.key === 'Escape') setRenaming(undefined)
          }}
        />
      ) : thread.name,
    },
    { key: 'location', header: t('Location'), width: 'minmax(160px, 2fr)', text: (thread) => thread.location ?? '', search: { shortOption: 'o', name: 'Location' } },
    { key: 'priority', header: t('Priority'), width: 'minmax(60px, auto)', text: (thread) => thread.priority === null || thread.priority === undefined ? '' : String(thread.priority), search: { shortOption: 'pri', name: 'Priority' } },
    { key: 'affinity', header: t('Affinity Mask'), width: 'minmax(80px, auto)', text: (thread) => affinityMaskText(thread.affinityMask), search: { shortOption: 'a', name: 'Affinity Mask' } },
    { key: 'suspended', header: t('Suspended Count'), width: 'minmax(60px, auto)', text: (thread) => String(thread.suspendedCount ?? 0), search: { shortOption: 'sc', name: 'Suspended Count' }, compare: (a, b) => (a.suspendedCount ?? 0) - (b.suspendedCount ?? 0) },
    // ThreadFormatter.WriteProcess: "name (id = 5)", the id in decimal whatever the number format is.
    { key: 'process', header: t('Process Name'), width: 'minmax(80px, auto)', text: (thread) => thread.processName ? `${thread.processName} (id = ${thread.processId ?? 0})` : '', search: { shortOption: 'p', name: 'Process Name' } },
    { key: 'appdomain', header: t('AppDomain'), width: 'minmax(80px, auto)', text: (thread) => thread.appDomainName ?? '', search: { shortOption: 'ad', name: 'AppDomain' } },
    { key: 'state', header: t('State'), width: 'minmax(80px, auto)', text: (thread) => (thread.state ?? []).join(', '), search: { shortOption: 's', name: 'State' } },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, hex, selectedThreadId, currentSessionId, renaming, rename])
  // The rows the search box leaves, in the list's own order: what Select All and Copy act on.
  const visibleThreads = useMemo(() => {
    if (!query)
      return threads
    const matcher = new SearchMatcher(columns.filter((column) => column.search).map((column) => ({ id: column.key, shortOption: column.search!.shortOption, name: t(column.search!.name) }))).setSearchText(query)
    return threads.filter((thread) => matcher.isMatchAll(columns.map((column) => column.text(thread))))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, query, t])
  const freezeRows = (rows: ThreadRow[], value: boolean): void => {
    for (const sessionId of new Set(rows.map((row) => row.sessionId)))
      void freeze(rows.filter((row) => row.sessionId === sessionId).map((row) => row.id), value, sessionId)
  }
  const openMenu = (rows: ThreadRow[], position: { x: number; y: number }): void => {
    const thread = rows[0]
    showDebugMenu(t('Threads'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: rows.length === 0, run: () => copyText(rows.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', disabled: visibleThreads.length === 0, run: () => setSelected(visibleThreads.map(rowKey)) },
      null,
      { key: 'switch', label: t('Switch To Thread'), shortcut: t('Enter'), disabled: rows.length !== 1 || !stopped(thread), run: () => { if (rows.length === 1) void switchToThread(thread) } },
      { key: 'rename', label: t('Rename'), shortcut: 'F2', disabled: rows.length !== 1, run: () => { if (rows.length === 1) setRenaming({ key: rowKey(thread), text: thread.name }) } },
      { key: 'freeze', label: t('Freeze'), disabled: !rows.some((row) => row.isFrozen !== true), run: () => freezeRows(rows.filter((row) => row.isFrozen !== true), true) },
      { key: 'thaw', label: t('Thaw'), disabled: !rows.some((row) => row.isFrozen === true), run: () => freezeRows(rows.filter((row) => row.isFrozen === true), false) },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <ProcessWindow processes={processes} filter={processFilter} onFilter={setProcessFilter} hex={hex}>
      <div className="debug-tool-pane">
        <div className="debug-grid-toolbar">
          <button type="button" className="icon-button" title={t('Freeze')} aria-label={t('Freeze')} disabled={!selected.some((key) => threads.find((thread) => rowKey(thread) === key)?.isFrozen !== true)} onClick={() => freezeRows(threads.filter((thread) => selected.includes(rowKey(thread)) && thread.isFrozen !== true), true)}><DsIcon name="Pause" /></button>
          <button type="button" className="icon-button" title={t('Thaw')} aria-label={t('Thaw')} disabled={!selected.some((key) => threads.find((thread) => rowKey(thread) === key)?.isFrozen === true)} onClick={() => freezeRows(threads.filter((thread) => selected.includes(rowKey(thread)) && thread.isFrozen === true), false)}><DsIcon name="Run" /></button>
        </div>
        <DebugGrid
          label={t('Threads')}
          columns={columns}
          rows={threads}
          rowKey={rowKey}
          selected={selected}
          onSelect={setSelected}
          onActivate={(thread) => void switchToThread(thread)}
          onMenu={openMenu}
          search={{ value: query, onChange: setQuery, onReset: () => setQuery('') }}
          onKeyDown={(event, rows) => {
            if (event.key === 'F2' && rows.length === 1) {
              event.preventDefault()
              setRenaming({ key: rowKey(rows[0]), text: rows[0].name })
            }
          }}
          rowClass={(thread) => `thread-row${isCurrent(thread) ? ' thread-current' : ''}`}
        />
      </div>
    </ProcessWindow>
  )
}

/** A row of the Modules window: a module, and the process it is loaded in. */
type ModuleRow = DebugModule & { sessionId: string }

export const ModulesPane = (): React.JSX.Element => {
  const processes = useDebugProcesses()
  const currentModules = useAppStore((state) => state.debugModules)
  const currentSessionId = useAppStore((state) => state.debugSessionId)
  const [processFilter, setProcessFilter] = useState('')
  // dnSpy's Modules window lists the modules of every process, or of the one the Process combo picks. A session
  // still starting has no entry yet; its modules are the top-level ones.
  const modules: ModuleRow[] = useMemo(() => processes.length === 0
    ? currentModules.map((module) => ({ ...module, sessionId: currentSessionId ?? '' }))
    : processes
      .filter((entry) => !processFilter || entry.sessionId === processFilter)
      .flatMap((entry) => entry.modules.map((module) => ({ ...module, sessionId: entry.sessionId }))), [processes, processFilter, currentModules, currentSessionId])
  const workspaceModules = useAppStore((state) => state.modules)
  const openPaths = useAppStore((state) => state.openPaths)
  const revealNode = useAppStore((state) => state.revealNode)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const { t } = useLanguage()
  const yesNo = (value: boolean | null | undefined): string => value === null || value === undefined ? '' : value ? t('Yes') : t('No')
  // FormatterUtils.WriteYesNoOrNA: an unknown optimization state reads N/A.
  const optimizedText = (value: boolean | null | undefined): string => value === null || value === undefined ? 'N/A' : yesNo(value)
  const columns: GridColumn<ModuleRow>[] = useMemo(() => [
    { key: 'name', header: t('Name'), width: 'minmax(140px, 1fr)', text: (module) => module.name, search: { shortOption: 'n', name: 'Name' }, render: (module) => <><DsIcon name={module.isExe ? 'AssemblyExe' : 'ModuleFile'} className="debug-variable-image" />{module.name}</> },
    { key: 'optimized', header: t('Optimized'), width: 'minmax(60px, auto)', text: (module) => optimizedText(module.isOptimized), search: { shortOption: 'opt', name: 'Optimized' } },
    { key: 'dynamic', header: t('Dynamic'), width: 'minmax(60px, auto)', text: (module) => yesNo(module.isDynamic), search: { shortOption: 'dyn', name: 'Dynamic' } },
    { key: 'in-memory', header: t('In Memory'), width: 'minmax(60px, auto)', text: (module) => yesNo(module.isInMemory), search: { shortOption: 'mem', name: 'In Memory' } },
    { key: 'order', header: t('Order'), width: 'minmax(50px, auto)', text: (module) => module.order === undefined ? '' : String(module.order), search: { shortOption: 'o', name: 'Order' }, compare: (a, b) => (a.order ?? 0) - (b.order ?? 0) },
    { key: 'version', header: t('Version'), width: 'minmax(70px, auto)', text: (module) => module.version ?? '', search: { shortOption: 'v', name: 'Version' } },
    { key: 'timestamp', header: t('Timestamp'), width: 'minmax(120px, auto)', text: (module) => module.timestamp ? new Date(module.timestamp).toLocaleString() : t('<Unknown>'), search: { shortOption: 'ts', name: 'Timestamp' } },
    {
      key: 'address',
      header: t('Address'),
      width: 'minmax(150px, auto)',
      search: { shortOption: 'a', name: 'Address' },
      text: (module) => {
        if (module.address === undefined) return t('<no address>')
        // ModuleFormatter.WriteAddress: always hexadecimal, as wide as the process's bitness.
        const process = processes.find((entry) => entry.sessionId === module.sessionId)?.process
        const width = process?.architecture === 'x86' ? 8 : 16
        return `${formatNumber(module.address, true, width)}-${formatNumber(module.address + (module.size ?? 0), true, width)}`
      },
    },
    { key: 'process', header: t('Process'), width: 'minmax(60px, auto)', text: (module) => module.processId === undefined ? '' : `[${formatNumber(module.processId, hex)}]${processes.find((entry) => entry.sessionId === module.sessionId)?.process?.name ? ` ${processes.find((entry) => entry.sessionId === module.sessionId)!.process!.name}` : ''}`, search: { shortOption: 'p', name: 'Process' }, compare: (a, b) => (a.processId ?? 0) - (b.processId ?? 0) },
    { key: 'appdomain', header: t('AppDomain'), width: 'minmax(80px, auto)', text: (module) => module.appDomainName ?? '', search: { shortOption: 'ad', name: 'AppDomain' } },
    { key: 'path', header: t('Path'), width: 'minmax(160px, 2fr)', text: (module) => module.path ?? '', search: { shortOption: 'f', name: 'Path' } },
  ], [t, hex, processes, optimizedText])

  // dnSpy's Go To Module: the module's node in the assembly explorer, opening the file first if needed.
  const goToModule = async (module: ModuleRow, newTab = false): Promise<void> => {
    const sessionId = module.sessionId
    let path: string | undefined = module.path
    // A module without a file — and with Use memory modules, any module — is read out of the process.
    if (!path || module.isInMemory || module.isDynamic || options.debugger.useMemoryModules) {
      if (!sessionId) return
      path = await useAppStore.getState().openModuleFromMemory(sessionId, module)
      if (!path) return
    }
    const known = workspaceModules.find((candidate) => candidate.path === path)
    if (!known)
      await openPaths([path])
    const opened = useAppStore.getState().modules.find((candidate) => candidate.path === path)
    if (opened) {
      if (newTab && useAppStore.getState().openNodeInNewTabById)
        await useAppStore.getState().openNodeInNewTabById!(opened.id)
      else
        await revealNode(opened.id)
    }
  }

  const saveModule = async (module: ModuleRow): Promise<void> => {
    const sessionId = module.sessionId
    if (!sessionId || typeof module.id !== 'number') return
    const target = await window.dnSpy.chooseDebugModuleSavePath(module.name)
    if (!target) return
    try {
      const path = await window.dnSpy.saveDebugModule(sessionId, module.id, target)
      appendOutput(t('Saved {name} to {path}.', { name: module.name, path }), 'debug')
    } catch (error) {
      await window.dnSpy.showMessage(error instanceof Error ? error.message : String(error))
    }
  }

  // ModuleVM's module is loaded into the tree: from its file, or out of the process when there is no file
  // (a dynamic or in-memory one), when the option says so, or when Load Modules was asked for it.
  const loadModule = async (module: ModuleRow, fromMemory = false): Promise<void> => {
    if (!module.path || fromMemory || module.isInMemory || module.isDynamic || options.debugger.useMemoryModules) {
      if (module.sessionId && typeof module.id === 'number')
        await useAppStore.getState().openModuleFromMemory(module.sessionId, module)
      return
    }
    if (!workspaceModules.some((candidate) => candidate.path === module.path))
      await openPaths([module.path])
  }

  const visibleModules = useMemo(() => {
    if (!query)
      return modules
    const matcher = new SearchMatcher(columns.filter((column) => column.search).map((column) => ({ id: column.key, shortOption: column.search!.shortOption, name: t(column.search!.name) }))).setSearchText(query)
    return modules.filter((module) => matcher.isMatchAll(columns.map((column) => column.text(module))))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules, query, t])

  const showInMemoryWindow = (module: ModuleRow, window: string): void => {
    if (module.address === undefined) return
    useAppStore.getState().showInMemoryWindow(module.sessionId, module.address, module.size ?? 0, window)
  }

  const openMenu = (rows: ModuleRow[], position: { x: number; y: number }): void => {
    const module = rows[0]
    const single = rows.length === 1
    showDebugMenu(t('Modules'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: rows.length === 0, run: () => copyText(rows.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', disabled: visibleModules.length === 0, run: () => setSelected(visibleModules.map((row) => `${row.sessionId}:${row.id}`)) },
      null,
      { key: 'go-to-module', label: t('Go To Module'), shortcut: t('Enter'), disabled: !single, run: () => { if (single) void goToModule(module) } },
      { key: 'load-modules', label: t('Load Modules'), disabled: rows.length === 0, run: () => { for (const row of rows) void loadModule(row) } },
      { key: 'load-all', label: t('Load All Modules'), disabled: modules.length === 0, run: () => { for (const row of modules) void loadModule(row) } },
      null,
      { key: 'open-from-memory', label: t('Open Module from Memory'), disabled: !single || typeof module?.id !== 'number', run: () => { if (single && module?.sessionId) void useAppStore.getState().openModuleFromMemory(module.sessionId, module) } },
      null,
      // dnSpy's Show in Memory Window: Ctrl+X uses the window shown last, Ctrl+1..4 a named one. The
      // commands are flat here because the popup menu has no submenus.
      { key: 'show-memory', label: t('Show in Memory Window'), shortcut: 'Ctrl+X', disabled: !single || module?.address === undefined, run: () => { if (single) showInMemoryWindow(module, 'memory') } },
      { key: 'show-memory-1', label: t('Memory 1'), shortcut: 'Ctrl+1', disabled: !single || module?.address === undefined, icon: 'MemoryWindow', run: () => { if (single) showInMemoryWindow(module, 'memory') } },
      { key: 'show-memory-2', label: t('Memory 2'), shortcut: 'Ctrl+2', disabled: !single || module?.address === undefined, icon: 'MemoryWindow', run: () => { if (single) showInMemoryWindow(module, 'memory-2') } },
      { key: 'show-memory-3', label: t('Memory 3'), shortcut: 'Ctrl+3', disabled: !single || module?.address === undefined, icon: 'MemoryWindow', run: () => { if (single) showInMemoryWindow(module, 'memory-3') } },
      { key: 'show-memory-4', label: t('Memory 4'), shortcut: 'Ctrl+4', disabled: !single || module?.address === undefined, icon: 'MemoryWindow', run: () => { if (single) showInMemoryWindow(module, 'memory-4') } },
      null,
      { key: 'open-folder', label: t('Open Containing Folder'), disabled: !single || !module?.path, run: () => { if (single && module?.path) void window.dnSpy.showItemInFolder(module.path) } },
      { key: 'copy-filename', label: t('Copy Filename'), disabled: !single || !module?.path, run: () => { if (single && module?.path) copyText(module.path) } },
      null,
      { key: 'save', label: t('Save Module'), icon: 'Save', disabled: rows.length === 0 || rows.some((row) => typeof row.id !== 'number'), run: () => { for (const row of rows) void saveModule(row) } },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <ProcessWindow processes={processes} filter={processFilter} onFilter={setProcessFilter} hex={hex}>
      <DebugGrid
        label={t('Modules')}
        columns={columns}
        rows={modules}
        rowKey={(module) => `${module.sessionId}:${module.id}`}
        selected={selected}
        onSelect={setSelected}
        onActivate={(module, newTab) => void goToModule(module, newTab)}
        onMenu={openMenu}
        search={{ value: query, onChange: setQuery, onReset: () => setQuery('') }}
      />
    </ProcessWindow>
  )
}

/**
 * dnSpy's Processes window: every process being debugged, the current one marked. Double click or Enter makes a
 * paused process the current one; the context menu runs, breaks, detaches from or kills the selected process.
 */
export const ProcessesPane = (): React.JSX.Element => {
  const processes = useDebugProcesses()
  const currentSessionId = useAppStore((state) => state.debugSessionId)
  const store = useAppStore.getState
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const { t } = useLanguage()
  const stateText = (row: DebugSessionEntry): string => row.process?.state === 'Terminated' ? t('Terminated') : row.state === 'stopped' ? t('Paused') : t('Running')
  const columns: GridColumn<DebugSessionEntry>[] = useMemo(() => [
    { key: 'marker', header: '', width: '22px', text: () => '', render: (row) => row.sessionId === currentSessionId ? <DsIcon name="CurrentInstructionPointer" /> : null },
    { key: 'name', header: t('Name'), width: 'minmax(120px, 1fr)', text: (row) => row.process?.name ?? '', search: { shortOption: 'n', name: 'Name' }, render: (row) => <><DsIcon name="Process" className="debug-variable-image" />{row.process?.name ?? ''}</> },
    { key: 'id', header: t('ID'), width: 'minmax(70px, auto)', text: (row) => formatNumber(row.process?.id, hex), search: { shortOption: 'p', name: 'ID' }, compare: (a, b) => (a.process?.id ?? 0) - (b.process?.id ?? 0) },
    { key: 'title', header: t('Title'), width: 'minmax(80px, auto)', text: () => '', search: { shortOption: 't', name: 'Title' } },
    { key: 'state', header: t('State'), width: 'minmax(70px, auto)', text: stateText, search: { shortOption: 's', name: 'State' } },
    { key: 'debugging', header: t('Debugging'), width: 'minmax(80px, auto)', text: (row) => row.process?.debugging ?? '', search: { shortOption: 'd', name: 'Debugging' } },
    { key: 'architecture', header: t('Architecture'), width: 'minmax(80px, auto)', text: (row) => row.process?.architecture ?? '', search: { shortOption: 'a', name: 'Architecture' } },
    { key: 'path', header: t('Path'), width: 'minmax(160px, 2fr)', text: (row) => row.process?.path ?? '', search: { shortOption: 'f', name: 'Path' } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, hex, currentSessionId])
  const visibleProcesses = useMemo(() => {
    if (!query)
      return processes
    const matcher = new SearchMatcher(columns.filter((column) => column.search).map((column) => ({ id: column.key, shortOption: column.search!.shortOption, name: t(column.search!.name) }))).setSearchText(query)
    return processes.filter((process) => matcher.isMatchAll(columns.map((column) => column.text(process))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes, query, t])
  // ProcessesOperations.SetCurrentProcess: only a paused process can be the current one.
  const makeCurrent = (row: DebugSessionEntry): void => {
    if (row.state === 'stopped')
      void store().setCurrentDebugSession(row.sessionId)
  }
  const openMenu = (rows: DebugSessionEntry[], position: { x: number; y: number }): void => {
    const row = rows[0]
    showDebugMenu(t('Processes'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: rows.length === 0, run: () => copyText(rows.map((item) => columns.map((column) => column.text(item)).join('\t')).join('\n')) },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', disabled: visibleProcesses.length === 0, run: () => setSelected(visibleProcesses.map((item) => item.sessionId)) },
      null,
      { key: 'set-current', label: t('Set Current Process'), disabled: rows.length !== 1 || row?.state !== 'stopped', run: () => { if (rows.length === 1) makeCurrent(row) } },
      null,
      { key: 'continue', label: t('Continue Process'), icon: 'Run', disabled: !rows.some((item) => item.state === 'stopped'), run: () => { for (const item of rows.filter((candidate) => candidate.state === 'stopped')) void store().continueDebugProcess(item.sessionId) } },
      { key: 'break', label: t('Break Process'), icon: 'Pause', disabled: !rows.some((item) => item.state === 'running'), run: () => { for (const item of rows.filter((candidate) => candidate.state === 'running')) void store().pauseDebugProcess(item.sessionId) } },
      null,
      { key: 'detach', label: t('Detach Process'), icon: 'Cancel', disabled: rows.length === 0, run: () => { for (const item of rows) void store().detachDebugProcess(item.sessionId) } },
      { key: 'terminate', label: t('Terminate Process'), icon: 'TerminateProcess', disabled: rows.length === 0, run: () => { for (const item of rows) void store().terminateDebugProcess(item.sessionId) } },
      null,
      { key: 'detach-when-stopped', label: t('Detach When Debugging Stopped'), checked: rows.length > 0 && rows.every((item) => item.shouldDetach === true), disabled: rows.length === 0, run: () => store().setDetachWhenDebuggingStopped(rows.map((item) => item.sessionId), !rows.every((item) => item.shouldDetach === true)) },
      ...hexEntries(t, options.debugger),
      null,
      { key: 'attach', label: t('Attach to Process...'), icon: 'Process', shortcut: 'Ctrl+Alt+P', run: () => store().openAttachDialog?.() },
    ], position)
  }
  return (
    <div className="debug-tool-pane">
      {/* ProcessesOperations' toolbar: continue, break, the three current-process steps, detach and terminate. */}
      <div className="debug-grid-toolbar" role="toolbar" aria-label={t('Processes')}>
        <button type="button" className="icon-button" title={t('Continue Process')} aria-label={t('Continue Process')} disabled={!selected.some((sessionId) => processes.find((row) => row.sessionId === sessionId)?.state === 'stopped')} onClick={() => { for (const sessionId of selected) { if (processes.find((row) => row.sessionId === sessionId)?.state === 'stopped') void store().continueDebugProcess(sessionId) } }}><DsIcon name="Run" /></button>
        <button type="button" className="icon-button" title={t('Break Process')} aria-label={t('Break Process')} disabled={!selected.some((sessionId) => processes.find((row) => row.sessionId === sessionId)?.state === 'running')} onClick={() => { for (const sessionId of selected) { if (processes.find((row) => row.sessionId === sessionId)?.state === 'running') void store().pauseDebugProcess(sessionId) } }}><DsIcon name="Pause" /></button>
        <button type="button" className="icon-button" title={t('Step Into (Current Process)')} aria-label={t('Step Into (Current Process)')} disabled={store().debugState !== 'stopped'} onClick={() => void store().stepDebug('stepIn', true)}><DsIcon name="StepInto" /></button>
        <button type="button" className="icon-button" title={t('Step Over (Current Process)')} aria-label={t('Step Over (Current Process)')} disabled={store().debugState !== 'stopped'} onClick={() => void store().stepDebug('next', true)}><DsIcon name="StepOver" /></button>
        <button type="button" className="icon-button" title={t('Step Out (Current Process)')} aria-label={t('Step Out (Current Process)')} disabled={store().debugState !== 'stopped'} onClick={() => void store().stepDebug('stepOut', true)}><DsIcon name="StepOut" /></button>
        <button type="button" className="icon-button" title={t('Detach Process')} aria-label={t('Detach Process')} disabled={selected.length === 0} onClick={() => { for (const sessionId of selected) void store().detachDebugProcess(sessionId) }}><DsIcon name="Cancel" /></button>
        <button type="button" className="icon-button" title={t('Terminate Process')} aria-label={t('Terminate Process')} disabled={selected.length === 0} onClick={() => { for (const sessionId of selected) void store().terminateDebugProcess(sessionId) }}><DsIcon name="TerminateProcess" /></button>
        <button type="button" className="icon-button" title={t('Attach to Process...')} aria-label={t('Attach to Process...')} onClick={() => store().openAttachDialog?.()}><DsIcon name="Process" /></button>
      </div>
      <DebugGrid
        label={t('Processes')}
        columns={columns}
        rows={processes}
        rowKey={(row) => row.sessionId}
        selected={selected}
        onSelect={setSelected}
        onActivate={makeCurrent}
        onMenu={openMenu}
        search={{ value: query, onChange: setQuery, onReset: () => setQuery('') }}
        rowClass={(row) => row.sessionId === currentSessionId ? 'process-current' : ''}
      />
    </div>
  )
}

export const DebugStatusPane = (): React.JSX.Element => {
  const state = useAppStore((appState) => appState.debugState)
  const reason = useAppStore((appState) => appState.stoppedReason)
  const { locale, t } = useLanguage()
  const label = useMemo(() => state === 'stopped' && reason ? t('Stopped: {reason}', { reason: t(reason) }) : t(state), [state, reason, locale])
  return <div className="pane-empty">{label}</div>
}

/** A tri-state cell of the Module Breakpoints window: Yes, No, or blank for "any". */
const TriState = ({ value, label, onChange }: { value?: boolean; label: string; onChange(value?: boolean): void }): React.JSX.Element => {
  const { t } = useLanguage()
  return (
    <select aria-label={label} value={value === undefined ? '' : value ? 'yes' : 'no'} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'yes')}>
      <option value="" />
      <option value="yes">{t('Yes')}</option>
      <option value="no">{t('No')}</option>
    </select>
  )
}

/**
 * dnSpy's Module Breakpoints window: the process pauses when a module that matches a row loads. Every column is
 * a filter, wildcards allowed in the names; an empty cell matches anything.
 */
export const ModuleBreakpointsPane = (): React.JSX.Element => {
  const rows = useAppStore((state) => state.moduleBreakpoints)
  const add = useAppStore((state) => state.addModuleBreakpoint)
  const update = useAppStore((state) => state.updateModuleBreakpoint)
  const remove = useAppStore((state) => state.removeModuleBreakpoints)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ id: string; field: 'moduleName' | 'order' | 'processName' | 'appDomainName' }>()
  const { t } = useLanguage()
  const triState = (value: boolean | undefined): string => value === undefined ? '' : value ? t('Yes') : t('No')
  const columns: GridColumn<ModuleBreakpoint>[] = useMemo(() => [
    {
      key: 'enabled', header: '', width: '28px', text: (row) => row.enabled ? t('Yes') : t('No'),
      render: (row) => <input type="checkbox" checked={row.enabled} aria-label={t(row.enabled ? 'Disable {name}' : 'Enable {name}', { name: row.moduleName || '*' })} onChange={() => void update(row.id, { enabled: !row.enabled })} />,
    },
    {
      key: 'moduleName', header: t('Module Name'), width: 'minmax(140px, 2fr)', text: (row) => row.moduleName, search: { shortOption: 'n', name: 'Module Name' },
      render: (row) => <input key={`${row.id}:${editing?.field === 'moduleName' ? 1 : 0}`} className="debug-cell-input" autoFocus={editing?.id === row.id && editing.field === 'moduleName'} aria-label={t('Module Name')} value={row.moduleName} placeholder="*" onChange={(event) => void update(row.id, { moduleName: event.target.value })} />,
    },
    { key: 'dynamic', header: t('Dynamic'), width: 'minmax(70px, auto)', text: (row) => triState(row.isDynamic), render: (row) => <TriState label={t('Dynamic')} value={row.isDynamic} onChange={(value) => void update(row.id, { isDynamic: value })} /> },
    { key: 'in-memory', header: t('In Memory'), width: 'minmax(70px, auto)', text: (row) => triState(row.isInMemory), render: (row) => <TriState label={t('In Memory')} value={row.isInMemory} onChange={(value) => void update(row.id, { isInMemory: value })} /> },
    { key: 'loaded', header: t('Loaded'), width: 'minmax(70px, auto)', text: (row) => triState(row.isLoaded), render: (row) => <TriState label={t('Loaded')} value={row.isLoaded} onChange={(value) => void update(row.id, { isLoaded: value })} /> },
    {
      key: 'order', header: t('Order'), width: 'minmax(50px, auto)', text: (row) => row.order === undefined ? '' : String(row.order),
      search: { shortOption: 'o', name: 'Order' }, compare: (a, b) => (a.order ?? 0) - (b.order ?? 0),
      render: (row) => <input key={`${row.id}:${editing?.field === 'order' ? 1 : 0}`} className="debug-cell-input" autoFocus={editing?.id === row.id && editing.field === 'order'} aria-label={t('Order')} value={row.order ?? ''} onChange={(event) => { const order = Number.parseInt(event.target.value, 10); void update(row.id, { order: Number.isFinite(order) ? order : undefined }) }} />,
    },
    {
      key: 'process', header: t('Process'), width: 'minmax(90px, 1fr)', text: (row) => row.processName ?? '', search: { shortOption: 'p', name: 'Process' },
      render: (row) => <input key={`${row.id}:${editing?.field === 'processName' ? 1 : 0}`} className="debug-cell-input" autoFocus={editing?.id === row.id && editing.field === 'processName'} aria-label={t('Process')} value={row.processName ?? ''} onChange={(event) => void update(row.id, { processName: event.target.value || undefined })} />,
    },
    {
      key: 'appdomain', header: t('AppDomain'), width: 'minmax(90px, 1fr)', text: (row) => row.appDomainName ?? '', search: { shortOption: 'ad', name: 'AppDomain' },
      render: (row) => <input key={`${row.id}:${editing?.field === 'appDomainName' ? 1 : 0}`} className="debug-cell-input" autoFocus={editing?.id === row.id && editing.field === 'appDomainName'} aria-label={t('AppDomain')} value={row.appDomainName ?? ''} onChange={(event) => void update(row.id, { appDomainName: event.target.value || undefined })} />,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, editing])
  // ModuleBreakpointsVM matches the filter against the name, order, process and app domain only.
  const visibleRows = useMemo(() => {
    if (!query)
      return rows
    const matcher = new SearchMatcher(columns.filter((column) => column.search).map((column) => ({ id: column.key, shortOption: column.search!.shortOption, name: t(column.search!.name) }))).setSearchText(query)
    return rows.filter((row) => matcher.isMatchAll(columns.filter((column) => column.search).map((column) => column.text(row))))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, t])
  const exportRows = async (wanted: ModuleBreakpoint[]): Promise<void> => {
    if (wanted.length === 0) return
    await window.dnSpy.saveCode('ModuleBreakpoints.xml', moduleBreakpointsXml(wanted))
  }
  const importFile = async (): Promise<void> => {
    const text = await window.dnSpy.readTextFile('moduleBreakpoints')
    if (text === undefined) return
    const imported = parseModuleBreakpointsXml(text)
    if (!imported) {
      void window.dnSpy.showMessage(t('The file is not a valid module breakpoint file.'))
      return
    }
    for (const row of imported)
      await add(row)
  }
  const openMenu = (visible: ModuleBreakpoint[], position: { x: number; y: number }): void => {
    const row = visible[0]
    const single = visible.length === 1
    showDebugMenu(t('Module Breakpoints'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: visible.length === 0, run: () => copyText(visible.map((candidate) => [candidate.enabled ? t('Yes') : t('No'), candidate.moduleName, triState(candidate.isDynamic), triState(candidate.isInMemory), triState(candidate.isLoaded), candidate.order ?? '', candidate.processName ?? '', candidate.appDomainName ?? ''].join('\t')).join('\n')) },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', disabled: visibleRows.length === 0, run: () => setSelected(visibleRows.map((candidate) => candidate.id)) },
      null,
      { key: 'add', label: t('Add Module Breakpoint'), icon: 'Add', shortcut: 'Insert', run: () => void add() },
      { key: 'delete', label: t('Delete'), icon: 'Cancel', shortcut: 'Del', disabled: visible.length === 0, run: () => void remove(visible.map((candidate) => candidate.id)) },
      { key: 'delete-all', label: t('Delete All'), icon: 'ClearBreakpointGroup', disabled: visibleRows.length === 0, run: () => void remove(visibleRows.map((candidate) => candidate.id)) },
      null,
      { key: 'enable', label: t('Enable Breakpoint'), icon: 'EnableAllBreakpoints', disabled: visible.length === 0, run: () => { for (const candidate of visible) void update(candidate.id, { enabled: true }) } },
      { key: 'disable', label: t('Disable Breakpoint'), icon: 'DisableAllBreakpoints', disabled: visible.length === 0, run: () => { for (const candidate of visible) void update(candidate.id, { enabled: false }) } },
      null,
      { key: 'edit-name', label: t('Edit Module Name'), shortcut: 'F2', disabled: !single, run: () => { if (single) setEditing({ id: row.id, field: 'moduleName' }) } },
      { key: 'edit-order', label: t('Edit Module Load Order'), shortcut: 'Ctrl+2', disabled: !single, run: () => { if (single) setEditing({ id: row.id, field: 'order' }) } },
      { key: 'edit-process', label: t('Edit Process Name'), shortcut: 'Ctrl+3', disabled: !single, run: () => { if (single) setEditing({ id: row.id, field: 'processName' }) } },
      { key: 'edit-appdomain', label: t('Edit AppDomain Name'), shortcut: 'Ctrl+4', disabled: !single, run: () => { if (single) setEditing({ id: row.id, field: 'appDomainName' }) } },
      null,
      { key: 'export-selected', label: t('Export Selected'), icon: 'Open', disabled: visible.length === 0, run: () => void exportRows(visible) },
      { key: 'export-matching', label: t('Export All'), icon: 'Open', disabled: visibleRows.length === 0, run: () => void exportRows(visibleRows) },
      { key: 'import', label: t('Import'), icon: 'Import', run: () => void importFile() },
    ], position)
  }
  return (
    <div className="debug-tool-pane">
      <div className="bookmarks-toolbar" role="toolbar" aria-label={t('Module Breakpoints')}>
        <button className="icon-button" title={t('Add Module Breakpoint')} aria-label={t('Add Module Breakpoint')} onClick={() => void add()}><DsIcon name="Add" /></button>
        <button className="icon-button" title={t('Delete')} aria-label={t('Delete')} disabled={selected.length === 0} onClick={() => void remove(selected)}><DsIcon name="Cancel" /></button>
        <button className="icon-button" title={t('Delete All')} aria-label={t('Delete All')} disabled={visibleRows.length === 0} onClick={() => void remove(visibleRows.map((row) => row.id))}><DsIcon name="ClearBreakpointGroup" /></button>
        <button className="icon-button" title={t('Export Selected')} aria-label={t('Export Selected')} disabled={selected.length === 0} onClick={() => void exportRows(rows.filter((row) => selected.includes(row.id)))}><DsIcon name="Open" /></button>
        <button className="icon-button" title={t('Import')} aria-label={t('Import')} onClick={() => void importFile()}><DsIcon name="Import" /></button>
      </div>
      <DebugGrid
        label={t('Module Breakpoints')}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        selected={selected}
        onSelect={setSelected}
        onMenu={openMenu}
        search={{ value: query, onChange: setQuery, onReset: () => setQuery('') }}
        onKeyDown={(event, selectedRows) => {
          if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
          if (event.key === 'Insert') {
            event.preventDefault()
            void add()
          } else if (event.key === 'Delete' && selectedRows.length > 0) {
            event.preventDefault()
            void remove(selectedRows.map((row) => row.id))
          } else if (selectedRows.length === 1) {
            const field = event.key === 'F2' ? 'moduleName'
              : event.ctrlKey && event.key === '2' ? 'order'
                : event.ctrlKey && event.key === '3' ? 'processName'
                  : event.ctrlKey && event.key === '4' ? 'appDomainName' : undefined
            if (field) {
              event.preventDefault()
              setEditing({ id: selectedRows[0].id, field })
            }
          }
        }}
      />
    </div>
  )
}
