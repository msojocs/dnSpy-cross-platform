import { useEffect, useMemo, useRef, useState } from 'react'
import { showPopupMenu, type IPopupMenuItem, type PopupMenuEntry } from 'flexlayout-react'
import type { BookmarkLocationText, TextPart } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import {
  BREAKPOINT_COLUMNS,
  breakpointLocationFormat,
  breakpointRows,
  breakpointsCopyText,
  labelsText,
  nextBreakpointSort,
  parseLabels,
  rowImage,
  rowNameParts,
  rowSettings,
  rowTexts,
  sortBreakpointRows,
  type BreakpointColumn,
  type BreakpointRow,
  type BreakpointSort,
} from '../breakpoints-model'
import { useLanguage } from '../localization'
import { SearchMatcher } from '../tool-window-search'
import { saveAppOptions, useAppOptions, type BreakpointDisplaySettings } from './app-options'
import { ColoredText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'
import { AskTextDialog } from './EditDialogs'

// dnSpy's Breakpoints window (CodeBreakpointsControl): a sortable list of every code breakpoint, its toolbar, its
// search box with the tool windows' column options, and the context menu the WPF window carries. This port's
// breakpoints by method name are rows of it too, with the box they are typed into under the list.

const menuItem = (key: string, label: string, onSelect: () => void, options: { disabled?: boolean; shortcut?: string; checked?: boolean; icon?: string } = {}): IPopupMenuItem => ({
  key,
  content: (
    <>
      <span className="document-tab-menu-icon">{options.checked !== undefined ? <MenuEntryIcon checked={options.checked} /> : <MenuEntryIcon name={options.icon} />}</span>
      <span className="document-tab-menu-label">{label}</span>
      {options.shortcut && <span className="document-tab-menu-shortcut">{options.shortcut}</span>}
    </>
  ),
  disabled: options.disabled,
  onSelect,
})

// The Show... options of the context menu, in dnSpy's order (GROUP_CTX_DBG_CODEBPS_OPTS).
const DISPLAY_OPTIONS: [keyof BreakpointDisplaySettings, string][] = [
  ['showTokens', 'Show Tokens'],
  ['showModuleNames', 'Show Module Names'],
  ['showParameterTypes', 'Show Parameter Types'],
  ['showParameterNames', 'Show Parameter Names'],
  ['showDeclaringTypes', 'Show Declaring Types'],
  ['showNamespaces', 'Show Namespaces'],
  ['showReturnTypes', 'Show Return Types'],
  ['showIntrinsicTypeKeywords', 'Show Intrinsic Type Keywords'],
]

/**
 * The Name cells of the code breakpoints, keyed by row id: the backend writes them with the C# formatter and the
 * window's display options, again whenever the locations, the options or the workspace change.
 */
const useNameTexts = (rows: BreakpointRow[], settings: BreakpointDisplaySettings): Map<string, BookmarkLocationText> => {
  const workspaceId = useAppStore((state) => state.workspaceId)
  const workspaceStateId = useAppStore((state) => state.workspaceStateId)
  const modulesCount = useAppStore((state) => state.modules.length)
  const [texts, setTexts] = useState(() => new Map<string, BookmarkLocationText>())
  const requestRef = useRef(0)
  const locatable = useMemo(() => rows.flatMap((row) =>
    row.kind === 'line' && row.breakpoint.modulePath && row.breakpoint.metadataToken !== undefined && row.breakpoint.ilOffset !== undefined
      ? [{ id: row.id, modulePath: row.breakpoint.modulePath, metadataToken: row.breakpoint.metadataToken, ilOffset: row.breakpoint.ilOffset }]
      : []), [rows])
  const locationsKey = locatable.map((location) => `${location.id}|${location.modulePath}|${location.metadataToken}|${location.ilOffset}`).join('\n')
  const format = breakpointLocationFormat(settings)
  const formatKey = JSON.stringify(format)

  useEffect(() => {
    const request = ++requestRef.current
    const formatLocations = window.dnSpy?.formatBookmarkLocations
    if (locatable.length === 0 || !formatLocations)
      return
    formatLocations(workspaceId, locatable.map(({ modulePath, metadataToken, ilOffset }) => ({ modulePath, metadataToken, ilOffset })), format).then((written) => {
      if (request === requestRef.current)
        setTexts(new Map(locatable.map((location, index) => [location.id, written[index]])))
    }, () => {
      // A backend that cannot answer leaves the cells to what the breakpoints carry.
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsKey, formatKey, workspaceId, workspaceStateId, modulesCount])
  return texts
}

/** A cell's text with the search's matches marked, the way dnSpy's list highlights them. */
export const Highlighted = ({ text, spans }: { text: string; spans: { start: number; length: number }[] }): React.JSX.Element => {
  if (spans.length === 0)
    return <>{text}</>
  const marks = new Array<boolean>(text.length).fill(false)
  for (const span of spans)
    for (let index = span.start; index < span.start + span.length && index < text.length; index++)
      marks[index] = true
  const pieces: React.ReactNode[] = []
  let start = 0
  for (let index = 1; index <= text.length; index++) {
    if (index === text.length || marks[index] !== marks[start]) {
      const piece = text.slice(start, index)
      pieces.push(marks[start] ? <mark key={start} className="search-match">{piece}</mark> : piece)
      start = index
    }
  }
  return <>{pieces}</>
}

export const BreakpointsPane = (): React.JSX.Element => {
  const lineBreakpoints = useAppStore((state) => state.lineBreakpoints)
  const functionBreakpoints = useAppStore((state) => state.functionBreakpoints)
  const debugging = useAppStore((state) => state.debugState !== 'inactive')
  const removeBreakpoints = useAppStore((state) => state.removeBreakpoints)
  const setBreakpointsEnabled = useAppStore((state) => state.setBreakpointsEnabled)
  const setBreakpointsLabels = useAppStore((state) => state.setBreakpointsLabels)
  const resetBreakpointHitCounts = useAppStore((state) => state.resetBreakpointHitCounts)
  const editBreakpointSettings = useAppStore((state) => state.editBreakpointSettings)
  const goToLineBreakpoint = useAppStore((state) => state.goToLineBreakpoint)
  const goToBreakpointDisassembly = useAppStore((state) => state.goToBreakpointDisassembly)
  const exportBreakpoints = useAppStore((state) => state.exportBreakpoints)
  const importBreakpointFile = useAppStore((state) => state.importBreakpointFile)
  const addFunctionBreakpoint = useAppStore((state) => state.addFunctionBreakpoint)
  const options = useAppOptions()
  const settings = options.breakpoints
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<BreakpointSort>()
  const [selected, setSelected] = useState<string[]>([])
  const [editingLabels, setEditingLabels] = useState<string>()
  const [labelsDialog, setLabelsDialog] = useState<{ ids: string[]; text: string }>()
  const [functionName, setFunctionName] = useState('')
  const [status, setStatus] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()

  const allRows = useMemo(() => breakpointRows(lineBreakpoints, functionBreakpoints), [lineBreakpoints, functionBreakpoints])
  const nameTexts = useNameTexts(allRows, settings)
  const columns = useMemo(() => BREAKPOINT_COLUMNS.map((column) => ({ ...column, name: t(column.header) })), [t])
  const matcher = useMemo(() => new SearchMatcher(columns.map(({ id, shortOption, name }) => ({ id, shortOption, name }))).setSearchText(query), [columns, query])

  const nameOf = useMemo(() => {
    const cache = new Map<string, TextPart[]>()
    return (row: BreakpointRow): TextPart[] => {
      let parts = cache.get(row.id)
      if (!parts) {
        parts = rowNameParts(row, nameTexts.get(row.id), settings.showTokens)
        cache.set(row.id, parts)
      }
      return parts
    }
  }, [nameTexts, settings.showTokens])
  const textOf = useMemo(() => {
    const cache = new Map<string, Record<BreakpointColumn, string>>()
    return (row: BreakpointRow): Record<BreakpointColumn, string> => {
      let texts = cache.get(row.id)
      if (!texts) {
        texts = rowTexts(row, nameOf(row), debugging, t)
        cache.set(row.id, texts)
      }
      return texts
    }
  }, [nameOf, debugging, t])

  const rows = useMemo(() => sortBreakpointRows(
    allRows.filter((row) => matcher.isMatchAll(BREAKPOINT_COLUMNS.map((column) => textOf(row)[column.id]))),
    sort,
    textOf,
  ), [allRows, matcher, sort, textOf])

  // A selection that outlived its rows would leave the commands acting on nothing.
  useEffect(() => {
    setSelected((current) => {
      const alive = current.filter((id) => rows.some((row) => row.id === id))
      return alive.length === current.length ? current : alive
    })
  }, [rows])

  const selectedRows = (ids = selected): BreakpointRow[] => rows.filter((row) => ids.includes(row.id))

  const selectRow = (id: string, event: React.MouseEvent): void => {
    setSelected((current) => {
      if (event.ctrlKey || event.metaKey)
        return current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
      if (event.shiftKey && current.length > 0) {
        const from = rows.findIndex((row) => row.id === current[current.length - 1])
        const to = rows.findIndex((row) => row.id === id)
        if (from >= 0 && to >= 0)
          return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.id)
      }
      return [id]
    })
  }

  const copyRows = (chosen: BreakpointRow[]): void => {
    if (chosen.length > 0)
      void navigator.clipboard?.writeText(breakpointsCopyText(chosen.map(textOf), BREAKPOINT_COLUMNS.map((column) => column.id)))
  }

  // dnSpy's Enable/Disable over a set: all of them enabled turns them off, anything else turns them on.
  const toggleEnabled = (chosen: BreakpointRow[]): void => {
    if (chosen.length > 0)
      void setBreakpointsEnabled(chosen.map((row) => row.id), !chosen.every((row) => row.enabled))
  }

  const goTo = (row: BreakpointRow | undefined, newTab = false): void => {
    if (row?.kind === 'line')
      void goToLineBreakpoint(row.id, newTab)
  }

  const canGoToDisassembly = (chosen: BreakpointRow[]): boolean =>
    debugging && chosen.length === 1 && chosen[0].kind === 'line' && chosen[0].breakpoint.state === 'bound'

  const runExport = async (chosen: BreakpointRow[]): Promise<void> => {
    try {
      const path = await exportBreakpoints(chosen.map((row) => row.id))
      setStatus(path ? t('Exported breakpoints to {path}.', { path }) : '')
    } catch (error) {
      await window.dnSpy.showMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const runImport = async (): Promise<void> => {
    let text: string | undefined
    try {
      text = await window.dnSpy.readTextFile('breakpoints')
    } catch (error) {
      await window.dnSpy.showMessage(error instanceof Error ? error.message : String(error))
      return
    }
    if (text === undefined)
      return
    const result = await importBreakpointFile(text)
    if (!result) {
      await window.dnSpy.showMessage(t('The breakpoint file could not be read.'))
      return
    }
    setStatus(result.skipped > 0
      ? t('Imported {count} breakpoint(s); skipped {skipped} the file cannot place.', { count: result.added, skipped: result.skipped })
      : t('Imported {count} breakpoint(s).', { count: result.added }))
  }

  // dnSpy's Edit Labels: in place over one row, through a box over several.
  const editLabels = (chosen: BreakpointRow[]): void => {
    if (chosen.length === 1)
      setEditingLabels(chosen[0].id)
    else if (chosen.length > 1)
      setLabelsDialog({ ids: chosen.map((row) => row.id), text: labelsText(rowSettings(chosen[0])) })
  }

  const focusSearch = (): void => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }

  const showSearchHelp = (): void => {
    void window.dnSpy.showMessage(matcher.helpText(t))
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const key = event.key.toLowerCase()
    if (event.ctrlKey && !event.altKey && (key === 'f' || key === 'e')) {
      event.preventDefault()
      focusSearch()
      return
    }
    if ((event.target as HTMLElement).matches('input, textarea'))
      return
    const chosen = selectedRows()
    if (event.key === 'Delete' && chosen.length > 0) {
      event.preventDefault()
      void removeBreakpoints(chosen.map((row) => row.id))
    } else if (event.key === 'F2' && chosen.length > 0) {
      event.preventDefault()
      editLabels(chosen)
    } else if (event.key === 'Enter' && event.altKey && chosen.length > 0) {
      event.preventDefault()
      editBreakpointSettings(chosen.map((row) => row.id))
    } else if (event.key === 'Enter' && chosen.length === 1) {
      event.preventDefault()
      goTo(chosen[0], event.ctrlKey || event.shiftKey)
    } else if (event.key === ' ' && !event.ctrlKey && !event.shiftKey && !event.altKey && chosen.length > 0 && !editingLabels) {
      event.preventDefault()
      toggleEnabled(chosen)
    } else if (event.ctrlKey && key === 'a') {
      event.preventDefault()
      setSelected(rows.map((row) => row.id))
    } else if (event.ctrlKey && (key === 'c' || event.key === 'Insert') && chosen.length > 0) {
      event.preventDefault()
      copyRows(chosen)
    }
  }

  const showContextMenu = (row: BreakpointRow | undefined, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    let ids = selected
    if (row && !selected.includes(row.id)) {
      ids = [row.id]
      setSelected(ids)
    }
    const chosen = selectedRows(ids)
    const items: PopupMenuEntry[] = [
      menuItem('copy', t('Copy'), () => copyRows(chosen), { disabled: chosen.length === 0, shortcut: 'Ctrl+C', icon: 'Copy' }),
      menuItem('select-all', t('Select All'), () => setSelected(rows.map((candidate) => candidate.id)), { disabled: chosen.length === rows.length, shortcut: 'Ctrl+A', icon: 'Select' }),
      { type: 'divider', key: 'breakpoints-code' },
      menuItem('go-to', t('Go To Source Code'), () => goTo(chosen[0]), { disabled: chosen.length !== 1 || chosen[0].kind !== 'line', shortcut: t('Enter'), icon: 'GoToSourceCode' }),
      menuItem('go-to-disassembly', t('Go To Disassembly'), () => { if (chosen[0]) void goToBreakpointDisassembly(chosen[0].id) }, { disabled: !canGoToDisassembly(chosen), icon: 'DisassemblyWindow' }),
      { type: 'divider', key: 'breakpoints-settings' },
      menuItem('settings', t('Settings'), () => editBreakpointSettings(chosen.map((candidate) => candidate.id)), { disabled: chosen.length === 0, shortcut: 'Alt+Enter', icon: 'Settings' }),
      menuItem('edit-labels', t('Edit Labels'), () => editLabels(chosen), { disabled: chosen.length === 0 || (chosen.length === 1 && editingLabels === chosen[0].id), shortcut: 'F2' }),
      menuItem('reset-hit-count', t('Reset Hit Count'), () => void resetBreakpointHitCounts(chosen.map((candidate) => candidate.id)), { disabled: chosen.length === 0 }),
      { type: 'divider', key: 'breakpoints-commands' },
      menuItem('remove', t('Remove Breakpoint'), () => void removeBreakpoints(chosen.map((candidate) => candidate.id)), { disabled: chosen.length === 0, shortcut: 'Del', icon: 'Cancel' }),
      menuItem('remove-all', t('Remove All Breakpoints'), () => void removeBreakpoints(rows.map((candidate) => candidate.id)), { disabled: rows.length === 0, icon: 'ClearBreakpointGroup' }),
      ...(chosen.some((candidate) => !candidate.enabled) ? [menuItem('enable', t('Enable Breakpoint'), () => void setBreakpointsEnabled(chosen.map((candidate) => candidate.id), true))] : []),
      ...(chosen.some((candidate) => candidate.enabled) ? [menuItem('disable', t('Disable Breakpoint'), () => void setBreakpointsEnabled(chosen.map((candidate) => candidate.id), false))] : []),
      { type: 'divider', key: 'breakpoints-export' },
      menuItem('export', t('Export Selected...'), () => void runExport(chosen), { disabled: chosen.length === 0, icon: 'Open' }),
      { type: 'divider', key: 'breakpoints-options' },
      ...DISPLAY_OPTIONS.map(([key, label]) => menuItem(key, t(label), () => saveAppOptions({ ...options, breakpoints: { ...settings, [key]: !settings[key] } }), { checked: settings[key] })),
    ]
    showPopupMenu({ anchor: { x: event.clientX, y: event.clientY }, returnFocusTo: event.currentTarget, title: t('Breakpoints'), items, onClose: () => undefined })
  }

  const cellText = (row: BreakpointRow, column: BreakpointColumn): React.ReactNode => {
    const text = textOf(row)[column]
    return <Highlighted text={text} spans={matcher.matchSpans(column, text)} />
  }

  const chosen = selectedRows()
  const submitFunction = (): void => {
    if (functionName.trim()) {
      void addFunctionBreakpoint(functionName)
      setFunctionName('')
    }
  }

  return (
    <div className={`breakpoints-pane${options.debugger.syntaxHighlight ? '' : ' debug-plain'}`} onKeyDown={onKeyDown} tabIndex={-1}>
      {/* CodeBreakpointsControl.xaml's tool bar, each button with the image and the tool tip dnSpy gives it. */}
      <div className="bookmarks-toolbar breakpoints-toolbar">
        <button className="icon-button" title={t('Remove breakpoint')} aria-label={t('Remove breakpoint')} disabled={chosen.length === 0} onClick={() => void removeBreakpoints(chosen.map((row) => row.id))}><DsIcon name="Cancel" /></button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Remove all breakpoints matching the current search criteria')} aria-label={t('Remove all breakpoints matching the current search criteria')} disabled={rows.length === 0} onClick={() => void removeBreakpoints(rows.map((row) => row.id))}><DsIcon name="ClearBreakpointGroup" /></button>
        <button className="icon-button" title={t('Enable or disable all breakpoints matching the current search criteria')} aria-label={t('Enable or disable all breakpoints matching the current search criteria')} disabled={rows.length === 0} onClick={() => toggleEnabled(rows)}><DsIcon name="ToggleAllBreakpoints" /></button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Export all breakpoints matching the current search criteria')} aria-label={t('Export all breakpoints matching the current search criteria')} disabled={rows.length === 0} onClick={() => void runExport(rows)}><DsIcon name="Open" /></button>
        <button className="icon-button" title={t('Import breakpoints from a file')} aria-label={t('Import breakpoints from a file')} onClick={() => void runImport()}><DsIcon name="Import" /></button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Go To Source Code')} aria-label={t('Go To Source Code')} disabled={chosen.length !== 1 || chosen[0].kind !== 'line'} onClick={() => goTo(chosen[0])}><DsIcon name="GoToSourceCode" /></button>
        <button className="icon-button" title={t('Go To Disassembly')} aria-label={t('Go To Disassembly')} disabled={!canGoToDisassembly(chosen)} onClick={() => { if (chosen[0]) void goToBreakpointDisassembly(chosen[0].id) }}><DsIcon name="DisassemblyWindow" /></button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Reset all search criteria so that all breakpoints are shown')} aria-label={t('Reset all search criteria so that all breakpoints are shown')} disabled={query === ''} onClick={() => setQuery('')}><DsIcon name="ClearWindowContent" /></button>
        <span className="bookmarks-separator" />
        <label className="breakpoints-search-label" title={t('Search for a breakpoint (Ctrl+F)')}>{t('Search')}</label>
        <input
          ref={searchRef}
          className="breakpoints-search"
          aria-label={t('Search for a breakpoint')}
          title={t('Search for a breakpoint (Ctrl+F)')}
          value={query}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="icon-button" title={t('Help')} aria-label={t('Help')} onClick={showSearchHelp}><DsIcon name="StatusHelp" /></button>
        {status && <span className="bookmarks-status">{status}</span>}
      </div>
      {rows.length === 0 && query.trim() !== '' ? (
        <div className="breakpoints-no-match">
          <span>{t('No breakpoints match your search filter.')}</span>
          <button className="icon-button" title={t('Reset all search criteria so that all breakpoints are shown')} aria-label={t('Reset all search criteria so that all breakpoints are shown')} onClick={() => setQuery('')}><DsIcon name="ClearWindowContent" /></button>
        </div>
      ) : (
        <div className="breakpoints-table" role="table" aria-label={t('Breakpoints')} ref={listRef} onContextMenu={(event) => showContextMenu(undefined, event)}>
          <div className="breakpoints-header" role="row">
            {columns.map((column) => (
              <span
                key={column.id}
                role="columnheader"
                aria-sort={sort?.column === column.id ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                onClick={() => setSort((current) => nextBreakpointSort(current, column.id))}
              >
                {column.name}
                {sort?.column === column.id && <span className="bookmarks-sort-arrow" aria-hidden>{sort.descending ? '▼' : '▲'}</span>}
              </span>
            ))}
          </div>
          <div className="breakpoints-rows">
            {rows.map((row) => {
              const severity = row.kind === 'line' ? row.breakpoint.severity : undefined
              const message = severity && row.kind === 'line' && row.breakpoint.message ? t('The breakpoint will not currently be hit. {message}', { message: t(row.breakpoint.message) }) : undefined
              const nameText = textOf(row).name
              return (
                <div
                  className={`breakpoint-row${selected.includes(row.id) ? ' selected' : ''}${row.enabled ? '' : ' breakpoint-disabled'}`}
                  role="row"
                  aria-selected={selected.includes(row.id)}
                  data-breakpoint-id={row.id}
                  key={row.id}
                  onMouseDown={(event) => { if (event.button === 0 || !selected.includes(row.id)) selectRow(row.id, event) }}
                  onDoubleClick={(event) => { if (!editingLabels) goTo(row, event.shiftKey || event.ctrlKey) }}
                  onContextMenu={(event) => { event.stopPropagation(); showContextMenu(row, event) }}
                >
                  <span className="breakpoint-name-cell" title={message}>
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      aria-label={t(row.enabled ? 'Disable {name}' : 'Enable {name}', { name: nameText })}
                      onChange={() => void setBreakpointsEnabled([row.id], !row.enabled)}
                      onMouseDown={(event) => event.stopPropagation()}
                    />
                    <DsIcon name={rowImage(row)} className={`breakpoint-row-image breakpoint-image-${rowImage(row)}`} />
                    <span className="breakpoint-name" title={message ?? nameText}>
                      {matcher.matchSpans('name', nameText).length > 0 ? <Highlighted text={nameText} spans={matcher.matchSpans('name', nameText)} /> : <ColoredText parts={nameOf(row)} />}
                    </span>
                  </span>
                  <span className="breakpoint-labels-cell" onDoubleClick={(event) => { event.stopPropagation(); setEditingLabels(row.id) }}>
                    {editingLabels === row.id ? (
                      <LabelsInput
                        value={labelsText(rowSettings(row))}
                        label={t('Labels')}
                        onCommit={(value) => { void setBreakpointsLabels([row.id], parseLabels(value)); setEditingLabels(undefined); listRef.current?.focus() }}
                        onCancel={() => setEditingLabels(undefined)}
                      />
                    ) : <span title={textOf(row).labels}>{cellText(row, 'labels')}</span>}
                  </span>
                  <span title={textOf(row).condition}>{cellText(row, 'condition')}</span>
                  <span title={textOf(row).hitCount}>{cellText(row, 'hitCount')}</span>
                  <span title={textOf(row).filter}>{cellText(row, 'filter')}</span>
                  <span title={textOf(row).whenHit}>{cellText(row, 'whenHit')}</span>
                  <span title={row.kind === 'line' ? row.breakpoint.modulePath : undefined}>{cellText(row, 'module')}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {/* This port's breakpoints by method name: the method, matched by name when its module loads. */}
      <div className="debug-input-row">
        <input aria-label={t('Function breakpoint')} placeholder="Namespace.Type.Method" value={functionName} onChange={(event) => setFunctionName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitFunction() }} />
        <button className="icon-button" aria-label={t('Add function breakpoint')} title={t('Add function breakpoint')} disabled={!functionName.trim()} onClick={submitFunction}><DsIcon name="Add" /></button>
      </div>
      {labelsDialog && (
        <AskTextDialog
          title={t('Edit Labels')}
          label={t('Labels')}
          initialText={labelsDialog.text}
          onClose={() => setLabelsDialog(undefined)}
          onOk={(text) => {
            void setBreakpointsLabels(labelsDialog.ids, parseLabels(text))
            setLabelsDialog(undefined)
          }}
        />
      )}
    </div>
  )
}

// Commits once: Escape must not be undone by the blur that follows the input being removed.
const LabelsInput = ({ value, label, onCommit, onCancel }: { value: string; label: string; onCommit(value: string): void; onCancel(): void }): React.JSX.Element => {
  const [text, setText] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)
  useEffect(() => inputRef.current?.select(), [])
  const finish = (commit: boolean): void => {
    if (doneRef.current)
      return
    doneRef.current = true
    if (commit)
      onCommit(text)
    else
      onCancel()
  }
  return (
    <input
      ref={inputRef}
      className="bookmark-edit"
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(true)}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter')
          finish(true)
        else if (event.key === 'Escape')
          finish(false)
      }}
    />
  )
}
