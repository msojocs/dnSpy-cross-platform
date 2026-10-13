import { useEffect, useMemo, useRef, useState } from 'react'
import { showPopupMenu, type IPopupMenuItem, type PopupMenuEntry } from 'flexlayout-react'
import { Check, Download, Play, Tag, Trash2, Upload, X } from 'lucide-react'
import type { BookmarkLocationText, TextPart } from '../../../shared/protocol'
import { bookmarkEntryOfFile, bookmarkFileEntries, filterBookmarks, parseBookmarkEntries, useAppStore } from '../app-store'
import type { Bookmark, BookmarkEntry } from '../app-store'
import { clearBookmarks, stepBookmark, toggleBookmarkAtCaret } from '../bookmark-commands'
import {
  bookmarkLocationFormat,
  bookmarkLocationParts,
  bookmarkRowText,
  bookmarksCopyText,
  modulePathParts,
  nextBookmarkSort,
  sortBookmarkRows,
  type BookmarkColumn,
  type BookmarkRowText,
  type BookmarkSort,
} from '../bookmark-model'
import { useLanguage } from '../localization'
import { saveAppOptions, useAppOptions, type BookmarkSettings } from './app-options'
import { ColoredText } from './ColoredText'

// dnSpy's Bookmarks window: a four-column list of every bookmark in the session, with a search box, a
// toolbar and a context menu carrying the same commands the View menu offers. The search box takes
// dnSpy's prefixes — `n:` name, `l:` label, `o:` location, `m:` module — as well as bare words, which
// match any of the four. A column header sorts by it; the Location column is written by the backend's C#
// formatter with the display options the context menu switches.

const menuItem = (key: string, label: string, onSelect: () => void, options: { disabled?: boolean; shortcut?: string; checked?: boolean } = {}): IPopupMenuItem => ({
  key,
  content: (
    <>
      {options.checked !== undefined && <span className="document-tab-menu-icon">{options.checked ? <Check size={14} strokeWidth={1.7} aria-hidden /> : null}</span>}
      <span className="document-tab-menu-label">{label}</span>
      {options.shortcut && <span className="document-tab-menu-shortcut">{options.shortcut}</span>}
    </>
  ),
  disabled: options.disabled,
  onSelect,
})

// The Show... options of the context menu, in dnSpy's order (GROUP_CTX_BOOKMARKS_OPTS).
const DISPLAY_OPTIONS: [keyof BookmarkSettings, string][] = [
  ['showTokens', 'Show Tokens'],
  ['showModuleNames', 'Show Module Names'],
  ['showParameterTypes', 'Show Parameter Types'],
  ['showParameterNames', 'Show Parameter Names'],
  ['showDeclaringTypes', 'Show Declaring Types'],
  ['showNamespaces', 'Show Namespaces'],
  ['showReturnTypes', 'Show Return Types'],
  ['showIntrinsicTypeKeywords', 'Show Intrinsic Type Keywords'],
]

const COLUMNS: [BookmarkColumn, string][] = [['name', 'Name'], ['labels', 'Labels'], ['location', 'Location'], ['module', 'Module']]

/**
 * The Location cells of the bookmarks, keyed by identity. They are asked for again whenever the set of
 * locations, the display options or the workspace's contents change — a rename edits what they read — and
 * an answer that arrives after a newer question was asked is dropped.
 */
const useBookmarkLocationTexts = (bookmarks: Bookmark[], settings: BookmarkSettings): Map<string, BookmarkLocationText> => {
  const workspaceId = useAppStore((state) => state.workspaceId)
  const workspaceStateId = useAppStore((state) => state.workspaceStateId)
  const modulesCount = useAppStore((state) => state.modules.length)
  const [texts, setTexts] = useState(() => new Map<string, BookmarkLocationText>())
  const requestRef = useRef(0)
  const locatable = useMemo(() => {
    const unique = new Map<string, Bookmark>()
    for (const bookmark of bookmarks) {
      if (bookmark.kind !== 'line')
        unique.set(bookmark.identity, bookmark)
    }
    return [...unique.values()]
  }, [bookmarks])
  const locationsKey = locatable.map((bookmark) => bookmark.identity).join('\n')
  const format = bookmarkLocationFormat(settings)
  const formatKey = JSON.stringify(format)

  useEffect(() => {
    const request = ++requestRef.current
    const formatLocations = window.dnSpy?.formatBookmarkLocations
    if (locatable.length === 0 || !formatLocations)
      return
    formatLocations(
      workspaceId,
      locatable.map((bookmark) => ({ modulePath: bookmark.modulePath, metadataToken: bookmark.metadataToken, ilOffset: bookmark.kind === 'token' ? null : bookmark.ilOffset })),
      format,
    ).then((written) => {
      if (request !== requestRef.current)
        return
      setTexts(new Map(locatable.map((bookmark, index) => [bookmark.identity, written[index]])))
    }, () => {
      // A backend that cannot answer leaves the cells to what the bookmarks stored.
    })
    // `locatable` and `format` are covered by the keys, which change exactly when they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsKey, formatKey, workspaceId, workspaceStateId, modulesCount])

  return texts
}

export const BookmarksPane = (): React.JSX.Element => {
  const bookmarks = useAppStore((state) => state.bookmarks)
  const activeBookmarkId = useAppStore((state) => state.activeBookmarkId)
  const goToBookmark = useAppStore((state) => state.goToBookmark)
  const removeBookmarks = useAppStore((state) => state.removeBookmarks)
  const setBookmarksEnabled = useAppStore((state) => state.setBookmarksEnabled)
  const renameBookmark = useAppStore((state) => state.renameBookmark)
  const setBookmarkLabels = useAppStore((state) => state.setBookmarkLabels)
  const importBookmarks = useAppStore((state) => state.importBookmarks)
  const options = useAppOptions()
  const settings = options.bookmarks
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<BookmarkSort>()
  const [selected, setSelected] = useState<string[]>([])
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'labels' }>()
  const [status, setStatus] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  const locationTexts = useBookmarkLocationTexts(bookmarks, settings)

  const locationOf = useMemo(() => {
    const cache = new Map<string, TextPart[]>()
    return (bookmark: Bookmark): TextPart[] => {
      let parts = cache.get(bookmark.id)
      if (!parts) {
        parts = bookmarkLocationParts(bookmark, locationTexts.get(bookmark.identity), settings.showTokens)
        cache.set(bookmark.id, parts)
      }
      return parts
    }
  }, [locationTexts, settings.showTokens])
  const textOf = useMemo(() => {
    const cache = new Map<string, BookmarkRowText>()
    return (bookmark: Bookmark): BookmarkRowText => {
      let text = cache.get(bookmark.id)
      if (!text) {
        text = bookmarkRowText(bookmark, locationOf(bookmark))
        cache.set(bookmark.id, text)
      }
      return text
    }
  }, [locationOf])

  const rows = useMemo(
    () => sortBookmarkRows(filterBookmarks(bookmarks, query, (bookmark) => textOf(bookmark).location), sort, textOf),
    [bookmarks, query, sort, textOf],
  )
  const hiddenCount = bookmarks.length - rows.length

  // A selection that outlived its rows would leave the toolbar acting on nothing.
  useEffect(() => {
    setSelected((current) => {
      const alive = current.filter((id) => bookmarks.some((bookmark) => bookmark.id === id))
      return alive.length === current.length ? current : alive
    })
  }, [bookmarks])

  const selectRow = (id: string, event: React.MouseEvent): void => {
    setSelected((current) => {
      if (event.ctrlKey || event.metaKey)
        return current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
      if (event.shiftKey && current.length > 0) {
        const from = rows.findIndex((bookmark) => bookmark.id === current[current.length - 1])
        const to = rows.findIndex((bookmark) => bookmark.id === id)
        if (from >= 0 && to >= 0)
          return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((bookmark) => bookmark.id)
      }
      return [id]
    })
  }

  // The selected rows in the order the window shows them — what dnSpy's commands call SortedSelectedItems.
  const selectedRows = (ids = selected): Bookmark[] => rows.filter((bookmark) => ids.includes(bookmark.id))

  const setDisplayOption = (key: keyof BookmarkSettings, value: boolean): void =>
    saveAppOptions({ ...options, bookmarks: { ...options.bookmarks, [key]: value } })

  const copyRows = (chosen: Bookmark[]): void => {
    if (chosen.length > 0)
      void navigator.clipboard?.writeText(bookmarksCopyText(chosen.map(textOf)))
  }

  // dnSpy writes its bookmarks as its settings XML (BookmarksSerializer), so a file made here opens in dnSpy
  // and one dnSpy made opens here.
  const exportBookmarks = async (chosen: Bookmark[]): Promise<void> => {
    const entries = bookmarkFileEntries(chosen)
    if (entries.length === 0)
      return
    try {
      const xml = await window.dnSpy.exportBookmarks(useAppStore.getState().workspaceId, entries)
      const saved = await window.dnSpy.saveCode('bookmarks.xml', xml)
      setStatus(saved ? t('Exported {count} bookmark(s) to {path}.', { count: entries.length, path: saved }) : '')
    } catch (reason) {
      useAppStore.getState().appendOutput(t('Export failed: {message}', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }

  const runImport = async (): Promise<void> => {
    let text: string | undefined
    try {
      text = await window.dnSpy.readTextFile('bookmarks')
    } catch {
      // A file the host could not read is reported the same way a damaged one is.
      setStatus(t('The bookmark file could not be read.'))
      return
    }
    if (text === undefined)
      return
    let entries: BookmarkEntry[]
    let skipped = 0
    try {
      if (text.trimStart().startsWith('<')) {
        const file = await window.dnSpy.importBookmarks(useAppStore.getState().workspaceId, text)
        entries = file.bookmarks.map(bookmarkEntryOfFile)
        skipped = file.skipped
      } else {
        // The JSON an earlier build of this port exported.
        entries = parseBookmarkEntries(JSON.parse(text))
      }
    } catch {
      setStatus(t('The bookmark file could not be read.'))
      return
    }
    if (entries.length === 0) {
      setStatus(t('The bookmark file could not be read.'))
      return
    }
    const count = importBookmarks(entries)
    setStatus(skipped > 0
      ? t('Imported {count} bookmark(s); skipped {skipped} the file cannot place.', { count, skipped })
      : t('Imported {count} bookmark(s).', { count }))
  }

  const toggleMatching = (): void => {
    // dnSpy's Enable/Disable: if anything in view is still enabled, turn the lot off; otherwise back on.
    const enabled = rows.some((bookmark) => bookmark.enabled)
    setBookmarksEnabled(rows.map((bookmark) => bookmark.id), !enabled)
  }

  // dnSpy's Space on the list: turns the selection off when all of it is on, and on otherwise.
  const toggleSelected = (): void => {
    const chosen = selectedRows()
    if (chosen.length > 0)
      setBookmarksEnabled(chosen.map((bookmark) => bookmark.id), !chosen.every((bookmark) => bookmark.enabled))
  }

  const focusSearch = (): void => {
    searchRef.current?.focus()
    searchRef.current?.select()
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
    if (event.key === 'Delete' && selected.length > 0) {
      event.preventDefault()
      removeBookmarks(selected)
    } else if ((event.key === 'F2' || (event.ctrlKey && key === '1')) && selected.length === 1) {
      event.preventDefault()
      setEditing({ id: selected[0], field: 'name' })
    } else if (event.ctrlKey && key === '2' && selected.length === 1) {
      event.preventDefault()
      setEditing({ id: selected[0], field: 'labels' })
    } else if (event.key === 'Enter' && selected.length === 1) {
      event.preventDefault()
      void goToBookmark(selected[0])
    } else if (event.key === ' ' && !event.ctrlKey && !event.shiftKey && !event.altKey && selected.length > 0) {
      event.preventDefault()
      toggleSelected()
    } else if (event.ctrlKey && key === 'a') {
      event.preventDefault()
      setSelected(rows.map((bookmark) => bookmark.id))
    } else if (event.ctrlKey && (key === 'c' || event.key === 'Insert') && selected.length > 0) {
      event.preventDefault()
      copyRows(selectedRows())
    }
  }

  // dnSpy's double click goes to the bookmark, in a tab of its own while Shift or Ctrl is held.
  const onRowDoubleClick = (bookmark: Bookmark, event: React.MouseEvent): void => {
    if (editing)
      return
    void goToBookmark(bookmark.id, event.shiftKey || event.ctrlKey || event.metaKey)
  }

  const showContextMenu = (bookmark: Bookmark, event: React.MouseEvent<HTMLElement>): void => {
    event.preventDefault()
    const ids = selected.includes(bookmark.id) ? selected : [bookmark.id]
    if (!selected.includes(bookmark.id))
      setSelected(ids)
    const chosen = selectedRows(ids)
    const single = chosen.length === 1 ? chosen[0] : undefined
    // dnSpy's groups: copying, going to the bookmark, its name and labels, removing and switching, export,
    // and the display options. Enable and Disable only show when the selection has something to switch.
    const items: PopupMenuEntry[] = [
      menuItem('copy', t('Copy'), () => copyRows(chosen), { disabled: chosen.length === 0, shortcut: 'Ctrl+C' }),
      menuItem('select-all', t('Select All'), () => setSelected(rows.map((row) => row.id)), { disabled: chosen.length === rows.length, shortcut: 'Ctrl+A' }),
      { type: 'divider', key: 'bookmark-code' },
      menuItem('go-to', t('Go To'), () => { if (single) void goToBookmark(single.id) }, { disabled: !single, shortcut: 'Enter' }),
      { type: 'divider', key: 'bookmark-settings' },
      menuItem('rename', t('Rename'), () => { if (single) setEditing({ id: single.id, field: 'name' }) }, { disabled: !single, shortcut: 'F2' }),
      menuItem('labels', t('Edit Labels'), () => { if (single) setEditing({ id: single.id, field: 'labels' }) }, { disabled: !single, shortcut: 'Ctrl+2' }),
      { type: 'divider', key: 'bookmark-actions' },
      menuItem('remove', t('Remove'), () => removeBookmarks(chosen.map((item) => item.id)), { disabled: chosen.length === 0, shortcut: 'Del' }),
      menuItem('remove-all', t('Remove All Bookmarks'), () => removeBookmarks(rows.map((row) => row.id)), { disabled: rows.length === 0 }),
      ...(chosen.some((item) => !item.enabled) ? [menuItem('enable', t('Enable'), () => setBookmarksEnabled(chosen.map((item) => item.id), true))] : []),
      ...(chosen.some((item) => item.enabled) ? [menuItem('disable', t('Disable'), () => setBookmarksEnabled(chosen.map((item) => item.id), false))] : []),
      { type: 'divider', key: 'bookmark-files' },
      menuItem('export', t('Export Selected...'), () => void exportBookmarks(chosen), { disabled: chosen.length === 0 }),
      { type: 'divider', key: 'bookmark-options' },
      ...DISPLAY_OPTIONS.map(([key, label]) => menuItem(key, t(label), () => setDisplayOption(key, !settings[key]), { checked: settings[key] })),
    ]
    showPopupMenu({
      anchor: { x: event.clientX, y: event.clientY },
      returnFocusTo: event.currentTarget,
      title: t('Bookmarks'),
      items,
      onClose: () => undefined,
    })
  }

  const cell = (parts: TextPart[]): React.ReactNode => settings.syntaxHighlight ? <ColoredText parts={parts} /> : parts.map((part) => part.text).join('')

  return (
    <div className={`bookmarks-pane${settings.syntaxHighlight ? ' syntax-highlight' : ''}`} onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="bookmarks-toolbar">
        <button className="icon-button" title={t('Toggle Bookmark')} aria-label={t('Toggle Bookmark')} onClick={toggleBookmarkAtCaret}><Tag size={14} /></button>
        <button className="icon-button" title={t('Previous Bookmark')} aria-label={t('Previous Bookmark')} onClick={() => stepBookmark(-1)}>↑</button>
        <button className="icon-button" title={t('Next Bookmark')} aria-label={t('Next Bookmark')} onClick={() => stepBookmark(1)}>↓</button>
        <button className="icon-button" title={t('Previous Bookmark With Same Label')} aria-label={t('Previous Bookmark With Same Label')} onClick={() => stepBookmark(-1, 'label')}>↑<Tag size={9} /></button>
        <button className="icon-button" title={t('Next Bookmark With Same Label')} aria-label={t('Next Bookmark With Same Label')} onClick={() => stepBookmark(1, 'label')}>↓<Tag size={9} /></button>
        <button className="icon-button" title={t('Previous Bookmark In Document')} aria-label={t('Previous Bookmark In Document')} onClick={() => stepBookmark(-1, 'document')}>↑▤</button>
        <button className="icon-button" title={t('Next Bookmark In Document')} aria-label={t('Next Bookmark In Document')} onClick={() => stepBookmark(1, 'document')}>↓▤</button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Go To')} aria-label={t('Go To')} disabled={selected.length !== 1} onClick={() => { if (selected.length === 1) void goToBookmark(selected[0]) }}><Play size={14} /></button>
        <button className="icon-button" title={t('Remove')} aria-label={t('Remove')} disabled={selected.length === 0} onClick={() => removeBookmarks(selected)}><Trash2 size={14} /></button>
        <button className="icon-button" title={t('Clear Bookmarks')} aria-label={t('Clear Bookmarks')} disabled={bookmarks.length === 0} onClick={clearBookmarks}><X size={14} /></button>
        <span className="bookmarks-separator" />
        <button className="icon-button" title={t('Import Bookmarks')} aria-label={t('Import Bookmarks')} onClick={() => void runImport()}><Upload size={14} /></button>
        <button className="icon-button" title={t('Export Bookmarks')} aria-label={t('Export Bookmarks')} disabled={rows.length === 0} onClick={() => void exportBookmarks(rows)}><Download size={14} /></button>
      </div>
      <div className="bookmarks-search">
        <input
          ref={searchRef}
          aria-label={t('Search bookmarks')}
          placeholder={t('Search (n: name, l: label, o: location, m: module)')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="icon-button" aria-label={t('Reset Search')} title={t('Reset Search')} disabled={query === ''} onClick={() => setQuery('')}><X size={13} /></button>
      </div>
      <div className="bookmarks-table" role="table" aria-label={t('Bookmarks')}>
        <div className="bookmarks-header" role="row">
          {COLUMNS.map(([column, label]) => (
            <span
              key={column}
              role="columnheader"
              aria-sort={sort?.column === column ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              title={t('Sort by {column}', { column: t(label) })}
              onClick={() => setSort((current) => nextBookmarkSort(current, column))}
            >
              {t(label)}
              {sort?.column === column && <span className="bookmarks-sort-arrow" aria-hidden>{sort.descending ? '▼' : '▲'}</span>}
            </span>
          ))}
        </div>
        <div className="bookmarks-rows">
          {rows.map((bookmark) => {
            const text = textOf(bookmark)
            const active = bookmark.id === activeBookmarkId
            return (
              <div
                className={`bookmark-row${selected.includes(bookmark.id) ? ' selected' : ''}${active ? ' active' : ''}${bookmark.enabled ? '' : ' bookmark-disabled'}`}
                role="row"
                key={bookmark.id}
                onMouseDown={(event) => selectRow(bookmark.id, event)}
                onDoubleClick={(event) => onRowDoubleClick(bookmark, event)}
                onContextMenu={(event) => showContextMenu(bookmark, event)}
              >
                <span className="bookmark-name-cell">
                  <input
                    type="checkbox"
                    checked={bookmark.enabled}
                    aria-label={t(bookmark.enabled ? 'Disable {name}' : 'Enable {name}', { name: bookmark.name })}
                    onChange={() => setBookmarksEnabled([bookmark.id], !bookmark.enabled)}
                  />
                  {editing?.id === bookmark.id && editing.field === 'name' ? (
                    <BookmarkTextInput
                      value={bookmark.name}
                      label={t('Name')}
                      onCommit={(value) => { renameBookmark(bookmark.id, value); setEditing(undefined) }}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <span
                      className={settings.syntaxHighlight ? (active ? 'tc-activeBookmarkName' : 'tc-bookmarkName') : undefined}
                      title={bookmark.name}
                      onDoubleClick={(event) => { event.stopPropagation(); setEditing({ id: bookmark.id, field: 'name' }) }}
                    >{bookmark.name}</span>
                  )}
                </span>
                <span className="bookmark-labels-cell">
                  {editing?.id === bookmark.id && editing.field === 'labels' ? (
                    <BookmarkTextInput
                      value={text.labels}
                      label={t('Labels')}
                      onCommit={(value) => { setBookmarkLabels(bookmark.id, value.split(',')); setEditing(undefined) }}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <span
                      title={text.labels}
                      onDoubleClick={(event) => { event.stopPropagation(); setEditing({ id: bookmark.id, field: 'labels' }) }}
                    >{text.labels}</span>
                  )}
                </span>
                <span className="bookmark-location-cell" title={text.location}>{cell(locationOf(bookmark))}</span>
                <span className="bookmark-module-cell" title={text.module}>{cell(modulePathParts(text.module))}</span>
              </div>
            )
          })}
        </div>
      </div>
      <div className="bookmarks-footer">
        {status && <span className="bookmarks-status">{status}</span>}
        <span className="status-spacer" />
        {hiddenCount > 0 && <span>{t('{count} filtered out', { count: hiddenCount })}</span>}
        <span>{t('{count} bookmark(s)', { count: rows.length })}</span>
        <button className="icon-button" title={t('Enable/Disable Matching Bookmarks')} aria-label={t('Enable/Disable Matching Bookmarks')} disabled={rows.length === 0} onClick={toggleMatching}>
          {t(rows.some((bookmark) => bookmark.enabled) ? 'Disable Matching' : 'Enable Matching')}
        </button>
        <button className="icon-button" title={t('Remove Matching Bookmarks')} aria-label={t('Remove Matching Bookmarks')} disabled={rows.length === 0} onClick={() => removeBookmarks(rows.map((bookmark) => bookmark.id))}><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

// Commits once: Escape must not be undone by the blur that follows the input being removed.
const BookmarkTextInput = ({ value, label, onCommit, onCancel }: { value: string; label: string; onCommit(value: string): void; onCancel(): void }): React.JSX.Element => {
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
      onKeyDown={(event) => {
        if (event.key === 'Enter')
          finish(true)
        else if (event.key === 'Escape')
          finish(false)
      }}
    />
  )
}
