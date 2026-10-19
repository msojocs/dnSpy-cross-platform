import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MetadataRow, MetadataTable } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import {
  bytesAsHex,
  contiguousRids,
  encodeColumnText,
  formatColumnValue,
  formatToken,
  parseClipboardBytes,
  pasteTarget,
  useMetadataTableCommands,
  type MetadataTableCommands,
} from '../metadata-table'
import { AskDialog } from './AskDialog'
import { MenuPopup } from './MenuBar'
import type { MenuItem } from './edit-menu'

const ROW_HEIGHT = 22
const OVERSCAN = 30
const PAGE = 256
const FALLBACK_HEIGHT = 600

interface CellProps {
  nodeId: string
  row: MetadataRow
  column: MetadataTable['columns'][number]
  value: number
}

/** A column of one row, in a box that writes the column's bytes when it loses the focus — WPF's grid TextBox. */
const Cell = ({ nodeId, row, column, value }: CellProps): React.JSX.Element => {
  const { t } = useLanguage()
  const hexWriteBytes = useAppStore((state) => state.hexWriteBytes)
  const initial = formatColumnValue(value)
  const [text, setText] = useState(initial)
  const encoded = encodeColumnText(column, text)
  const error = typeof encoded === 'string'
    ? t(encoded, { min: '0', max: String(2 ** (column.size * 8) - 1), maxHex: (2 ** (column.size * 8) - 1).toString(16).toUpperCase() })
    : undefined
  const commit = (): void => {
    if (typeof encoded !== 'string' && text !== initial)
      void hexWriteBytes(nodeId, row.offset + column.offset, encoded)
  }
  return (
    <input
      className="md-table-cell"
      aria-label={`${column.name} ${row.rid}`}
      aria-invalid={error !== undefined}
      title={error}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
    />
  )
}

/** The little-endian bytes of a row, put back together from its columns — what Copy puts on the clipboard. */
const rowBytes = (table: MetadataTable, row: MetadataRow): Uint8Array => {
  const bytes = new Uint8Array(table.rowSize)
  table.columns.forEach((column, index) => {
    let rest = row.values[index] ?? 0
    for (let byte = 0; byte < column.size; byte++) {
      bytes[column.offset + byte] = rest & 0xFF
      rest = Math.floor(rest / 256)
    }
  })
  return bytes
}

interface MetadataTableViewProps {
  nodeId: string
  /** Opens the hex tab of the document on a range — dnSpy's Show in Hex Editor. */
  onShowHex(moduleId: string, offset: number, length: number): void
}

/**
 * dnSpy's metadata table document (MetadataTableVM in a ListView): a row per record with its RID, token and
 * offset, a box per column that writes the column's bytes, and the Info column where the table has one. The rows
 * are read a page at a time as they scroll into view, and read again after every change to the workspace. The
 * selection is the ListView's extended one, and the commands of MDTableContextMenuCommands run on it from the
 * context menu, their keys, and the Edit menu while this view was the last to have the focus.
 */
export const MetadataTableView = ({ nodeId, onShowHex }: MetadataTableViewProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const stateId = useAppStore((state) => state.workspaceStateId)
  const hexWriteBytes = useAppStore((state) => state.hexWriteBytes)
  const appendOutput = useAppStore((state) => state.appendOutput)
  const [table, setTable] = useState<MetadataTable>()
  const [failure, setFailure] = useState<string>()
  const [rows, setRows] = useState<Map<number, MetadataRow>>(new Map())
  const [selected, setSelected] = useState<number[]>([])
  const anchor = useRef<number | undefined>(undefined)
  const [scroll, setScroll] = useState({ top: 0, height: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number }>()
  const [askRid, setAskRid] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const requested = useRef(new Set<number>())
  const viewId = useMemo(() => `md-table:${nodeId}:${Math.random().toString(36).slice(2)}`, [nodeId])

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    void window.dnSpy.getMetadataTable(workspaceId, nodeId)
      .then((loaded) => {
        if (cancelled)
          return
        setTable(loaded)
        setFailure(undefined)
        // Every page is read again: an edit, an undo or a sort may have changed any row.
        requested.current = new Set()
        setRows(new Map())
      })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, nodeId, stateId])

  const loadRows = useCallback(async (first: number, last: number): Promise<MetadataRow[]> => {
    if (!workspaceId || !table)
      return []
    const loaded: MetadataRow[] = []
    for (let page = Math.floor((first - 1) / PAGE); page <= Math.floor((last - 1) / PAGE); page++) {
      const response = await window.dnSpy.getMetadataTableRows(workspaceId, nodeId, page * PAGE + 1, PAGE)
      loaded.push(...response.rows)
    }
    setRows((current) => {
      const next = new Map(current)
      for (const row of loaded)
        next.set(row.rid, row)
      return next
    })
    return loaded
  }, [workspaceId, nodeId, table])

  // The rows on screen, and a margin round them.
  const height = scroll.height > 0 ? scroll.height : FALLBACK_HEIGHT
  const count = table?.rows ?? 0
  const firstVisible = Math.max(1, Math.floor(scroll.top / ROW_HEIGHT) - OVERSCAN + 1)
  const lastVisible = Math.min(count, Math.ceil((scroll.top + height) / ROW_HEIGHT) + OVERSCAN)
  useEffect(() => {
    if (!table || count === 0)
      return
    for (let page = Math.floor((firstVisible - 1) / PAGE); page <= Math.floor((lastVisible - 1) / PAGE); page++) {
      if (requested.current.has(page))
        continue
      requested.current.add(page)
      void loadRows(page * PAGE + 1, Math.min(count, page * PAGE + PAGE)).catch(() => requested.current.delete(page))
    }
  }, [table, count, firstVisible, lastVisible, loadRows])

  useEffect(() => {
    const element = scroller.current
    if (!element)
      return
    setScroll({ top: element.scrollTop, height: element.clientHeight })
    if (typeof ResizeObserver === 'undefined')
      return
    const observer = new ResizeObserver(() => setScroll((current) => ({ ...current, height: element.clientHeight })))
    observer.observe(element)
    return () => observer.disconnect()
  }, [table !== undefined])

  /** The selected rows, read for any that have not scrolled into view yet. */
  const selectedRows = async (): Promise<MetadataRow[]> => {
    const rids = [...selected].sort((a, b) => a - b)
    const missing = rids.filter((rid) => !rows.has(rid))
    const fetched = missing.length > 0 ? await loadRows(missing[0], missing.at(-1)!) : []
    const all = new Map(rows)
    for (const row of fetched)
      all.set(row.rid, row)
    return rids.map((rid) => all.get(rid)).filter((row): row is MetadataRow => row !== undefined)
  }

  const reveal = (rid: number): void => {
    const element = scroller.current
    if (!element)
      return
    const top = (rid - 1) * ROW_HEIGHT
    if (top < element.scrollTop)
      element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight - ROW_HEIGHT)
      element.scrollTop = top + 2 * ROW_HEIGHT - element.clientHeight
  }

  const select = (rid: number, mode: 'single' | 'toggle' | 'range'): void => {
    if (mode === 'range' && anchor.current !== undefined) {
      const [from, to] = anchor.current < rid ? [anchor.current, rid] : [rid, anchor.current]
      setSelected(Array.from({ length: to - from + 1 }, (_, index) => from + index))
      return
    }
    anchor.current = rid
    setSelected((current) => mode === 'toggle'
      ? current.includes(rid) ? current.filter((entry) => entry !== rid) : [...current, rid]
      : [rid])
  }

  const contiguous = selected.length > 0 && contiguousRids(selected)
  const sortRange = async (rid: number, rowCount: number): Promise<void> => {
    if (!workspaceId)
      return
    try {
      const sorted = await window.dnSpy.sortMetadataTable(workspaceId, nodeId, rid, rowCount)
      await hexWriteBytes(nodeId, sorted.offset, Uint8Array.from(atob(sorted.base64Data), (character) => character.charCodeAt(0)))
    } catch (error) {
      appendOutput(error instanceof Error ? error.message : String(error))
    }
  }
  const commands: MetadataTableCommands | undefined = table && {
    canSort: table.canSort,
    canSortSelection: table.canSort && selected.length > 1 && contiguous,
    hasSelection: selected.length > 0,
    canShowInHex: contiguous,
    sortTable: () => { void sortRange(1, table.rows) },
    sortSelection: () => {
      if (table.canSort && selected.length > 1 && contiguous)
        void sortRange(Math.min(...selected), selected.length)
    },
    goToRid: () => setAskRid(true),
    showInHex: () => {
      if (!workspaceId || !contiguous)
        return
      void Promise.all([selectedRows(), window.dnSpy.resolveHexTarget(workspaceId, nodeId)]).then(([records, target]) => {
        if (records.length > 0)
          onShowHex(target.moduleId, records[0].offset, records.length * table.rowSize)
      })
    },
    copyAsText: () => {
      if (!workspaceId || selected.length === 0)
        return
      void window.dnSpy.getMetadataTableText(workspaceId, nodeId, [...selected].sort((a, b) => a - b))
        .then((response) => { if (response.text.length > 0) void navigator.clipboard.writeText(response.text) })
    },
    copy: () => {
      if (selected.length === 0)
        return
      void selectedRows().then((records) => {
        const text = records.map((row) => bytesAsHex(rowBytes(table, row))).join('')
        if (text.length > 0)
          void navigator.clipboard.writeText(text)
      })
    },
    paste: () => {
      void (async () => {
        const records = await selectedRows()
        const data = parseClipboardBytes(await navigator.clipboard.readText().catch(() => ''))
        const target = data && pasteTarget(data, table.rowSize, records[0], table.rows)
        if (!data || !target) {
          appendOutput(t('The clipboard does not hold whole rows of this table.'))
          return
        }
        await hexWriteBytes(nodeId, target.offset, data)
      })()
    },
  }

  // The Edit menu acts on the table view that last had the focus.
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const register = (): void => {
    if (commandsRef.current)
      useMetadataTableCommands.setState({ active: { viewId, commands: commandsRef.current } })
  }
  useEffect(() => {
    if (useMetadataTableCommands.getState().active?.viewId === viewId && commands)
      useMetadataTableCommands.setState({ active: { viewId, commands } })
  })
  useEffect(() => () => {
    if (useMetadataTableCommands.getState().active?.viewId === viewId)
      useMetadataTableCommands.setState({ active: undefined })
  }, [viewId])

  if (!table)
    return <div className={failure ? 'modal-error' : 'loading-state'}>{failure ?? t('Loading...')}</div>

  const menuItems = (): MenuItem[] => {
    const entries: MenuItem[] = [
      { label: t('Sort Table'), shortcut: 'Ctrl+Shift+T', disabled: !commands!.canSort, action: commands!.sortTable },
      { label: t('Sort Selection'), disabled: !commands!.canSortSelection, action: commands!.sortSelection },
      { label: t('Go to RID...'), shortcut: 'Ctrl+G', action: commands!.goToRid },
      { label: t('Show in Hex Editor'), icon: 'Binary', shortcut: 'Ctrl+X', disabled: !commands!.canShowInHex, action: commands!.showInHex },
      { separator: true },
      { label: t('Copy as Text'), shortcut: 'Ctrl+Shift+C', disabled: !commands!.hasSelection, action: commands!.copyAsText },
      { label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: !commands!.hasSelection, action: commands!.copy },
      { label: t('Paste'), icon: 'Paste', shortcut: 'Ctrl+V', disabled: !commands!.hasSelection, action: commands!.paste },
    ]
    return entries
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const inCell = event.target instanceof HTMLInputElement
    const key = event.key.toLowerCase()
    const run = (action: () => void): void => { event.preventDefault(); event.stopPropagation(); action() }
    if (event.ctrlKey && event.shiftKey && key === 't')
      run(commands!.sortTable)
    else if (event.ctrlKey && !event.shiftKey && key === 'g')
      run(commands!.goToRid)
    else if (event.ctrlKey && event.shiftKey && key === 'c' && !inCell)
      run(commands!.copyAsText)
    else if (event.ctrlKey && !event.shiftKey && key === 'c' && !inCell)
      run(commands!.copy)
    else if (event.ctrlKey && !event.shiftKey && key === 'v' && !inCell)
      run(commands!.paste)
    else if (event.ctrlKey && !event.shiftKey && key === 'x' && !inCell)
      run(commands!.showInHex)
    else if (event.ctrlKey && !event.shiftKey && key === 'a' && !inCell)
      run(() => setSelected(Array.from({ length: table.rows }, (_, index) => index + 1)))
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !inCell) {
      const current = anchor.current ?? 0
      const next = Math.min(table.rows, Math.max(1, current + (event.key === 'ArrowDown' ? 1 : -1)))
      run(() => { select(next, event.shiftKey ? 'range' : 'single'); if (!event.shiftKey) anchor.current = next; reveal(next) })
    }
  }

  const visible: number[] = []
  for (let rid = firstVisible; rid <= lastVisible; rid++)
    visible.push(rid)
  const columnCount = 3 + table.columns.length + (table.hasInfo ? 1 : 0)
  return (
    <div
      className="md-table-view"
      ref={scroller}
      tabIndex={0}
      role="grid"
      aria-label={table.name}
      aria-rowcount={table.rows}
      aria-multiselectable="true"
      onFocus={register}
      onMouseDown={register}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
      onContextMenu={(event) => { event.preventDefault(); register(); setMenu({ x: event.clientX, y: event.clientY }) }}
    >
      <table className="md-table">
        <thead>
          <tr>
            <th className="md-table-rid">{t('RID')}</th>
            <th>{t('Token')}</th>
            <th>{t('Offset')}</th>
            {table.columns.map((column) => <th key={column.name}>{column.name}</th>)}
            {table.hasInfo && <th>{t('Info')}</th>}
          </tr>
        </thead>
        <tbody>
          {firstVisible > 1 && <tr aria-hidden="true" style={{ height: (firstVisible - 1) * ROW_HEIGHT }}><td colSpan={columnCount} /></tr>}
          {visible.map((rid) => {
            const row = rows.get(rid)
            const isSelected = selected.includes(rid)
            return (
              <tr
                key={rid}
                role="row"
                aria-rowindex={rid}
                aria-selected={isSelected}
                className={isSelected ? 'selected' : undefined}
                style={{ height: ROW_HEIGHT }}
                onMouseDown={(event) => {
                  if (event.button === 2 && isSelected)
                    return
                  select(rid, event.shiftKey ? 'range' : event.ctrlKey ? 'toggle' : 'single')
                }}
              >
                <td className="md-table-rid">{rid}</td>
                <td><input readOnly tabIndex={-1} className="md-table-cell" aria-label={`${t('Token')} ${rid}`} value={row ? formatToken(row.token) : ''} /></td>
                <td><input readOnly tabIndex={-1} className="md-table-cell" aria-label={`${t('Offset')} ${rid}`} value={row ? formatToken(row.offset) : ''} /></td>
                {table.columns.map((column, index) => (
                  <td key={column.name}>
                    {row && <Cell key={`${row.values[index]}`} nodeId={nodeId} row={row} column={column} value={row.values[index] ?? 0} />}
                  </td>
                ))}
                {table.hasInfo && <td><input readOnly tabIndex={-1} className="md-table-cell" aria-label={`${t('Info')} ${rid}`} value={row?.info ?? ''} /></td>}
              </tr>
            )
          })}
          {lastVisible < table.rows && <tr aria-hidden="true" style={{ height: (table.rows - lastVisible) * ROW_HEIGHT }}><td colSpan={columnCount} /></tr>}
        </tbody>
      </table>
      {menu && (
        <div className="hex-context-menu" style={{ left: menu.x, top: menu.y }}>
          <MenuPopup items={menuItems()} onClose={() => setMenu(undefined)} />
        </div>
      )}
      {askRid && (
        <AskDialog
          title="Go to RID"
          label={t('RID')}
          validate={(text) => {
            const trimmed = text.trim()
            const hexadecimal = /^(0x|&h)/i.test(trimmed)
            const digits = hexadecimal ? trimmed.slice(2) : trimmed
            if (!(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits))
              return t('The value is not a hexadecimal or decimal integer')
            // SimpleTypeConverter.ParseUInt32(s, 1, rows), whose range check is the one that ever answers.
            const rid = parseInt(digits, hexadecimal ? 16 : 10)
            return rid >= 1 && rid <= table.rows
              ? undefined
              : t('Value must be between {min} ({sign}0x{minHex}) and {max} (0x{maxHex}) inclusive', { min: 1, sign: '', minHex: '1', max: table.rows, maxHex: table.rows.toString(16).toUpperCase() })
          }}
          onAccept={(text) => {
            const trimmed = text.trim()
            const rid = /^(0x|&h)/i.test(trimmed) ? parseInt(trimmed.slice(2), 16) : parseInt(trimmed, 10)
            setAskRid(false)
            anchor.current = rid
            setSelected([rid])
            reveal(rid)
            scroller.current?.focus()
          }}
          onClose={() => setAskRid(false)}
        />
      )}
    </div>
  )
}
