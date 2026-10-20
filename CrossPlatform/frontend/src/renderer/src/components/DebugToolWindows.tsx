import { useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { DebugModule, DebugStackFrame, DebugThread } from '../../../shared/protocol'
import { debugProcessesOf, frameCodeLocation, lineBreakpointsAtLocation, useAppStore, type DebugSessionEntry } from '../app-store'
import { useLanguage } from '../localization'
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
}

/** dnSpy's ListView windows: a header row and a row per item, selected by click, activated by double click or Enter. */
const DebugGrid = <T,>({ label, columns, rows, rowKey, selected, onSelect, onActivate, onMenu, rowClass }: {
  label: string
  columns: GridColumn<T>[]
  rows: T[]
  rowKey(row: T): string
  selected?: string
  onSelect(key: string): void
  onActivate?(row: T): void
  onMenu(row: T | undefined, position: { x: number; y: number }): void
  rowClass?(row: T): string
}): React.JSX.Element => {
  const move = (delta: number): void => {
    const index = rows.findIndex((row) => rowKey(row) === selected)
    const target = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
    if (target) onSelect(rowKey(target))
  }
  return (
    <div
      className="debug-table debug-grid"
      role="grid"
      aria-label={label}
      tabIndex={0}
      style={{ gridTemplateColumns: columns.map((column) => column.width).join(' ') }}
      onKeyDown={(event) => {
        const row = rows.find((candidate) => rowKey(candidate) === selected)
        if (event.key === 'ArrowDown') move(1)
        else if (event.key === 'ArrowUp') move(-1)
        else if (event.key === 'Enter' && row) onActivate?.(row)
        else if (event.key === 'c' && event.ctrlKey && row) copyText(columns.map((column) => column.text(row)).join('\t'))
        else return
        event.preventDefault()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(rows.find((row) => rowKey(row) === selected), { x: event.clientX, y: event.clientY })
      }}
    >
      {columns.map((column) => <div className="debug-table-header" role="columnheader" key={column.key}>{column.header}</div>)}
      {rows.map((row) => {
        const key = rowKey(row)
        return (
          <div
            className={`debug-table-row${selected === key ? ' selected' : ''}${rowClass ? ` ${rowClass(row)}` : ''}`}
            role="row"
            aria-selected={selected === key}
            key={key}
            onMouseDown={() => onSelect(key)}
            onDoubleClick={() => onActivate?.(row)}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onSelect(key)
              onMenu(row, { x: event.clientX, y: event.clientY })
            }}
          >
            {columns.map((column) => <span key={column.key} title={column.text(row)}>{column.render ? column.render(row) : column.text(row)}</span>)}
          </div>
        )
      })}
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
  const openMenu = (frame: DebugStackFrame | undefined, position: { x: number; y: number }): void => {
    const callStack = options.callStack
    const check = (key: keyof CallStackSettings, label: string): MenuItem => ({ key, label, checked: callStack[key], run: () => toggleCallStackOption(key) })
    const top = frames.find((candidate) => !candidate.isInternal)
    showDebugMenu(t('Call Stack'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !frame, run: () => { if (frame) copyText(frame.name) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(frames.map((candidate) => candidate.name).join('\n')) },
      null,
      { key: 'switch', label: t('Switch To Frame'), shortcut: t('Enter'), disabled: !frame || frame.isInternal === true, run: () => { if (frame) void switchToFrame(frame.id) } },
      { key: 'go-to-code', label: t('Go To Code'), icon: 'GoToSourceCode', disabled: !frame || frame.isInternal === true, run: () => { if (frame) void switchToFrame(frame.id) } },
      { key: 'go-to-disassembly', label: t('Go To Disassembly'), icon: 'DisassemblyWindow', disabled: !frame || frame.isInternal === true, run: () => { if (frame) void showDisassembly({ frameId: frame.id }) } },
      { key: 'run-to-cursor', label: t('Run To Cursor'), icon: 'Cursor', shortcut: 'Ctrl+F10', disabled: !frame || frame.isInternal === true || frame.id === top?.id, run: () => { if (frame) void runToCursor(frame.id) } },
      // dnSpy has the command and never enables it: CallStackOperations.CanUnwindToFrame is always false.
      { key: 'unwind', label: t('Unwind To This Frame'), disabled: true, run: () => undefined },
      null,
      ...breakpointEntries(frame),
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
      className="result-list"
      role="list"
      aria-label={t('Call Stack')}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu(frames.find((frame) => frame.id === selectedFrameId), { x: event.clientX, y: event.clientY })
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
            className={`result-row stack-row${selectedFrameId === frame.id ? ' selected' : ''}${active ? ' active' : ''}${frame.isInternal ? ' stack-row-internal' : ''}`}
            title={location || frame.description || undefined}
            aria-current={active ? 'true' : undefined}
            onClick={() => void selectFrame(frame.id)}
            onDoubleClick={() => { if (!frame.isInternal) void switchToFrame(frame.id) }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void selectFrame(frame.id)
              openMenu(frame, { x: event.clientX, y: event.clientY })
            }}
            // A button takes Enter as a click, so the switch has to claim the key before the select does.
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (!frame.isInternal) void switchToFrame(frame.id)
              } else if (event.key === 'F9' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                // F9 in the window toggles the frame's breakpoint, as its Breakpoint submenu's shortcut says.
                const location = frameCodeLocation(frame)
                if (!location)
                  return
                event.preventDefault()
                event.stopPropagation()
                const store = useAppStore.getState()
                const existing = lineBreakpointsAtLocation(store.lineBreakpoints, location)
                if (existing.length === 0)
                  void store.addLocationBreakpoint(location)
                else
                  void store.removeBreakpoints(existing.map((breakpoint) => breakpoint.id))
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

/** dnSpy's ThreadCategory images. */
const threadCategoryImage = (category?: string): string => {
  switch (category) {
    case 'Main': return 'Thread'
    case 'GC': case 'Finalizer': return 'Thread'
    default: return 'Thread'
  }
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
  const [selected, setSelected] = useState<string>()
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
    { key: 'id', header: t('ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.id, hex) },
    { key: 'managed-id', header: t('Managed ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.managedId, hex) },
    { key: 'category', header: t('Category'), width: 'minmax(80px, auto)', text: (thread) => thread.category ? t(thread.category) : '', render: (thread) => <><DsIcon name={threadCategoryImage(thread.category)} className="debug-variable-image" />{thread.category ? t(thread.category) : ''}</> },
    {
      key: 'name',
      header: t('Name'),
      width: 'minmax(100px, 1fr)',
      text: (thread) => thread.name,
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
    { key: 'location', header: t('Location'), width: 'minmax(160px, 2fr)', text: (thread) => thread.location ?? '' },
    { key: 'priority', header: t('Priority'), width: 'minmax(60px, auto)', text: (thread) => thread.priority === null || thread.priority === undefined ? '' : String(thread.priority) },
    { key: 'affinity', header: t('Affinity Mask'), width: 'minmax(80px, auto)', text: (thread) => thread.affinityMask ?? '' },
    { key: 'suspended', header: t('Suspended Count'), width: 'minmax(60px, auto)', text: (thread) => String(thread.suspendedCount ?? 0) },
    { key: 'process', header: t('Process Name'), width: 'minmax(80px, auto)', text: (thread) => thread.processName ? `[${formatNumber(thread.processId, hex)}] ${thread.processName}` : '' },
    { key: 'appdomain', header: t('AppDomain'), width: 'minmax(80px, auto)', text: (thread) => thread.appDomainName ?? '' },
    { key: 'state', header: t('State'), width: 'minmax(80px, auto)', text: (thread) => (thread.state ?? []).join(', ') },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, hex, selectedThreadId, currentSessionId, renaming, rename])
  const openMenu = (thread: ThreadRow | undefined, position: { x: number; y: number }): void => {
    showDebugMenu(t('Threads'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !thread, run: () => { if (thread) copyText(columns.map((column) => column.text(thread)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(threads.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      null,
      { key: 'switch', label: t('Switch To Thread'), shortcut: t('Enter'), disabled: !thread || !stopped(thread), run: () => { if (thread) void switchToThread(thread) } },
      { key: 'rename', label: t('Rename'), disabled: !thread, run: () => { if (thread) setRenaming({ key: rowKey(thread), text: thread.name }) } },
      { key: 'freeze', label: t('Freeze'), disabled: !thread || thread.isFrozen === true, run: () => { if (thread) void freeze([thread.id], true, thread.sessionId) } },
      { key: 'thaw', label: t('Thaw'), disabled: !thread || thread.isFrozen !== true, run: () => { if (thread) void freeze([thread.id], false, thread.sessionId) } },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <ProcessWindow processes={processes} filter={processFilter} onFilter={setProcessFilter} hex={hex}>
      <DebugGrid
        label={t('Threads')}
        columns={columns}
        rows={threads}
        rowKey={rowKey}
        selected={selected}
        onSelect={setSelected}
        onActivate={(thread) => void switchToThread(thread)}
        onMenu={openMenu}
        rowClass={(thread) => `thread-row${isCurrent(thread) ? ' thread-current' : ''}`}
      />
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
  const [selected, setSelected] = useState<string>()
  const { t } = useLanguage()
  const yesNo = (value: boolean | null | undefined): string => value === null || value === undefined ? '' : value ? t('Yes') : t('No')
  const columns: GridColumn<ModuleRow>[] = useMemo(() => [
    { key: 'name', header: t('Name'), width: 'minmax(140px, 1fr)', text: (module) => module.name, render: (module) => <><DsIcon name={module.isExe ? 'AssemblyExe' : 'ModuleFile'} className="debug-variable-image" />{module.name}</> },
    { key: 'optimized', header: t('Optimized'), width: 'minmax(60px, auto)', text: (module) => yesNo(module.isOptimized) },
    { key: 'dynamic', header: t('Dynamic'), width: 'minmax(60px, auto)', text: (module) => yesNo(module.isDynamic) },
    { key: 'in-memory', header: t('In Memory'), width: 'minmax(60px, auto)', text: (module) => yesNo(module.isInMemory) },
    { key: 'order', header: t('Order'), width: 'minmax(50px, auto)', text: (module) => module.order === undefined ? '' : String(module.order) },
    { key: 'version', header: t('Version'), width: 'minmax(70px, auto)', text: (module) => module.version ?? '' },
    { key: 'timestamp', header: t('Timestamp'), width: 'minmax(120px, auto)', text: (module) => module.timestamp ? new Date(module.timestamp).toLocaleString() : '' },
    { key: 'address', header: t('Address'), width: 'minmax(150px, auto)', text: (module) => module.address === undefined ? '' : `${formatNumber(module.address, true, 16)}-${formatNumber(module.address + (module.size ?? 0), true, 16)}` },
    { key: 'process', header: t('Process'), width: 'minmax(60px, auto)', text: (module) => formatNumber(module.processId, hex) },
    { key: 'appdomain', header: t('AppDomain'), width: 'minmax(80px, auto)', text: (module) => module.appDomainName ?? '' },
    { key: 'path', header: t('Path'), width: 'minmax(160px, 2fr)', text: (module) => module.path ?? '' },
  ], [t, hex])

  // dnSpy's Go To Module: the module's node in the assembly explorer, opening the file first if needed.
  const goToModule = async (module: ModuleRow): Promise<void> => {
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
    if (opened)
      await revealNode(opened.id)
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

  const openMenu = (module: ModuleRow | undefined, position: { x: number; y: number }): void => {
    const sessionId = module?.sessionId
    showDebugMenu(t('Modules'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !module, run: () => { if (module) copyText(columns.map((column) => column.text(module)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(modules.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      null,
      { key: 'go-to-module', label: t('Go To Module'), shortcut: t('Enter'), disabled: !module, run: () => { if (module) void goToModule(module) } },
      { key: 'open-from-memory', label: t('Open Module from Memory'), disabled: !module || typeof module.id !== 'number', run: () => {
        if (!module || !sessionId || typeof module.id !== 'number') return
        void useAppStore.getState().openModuleFromMemory(sessionId, module)
      } },
      { key: 'load-all', label: t('Load All Modules'), disabled: modules.length === 0, run: () => void openPaths(modules.map((row) => row.path).filter((path): path is string => !!path && !workspaceModules.some((candidate) => candidate.path === path))) },
      null,
      { key: 'save', label: t('Save Module'), icon: 'Save', disabled: !module || typeof module.id !== 'number', run: () => { if (module) void saveModule(module) } },
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
        onActivate={(module) => void goToModule(module)}
        onMenu={openMenu}
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
  const [selected, setSelected] = useState<string>()
  const { t } = useLanguage()
  const stateText = (row: DebugSessionEntry): string => row.process?.state === 'Terminated' ? t('Terminated') : row.state === 'stopped' ? t('Paused') : t('Running')
  const columns: GridColumn<DebugSessionEntry>[] = [
    { key: 'marker', header: '', width: '22px', text: () => '', render: (row) => row.sessionId === currentSessionId ? <DsIcon name="CurrentInstructionPointer" /> : null },
    { key: 'name', header: t('Name'), width: 'minmax(120px, 1fr)', text: (row) => row.process?.name ?? '', render: (row) => <><DsIcon name="Process" className="debug-variable-image" />{row.process?.name ?? ''}</> },
    { key: 'id', header: t('ID'), width: 'minmax(70px, auto)', text: (row) => formatNumber(row.process?.id, hex) },
    { key: 'title', header: t('Title'), width: 'minmax(80px, auto)', text: () => '' },
    { key: 'state', header: t('State'), width: 'minmax(70px, auto)', text: stateText },
    { key: 'debugging', header: t('Debugging'), width: 'minmax(80px, auto)', text: (row) => row.process?.debugging ?? '' },
    { key: 'architecture', header: t('Architecture'), width: 'minmax(80px, auto)', text: (row) => row.process?.architecture ?? '' },
    { key: 'path', header: t('Path'), width: 'minmax(160px, 2fr)', text: (row) => row.process?.path ?? '' },
  ]
  // ProcessesOperations.SetCurrentProcess: only a paused process can be the current one.
  const makeCurrent = (row: DebugSessionEntry): void => {
    if (row.state === 'stopped')
      void store().setCurrentDebugSession(row.sessionId)
  }
  const openMenu = (row: DebugSessionEntry | undefined, position: { x: number; y: number }): void => {
    showDebugMenu(t('Processes'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !row, run: () => { if (row) copyText(columns.map((column) => column.text(row)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(processes.map((item) => columns.map((column) => column.text(item)).join('\t')).join('\n')) },
      null,
      { key: 'continue', label: t('Continue Process'), icon: 'Run', disabled: row?.state !== 'stopped', run: () => { if (row) void store().continueDebugProcess(row.sessionId) } },
      { key: 'break', label: t('Break Process'), icon: 'Pause', disabled: row?.state !== 'running', run: () => { if (row) void store().pauseDebugProcess(row.sessionId) } },
      null,
      { key: 'detach', label: t('Detach Process'), icon: 'Cancel', disabled: !row, run: () => { if (row) void store().detachDebugProcess(row.sessionId) } },
      { key: 'terminate', label: t('Terminate Process'), icon: 'TerminateProcess', disabled: !row, run: () => { if (row) void store().terminateDebugProcess(row.sessionId) } },
      null,
      { key: 'detach-when-stopped', label: t('Detach When Debugging Stopped'), checked: row?.shouldDetach === true, disabled: !row, run: () => { if (row) store().setDetachWhenDebuggingStopped([row.sessionId], !row.shouldDetach) } },
      ...hexEntries(t, options.debugger),
      null,
      { key: 'attach', label: t('Attach to Process...'), icon: 'Process', shortcut: 'Ctrl+Alt+P', run: () => store().openAttachDialog?.() },
    ], position)
  }
  return (
    <DebugGrid
      label={t('Processes')}
      columns={columns}
      rows={processes}
      rowKey={(row) => row.sessionId}
      selected={selected}
      onSelect={setSelected}
      onActivate={makeCurrent}
      onMenu={openMenu}
      rowClass={(row) => row.sessionId === currentSessionId ? 'process-current' : ''}
    />
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
  const [selected, setSelected] = useState<string>()
  const { t } = useLanguage()
  const openMenu = (position: { x: number; y: number }): void => {
    const row = rows.find((candidate) => candidate.id === selected)
    showDebugMenu(t('Module Breakpoints'), [
      { key: 'add', label: t('Add Module Breakpoint'), icon: 'Add', run: () => void add() },
      null,
      { key: 'delete', label: t('Delete'), icon: 'Cancel', shortcut: 'Del', disabled: !row, run: () => { if (row) void remove([row.id]) } },
      { key: 'delete-all', label: t('Delete All'), icon: 'ClearBreakpointGroup', disabled: rows.length === 0, run: () => void remove(rows.map((candidate) => candidate.id)) },
      null,
      { key: 'enable-all', label: t('Enable All Breakpoints'), icon: 'EnableAllBreakpoints', disabled: rows.every((candidate) => candidate.enabled), run: () => { for (const candidate of rows) void update(candidate.id, { enabled: true }) } },
      { key: 'disable-all', label: t('Disable All Breakpoints'), icon: 'DisableAllBreakpoints', disabled: rows.every((candidate) => !candidate.enabled), run: () => { for (const candidate of rows) void update(candidate.id, { enabled: false }) } },
    ], position)
  }
  return (
    <div className="debug-tool-pane">
      <div className="bookmarks-toolbar">
        <button className="icon-button" title={t('Add Module Breakpoint')} aria-label={t('Add Module Breakpoint')} onClick={() => void add()}><DsIcon name="Add" /></button>
        <button className="icon-button" title={t('Delete')} aria-label={t('Delete')} disabled={!selected} onClick={() => { if (selected) void remove([selected]) }}><DsIcon name="Cancel" /></button>
        <button className="icon-button" title={t('Delete All')} aria-label={t('Delete All')} disabled={rows.length === 0} onClick={() => void remove(rows.map((row) => row.id))}><DsIcon name="ClearBreakpointGroup" /></button>
      </div>
      <div
        className="debug-table debug-grid module-breakpoints-table"
        role="grid"
        aria-label={t('Module Breakpoints')}
        style={{ gridTemplateColumns: '28px minmax(140px, 2fr) minmax(50px, auto) minmax(70px, auto) minmax(70px, auto) minmax(70px, auto) minmax(90px, 1fr) minmax(90px, 1fr)' }}
        onContextMenu={(event) => { event.preventDefault(); openMenu({ x: event.clientX, y: event.clientY }) }}
        onKeyDown={(event) => { if (event.key === 'Delete' && selected && (event.target as HTMLElement).tagName !== 'INPUT') void remove([selected]) }}
      >
        <div className="debug-table-header" />
        <div className="debug-table-header">{t('Module Name')}</div>
        <div className="debug-table-header">{t('Order')}</div>
        <div className="debug-table-header">{t('Dynamic')}</div>
        <div className="debug-table-header">{t('In Memory')}</div>
        <div className="debug-table-header">{t('Loaded')}</div>
        <div className="debug-table-header">{t('AppDomain')}</div>
        <div className="debug-table-header">{t('Process')}</div>
        {rows.map((row) => (
          <div className={`debug-table-row${selected === row.id ? ' selected' : ''}`} role="row" key={row.id} onMouseDown={() => setSelected(row.id)}>
            <span><input type="checkbox" checked={row.enabled} aria-label={t(row.enabled ? 'Disable {name}' : 'Enable {name}', { name: row.moduleName || '*' })} onChange={() => void update(row.id, { enabled: !row.enabled })} /></span>
            <span><input className="debug-cell-input" aria-label={t('Module Name')} value={row.moduleName} placeholder="*" onChange={(event) => void update(row.id, { moduleName: event.target.value })} /></span>
            <span><input className="debug-cell-input" aria-label={t('Order')} value={row.order ?? ''} onChange={(event) => { const order = Number.parseInt(event.target.value, 10); void update(row.id, { order: Number.isFinite(order) ? order : undefined }) }} /></span>
            <span><TriState label={t('Dynamic')} value={row.isDynamic} onChange={(value) => void update(row.id, { isDynamic: value })} /></span>
            <span><TriState label={t('In Memory')} value={row.isInMemory} onChange={(value) => void update(row.id, { isInMemory: value })} /></span>
            <span><TriState label={t('Loaded')} value={row.isLoaded} onChange={(value) => void update(row.id, { isLoaded: value })} /></span>
            <span><input className="debug-cell-input" aria-label={t('AppDomain')} value={row.appDomainName ?? ''} onChange={(event) => void update(row.id, { appDomainName: event.target.value || undefined })} /></span>
            <span><input className="debug-cell-input" aria-label={t('Process')} value={row.processName ?? ''} onChange={(event) => void update(row.id, { processName: event.target.value || undefined })} /></span>
          </div>
        ))}
      </div>
    </div>
  )
}
