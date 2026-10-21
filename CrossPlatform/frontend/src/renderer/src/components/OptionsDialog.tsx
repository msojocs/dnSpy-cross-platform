import { useEffect, useMemo, useRef, useState } from 'react'
import { hexEncodingSelection, loadHexEncodings } from '../hex-encodings'
import { useLanguage } from '../localization'
import { trapTabKey } from './modal-stack'
import { loadAppOptions, resetAppOptions, saveAppOptions, type AppOptions } from './app-options'
import { CloseGlyph, SubmenuArrowGlyph, TreeExpanderGlyph } from './DsGlyphs'
import { FontOptions } from './FontOptions'
import {
  OPTION_PAGES,
  collectResets,
  findPagePath,
  firstSelectablePage,
  hasChildren,
  pageControls,
  selectOptions,
  type ControlSpec,
  type GroupSpec,
  type PageSpec,
} from './options-pages'

interface OptionsDialogProps {
  onClose(): void
  /** Optional root id to focus (e.g. 'debugger' when opened from Debug → Options). */
  initialCategory?: string
}

type Translate = (message: string, values?: Record<string, string | number>) => string

const normalizeForSearch = (value: string): string => value.toLowerCase().trim()

/**
 * Returns a setter that mutates a nested AppOptions field via dot path.
 * Mirrors the upstream `Settings` properties bound from each WPF page XAML.
 */
const setNested = (path: string[], value: unknown) => {
  if (path.length === 0)
    throw new Error('setNested called with empty path')
  return (current: AppOptions): AppOptions => {
    const next = JSON.parse(JSON.stringify(current)) as AppOptions
    let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>
    for (let i = 0; i < path.length - 1; i++) {
      cursor = cursor[path[i]!] as Record<string, unknown>
    }
    cursor[path.at(-1)!] = value
    return next
  }
}

const readValue = (options: AppOptions, path: string): unknown => {
  let cursor: unknown = options
  for (const part of path.split('.')) {
    if (cursor === null || cursor === undefined)
      return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Everything a page contributes to the search index, including its group headers. */
const pageHaystack = (page: PageSpec, t: Translate): string => {
  const groups = (page.groups ?? [])
    .map((group) => `${group.titleKey ? t(group.titleKey) : ''} ${group.controls.map((control) => `${t(control.labelKey)}${control.kind === 'select' ? ` ${selectOptions(control).map((option) => t(option.labelKey)).join(' ')}` : ''}`).join(' ')}`)
    .join(' ')
  return `${t(page.titleKey)} ${page.descriptionKey ? t(page.descriptionKey) : ''} ${groups}`
}

/**
 * Keeps pages whose own text matches, and containers that either match themselves
 * (in which case their whole sub-tree stays visible) or still have a matching
 * descendant. Mirrors how the WPF dialog leaves a category in place for its children.
 */
const filterPages = (pages: PageSpec[], search: string, t: Translate): PageSpec[] => {
  if (!search)
    return pages
  const result: PageSpec[] = []
  for (const page of pages) {
    if (normalizeForSearch(pageHaystack(page, t)).includes(search)) {
      // A container matching on its own title keeps every child, not just the
      // matching ones, so the branch stays navigable.
      result.push(page)
      continue
    }
    if (page.pages) {
      const children = filterPages(page.pages, search, t)
      if (children.length)
        result.push({ ...page, pages: children })
    }
  }
  return result
}

/** Ids of every ancestor of `pageId`, outermost first. Used to reveal a selection. */
const ancestorsOf = (pageId: string): string[] => {
  const trail = findPagePath(OPTION_PAGES, pageId)
  return trail ? trail.slice(0, -1).map((page) => page.id) : []
}

/** The page a freshly opened dialog lands on. */
const initialSelection = (initialCategory?: string): string => {
  const root = initialCategory ? OPTION_PAGES.find((page) => page.id === initialCategory) : undefined
  return firstSelectablePage(root ?? OPTION_PAGES[0]!)?.id ?? ''
}

/**
 * Every node that must be open for `pageId` to be reachable, including `pageId` itself
 * when it is a container as well as a page (the Disassembler node owns the Code Style
 * sub-tree). Upstream starts with everything else folded.
 */
const expandedFor = (pageId: string): string[] => {
  const ids = ancestorsOf(pageId)
  const page = pageId ? findPagePath(OPTION_PAGES, pageId)?.at(-1) : undefined
  if (page && hasChildren(page))
    ids.push(page.id)
  return ids
}

interface ControlRowProps {
  spec: ControlSpec
  options: AppOptions
  onChange(path: string, value: unknown): void
  t: Translate
}

/**
 * `enabledWhen` as upstream's general settings pages read it: a dot-path, an alternative for each `|`, and a
 * `!` in front of a path that must be off (GeneralAppSettingsPageBase's `UseVirtualSpace || !WordWrap`).
 */
const enabledBy = (options: AppOptions, expression: string): boolean =>
  expression.split('|').some((term) => {
    const path = term.trim()
    return path.startsWith('!') ? !readValue(options, path.slice(1)) : Boolean(readValue(options, path))
  })

const ControlRow = ({ spec, options, onChange, t }: ControlRowProps): React.JSX.Element => {
  const value = readValue(options, spec.path)
  const isDisabled = spec.enabledWhen !== undefined && !enabledBy(options, spec.enabledWhen)

  if (spec.kind === 'checkbox') {
    return (
      <label className={`options-row${isDisabled ? ' options-row-disabled' : ''}`}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={isDisabled}
          onChange={(event) => onChange(spec.path, event.target.checked)}
        />
        <span>{t(spec.labelKey)}</span>
      </label>
    )
  }

  if (spec.kind === 'select') {
    return (
      <label className={`options-row options-row-select${isDisabled ? ' options-row-disabled' : ''}`}>
        <span className="options-row-label">{t(spec.labelKey)}</span>
        <select
          className="options-row-select-input"
          value={typeof value === 'string' ? value : ''}
          disabled={isDisabled}
          onChange={(event) => onChange(spec.path, event.target.value)}
        >
          {selectOptions(spec).map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
      </label>
    )
  }

  // GeneralAppSettingsPage's ClearAllWarningsCommand: enabled while some message is silenced, and done at once.
  if (spec.kind === 'button') {
    const held = Array.isArray(value) ? value.length > 0 : Boolean(value)
    return (
      <div className="options-row options-row-button">
        <button
          type="button"
          disabled={!held || isDisabled}
          onClick={() => {
            // dnSpy's MessageBoxService.EnableAllWarnings does not wait for OK: the saved options lose the list
            // now, and the page's copy follows so OK does not put it back.
            const saved = loadAppOptions()
            saveAppOptions(setNested(spec.path.split('.'), [])(saved))
            onChange(spec.path, [])
          }}
        >
          {t(spec.labelKey)}
        </button>
      </div>
    )
  }

  if (spec.kind === 'fonts')
    return <FontOptions options={options} onChange={(byTheme) => onChange(spec.path, byTheme)} />

  if (spec.kind === 'text') {
    return (
      <label className={`options-row options-row-text${isDisabled ? ' options-row-disabled' : ''}`}>
        <span className="options-row-label">{t(spec.labelKey)}</span>
        <input
          type="text"
          className="options-row-text-input"
          placeholder={spec.placeholder}
          disabled={isDisabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(spec.path, event.target.value)}
        />
      </label>
    )
  }

  if (spec.kind === 'textarea') {
    return (
      <label className={`options-row options-row-textarea${isDisabled ? ' options-row-disabled' : ''}`}>
        <span className="options-row-label">{t(spec.labelKey)}</span>
        <textarea
          className="options-row-textarea-input"
          rows={spec.rows}
          disabled={isDisabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(spec.path, event.target.value)}
        />
      </label>
    )
  }

  return (
    <label className={`options-row options-row-number${isDisabled ? ' options-row-disabled' : ''}`}>
      <span className="options-row-label">{t(spec.labelKey)}</span>
      <input
        type="number"
        className="options-row-number-input"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        disabled={isDisabled}
        value={typeof value === 'number' ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next))
            onChange(spec.path, next)
        }}
      />
    </label>
  )
}

interface ControlGroupProps {
  group: GroupSpec
  options: AppOptions
  onChange(path: string, value: unknown): void
  t: Translate
}

const ControlGroup = ({ group, options, onChange, t }: ControlGroupProps): React.JSX.Element => {
  const columns = group.columns ?? 1
  const body = (
    <div
      className={`options-group-body${columns > 1 ? ' options-group-columns' : ''}`}
      style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {group.controls.map((spec) => (
        <ControlRow key={spec.path} spec={spec} options={options} onChange={onChange} t={t} />
      ))}
    </div>
  )
  if (!group.titleKey)
    return <div className="options-group">{body}</div>
  return (
    <fieldset className="options-group">
      <legend className="options-group-title">{t(group.titleKey)}</legend>
      {body}
    </fieldset>
  )
}

interface PageNodeProps {
  page: PageSpec
  selectedPageId: string | undefined
  onSelect(pageId: string): void
  expanded: Set<string>
  onToggle(id: string): void
  level: number
  t: Translate
}

const PageNode = ({ page, selectedPageId, onSelect, expanded, onToggle, level, t }: PageNodeProps): React.JSX.Element => {
  const children = page.pages ?? []
  const target = firstSelectablePage(page)
  const selected = page.groups !== undefined && selectedPageId === page.id
  // A container is highlighted for as long as the selection sits anywhere inside it.
  const selectedInside = !selected && selectedPageId !== undefined && findPagePath(children, selectedPageId) !== undefined
  const indent = { paddingLeft: `${10 + level * 12}px` }

  if (!hasChildren(page)) {
    return (
      <li className={`options-tree-category${selected ? ' options-tree-category-selected' : ''}`}>
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          className={`options-tree-page options-tree-page-leaf${selected ? ' options-tree-page-selected' : ''}`}
          style={indent}
          onClick={() => onSelect(page.id)}
        >
          <span className="options-tree-page-title">{t(page.titleKey)}</span>
          <span className="options-tree-page-count">{pageControls(page).length}</span>
        </button>
      </li>
    )
  }

  const isExpanded = expanded.has(page.id)
  return (
    <li className={`options-tree-category${selected || selectedInside ? ' options-tree-category-selected' : ''}`}>
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-expanded={isExpanded}
        className="options-tree-category-button"
        style={indent}
        onClick={() => {
          if (target)
            onSelect(target.id)
          // Expanding is a side effect of selecting, so only fold a branch that was
          // already open — a plain toggle would undo the expansion we just asked for.
          if (selected && isExpanded)
            onToggle(page.id)
        }}
      >
        {/* The settings tree is a SharpTreeView, so it wears ExpandCollapseToggleStyle's expander. */}
        <TreeExpanderGlyph expanded={isExpanded} className="options-tree-chevron" />
        <span className="options-tree-label">{t(page.titleKey)}</span>
        <span className="options-tree-count">{children.length}</span>
      </button>
      {isExpanded && (
        <ul className="options-tree-pages" role="group">
          {children.map((child) => (
            <PageNode
              key={child.id}
              page={child}
              selectedPageId={selectedPageId}
              onSelect={onSelect}
              expanded={expanded}
              onToggle={onToggle}
              level={level + 1}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Option paths that are cleared when their controlling option is switched off. */
const RESETS = collectResets(OPTION_PAGES)

export const OptionsDialog = ({ onClose, initialCategory }: OptionsDialogProps): React.JSX.Element => {
  const dialog = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const { t } = useLanguage()
  const [options, setOptions] = useState<AppOptions>(() => loadAppOptions())
  const [selectedPageId, setSelectedPageId] = useState<string>(() => initialSelection(initialCategory))
  const [search, setSearch] = useState('')
  // The Hex Editor pages list every encoding .NET has, which the backend is asked for once.
  const [encodingsLoaded, setEncodingsLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    void loadHexEncodings().then(() => {
      if (cancelled)
        return
      setOptions((current) => {
        let next = current
        for (const view of ['hexViewer', 'memoryWindow'] as const) {
          const encoding = String(hexEncodingSelection(current.hexEditor[view].general.encoding))
          if (encoding !== current.hexEditor[view].general.encoding)
            next = setNested(['hexEditor', view, 'general', 'encoding'], encoding)(next)
        }
        return next
      })
      setEncodingsLoaded(true)
    })
    return () => { cancelled = true }
  }, [])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandedFor(initialSelection(initialCategory))))

  useEffect(() => searchInput.current?.focus(), [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const handleChange = (path: string, value: unknown): void => {
    const parts = path.split('.')
    setOptions((current) => {
      let next = setNested(parts, value)(current)
      for (const dependent of value === false ? RESETS.get(path) ?? [] : [])
        next = setNested(dependent.split('.'), false)(next)
      return next
    })
  }

  const handleReset = (): void => {
    setOptions(resetAppOptions())
  }

  const handleApply = (): void => {
    saveAppOptions(options)
    onClose()
  }

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id))
        next.delete(id)
      else
        next.add(id)
      return next
    })
  }

  const selectPage = (pageId: string): void => {
    setSelectedPageId(pageId)
    setExpanded((current) => {
      const next = new Set(current)
      expandedFor(pageId).forEach((id) => next.add(id))
      return next
    })
  }

  const normalizedSearch = normalizeForSearch(search)
  const visiblePages = useMemo(() => filterPages(OPTION_PAGES, normalizedSearch, t), [normalizedSearch, t, encodingsLoaded])
  const selectionPath = useMemo(() => findPagePath(OPTION_PAGES, selectedPageId) ?? [], [selectedPageId])
  const selectedPage = selectionPath.at(-1)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="modal options-dialog" role="dialog" aria-modal="true" aria-labelledby="options-title" onKeyDown={(event) => trapTabKey(event, dialog.current)}>
        <div className="modal-title">
          <span id="options-title">{t('Options')}</span>
          <button type="button" className="icon-button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="options-body">
          <div className="options-sidebar" role="group" aria-label={t('Categories')}>
            {/* AppSettingsDlg's search box is a plain TextBox, with no image beside it. */}
            <div className="options-search">
              <input
                ref={searchInput}
                type="search"
                placeholder={t('Search settings')}
                aria-label={t('Search settings')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button type="button" className="icon-button" aria-label={t('Clear search')} title={t('Clear')} onClick={() => setSearch('')}>
                  <CloseGlyph />
                </button>
              )}
            </div>
            <nav className="options-tree" role="tree" aria-label={t('Categories')}>
              {visiblePages.map((page) => (
                <PageNode
                  key={page.id}
                  page={page}
                  selectedPageId={selectedPageId}
                  onSelect={selectPage}
                  // A search result is only useful if its matches are on screen.
                  expanded={normalizedSearch ? new Set(visiblePages.map((p) => p.id)) : expanded}
                  onToggle={toggleExpanded}
                  level={0}
                  t={t}
                />
              ))}
            </nav>
          </div>
          <section className="options-detail" aria-live="polite">
            {selectedPage ? (
              <>
                <header className="options-detail-header">
                  {selectionPath.length > 1 && (
                    <p className="options-detail-breadcrumb">
                      {selectionPath.map((page, index) => (
                        <span key={page.id}>
                          {index > 0 && <SubmenuArrowGlyph />}
                          <span>{t(page.titleKey)}</span>
                        </span>
                      ))}
                    </p>
                  )}
                  <h2 className="options-detail-title">{t(selectedPage.titleKey)}</h2>
                  {selectedPage.descriptionKey && (
                    <p className="options-detail-description">{t(selectedPage.descriptionKey)}</p>
                  )}
                </header>
                <div className="options-detail-body">
                  {(selectedPage.groups ?? []).map((group) => (
                    <ControlGroup
                      key={`${selectedPage.id}:${group.id}`}
                      group={group}
                      options={options}
                      onChange={handleChange}
                      t={t}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="options-empty">{t('Select a category to view its settings.')}</div>
            )}
          </section>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={handleReset}>
            {t('Restore Defaults')}
          </button>
          <span className="modal-action-spacer" />
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" onClick={handleApply}>{t('Apply')}</button>
        </div>
      </div>
    </div>
  )
}
