import { useEffect, useMemo, useRef, useState } from 'react'
import type { DebugExceptionCategory, DebugExceptionCondition, DebugExceptionSettings } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { trapTabKey, useModalLayer } from './modal-stack'
import { DsIcon } from './DsIcon'
import { CloseGlyph } from './DsGlyphs'

// dnSpy's Exception Settings window: every exception type the engine knows, a checkbox per row for
// "Break When Thrown", the category and the conditions, and a toolbar carrying the same commands WPF
// offers. The engine owns the list — the client keeps only what it changed against the defaults and
// replays that diff, which is also what it persists.

const ALL_CATEGORIES = ''

/** The code as WPF spells it: eight hex digits, or decimal for a category that says so. */
const formatCode = (code: number, category: DebugExceptionCategory | undefined): string => {
  if (category?.decimalCode)
    return category.unsignedCode ? String(code >>> 0) : String(code)
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/** WPF quotes a condition's value the way C# does, escapes included. */
const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** `Namespace.Type (description)`, the way the Name column reads. `allText` names the category default
 * row, which stands for every type of that category the list does not name. */
const exceptionLabel = (row: DebugExceptionSettings, category: DebugExceptionCategory | undefined, allText: string): string => {
  if (row.name)
    return row.description ? `${row.name} (${row.description})` : row.name
  if (row.code !== null)
    return formatCode(row.code, category)
  return allText
}

const EXCEPTION_CONDITION_TYPES: DebugExceptionCondition['type'][] = ['moduleNameEquals', 'moduleNameNotEquals']

export const ExceptionSettingsPane = (): React.JSX.Element => {
  const categories = useAppStore((state) => state.exceptionCategories)
  const exceptions = useAppStore((state) => state.exceptionSettings)
  const loaded = useAppStore((state) => state.exceptionSettingsLoaded)
  const error = useAppStore((state) => state.exceptionSettingsError)
  const loadExceptionSettings = useAppStore((state) => state.loadExceptionSettings)
  const setExceptionBreakWhenThrown = useAppStore((state) => state.setExceptionBreakWhenThrown)
  const addExceptionDefinition = useAppStore((state) => state.addExceptionDefinition)
  const removeExceptionDefinitions = useAppStore((state) => state.removeExceptionDefinitions)
  const setExceptionConditions = useAppStore((state) => state.setExceptionConditions)
  const restoreDefaultExceptionSettings = useAppStore((state) => state.restoreDefaultExceptionSettings)
  const [query, setQuery] = useState('')
  const [showOnlyEnabled, setShowOnlyEnabled] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES)
  const [selected, setSelected] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [editingConditions, setEditingConditions] = useState<string[]>()
  const { t } = useLanguage()

  // The engine is only asked when the window is opened, and it answers with the stored diff already
  // applied, so a list the user changed in an earlier run comes back the way they left it.
  useEffect(() => {
    if (!loaded && !error)
      void loadExceptionSettings()
  }, [loaded, error, loadExceptionSettings])

  const categoryOf = (name: string): DebugExceptionCategory | undefined => categories.find((category) => category.name === name)

  const conditionsText = (row: DebugExceptionSettings): string => row.conditions
    .map((condition) => `${t(condition.type === 'moduleNameEquals' ? 'Module name equals' : 'Module name not equals')} ${quote(condition.value)}`)
    .join(` ${t('And')} `)

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return exceptions.filter((row) => {
      if (categoryFilter !== ALL_CATEGORIES && row.category !== categoryFilter)
        return false
      if (showOnlyEnabled && !row.stopFirstChance)
        return false
      if (needle === '')
        return true
      const category = categories.find((candidate) => candidate.name === row.category)
      const haystack = [
        row.name ?? '',
        row.code !== null ? formatCode(row.code, category) : '',
        row.description ?? '',
        category?.displayName ?? row.category,
        category?.shortDisplayName ?? '',
        row.conditions.map((condition) => condition.value).join(' '),
      ].join('\t').toLowerCase()
      return haystack.includes(needle)
    })
  }, [exceptions, categories, categoryFilter, showOnlyEnabled, query, t])

  // A selection that outlived its rows would leave the toolbar acting on nothing.
  useEffect(() => {
    setSelected((current) => {
      const alive = current.filter((key) => exceptions.some((row) => row.key === key))
      return alive.length === current.length ? current : alive
    })
  }, [exceptions])

  const selectRow = (key: string, event: React.MouseEvent): void => {
    setSelected((current) => {
      if (event.ctrlKey || event.metaKey)
        return current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]
      if (event.shiftKey && current.length > 0) {
        const from = rows.findIndex((row) => row.key === current[current.length - 1])
        const to = rows.findIndex((row) => row.key === key)
        if (from >= 0 && to >= 0)
          return rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.key)
      }
      return [key]
    })
  }

  const toggleMatching = (): void => {
    // WPF's ToggleAllBreakpoints: if anything in view is still set, clear the lot; otherwise set it.
    const value = !rows.some((row) => row.stopFirstChance)
    void setExceptionBreakWhenThrown(rows.map((row) => row.key), value)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if ((event.target as HTMLElement).matches('input, textarea, select'))
      return
    if (event.key === 'Delete' && selected.length > 0) {
      event.preventDefault()
      void removeExceptionDefinitions(selected)
    } else if (event.key === ' ' && selected.length > 0) {
      // dnSpy binds Space to the same command the checkbox runs.
      event.preventDefault()
      const value = !selected.every((key) => exceptions.find((row) => row.key === key)?.stopFirstChance)
      void setExceptionBreakWhenThrown(selected, value)
    } else if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelected(rows.map((row) => row.key))
    }
  }

  const editingRows = exceptions.filter((row) => (editingConditions ?? []).includes(row.key))

  return (
    <div className="debug-tool-pane exception-settings-pane" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* ExceptionControl.xaml's tool bar, each button with the image dnSpy gives it. */}
      <div className="bookmarks-toolbar">
        <button
          className={`icon-button${showOnlyEnabled ? ' active' : ''}`}
          title={t('Show only enabled exceptions')}
          aria-label={t('Show only enabled exceptions')}
          aria-pressed={showOnlyEnabled}
          onClick={() => setShowOnlyEnabled((value) => !value)}
        ><DsIcon name="Filter" /></button>
        <span className="bookmarks-separator" />
        <button
          className="icon-button"
          title={t('Add an exception to the list')}
          aria-label={t('Add an exception to the list')}
          aria-pressed={adding}
          disabled={categories.length === 0}
          onClick={() => setAdding((value) => !value)}
        ><DsIcon name="Add" /></button>
        <button
          className="icon-button"
          title={t('Remove an exception from the list')}
          aria-label={t('Remove an exception from the list')}
          disabled={selected.length === 0}
          onClick={() => void removeExceptionDefinitions(selected)}
        ><DsIcon name="RemoveCommand" /></button>
        <button
          className="icon-button"
          title={t('Enable or disable all exceptions matching the current search criteria')}
          aria-label={t('Enable or disable all exceptions matching the current search criteria')}
          disabled={rows.length === 0}
          onClick={toggleMatching}
        ><DsIcon name="ToggleAllBreakpoints" /></button>
        <button
          className="icon-button"
          title={t('Edit conditions')}
          aria-label={t('Edit conditions')}
          disabled={selected.length === 0}
          onClick={() => setEditingConditions(selected)}
        ><DsIcon name="Edit" /></button>
        <button
          className="icon-button"
          title={t('Restore the list to the default settings')}
          aria-label={t('Restore the list to the default settings')}
          onClick={() => void restoreDefaultExceptionSettings()}
        ><DsIcon name="UndoCheckBoxList" /></button>
        <span className="bookmarks-separator" />
        <select
          className="exception-category-filter"
          aria-label={t('Category')}
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
        >
          <option value={ALL_CATEGORIES}>{t('All')}</option>
          {categories.map((category) => <option key={category.name} value={category.name}>{category.shortDisplayName}</option>)}
        </select>
        <span className="bookmarks-separator" />
        <button
          className="icon-button"
          title={t('Reset all search criteria so that all exceptions are shown')}
          aria-label={t('Reset all search criteria so that all exceptions are shown')}
          disabled={query === '' && categoryFilter === ALL_CATEGORIES && !showOnlyEnabled}
          onClick={() => { setQuery(''); setCategoryFilter(ALL_CATEGORIES); setShowOnlyEnabled(false) }}
        ><DsIcon name="ClearWindowContent" /></button>
        <span className="bookmarks-separator" />
        <span className="exception-search-label">{t('Search')}</span>
        <input
          className="exception-search"
          aria-label={t('Search for an exception')}
          placeholder={t('Search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {adding && (
        <AddExceptionRow
          categories={categories}
          onCancel={() => setAdding(false)}
          onAdd={(entry) => { setAdding(false); void addExceptionDefinition(entry) }}
        />
      )}

      {error ? (
        <div className="pane-empty">{t('The exception settings could not be read: {message}', { message: error })}</div>
      ) : rows.length === 0 ? (
        <div className="pane-empty">
          <span>{loaded ? t('No exception types match your search filter.') : t('Loading')}</span>
        </div>
      ) : (
        <div className="exception-table" role="table" aria-label={t('Exception Settings')}>
          <div className="exception-header" role="row">
            <span role="columnheader">{t('Break When Thrown')}</span>
            <span role="columnheader">{t('Category')}</span>
            <span role="columnheader">{t('Conditions')}</span>
          </div>
          <div className="exception-rows">
            {rows.map((row) => {
              const category = categoryOf(row.category)
              const label = exceptionLabel(row, category, t('<All {0} not in this list>', { 0: category?.displayName ?? row.category }))
              const conditions = conditionsText(row)
              return (
                <div
                  className={`exception-row${selected.includes(row.key) ? ' selected' : ''}`}
                  role="row"
                  key={row.key}
                  onMouseDown={(event) => selectRow(row.key, event)}
                >
                  <span className="exception-name-cell">
                    <input
                      type="checkbox"
                      checked={row.stopFirstChance}
                      aria-label={t(row.stopFirstChance ? 'Disable {name}' : 'Enable {name}', { name: label })}
                      onChange={() => void setExceptionBreakWhenThrown([row.key], !row.stopFirstChance)}
                    />
                    <span title={label}>{label}</span>
                  </span>
                  <span title={category?.displayName ?? row.category}>{category?.displayName ?? row.category}</span>
                  <span title={conditions}>{conditions}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="bookmarks-footer">
        <span className="status-spacer" />
        <span>{t('{count} exception(s)', { count: rows.length })}</span>
      </div>

      {editingConditions && (
        <ExceptionConditionsDialog
          rows={editingRows}
          onClose={() => setEditingConditions(undefined)}
          onSave={(conditions) => { const keys = editingConditions; setEditingConditions(undefined); void setExceptionConditions(keys, conditions) }}
        />
      )}
    </div>
  )
}

/** WPF's AddExceptionControl: a category, the name or code, and a description for code categories. */
const AddExceptionRow = ({ categories, onAdd, onCancel }: {
  categories: DebugExceptionCategory[]
  onAdd(entry: { category: string; name?: string; code?: number; description?: string }): void
  onCancel(): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const [category, setCategory] = useState(categories[0]?.name ?? '')
  const [nameOrCode, setNameOrCode] = useState('')
  const [description, setDescription] = useState('')
  const selected = categories.find((candidate) => candidate.name === category)
  const isCode = selected?.hasCode ?? false
  const trimmed = nameOrCode.trim()
  // WPF parses the box as a number for a code category and as a type name otherwise.
  const code = isCode ? Number.parseInt(trimmed.replace(/^0[xX]/, ''), trimmed.toLowerCase().startsWith('0x') ? 16 : 10) : Number.NaN
  const valid = trimmed !== '' && (!isCode || Number.isInteger(code))

  const submit = (): void => {
    if (!valid)
      return
    onAdd(isCode
      ? { category, code, description: description.trim() || undefined }
      : { category, name: trimmed, description: description.trim() || undefined })
  }

  return (
    <div className="exception-add-row">
      <button className="command-button" disabled={!valid} onClick={submit}>{t('Add')}</button>
      <select aria-label={t('Category')} value={category} onChange={(event) => setCategory(event.target.value)}>
        {categories.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.shortDisplayName}</option>)}
      </select>
      <input
        aria-label={isCode ? t('Code') : t('Name')}
        className="exception-add-name"
        aria-invalid={!valid && trimmed !== ''}
        title={trimmed === '' ? t("Name can't be empty") : undefined}
        value={nameOrCode}
        onChange={(event) => setNameOrCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter')
            submit()
          else if (event.key === 'Escape')
            onCancel()
        }}
      />
      <input
        aria-label={t('Exception description')}
        title={t('Exception description')}
        // WPF only asks for a description when the category identifies types by a number.
        disabled={!isCode}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
    </div>
  )
}

/** WPF's EditExceptionConditionsDlg: one or more module-name conditions, all of which have to hold. */
const ExceptionConditionsDialog = ({ rows, onClose, onSave }: {
  rows: DebugExceptionSettings[]
  onClose(): void
  onSave(conditions: DebugExceptionCondition[]): void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const dialog = useRef<HTMLDivElement>(null)
  const depth = useModalLayer(onClose)
  // WPF edits the first selected row's conditions and applies the result to all of them.
  const [conditions, setConditions] = useState<DebugExceptionCondition[]>(rows[0]?.conditions ?? [])

  const setCondition = (index: number, change: Partial<DebugExceptionCondition>): void =>
    setConditions((current) => current.map((condition, position) => position === index ? { ...condition, ...change } : condition))

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      style={{ zIndex: 100 + depth * 10 }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        ref={dialog}
        className="modal exception-conditions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exception-conditions-title"
        onKeyDown={(event) => trapTabKey(event, dialog.current)}
      >
        <div className="modal-title">
          <span id="exception-conditions-title">{t('Edit conditions')}</span>
          <button className="icon-button" aria-label={t('Close')} onClick={onClose}><CloseGlyph /></button>
        </div>
        <div className="exception-conditions-body">
          {conditions.length === 0 && <span className="exception-conditions-empty">{t('No conditions')}</span>}
          {conditions.map((condition, index) => (
            <div className="exception-condition-row" key={index}>
              {index > 0 && <span className="exception-condition-and">{t('And')}</span>}
              <select
                aria-label={t('Conditions')}
                value={condition.type}
                onChange={(event) => setCondition(index, { type: event.target.value as DebugExceptionCondition['type'] })}
              >
                {EXCEPTION_CONDITION_TYPES.map((type) => (
                  <option key={type} value={type}>{t(type === 'moduleNameEquals' ? 'Module name equals' : 'Module name not equals')}</option>
                ))}
              </select>
              <input
                aria-label={t('Module name')}
                value={condition.value}
                onChange={(event) => setCondition(index, { value: event.target.value })}
              />
              <button
                className="icon-button"
                aria-label={t('Remove')}
                title={t('Remove')}
                onClick={() => setConditions((current) => current.filter((_, position) => position !== index))}
              ><DsIcon name="Cancel" /></button>
            </div>
          ))}
          <button
            className="icon-button exception-condition-add"
            aria-label={t('Add')}
            title={t('Add')}
            onClick={() => setConditions((current) => [...current, { type: 'moduleNameEquals', value: '' }])}
          ><DsIcon name="Add" /></button>
        </div>
        <div className="modal-actions">
          <span className="modal-action-spacer" />
          <button onClick={onClose}>{t('Cancel')}</button>
          {/* A condition with no pattern would match nothing but read as if it did. */}
          <button className="primary" disabled={conditions.some((condition) => condition.value.trim() === '')} onClick={() => onSave(conditions)}>{t('OK')}</button>
        </div>
      </div>
    </div>
  )
}
