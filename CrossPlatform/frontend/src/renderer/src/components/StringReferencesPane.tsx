import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { StringReference, TextPart } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { findSearchResultCaret } from '../search-model'
import {
  STRING_REFERENCES_COLUMNS,
  STRING_REFERENCE_KIND_LABELS,
  nextStringReferencesSort,
  sortStringReferences,
  stringReferencesFilter,
  type StringReferencesColumn,
  type StringReferencesSettings,
  type StringReferencesSort,
} from '../string-references-model'
import { useStringReferencesStore } from '../string-references-store'
import { loadAppOptions, saveAppOptions, useAppOptions } from './app-options'
import { NodeIcon } from './AssemblyExplorer'
import { ColoredText } from './ColoredText'
import { DsIcon } from './DsIcon'
import { showStringReferencesContextMenu } from './StringReferencesContextMenu'
import './StringReferencesPane.css'

/** What the window needs from the shell, which owns the document tabs and the clipboard. */
export interface StringReferencesPaneCommands {
  /** Opens a node — in a tab of its own when asked to — and names the tab the document landed in. */
  openNode(nodeId: string, newTab: boolean): Promise<{ documentId: string; viewId: string } | undefined>
  copyText(text: string): void
}

/** The three switches under the expander, in dnSpy's order. */
export const STRING_REFERENCES_OPTIONS: readonly { key: keyof StringReferencesSettings; label: string }[] = [
  { key: 'caseSensitive', label: 'Case sensitive' },
  { key: 'regex', label: 'Regular expression' },
  { key: 'matchFormatted', label: 'Match on formatted string' },
]

// The text box's binding delay: the list is filtered a tenth of a second after the last keystroke.
export const STRING_REFERENCES_FILTER_DELAY_MS = 100

// The list draws only the rows in sight and a margin of them either side: an assembly holds tens of thousands.
const ROW_HEIGHT = 22
const OVERSCAN = 20
const FALLBACK_HEIGHT = 600
const MIN_COLUMN_WIDTH = 30

const updateSettings = (patch: Partial<StringReferencesSettings>): void => {
  const options = loadAppOptions()
  saveAppOptions({ ...options, stringReferences: { ...options.stringReferences, ...patch } })
}

/** The referrer's words between the names ("parameter", "attribute") are dnSpy's resources, so they translate. */
const localizedParts = (parts: TextPart[], t: (message: string) => string): TextPart[] =>
  parts.map((part) => part.color === 'darkGray' ? { ...part, text: t(part.text) } : part)

/**
 * dnSpy's String References window: a search box with its options and a Refresh button over the list of every
 * string the scanned assemblies hold — what kind of reference it is, the string as a C# literal, the member it is
 * in and its module. A header sorts by its column and can be dragged to another place or widened; a row is
 * followed with a double click or Enter, into a tab of its own with Ctrl or Shift, an `ldstr` to its statement.
 */
export const StringReferencesPane = ({ commands }: { commands: StringReferencesPaneCommands }): React.JSX.Element => {
  const references = useStringReferencesStore((state) => state.references)
  const focusRequested = useStringReferencesStore((state) => state.focusRequested)
  const workspaceId = useAppStore((state) => state.workspaceId)
  const settings = useAppOptions().stringReferences
  const { t } = useLanguage()
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [sort, setSort] = useState<StringReferencesSort>()
  const [selected, setSelected] = useState<StringReference>()
  const [order, setOrder] = useState<StringReferencesColumn[]>(() => STRING_REFERENCES_COLUMNS.map((entry) => entry.column))
  const [widths, setWidths] = useState<Record<StringReferencesColumn, number>>(() =>
    Object.fromEntries(STRING_REFERENCES_COLUMNS.map((entry) => [entry.column, entry.width])) as Record<StringReferencesColumn, number>)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  // The text box is bound with a delay: what was typed filters the list once the typing stops.
  useEffect(() => {
    if (query === appliedQuery)
      return
    const timer = setTimeout(() => setAppliedQuery(query), STRING_REFERENCES_FILTER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, appliedQuery])

  // An invalid pattern keeps the filter the list had, and the box shows the error.
  const lastFilter = useRef<(reference: StringReference) => boolean>(() => true)
  const filter = useMemo(() => stringReferencesFilter(appliedQuery, settings), [appliedQuery, settings])
  if (filter.matches)
    lastFilter.current = filter.matches
  const matches = lastFilter.current
  const rows = useMemo(() => sortStringReferences(references.filter(matches), sort), [references, matches, sort])
  const selectedIndex = selected ? rows.indexOf(selected) : -1

  useEffect(() => {
    if (selected && !references.includes(selected))
      setSelected(undefined)
  }, [references, selected])

  const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((viewport.top + (viewport.height > 0 ? viewport.height : FALLBACK_HEIGHT)) / ROW_HEIGHT) + OVERSCAN)

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

  // Showing the window gives its search box the focus with the text selected (StringReferencesService.Focus);
  // the window's tab may still be on its way to the front, so it waits a few frames for the box to show.
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
        useStringReferencesStore.getState().focusHandled()
      } else if (++frame < 30)
        handle = requestAnimationFrame(attempt)
      else
        useStringReferencesStore.getState().focusHandled()
    }
    attempt()
    return () => {
      if (handle !== undefined)
        cancelAnimationFrame(handle)
    }
  }, [focusRequested])

  /** dnSpy's FollowReference: the referrer, and for an `ldstr` the statement the instruction is in. */
  const follow = (reference: StringReference | undefined, newTab: boolean): void => {
    const nodeId = reference?.nodeId
    if (!nodeId)
      return
    void (async () => {
      const opened = await commandsRef.current.openNode(nodeId, newTab)
      if (!opened || reference.ilOffset === null)
        return
      const appStore = useAppStore.getState()
      const decompiled = appStore.documents[opened.documentId]
      const caret = decompiled && findSearchResultCaret(decompiled, reference.token, reference.ilOffset)
      if (caret)
        appStore.revealCaret(opened.documentId, caret.line, caret.column, opened.viewId)
    })()
  }

  const select = (index: number, focus: boolean): void => {
    const reference = rows[index]
    if (!reference)
      return
    setSelected(reference)
    if (!focus)
      return
    const element = listRef.current
    if (!element)
      return
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop)
      element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(top + ROW_HEIGHT - element.clientHeight, 0)
    measure()
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus())
  }

  const onListKeyDown = (event: React.KeyboardEvent): void => {
    const ctrl = event.ctrlKey || event.metaKey
    const lastIndex = rows.length - 1
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? FALLBACK_HEIGHT) / ROW_HEIGHT) - 1)
    let handled = true
    if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      // ApplicationCommands.Copy on the list: the selected string as a literal.
      if (selected)
        commandsRef.current.copyText(selected.formattedLiteral)
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
      follow(selected, event.shiftKey || ctrl)
    else
      handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const openMenu = (reference: StringReference, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setSelected(reference)
    showStringReferencesContextMenu({
      t,
      reference,
      copyText: (text) => commandsRef.current.copyText(text),
      follow: (newTab) => follow(reference, newTab),
    }, { x: event.clientX, y: event.clientY }, event.currentTarget)
  }

  // Dragging a header onto another moves its column there (GridView's AllowsColumnReorder).
  const dragged = useRef<StringReferencesColumn | undefined>(undefined)
  const dropOn = (target: StringReferencesColumn): void => {
    const source = dragged.current
    dragged.current = undefined
    if (!source || source === target)
      return
    setOrder((current) => {
      const next = current.filter((column) => column !== source)
      next.splice(next.indexOf(target), 0, source)
      return next
    })
  }

  // Dragging a header's right edge widens or narrows its column.
  const startResize = (column: StringReferencesColumn, event: React.PointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[column]
    const move = (moved: PointerEvent): void =>
      setWidths((current) => ({ ...current, [column]: Math.max(MIN_COLUMN_WIDTH, startWidth + moved.clientX - startX) }))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const setOption = (key: keyof StringReferencesSettings, value: boolean): void => {
    updateSettings({ [key]: value })
    useStringReferencesStore.getState().startIfNotStarted()
  }

  const gridTemplateColumns = order.map((column) => `${widths[column]}px`).join(' ')
  const labelOf = (column: StringReferencesColumn): string => t(STRING_REFERENCES_COLUMNS.find((entry) => entry.column === column)!.label)

  const cell = (reference: StringReference, column: StringReferencesColumn): React.ReactNode => {
    switch (column) {
      case 'kind':
        return <span key={column} className="strings-cell">{t(STRING_REFERENCE_KIND_LABELS[reference.kind])}</span>
      case 'literal':
        // TextElementFlags.FilterOutNewLines: a literal stays on its row.
        return <span key={column} className="strings-cell code-colors"><span className={reference.isVerbatim ? 'tc-verbatimString' : 'tc-string'}>{reference.formattedLiteral.replace(/[\r\n\u0085\u2028\u2029]/g, ' ')}</span></span>
      case 'referrer':
        return (
          <span key={column} className="strings-cell strings-referrer code-colors">
            <span className="result-icon"><NodeIcon icon={reference.referrerIcon} /></span>
            <span className="strings-referrer-text"><ColoredText parts={localizedParts(reference.referrerParts, t)} /></span>
          </span>
        )
      case 'module':
        return <span key={column} className="strings-cell"><span className="tc-assemblyModule">{reference.moduleName}</span></span>
    }
  }

  const tabStop = selectedIndex >= 0 ? selectedIndex : 0
  return (
    <div className="strings-pane">
      <div className="search-controls">
        <input
          ref={inputRef}
          value={query}
          aria-label={t('Search')}
          aria-invalid={filter.error ? true : undefined}
          className={filter.error ? 'strings-search-error' : undefined}
          title={filter.error ? t(filter.error) : undefined}
          disabled={!workspaceId}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value)
            useStringReferencesStore.getState().startIfNotStarted()
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && rows.length > 0) {
              event.preventDefault()
              select(Math.max(selectedIndex, 0), true)
            }
          }}
        />
        <button
          className="search-options-toggle"
          aria-expanded={expanded}
          aria-controls="strings-options"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          {t('Options')}
        </button>
        <span className="strings-separator" aria-hidden />
        <button
          className="icon-button"
          title={t('Refresh')}
          aria-label={t('Refresh')}
          disabled={!workspaceId}
          onClick={() => useStringReferencesStore.getState().refresh()}
        >
          <DsIcon name="Refresh" />
        </button>
      </div>
      {expanded && (
        <div id="strings-options" className="search-options" role="group" aria-label={t('Options')}>
          {STRING_REFERENCES_OPTIONS.map((option) => (
            <label key={option.key}>
              <input type="checkbox" checked={settings[option.key]} onChange={(event) => setOption(option.key, event.target.checked)} />
              {t(option.label)}
            </label>
          ))}
        </div>
      )}
      <div className="strings-table" role="grid" aria-label={t('String References')} aria-rowcount={rows.length}>
        <div className="strings-header" role="row" style={{ gridTemplateColumns }}>
          {order.map((column) => (
            <span
              key={column}
              role="columnheader"
              data-column={column}
              draggable
              aria-sort={sort?.column === column ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              onClick={() => setSort((current) => nextStringReferencesSort(current, column))}
              onDragStart={(event) => {
                dragged.current = column
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                if (dragged.current)
                  event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                dropOn(column)
              }}
            >
              <span className="strings-header-label">{labelOf(column)}</span>
              {sort?.column === column && <span className="strings-sort-arrow" aria-hidden>{sort.descending ? '▼' : '▲'}</span>}
              <span
                className="strings-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('Resize {column}', { column: labelOf(column) })}
                onPointerDown={(event) => startResize(column, event)}
                onClick={(event) => event.stopPropagation()}
              />
            </span>
          ))}
        </div>
        <div ref={listRef} className="strings-rows result-list" role="rowgroup" onKeyDown={onListKeyDown} onScroll={measure}>
          {first > 0 && <div role="none" style={{ height: first * ROW_HEIGHT }} />}
          {rows.slice(first, last).map((reference, offset) => {
            const index = first + offset
            return (
              <div
                key={`${reference.kind}:${reference.token}:${reference.ilOffset ?? ''}:${index}`}
                className={`strings-row${reference === selected ? ' selected' : ''}`}
                role="row"
                aria-selected={reference === selected}
                tabIndex={index === tabStop ? 0 : -1}
                data-index={index}
                data-kind={reference.kind}
                style={{ gridTemplateColumns }}
                onMouseDown={(event) => { if (event.button === 0 || event.button === 2) setSelected(reference) }}
                onDoubleClick={(event) => {
                  if (event.button === 0)
                    follow(reference, event.ctrlKey || event.shiftKey)
                }}
                onContextMenu={(event) => openMenu(reference, event)}
              >
                {order.map((column) => cell(reference, column))}
              </div>
            )
          })}
          {last < rows.length && <div role="none" style={{ height: (rows.length - last) * ROW_HEIGHT }} />}
        </div>
      </div>
    </div>
  )
}
