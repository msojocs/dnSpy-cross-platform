import { useMemo, useState, type ReactNode } from 'react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { DebugModule, DebugStackFrame, DebugThread } from '../../../shared/protocol'
import { breakpointConditionsSummary, breakpointsFile, methodBreakpointName, parseLineBreakpointEntries, parseFunctionBreakpoints, useAppStore } from '../app-store'
import type { BreakpointSettings, LineBreakpoint } from '../app-store'
import { useLanguage } from '../localization'
import { loadAppOptions, saveAppOptions, useAppOptions, type CallStackSettings, type DebuggerOptions } from './app-options'
import { BreakpointSettingsDialog } from './BreakpointSettingsDialog'
import { ColoredText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'

export { LocalsPane, WatchPane, AutosPane, StaticFieldsPane } from './DebugVariablesWindows'

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
  const showToolWindow = useAppStore((state) => state.openToolWindow)
  const options = useAppOptions()
  const { t } = useLanguage()
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
      { key: 'go-to-disassembly', label: t('Go To Disassembly'), icon: 'DisassemblyWindow', disabled: !frame || frame.isInternal === true, run: () => { if (frame) { void switchToFrame(frame.id).then(() => showToolWindow?.('disassembly')) } } },
      { key: 'run-to-cursor', label: t('Run To Cursor'), icon: 'Cursor', shortcut: 'Ctrl+F10', disabled: !frame || frame.isInternal === true || frame.id === top?.id, run: () => { if (frame) void runToCursor(frame.id) } },
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

export const ThreadsPane = (): React.JSX.Element => {
  const threads = useAppStore((state) => state.debugThreads)
  const selectedThreadId = useAppStore((state) => state.selectedDebugThreadId)
  const selectThread = useAppStore((state) => state.selectDebugThread)
  const freeze = useAppStore((state) => state.freezeDebugThreads)
  const rename = useAppStore((state) => state.renameDebugThread)
  const debugState = useAppStore((state) => state.debugState)
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string>()
  const [renaming, setRenaming] = useState<{ id: number; text: string }>()
  const { t } = useLanguage()
  const columns: GridColumn<DebugThread>[] = useMemo(() => [
    { key: 'marker', header: '', width: '22px', text: () => '', render: (thread) => thread.id === selectedThreadId ? <DsIcon name="CurrentInstructionPointer" /> : thread.isFrozen ? <DsIcon name="Pause" /> : null },
    { key: 'id', header: t('ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.id, hex) },
    { key: 'managed-id', header: t('Managed ID'), width: 'minmax(60px, auto)', text: (thread) => formatNumber(thread.managedId, hex) },
    { key: 'category', header: t('Category'), width: 'minmax(80px, auto)', text: (thread) => thread.category ? t(thread.category) : '', render: (thread) => <><DsIcon name={threadCategoryImage(thread.category)} className="debug-variable-image" />{thread.category ? t(thread.category) : ''}</> },
    {
      key: 'name',
      header: t('Name'),
      width: 'minmax(100px, 1fr)',
      text: (thread) => thread.name,
      render: (thread) => renaming?.id === thread.id ? (
        <input
          className="debug-value-editor"
          autoFocus
          aria-label={t('Name')}
          value={renaming.text}
          onChange={(event) => setRenaming({ id: thread.id, text: event.target.value })}
          onBlur={() => { void rename(thread.id, renaming.text.trim() || null); setRenaming(undefined) }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') { void rename(thread.id, renaming.text.trim() || null); setRenaming(undefined) }
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
  ], [t, hex, selectedThreadId, renaming, rename])
  const openMenu = (thread: DebugThread | undefined, position: { x: number; y: number }): void => {
    showDebugMenu(t('Threads'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !thread, run: () => { if (thread) copyText(columns.map((column) => column.text(thread)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(threads.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      null,
      { key: 'switch', label: t('Switch To Thread'), shortcut: t('Enter'), disabled: !thread || debugState !== 'stopped', run: () => { if (thread) void selectThread(thread.id) } },
      { key: 'rename', label: t('Rename'), disabled: !thread, run: () => { if (thread) setRenaming({ id: thread.id, text: thread.name }) } },
      { key: 'freeze', label: t('Freeze'), disabled: !thread || thread.isFrozen === true, run: () => { if (thread) void freeze([thread.id], true) } },
      { key: 'thaw', label: t('Thaw'), disabled: !thread || thread.isFrozen !== true, run: () => { if (thread) void freeze([thread.id], false) } },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <DebugGrid
      label={t('Threads')}
      columns={columns}
      rows={threads}
      rowKey={(thread) => String(thread.id)}
      selected={selected}
      onSelect={setSelected}
      onActivate={(thread) => { if (debugState === 'stopped') void selectThread(thread.id) }}
      onMenu={openMenu}
      rowClass={(thread) => `thread-row${thread.id === selectedThreadId ? ' thread-current' : ''}`}
    />
  )
}

// A line breakpoint is identified by the method it lives in plus the line, so two breakpoints in the same method
// do not read as the same row. The method name is the dotted form the Debug menu also uses, which keeps the pane
// and the "Toggle Method Breakpoint" entry speaking the same language.
const lineBreakpointLabel = (breakpoint: LineBreakpoint): string => {
  const method = methodBreakpointName(breakpoint.description)
  return method ? `${method}:${breakpoint.line}` : `Line ${breakpoint.line}`
}

export const BreakpointsPane = (): React.JSX.Element => {
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  // Which breakpoint's settings dialog is open: a line breakpoint by id, a function one by name.
  const [editing, setEditing] = useState<{ kind: 'line' | 'function'; key: string }>()
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const removeLineBreakpoint = useAppStore((state) => state.removeLineBreakpoint)
  const setLineBreakpointEnabled = useAppStore((state) => state.setLineBreakpointEnabled)
  const setLineBreakpointSettings = useAppStore((state) => state.setLineBreakpointSettings)
  const breakpoints = useAppStore((state) => state.functionBreakpoints)
  const addBreakpoint = useAppStore((state) => state.addFunctionBreakpoint)
  const removeBreakpoint = useAppStore((state) => state.removeFunctionBreakpoint)
  const setBreakpointEnabled = useAppStore((state) => state.setFunctionBreakpointEnabled)
  const setBreakpointSettings = useAppStore((state) => state.setFunctionBreakpointSettings)
  const importBreakpoints = useAppStore((state) => state.importBreakpoints)
  const goToLineBreakpoint = useAppStore((state) => state.goToLineBreakpoint)
  const deleteAll = useAppStore((state) => state.deleteAllBreakpoints)
  const [search, setSearch] = useState('')
  const { t } = useLanguage()
  // dnSpy's search box filters on every column the window shows: the location, the labels and the settings.
  const matches = (...texts: (string | undefined)[]): boolean => {
    const needle = search.trim().toLowerCase()
    return !needle || texts.some((text) => text?.toLowerCase().includes(needle))
  }
  const visibleLineBreakpoints = lineBreakpoints.filter((breakpoint) => matches(lineBreakpointLabel(breakpoint), breakpoint.modulePath, breakpoint.settings?.labels?.join(' '), breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)))
  const visibleFunctionBreakpoints = breakpoints.filter((breakpoint) => matches(breakpoint.name, breakpoint.settings?.labels?.join(' '), breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)))
  const openLineMenu = (breakpoint: LineBreakpoint, position: { x: number; y: number }): void => {
    showDebugMenu(t('Breakpoints'), [
      { key: 'go-to-code', label: t('Go To Source Code'), icon: 'GoToSourceCode', shortcut: t('Enter'), run: () => void goToLineBreakpoint(breakpoint.id) },
      { key: 'go-to-code-new-tab', label: t('Go To Source Code (New Tab)'), run: () => void goToLineBreakpoint(breakpoint.id, true) },
      null,
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', run: () => copyText([lineBreakpointLabel(breakpoint), breakpoint.modulePath ?? '', breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount) ?? ''].join('\t')) },
      null,
      { key: 'toggle', label: breakpoint.enabled ? t('Disable Breakpoint') : t('Enable Breakpoint'), icon: 'ToggleAllBreakpoints', shortcut: t('Space'), run: () => void setLineBreakpointEnabled(breakpoint.id, !breakpoint.enabled) },
      { key: 'settings', label: t('Settings...'), icon: 'Settings', shortcut: 'Alt+Enter', run: () => setEditing({ kind: 'line', key: breakpoint.id }) },
      null,
      { key: 'delete', label: t('Delete'), icon: 'Cancel', shortcut: 'Del', run: () => void removeLineBreakpoint(breakpoint.id) },
      { key: 'delete-all', label: t('Delete All Breakpoints'), icon: 'ClearBreakpointGroup', shortcut: 'Ctrl+Shift+F9', run: () => void deleteAll?.() },
      null,
      { key: 'export', label: t('Export Breakpoints'), icon: 'Open', run: () => void exportBreakpoints() },
      { key: 'import', label: t('Import Breakpoints'), icon: 'Import', run: () => void runImport() },
    ], position)
  }
  const submit = (): void => {
    if (name.trim()) {
      void addBreakpoint(name)
      setName('')
    }
  }

  // The same file the settings are written as, so an export can be dropped back in by hand.
  const exportBreakpoints = async (): Promise<void> => {
    const file = breakpointsFile(useAppStore.getState())
    if (file.breakpoints.length === 0 && file.functions.length === 0)
      return
    const saved = await window.dnSpy.saveCode('breakpoints.json', JSON.stringify(file, null, 2))
    setStatus(saved ? t('Exported breakpoints to {path}.', { path: saved }) : '')
  }

  const runImport = async (): Promise<void> => {
    let text: string | undefined
    try {
      text = await window.dnSpy.readTextFile('breakpoints')
    } catch {
      // A file the host could not read is reported the same way a damaged one is.
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    if (text === undefined)
      return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    const stored = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    const file = {
      breakpoints: parseLineBreakpointEntries(parsed),
      functions: parseFunctionBreakpoints(stored.functions),
    }
    if (file.breakpoints.length === 0 && file.functions.length === 0) {
      setStatus(t('The breakpoint file could not be read.'))
      return
    }
    setStatus(t('Imported {count} breakpoint(s).', { count: await importBreakpoints(file) }))
  }

  return (
    <div className="debug-tool-pane">
      {/* CodeBreakpointsControl.xaml's import and export buttons, with the images dnSpy gives them; the
          settings and remove buttons on each row are its context menu's _Settings and Remove Breakpoint. */}
      <div className="bookmarks-toolbar">
        <button className="icon-button" title={t('Import Breakpoints')} aria-label={t('Import Breakpoints')} onClick={() => void runImport()}><DsIcon name="Import" /></button>
        <button
          className="icon-button"
          title={t('Export Breakpoints')}
          aria-label={t('Export Breakpoints')}
          disabled={lineBreakpoints.length === 0 && breakpoints.length === 0}
          onClick={() => void exportBreakpoints()}
        ><DsIcon name="Open" /></button>
        {status ? <span className="bookmarks-status">{status}</span> : null}
        <input className="breakpoints-search" type="search" aria-label={t('Search')} placeholder={t('Search')} value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="result-list">
        {visibleLineBreakpoints.map((breakpoint) => {
          const label = lineBreakpointLabel(breakpoint)
          const summary = breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)
          return (
            <div
              className={`breakpoint-row${breakpoint.enabled ? '' : ' breakpoint-disabled'}`}
              key={breakpoint.id}
              onDoubleClick={() => void goToLineBreakpoint(breakpoint.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                openLineMenu(breakpoint, { x: event.clientX, y: event.clientY })
              }}
            >
              <div className="breakpoint-main-row">
                <input
                  type="checkbox"
                  checked={breakpoint.enabled}
                  aria-label={t(breakpoint.enabled ? 'Disable {name}' : 'Enable {name}', { name: label })}
                  onChange={() => void setLineBreakpointEnabled(breakpoint.id, !breakpoint.enabled)}
                />
                <span className={`breakpoint-state breakpoint-state-${breakpoint.state}`} title={breakpoint.message ?? t('Bound')} />
                <span title={breakpoint.message ?? breakpoint.description}>{label}</span>
                {breakpoint.settings?.labels?.length ? <span className="breakpoint-labels">{breakpoint.settings.labels.join(', ')}</span> : null}
                <span className="breakpoint-module" title={breakpoint.modulePath}>{breakpoint.modulePath?.split(/[\\/]/).at(-1)}</span>
                <button
                  className="icon-button"
                  aria-label={t('Breakpoint settings for {name}', { name: label })}
                  title={t('Breakpoint settings')}
                  onClick={() => setEditing({ kind: 'line', key: breakpoint.id })}
                >
                  <DsIcon name="Settings" />
                </button>
                <button className="icon-button" aria-label={t('Remove {name}', { name: label })} onClick={() => void removeLineBreakpoint(breakpoint.id)}><DsIcon name="Cancel" /></button>
              </div>
              {summary && <div className="breakpoint-summary">{summary}</div>}
            </div>
          )
        })}
      </div>
      <div className="debug-input-row">
        <input aria-label={t('Function breakpoint')} placeholder="Namespace.Type.Method" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
        <button className="icon-button" aria-label={t('Add function breakpoint')} title={t('Add function breakpoint')} disabled={!name.trim()} onClick={submit}><DsIcon name="Add" /></button>
      </div>
      <div className="result-list">
        {visibleFunctionBreakpoints.map((breakpoint) => {
          const summary = breakpointConditionsSummary(breakpoint.settings, breakpoint.hitCount)
          return (
            <div className={`breakpoint-row${breakpoint.enabled ? '' : ' breakpoint-disabled'}`} key={breakpoint.name}>
              <div className="breakpoint-main-row">
                <input
                  type="checkbox"
                  checked={breakpoint.enabled}
                  aria-label={t(breakpoint.enabled ? 'Disable {name}' : 'Enable {name}', { name: breakpoint.name })}
                  onChange={() => void setBreakpointEnabled(breakpoint.name, !breakpoint.enabled)}
                />
                <span>{breakpoint.name}</span>
                <button
                  className="icon-button"
                  aria-label={t('Breakpoint settings for {name}', { name: breakpoint.name })}
                  title={t('Breakpoint settings')}
                  onClick={() => setEditing({ kind: 'function', key: breakpoint.name })}
                >
                  <DsIcon name="Settings" />
                </button>
                <button className="icon-button" aria-label={t('Remove {name}', { name: breakpoint.name })} onClick={() => void removeBreakpoint(breakpoint.name)}><DsIcon name="Cancel" /></button>
              </div>
              {summary && <div className="breakpoint-summary">{summary}</div>}
            </div>
          )
        })}
      </div>
      {editing && (
        <BreakpointSettingsDialog
          title={t('Breakpoint settings')}
          settings={
            editing.kind === 'line'
              ? lineBreakpoints.find((bp) => bp.id === editing.key)?.settings
              : breakpoints.find((bp) => bp.name === editing.key)?.settings
          }
          onClose={() => setEditing(undefined)}
          onSave={(settings) => {
            if (editing.kind === 'line') {
              void setLineBreakpointSettings(editing.key, settings)
            } else {
              void setBreakpointSettings(editing.key, settings)
            }
            setEditing(undefined)
          }}
        />
      )}
    </div>
  )
}

export const ModulesPane = (): React.JSX.Element => {
  const modules = useAppStore((state) => state.debugModules)
  const sessionId = useAppStore((state) => state.debugSessionId)
  const workspaceModules = useAppStore((state) => state.modules)
  const openPaths = useAppStore((state) => state.openPaths)
  const revealNode = useAppStore((state) => state.revealNode)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string>()
  const { t } = useLanguage()
  const yesNo = (value: boolean | null | undefined): string => value === null || value === undefined ? '' : value ? t('Yes') : t('No')
  const columns: GridColumn<DebugModule>[] = useMemo(() => [
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
  const goToModule = async (module: DebugModule): Promise<void> => {
    let path = module.path
    if (!path || module.isInMemory || module.isDynamic) {
      if (!sessionId || typeof module.id !== 'number') return
      path = await window.dnSpy.saveDebugModule(sessionId, module.id)
    }
    const known = workspaceModules.find((candidate) => candidate.path === path)
    if (!known)
      await openPaths([path])
    const opened = useAppStore.getState().modules.find((candidate) => candidate.path === path)
    if (opened)
      await revealNode(opened.id)
  }

  const saveModule = async (module: DebugModule): Promise<void> => {
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

  const openMenu = (module: DebugModule | undefined, position: { x: number; y: number }): void => {
    showDebugMenu(t('Modules'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !module, run: () => { if (module) copyText(columns.map((column) => column.text(module)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(modules.map((row) => columns.map((column) => column.text(row)).join('\t')).join('\n')) },
      null,
      { key: 'go-to-module', label: t('Go To Module'), shortcut: t('Enter'), disabled: !module, run: () => { if (module) void goToModule(module) } },
      { key: 'open-from-memory', label: t('Open Module from Memory'), disabled: !module || typeof module.id !== 'number', run: () => {
        if (!module || !sessionId || typeof module.id !== 'number') return
        void window.dnSpy.saveDebugModule(sessionId, module.id).then((path) => openPaths([path]))
      } },
      { key: 'load-all', label: t('Load All Modules'), disabled: modules.length === 0, run: () => void openPaths(modules.map((row) => row.path).filter((path): path is string => !!path && !workspaceModules.some((candidate) => candidate.path === path))) },
      null,
      { key: 'save', label: t('Save Module'), icon: 'Save', disabled: !module || typeof module.id !== 'number', run: () => { if (module) void saveModule(module) } },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <DebugGrid
      label={t('Modules')}
      columns={columns}
      rows={modules}
      rowKey={(module) => String(module.id)}
      selected={selected}
      onSelect={setSelected}
      onActivate={(module) => void goToModule(module)}
      onMenu={openMenu}
    />
  )
}

/** dnSpy's Processes window: the process each session debugs. */
export const ProcessesPane = (): React.JSX.Element => {
  const process = useAppStore((state) => state.debugProcess)
  const detach = useAppStore((state) => state.detachDebug)
  const terminate = useAppStore((state) => state.terminateDebug)
  const pause = useAppStore((state) => state.pauseDebug)
  const resume = useAppStore((state) => state.continueDebug)
  const debugState = useAppStore((state) => state.debugState)
  const options = useAppOptions()
  const hex = options.debugger.useHexadecimal
  const [selected, setSelected] = useState<string>()
  const { t } = useLanguage()
  const rows = process ? [process] : []
  const columns: GridColumn<NonNullable<typeof process>>[] = [
    { key: 'name', header: t('Name'), width: 'minmax(120px, 1fr)', text: (row) => row.name ?? '', render: (row) => <><DsIcon name="Process" className="debug-variable-image" />{row.name}</> },
    { key: 'id', header: t('ID'), width: 'minmax(70px, auto)', text: (row) => formatNumber(row.id, hex) },
    { key: 'title', header: t('Title'), width: 'minmax(80px, auto)', text: () => '' },
    { key: 'state', header: t('State'), width: 'minmax(70px, auto)', text: (row) => t(row.state) },
    { key: 'debugging', header: t('Debugging'), width: 'minmax(80px, auto)', text: (row) => row.debugging },
    { key: 'architecture', header: t('Architecture'), width: 'minmax(80px, auto)', text: (row) => row.architecture },
    { key: 'path', header: t('Path'), width: 'minmax(160px, 2fr)', text: (row) => row.path ?? '' },
  ]
  const openMenu = (row: typeof process, position: { x: number; y: number }): void => {
    showDebugMenu(t('Processes'), [
      { key: 'copy', label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !row, run: () => { if (row) copyText(columns.map((column) => column.text(row)).join('\t')) } },
      { key: 'select-all', label: t('Select All'), icon: 'Select', shortcut: 'Ctrl+A', run: () => copyText(rows.map((item) => columns.map((column) => column.text(item)).join('\t')).join('\n')) },
      null,
      { key: 'continue', label: t('Continue Process'), icon: 'Run', disabled: debugState !== 'stopped', run: () => void resume() },
      { key: 'break', label: t('Break Process'), icon: 'Pause', disabled: debugState !== 'running', run: () => void pause() },
      { key: 'detach', label: t('Detach Process'), disabled: !row, run: () => void detach() },
      { key: 'terminate', label: t('Terminate Process'), icon: 'TerminateProcess', disabled: !row, run: () => void terminate() },
      null,
      ...hexEntries(t, options.debugger),
    ], position)
  }
  return (
    <DebugGrid
      label={t('Processes')}
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.id)}
      selected={selected}
      onSelect={setSelected}
      onMenu={openMenu}
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
