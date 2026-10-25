import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { showPopupMenu, type PopupMenuEntry } from 'flexlayout-react'
import type { DebugVariable } from '../../../shared/protocol'
import { useAppStore, watchList, watchValueList } from '../app-store'
import { useLanguage } from '../localization'
import { loadAppOptions, saveAppOptions, useAppOptions, type DebuggerOptions } from './app-options'
import { ColoredText } from './ColoredText'
import { DsIcon, MenuEntryIcon } from './DsIcon'
import { TreeExpanderGlyph } from './DsGlyphs'

/** How many children an expanded row reads at a time; the rest come in with the row that offers them. */
const CHILD_PAGE = 1000

/** A row of a variables window with where it sits: the path keys its expansion, so a step keeps it open. */
interface FlatRow {
  key: string
  variable: DebugVariable
  depth: number
  parentKey?: string
  /** The "more rows" placeholder under a row with more children than were read. */
  more?: { parentKey: string; reference: number; loaded: number; total: number }
}

interface ChildState {
  rows: DebugVariable[]
  total?: number | null
  loading: boolean
}

/** What a variables window adds to the shared tree: the Watch window's editable names and its own commands. */
interface VariablesTreeProps {
  label: string
  rows: DebugVariable[]
  /** The Watch window the rows are (1–4): their Name column is the expression and can be edited. */
  watchWindow?: number
  /** The row the Watch window keeps for typing a new expression. */
  newWatchRow?: boolean
  emptyText?: string
}

/**
 * The keys of a list of rows: the parent's key and the row's expression, which is what dnSpy keeps a row's
 * expansion and its "changed" state by across steps — a row moving down because a return value was added above
 * it is still the same row. Two rows with one expression are told apart by their order.
 */
const rowKeys = (parentKey: string | undefined, list: readonly DebugVariable[]): string[] => {
  const seen = new Map<string, number>()
  return list.map((variable) => {
    const base = `${parentKey ?? ''}/${variable.evaluateName ?? variable.name}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}#${count}`
  })
}

const nameOf = (variable: DebugVariable): ReactNode =>
  variable.nameParts?.length ? <ColoredText parts={variable.nameParts} /> : variable.name

const valueOf = (variable: DebugVariable): ReactNode => {
  // ValueNodeFormatter.WriteValueAndObjectId: "value {$1}" for a value that has an object id.
  const objectId = variable.objectId ? <span className="tc-debugObjectIdName">{` {${variable.objectId}}`}</span> : null
  return <>
    {variable.valueParts?.length ? <ColoredText parts={variable.valueParts} /> : <span className={variable.isError ? 'tc-error' : undefined}>{variable.value}</span>}
    {objectId}
  </>
}

const typeOf = (variable: DebugVariable): ReactNode =>
  variable.typeParts?.length ? <ColoredText parts={variable.typeParts} /> : variable.type

const copyText = (text: string): void => {
  void navigator.clipboard.writeText(text).catch(() => undefined)
}

/** VariablesWindowOperationsImpl.GetExpression per line: a copied row pastes the text before the first tab. */
const pastedExpressions = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => { const index = line.indexOf('\t'); return (index >= 0 ? line.slice(0, index) : line).trim() }).filter((line) => line.length > 0)

/** Flips one of the debugger's display toggles the way dnSpy's context menu does: the setting is global. */
const toggleDebuggerOption = (key: keyof DebuggerOptions): void => {
  const options = loadAppOptions()
  saveAppOptions({ ...options, debugger: { ...options.debugger, [key]: !options.debugger[key] } })
}

/**
 * The tree the Locals, Autos and Watch windows share — dnSpy's VariablesWindowControl: Name, Value and Type
 * columns, each in the colours the value formatter writes, rows that expand into their members, values edited
 * in place, and the context menu of VariablesWindowCommands.
 */
export const VariablesTree = ({ label, rows, watchWindow, newWatchRow = false, emptyText }: VariablesTreeProps): React.JSX.Element => {
  const { t } = useLanguage()
  const watch = watchWindow !== undefined
  const sessionId = useAppStore((state) => state.debugSessionId)
  const generation = useAppStore((state) => state.debugGeneration)
  const debugState = useAppStore((state) => state.debugState)
  const setDebugValue = useAppStore((state) => state.setDebugValue)
  const addWatch = useAppStore((state) => state.addWatch)
  const editWatch = useAppStore((state) => state.editWatch)
  const removeWatch = useAppStore((state) => state.removeWatch)
  const clearWatches = useAppStore((state) => state.clearWatches)
  const makeObjectId = useAppStore((state) => state.makeDebugObjectId)
  const deleteObjectId = useAppStore((state) => state.deleteDebugObjectId)
  const debuggerOptions = useAppOptions().debugger
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [children, setChildren] = useState<Record<string, ChildState>>({})
  const [selected, setSelected] = useState<string[]>([])
  const anchorRef = useRef<string | undefined>(undefined)
  const [editing, setEditing] = useState<{ key: string; column: 'name' | 'value'; text: string }>()
  const [newWatch, setNewWatch] = useState<string>()
  const tableRef = useRef<HTMLDivElement>(null)
  const stopped = debugState === 'stopped'
  // dnSpy's Highlight changed variables: a row whose value differs from what the same row showed at the last
  // stop is drawn in the changed colour. The values are remembered per stop, keyed like the expansion.
  const seenValues = useRef<{ generation: number; previous: Map<string, string>; current: Map<string, string> }>({ generation, previous: new Map(), current: new Map() })
  if (seenValues.current.generation !== generation)
    seenValues.current = { generation, previous: seenValues.current.current, current: new Map() }
  const isChanged = (key: string, value: string): boolean => {
    const seen = seenValues.current
    seen.current.set(key, value)
    return debuggerOptions.highlightChangedVariables && seen.previous.has(key) && seen.previous.get(key) !== value
  }

  // A new stop reads every expanded row again: the references of the last stop are gone, and dnSpy keeps a
  // row open across steps by its expression, which is the key here.
  const childrenFor = useCallback(async (key: string, reference: number, start = 0): Promise<void> => {
    if (!sessionId || reference === 0) return
    setChildren((current) => ({ ...current, [key]: { rows: start === 0 ? [] : current[key]?.rows ?? [], total: current[key]?.total, loading: true } }))
    try {
      const page = await window.dnSpy.getDebugChildren(sessionId, reference, start, CHILD_PAGE)
      setChildren((current) => ({ ...current, [key]: { rows: [...(start === 0 ? [] : current[key]?.rows ?? []), ...page.variables], total: page.totalCount, loading: false } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setChildren((current) => ({ ...current, [key]: { rows: [{ name: '', value: message, variablesReference: 0, isError: true, image: 'StatusError' }], loading: false } }))
    }
  }, [sessionId])

  const flat = useMemo(() => {
    const result: FlatRow[] = []
    const walk = (list: DebugVariable[], depth: number, parentKey?: string): void => {
      const keys = rowKeys(parentKey, list)
      list.forEach((variable, index) => {
        const key = keys[index]
        result.push({ key, variable, depth, parentKey })
        if (!expanded.has(key) || variable.variablesReference === 0) return
        const state = children[key]
        if (!state) return
        walk(state.rows, depth + 1, key)
        if (state.total && state.total > state.rows.length)
          result.push({ key: `${key}/more`, variable: { name: '', value: '', variablesReference: 0 }, depth: depth + 1, parentKey: key, more: { parentKey: key, reference: variable.variablesReference, loaded: state.rows.length, total: state.total } })
      })
    }
    walk(rows, 0)
    return result
  }, [rows, expanded, children])

  // The rows of a stop come with their own references; every open row is read again under its new one.
  useEffect(() => {
    setChildren({})
    if (!stopped) return
    const reopen = (list: DebugVariable[], parentKey?: string): void => {
      const keys = rowKeys(parentKey, list)
      list.forEach((variable, index) => {
        const key = keys[index]
        if (expanded.has(key) && variable.variablesReference !== 0)
          void childrenFor(key, variable.variablesReference)
      })
    }
    reopen(rows)
    // Only the top-level rows are reopened here; their children reopen theirs as they arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, generation, stopped])

  useEffect(() => {
    for (const [key, state] of Object.entries(children)) {
      if (state.loading) continue
      const keys = rowKeys(key, state.rows)
      state.rows.forEach((variable, index) => {
        const childKey = keys[index]
        if (expanded.has(childKey) && variable.variablesReference !== 0 && !children[childKey])
          void childrenFor(childKey, variable.variablesReference)
      })
    }
  }, [children, expanded, childrenFor])

  const toggle = (row: FlatRow, open?: boolean): void => {
    if (row.variable.variablesReference === 0) return
    const isOpen = expanded.has(row.key)
    const next = open ?? !isOpen
    if (next === isOpen) return
    setExpanded((current) => {
      const copy = new Set(current)
      if (next) copy.add(row.key)
      else copy.delete(row.key)
      return copy
    })
    if (next && !children[row.key])
      void childrenFor(row.key, row.variable.variablesReference)
  }

  const expression = (variable: DebugVariable): string => variable.evaluateName ?? variable.name

  const commitEdit = async (): Promise<void> => {
    if (!editing) return
    const row = flat.find((candidate) => candidate.key === editing.key)
    const { text, column } = editing
    setEditing(undefined)
    if (!row) return
    if (column === 'name') {
      if (text.trim() !== row.variable.name)
        await editWatch(row.variable.name, text, watchWindow)
      return
    }
    const original = row.variable.editText ?? row.variable.value
    if (text === original) return
    const error = await setDebugValue(expression(row.variable), text)
    if (error)
      await window.dnSpy.showMessage(t('Error: {message}', { message: error }))
  }

  const startEdit = (row: FlatRow, column: 'name' | 'value'): void => {
    if (column === 'value' && (!stopped || !row.variable.canEdit)) return
    if (column === 'name' && (!watch || row.depth !== 0)) return
    setEditing({ key: row.key, column, text: column === 'name' ? row.variable.name : row.variable.editText ?? row.variable.value })
  }

  /** ValueNodeFormatter.WriteValueAndObjectId: the object id follows the value, in braces. */
  const valueText = (variable: DebugVariable): string => `${variable.value}${variable.objectId ? ` {${variable.objectId}}` : ''}`

  const selectedRows = flat.filter((row) => selected.includes(row.key) && !row.more)

  const chooseRow = (row: FlatRow, event: React.MouseEvent): void => {
    if (event.shiftKey && anchorRef.current !== undefined) {
      const from = flat.findIndex((candidate) => candidate.key === anchorRef.current)
      const to = flat.findIndex((candidate) => candidate.key === row.key)
      if (from >= 0 && to >= 0)
        setSelected(flat.slice(Math.min(from, to), Math.max(from, to) + 1).map((candidate) => candidate.key))
      return
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => current.includes(row.key) ? current.filter((key) => key !== row.key) : [...current, row.key])
    } else {
      setSelected([row.key])
    }
    anchorRef.current = row.key
  }

  /** VariablesWindowOperationsImpl.Copy: expander, a tab, another tab, name, value with object id, type. */
  const copyRows = (rows: FlatRow[]): void => {
    const lines = rows.map((row) => {
      const variable = row.variable
      const expander = variable.variablesReference !== 0 ? (expanded.has(row.key) ? '-' : '+') : ' '
      return `${expander}\t\t${variable.name}\t${valueText(variable)}\t${variable.type ?? ''}`
    })
    if (lines.length > 0)
      copyText(lines.join('\n'))
  }

  const openMenu = (rows: FlatRow[], position: { x: number; y: number }): void => {
    const row = rows[0]
    const variable = row?.variable
    const realRows = rows.filter((candidate) => !candidate.more)
    const single = realRows.length === 1
    const options = loadAppOptions().debugger
    const items: PopupMenuEntry[] = []
    const add = (key: string, labelText: string, run: () => void, extra?: { icon?: ReactNode; shortcut?: string; disabled?: boolean }): void => {
      items.push({
        key,
        content: (
          <>
            <span className="document-tab-menu-icon">{extra?.icon}</span>
            <span className="document-tab-menu-label">{labelText}</span>
            {extra?.shortcut && <span className="document-tab-menu-shortcut">{extra.shortcut}</span>}
          </>
        ),
        disabled: extra?.disabled,
        onSelect: run,
      })
    }
    const divider = (key: string): void => { items.push({ type: 'divider', key }) }
    const isRealRow = !!variable && !row?.more
    add('copy', t('Copy'), () => copyRows(realRows), { icon: <MenuEntryIcon name="Copy" />, shortcut: 'Ctrl+C', disabled: realRows.length === 0 })
    add('copy-value', t('Copy Value'), () => copyText(realRows.map((candidate) => valueText(candidate.variable)).join('\n')), { shortcut: 'Ctrl+Shift+C', disabled: realRows.length === 0 })
    add('copy-expression', t('Copy Expression'), () => copyText(realRows.map((candidate) => expression(candidate.variable)).join('\n')), { disabled: realRows.length === 0 })
    if (watch) {
      add('paste', t('Paste'), () => { void navigator.clipboard.readText().then(async (text) => { for (const line of pastedExpressions(text)) await addWatch(line, watchWindow) }) }, { icon: <MenuEntryIcon name="Paste" />, shortcut: 'Ctrl+V' })
      add('delete-watch', t('Delete Watch'), () => { for (const candidate of realRows.filter((candidate) => candidate.depth === 0)) removeWatch(candidate.variable.name, watchWindow) }, { icon: <MenuEntryIcon name="Cancel" />, shortcut: 'Del', disabled: !realRows.some((candidate) => candidate.depth === 0) })
      add('clear-all', t('Clear All'), () => clearWatches(watchWindow), { icon: <MenuEntryIcon name="ClearWindowContent" /> })
    }
    divider('edit')
    add('edit-value', t('Edit Value'), () => { if (row) startEdit(row, 'value') }, { shortcut: 'F2', disabled: !single || !stopped || !variable?.canEdit })
    if (watch)
      add('edit-expression', t('Edit Expression'), () => { if (row) startEdit(row, 'name') }, { disabled: !single || row?.depth !== 0 })
    add('add-watch', t('Add Watch'), () => { for (const candidate of realRows) { if (candidate.variable.evaluateName) void addWatch(candidate.variable.evaluateName) } }, { icon: <MenuEntryIcon name="Watch" />, disabled: realRows.length === 0 })
    if (variable?.objectId)
      add('delete-object-id', t('Delete Object ID'), () => { if (variable.objectId) void deleteObjectId(variable.objectId) }, { disabled: !single })
    else
      add('make-object-id', t('Make Object ID'), () => { if (variable?.evaluateName) void makeObjectId(variable.evaluateName) }, { disabled: !single || !stopped || !variable?.evaluateName || variable.variablesReference === 0 })
    divider('native')
    add('save', t('Save...'), () => {
      if (!single || !variable?.address || !sessionId) return
      const count = variable.size ?? 0
      void window.dnSpy.readDebugMemory(sessionId, variable.address, count).then(
        (memory) => window.dnSpy.saveBinary(`${variable.name || 'value'}.bin`, memory.data),
        () => undefined)
    }, { icon: <MenuEntryIcon name="Save" />, disabled: !single || !variable?.address || !sessionId })
    // VariablesWindowOperations' Show in Memory Window: the value's raw span, in the window Ctrl+X uses
    // or in the one Ctrl+1..4 names. The popup menu has no submenus, so the windows are flat entries.
    const showMemory = (window: string): void => {
      if (!single || !variable?.address || !sessionId) return
      useAppStore.getState().showInMemoryWindow(sessionId, Number.parseInt(variable.address, 16), variable.size ?? 0, window)
    }
    add('show-memory', t('Show in Memory Window'), () => showMemory('memory'), { icon: <MenuEntryIcon name="MemoryWindow" />, shortcut: 'Ctrl+X', disabled: !single || !variable?.address || !sessionId })
    add('show-memory-1', t('Memory 1'), () => showMemory('memory'), { shortcut: 'Ctrl+1', disabled: !single || !variable?.address || !sessionId })
    add('show-memory-2', t('Memory 2'), () => showMemory('memory-2'), { shortcut: 'Ctrl+2', disabled: !single || !variable?.address || !sessionId })
    add('show-memory-3', t('Memory 3'), () => showMemory('memory-3'), { shortcut: 'Ctrl+3', disabled: !single || !variable?.address || !sessionId })
    add('show-memory-4', t('Memory 4'), () => showMemory('memory-4'), { shortcut: 'Ctrl+4', disabled: !single || !variable?.address || !sessionId })
    divider('refresh')
    add('refresh', t('Refresh'), () => { void useAppStore.getState().refreshVariables() }, { icon: <MenuEntryIcon name="Refresh" />, disabled: !stopped })
    add('select-all', t('Select All'), () => setSelected(flat.filter((candidate) => !candidate.more).map((candidate) => candidate.key)), { icon: <MenuEntryIcon name="Select" />, shortcut: 'Ctrl+A', disabled: flat.length === 0 })
    divider('tree')
    add('collapse-parent', t('Collapse Parent'), () => {
      const parent = flat.find((candidate) => candidate.key === row?.parentKey)
      if (parent) {
        toggle(parent, false)
        setSelected([parent.key])
      }
    }, { disabled: !row?.parentKey })
    add('expand-children', t('Expand Children'), () => {
      if (!row) return
      toggle(row, true)
      const state = children[row.key]
      if (state)
        setExpanded((current) => new Set([...current, ...rowKeys(row.key, state.rows).filter((_, index) => state.rows[index].variablesReference !== 0)]))
    }, { disabled: !isRealRow || variable?.variablesReference === 0 })
    add('collapse-children', t('Collapse Children'), () => {
      if (!row) return
      setExpanded((current) => new Set([...current].filter((key) => !key.startsWith(`${row.key}/`))))
    }, { disabled: !isRealRow || !expanded.has(row?.key ?? '') })
    divider('options')
    const check = (key: keyof DebuggerOptions, labelText: string): void =>
      add(`option-${key}`, labelText, () => toggleDebuggerOption(key), { icon: <MenuEntryIcon checked={options[key] === true} /> })
    check('useHexadecimal', t('Hexadecimal Display'))
    check('useDigitSeparators', t('Digit Separators'))
    check('showOnlyPublicMembers', t('Show Only Public Members'))
    check('showRawStructureOfObjects', t('Show Raw Structure of Objects'))
    check('showNamespaces', t('Show Namespaces'))
    check('showIntrinsicTypeKeywords', t('Show Intrinsic Type Keywords'))
    check('showTokens', t('Show Tokens'))
    showPopupMenu({ anchor: position, title: label, items, onClose: () => undefined, returnFocusTo: tableRef.current ?? undefined })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (editing) return
    const primaryKey = selected[0]
    const index = flat.findIndex((row) => row.key === primaryKey)
    const row = flat[index]
    const move = (to: number, extend: boolean): void => {
      const target = flat[Math.max(0, Math.min(flat.length - 1, to))]
      if (!target) return
      if (extend && anchorRef.current !== undefined) {
        const from = flat.findIndex((candidate) => candidate.key === anchorRef.current)
        const toIndex = flat.indexOf(target)
        setSelected(flat.slice(Math.min(from, toIndex), Math.max(from, toIndex) + 1).map((candidate) => candidate.key))
      } else {
        setSelected([target.key])
        anchorRef.current = target.key
      }
    }
    if (event.key === 'ArrowDown') move(index + 1, event.shiftKey)
    else if (event.key === 'ArrowUp') move(index - 1, event.shiftKey)
    else if (event.key === 'Home') move(0, event.shiftKey)
    else if (event.key === 'End') move(flat.length - 1, event.shiftKey)
    else if (event.key === 'ArrowRight' && row) {
      if (!expanded.has(row.key)) toggle(row, true)
      else move(index + 1, false)
    } else if (event.key === 'ArrowLeft' && row) {
      if (expanded.has(row.key)) toggle(row, false)
      else if (row.parentKey) {
        setSelected([row.parentKey])
        anchorRef.current = row.parentKey
      }
    } else if (event.key === 'Enter' && row) toggle(row)
    else if (event.key === 'F2' && selectedRows.length === 1) startEdit(row, watch && row.depth === 0 && !event.shiftKey ? 'name' : 'value')
    else if (event.key === 'Delete' && watch && selectedRows.some((candidate) => candidate.depth === 0)) {
      for (const candidate of selectedRows.filter((candidate) => candidate.depth === 0))
        removeWatch(candidate.variable.name, watchWindow)
    } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) setSelected(flat.filter((candidate) => !candidate.more).map((candidate) => candidate.key))
    else if ((event.key === 'c' && (event.ctrlKey || event.metaKey)) || (event.key === 'Insert' && event.ctrlKey)) {
      if (event.shiftKey)
        copyText(selectedRows.map((candidate) => valueText(candidate.variable)).join('\n'))
      else
        copyRows(selectedRows)
    }
    else return
    event.preventDefault()
  }

  const editor = (column: 'name' | 'value'): React.JSX.Element => (
    <input
      className="debug-value-editor"
      autoFocus
      aria-label={column === 'name' ? t('Expression') : t('Value')}
      value={editing?.text ?? ''}
      onChange={(event) => setEditing((current) => current && { ...current, text: event.target.value })}
      onBlur={() => void commitEdit()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void commitEdit()
        else if (event.key === 'Escape') setEditing(undefined)
      }}
    />
  )

  return (
    <div
      ref={tableRef}
      className={`debug-table${debuggerOptions.syntaxHighlight ? '' : ' debug-table-plain'}`}
      role="treegrid"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu(selectedRows, { x: event.clientX, y: event.clientY })
      }}
    >
      <div className="debug-table-header">{t('Name')}</div><div className="debug-table-header">{t('Value')}</div><div className="debug-table-header">{t('Type')}</div>
      {flat.map((row) => {
        const { variable } = row
        if (row.more) {
          const more = row.more
          return (
            <div className="debug-table-row" role="row" key={row.key}>
              <span className="debug-variable-name" style={{ paddingLeft: `${7 + row.depth * 15}px` }}>
                <button className="link-button" onClick={() => void childrenFor(more.parentKey, more.reference, more.loaded)}>
                  {t('Show {count} more of {total}', { count: Math.min(CHILD_PAGE, more.total - more.loaded), total: more.total })}
                </button>
              </span><span /><span />
            </div>
          )
        }
        const isOpen = expanded.has(row.key)
        const loading = children[row.key]?.loading === true
        const isEditing = editing?.key === row.key
        return (
          <div
            className={`debug-table-row${selected.includes(row.key) ? ' selected' : ''}${variable.isError ? ' debug-row-error' : ''}`}
            role="row"
            aria-level={row.depth + 1}
            aria-expanded={variable.variablesReference !== 0 ? isOpen : undefined}
            aria-selected={selected.includes(row.key)}
            key={row.key}
            onMouseDown={(event) => chooseRow(row, event)}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const rows = selected.includes(row.key) ? selectedRows : [row]
              if (!selected.includes(row.key))
                setSelected([row.key])
              openMenu(rows, { x: event.clientX, y: event.clientY })
            }}
          >
            <span className="debug-variable-name" style={{ paddingLeft: `${7 + row.depth * 15}px` }} onDoubleClick={() => startEdit(row, 'name')}>
              <button className="tree-expander" aria-label={t(isOpen ? 'Collapse {name}' : 'Expand {name}', { name: variable.name })} disabled={variable.variablesReference === 0} onClick={() => toggle(row)}>
                {/* The variables windows expand a value with the tree's ExpandCollapseToggleStyle; while its children
                    load the port shows its spinner, which dnSpy has no counterpart of. */}
                {loading ? <LoaderCircle className="spin" size={12} /> : variable.variablesReference !== 0 ? <TreeExpanderGlyph expanded={isOpen} /> : null}
              </button>
              {variable.image ? <DsIcon name={variable.image} className="debug-variable-image" /> : null}
              {isEditing && editing.column === 'name' ? editor('name') : <span className="debug-variable-text">{nameOf(variable)}</span>}
            </span>
            <span
              title={valueText(variable)}
              className={`${variable.canEdit && stopped ? 'debug-value-editable' : ''}${isChanged(row.key, variable.value) ? ' debug-value-changed' : ''}`}
              onDoubleClick={() => startEdit(row, 'value')}
            >
              {isEditing && editing.column === 'value' ? editor('value') : (
                <>
                  {variable.needsRefresh ? <DsIcon name="Refresh" className="debug-variable-image" /> : null}
                  {valueOf(variable)}
                </>
              )}
            </span>
            <span title={variable.type}>{typeOf(variable)}</span>
          </div>
        )
      })}
      {newWatchRow && (
        <div className="debug-table-row" role="row">
          <span className="debug-variable-name" style={{ paddingLeft: '22px' }}>
            {newWatch !== undefined ? (
              <input
                className="debug-value-editor"
                autoFocus
                aria-label={t('Watch expression')}
                value={newWatch}
                onChange={(event) => setNewWatch(event.target.value)}
                onBlur={() => {
                  if (newWatch.trim()) void addWatch(newWatch, watchWindow)
                  setNewWatch(undefined)
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === 'Enter') {
                    if (newWatch.trim()) void addWatch(newWatch, watchWindow)
                    setNewWatch(undefined)
                  } else if (event.key === 'Escape') setNewWatch(undefined)
                }}
              />
            ) : (
              <button className="debug-new-watch" aria-label={t('Add watch')} onClick={() => setNewWatch('')} onDoubleClick={() => setNewWatch('')} />
            )}
          </span><span /><span />
        </div>
      )}
      {flat.length === 0 && !newWatchRow && emptyText ? <div className="debug-table-empty">{emptyText}</div> : null}
    </div>
  )
}

export const LocalsPane = (): React.JSX.Element => {
  const variables = useAppStore((state) => state.debugVariables)
  const { t } = useLanguage()
  return <VariablesTree label={t('Locals')} rows={variables} />
}

/** dnSpy's Autos window: the variables the statements around the current one read and write. */
export const AutosPane = (): React.JSX.Element => {
  const { t } = useLanguage()
  const sessionId = useAppStore((state) => state.debugSessionId)
  const frameId = useAppStore((state) => state.activeDebugFrameId)
  const debugState = useAppStore((state) => state.debugState)
  const generation = useAppStore((state) => state.debugGeneration)
  const [rows, setRows] = useState<DebugVariable[]>([])
  useEffect(() => {
    if (!sessionId || frameId === undefined || debugState !== 'stopped') {
      setRows([])
      return
    }
    let current = true
    void window.dnSpy.getDebugAutos(sessionId, frameId).then((autos) => { if (current) setRows(autos) }, () => { if (current) setRows([]) })
    return () => { current = false }
  }, [sessionId, frameId, debugState, generation])
  return <VariablesTree label={t('Autos')} rows={rows} />
}

/** The port's Static Fields window: the static fields the active frame's method reads and writes, by type. */
export const StaticFieldsPane = (): React.JSX.Element => {
  const { t } = useLanguage()
  const sessionId = useAppStore((state) => state.debugSessionId)
  const frameId = useAppStore((state) => state.activeDebugFrameId)
  const debugState = useAppStore((state) => state.debugState)
  const generation = useAppStore((state) => state.debugGeneration)
  const [rows, setRows] = useState<DebugVariable[]>([])
  useEffect(() => {
    if (!sessionId || frameId === undefined || debugState !== 'stopped') {
      setRows([])
      return
    }
    let current = true
    void window.dnSpy.getDebugStaticFields(sessionId, frameId).then((fields) => { if (current) setRows(fields) }, () => { if (current) setRows([]) })
    return () => { current = false }
  }, [sessionId, frameId, debugState, generation])
  return <VariablesTree label={t('Static Fields')} rows={rows} />
}

/** dnSpy's Watch windows (1–4): an expression per row, typed into the empty row at the bottom. */
export const WatchPane = ({ window = 1 }: { window?: number }): React.JSX.Element => {
  const watches = useAppStore((state) => watchList(state, window))
  const values = useAppStore((state) => watchValueList(state, window))
  const canEvaluate = useAppStore((state) => state.debugCapabilities.supportsEvaluate !== false)
  const { t } = useLanguage()
  // Before the first stop a watch has no value yet; its row is there all the same, as dnSpy keeps it.
  const rows = useMemo(() => watches.map((watch) => values.find((value) => value.name === watch) ?? { name: watch, value: '', variablesReference: 0 }), [watches, values])
  return <VariablesTree label={window === 1 ? t('Watch') : t('Watch {number}', { number: window })} rows={rows} watchWindow={window} newWatchRow={canEvaluate} />
}
