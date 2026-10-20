import { useEffect, useMemo, useRef, useState } from 'react'
import type { DebugProcess } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { SearchMatcher } from '../tool-window-search'
import { Highlighted } from './BreakpointsWindow'
import { CloseGlyph } from './DsGlyphs'
import { DsIcon } from './DsIcon'

/** dnSpy's Attach to Process columns, with the search options SearchColumnDefinition gives each. */
const ATTACH_COLUMNS = [
  { id: 'process', shortOption: 'p', name: 'Process' },
  { id: 'pid', shortOption: 'i', name: 'ID' },
  { id: 'title', shortOption: 't', name: 'Title' },
  { id: 'type', shortOption: 'T', name: 'Type' },
  { id: 'architecture', shortOption: 'a', name: 'Architecture' },
  { id: 'filename', shortOption: 'f', name: 'Filename' },
  { id: 'commandLine', shortOption: 'c', name: 'Command Line' },
] as const

type AttachColumn = typeof ATTACH_COLUMNS[number]['id']

/** ProgramFormatter: what each column of a process reads. */
export const attachColumnTexts = (process: DebugProcess): Record<AttachColumn, string> => ({
  process: process.name,
  pid: String(process.processId),
  title: process.title ?? '',
  type: process.runtimeName ?? '',
  architecture: process.architecture ?? '',
  filename: process.executablePath ?? '',
  commandLine: process.commandLine ?? '',
})

const compareText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** AttachToProcessVM.GetDefaultOrder: by name, then id, then runtime. */
const defaultOrder = (a: DebugProcess, b: DebugProcess): number =>
  compareText(a.name, b.name) || a.processId - b.processId || compareText(a.runtimeName ?? '', b.runtimeName ?? '')

/** AttachToProcessVM.Compare: the sorted column, the default order breaking ties. */
export const sortAttachableProcesses = (processes: DebugProcess[], sort?: { column: AttachColumn; descending: boolean }): DebugProcess[] => {
  const sorted = [...processes]
  sorted.sort((a, b) => {
    if (!sort)
      return defaultOrder(a, b)
    const diff = sort.column === 'pid'
      ? a.processId - b.processId
      : compareText(attachColumnTexts(a)[sort.column], attachColumnTexts(b)[sort.column])
    const result = diff || defaultOrder(a, b)
    return sort.descending ? -result : result
  })
  return sorted
}

/**
 * dnSpy's Attach to Process dialog: the processes with a runtime the debugger can attach to, minus those it debugs
 * already, in a sortable list with the tool windows' search box. Several can be picked and attached to at once.
 */
export const AttachDialog = ({ onClose }: { onClose(): void }): React.JSX.Element => {
  const [processes, setProcesses] = useState<DebugProcess[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<number[]>([])
  const [anchor, setAnchor] = useState<number>()
  const [sort, setSort] = useState<{ column: AttachColumn; descending: boolean }>()
  const attachDebug = useAppStore((state) => state.attachDebug)
  const debugSessions = useAppStore((state) => state.debugSessions)
  const debugProcess = useAppStore((state) => state.debugProcess)
  const { t } = useLanguage()
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const columns = useMemo(() => ATTACH_COLUMNS.map((column) => ({ ...column, name: t(column.name) })), [t])
  const matcher = useMemo(() => new SearchMatcher(columns).setSearchText(query), [columns, query])

  const refresh = (): void => {
    if (loading) return
    setLoading(true)
    void window.dnSpy.listDebugProcesses().then(setProcesses).catch(() => setProcesses([])).finally(() => setLoading(false))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [])

  // DbgManager.CanDebugRuntime: a process the debugger is debugging already is not offered again.
  const debugged = useMemo(() => new Set([...debugSessions.map((entry) => entry.process?.id), debugProcess?.id].filter((id): id is number => id !== undefined)), [debugSessions, debugProcess])
  const rows = useMemo(() => sortAttachableProcesses(
    processes.filter((process) => !debugged.has(process.processId) && matcher.isMatchAll(ATTACH_COLUMNS.map((column) => attachColumnTexts(process)[column.id]))),
    sort), [processes, debugged, matcher, sort])

  // AttachToProcessVM.FilterList: with nothing selected, the first process is.
  useEffect(() => {
    const visible = selected.filter((id) => rows.some((row) => row.processId === id))
    if (visible.length !== selected.length || (visible.length === 0 && rows.length > 0))
      setSelected(visible.length > 0 ? visible : rows.length > 0 ? [rows[0].processId] : [])
  }, [rows, selected])

  const attach = async (ids: number[]): Promise<void> => {
    if (ids.length === 0) return
    onClose()
    for (const id of ids)
      await attachDebug(id)
  }

  const select = (id: number, event: React.MouseEvent | React.KeyboardEvent): void => {
    if (event.shiftKey && anchor !== undefined) {
      const from = rows.findIndex((row) => row.processId === anchor)
      const to = rows.findIndex((row) => row.processId === id)
      if (from >= 0 && to >= 0) {
        setSelected(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.processId))
        return
      }
    }
    if (event.ctrlKey)
      setSelected((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id])
    else
      setSelected([id])
    setAnchor(id)
  }

  const copy = (): void => {
    const text = rows.filter((row) => selected.includes(row.processId)).map((row) => ATTACH_COLUMNS.map((column) => attachColumnTexts(row)[column.id]).join('\t')).join('\n')
    if (text)
      void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    const index = rows.findIndex((row) => row.processId === (anchor ?? selected[0]))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) select(next.processId, event)
    } else if (event.key === 'Enter') {
      void attach(selected)
    } else if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      setSelected(rows.map((row) => row.processId))
    } else if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      copy()
    } else {
      return
    }
    event.preventDefault()
  }

  const cell = (process: DebugProcess, column: AttachColumn): React.ReactNode => {
    const text = attachColumnTexts(process)[column]
    return <Highlighted text={text} spans={matcher.matchSpans(column, text)} />
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal attach-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attach-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.ctrlKey && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            searchRef.current?.focus()
          } else if (event.key === 'F5') {
            event.preventDefault()
            refresh()
          }
        }}
      >
        <div className="modal-title"><span id="attach-title">{t('Attach to Process')}</span><button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button></div>
        <div className="attach-filter">
          <input ref={searchRef} autoFocus aria-label={t('Search for a process')} title={`${t('Search for a process')} (Ctrl+F)`} placeholder={t('Search')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" title={t('Help')} aria-label={t('Help')} onClick={() => void window.dnSpy.showMessage(matcher.helpText(t))}><DsIcon name="StatusHelp" /></button>
          <button className="icon-button" title={`${t('Refresh')} (F5)`} aria-label={t('Refresh')} disabled={loading} onClick={refresh}><DsIcon name="Refresh" className={loading ? 'spin' : undefined} /></button>
        </div>
        <div className="attach-table" role="grid" aria-label={t('Processes')} aria-multiselectable="true" tabIndex={0} ref={listRef} onKeyDown={onListKeyDown}>
          <div className="attach-row attach-header" role="row">
            {columns.map((column) => (
              <span
                key={column.id}
                role="columnheader"
                aria-sort={sort?.column === column.id ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                // GridViewColumnSorter: ascending, then descending, then the default order again.
                onClick={() => setSort((current) => current?.column !== column.id ? { column: column.id, descending: false } : current.descending ? undefined : { column: column.id, descending: true })}
              >
                {column.name}
                {sort?.column === column.id && <span className="bookmarks-sort-arrow" aria-hidden>{sort.descending ? '▼' : '▲'}</span>}
              </span>
            ))}
          </div>
          {rows.map((process) => (
            <div
              key={process.processId}
              className={`attach-row process-row${selected.includes(process.processId) ? ' selected' : ''}`}
              role="row"
              aria-selected={selected.includes(process.processId)}
              onMouseDown={(event) => select(process.processId, event)}
              onDoubleClick={() => void attach([process.processId])}
            >
              {ATTACH_COLUMNS.map((column) => <span key={column.id} title={attachColumnTexts(process)[column.id]}>{cell(process, column.id)}</span>)}
            </div>
          ))}
        </div>
        <div className="modal-actions"><span className="modal-action-spacer" /><button className="primary" disabled={selected.length === 0} onClick={() => void attach(selected)}>{t('Attach')}</button><button onClick={onClose}>{t('Cancel')}</button></div>
      </div>
    </div>
  )
}
