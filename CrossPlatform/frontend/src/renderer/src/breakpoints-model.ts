import type { BookmarkLocationFormat, BookmarkLocationText, TextPart } from '../../shared/protocol'
import type { BreakpointSettings, FunctionBreakpoint, LineBreakpoint } from './app-store'
import { breakpointImage, breakpointKind } from './app-store'
import type { BreakpointDisplaySettings } from './components/app-options'
import { formatIlOffset, partsText } from './bookmark-model'

type Translate = (message: string, values?: Record<string, string | number>) => string

/** The Breakpoints window's columns, in dnSpy's order (CodeBreakpointsWindowColumnIds), with their search options. */
export type BreakpointColumn = 'name' | 'labels' | 'condition' | 'hitCount' | 'filter' | 'whenHit' | 'module'

export const BREAKPOINT_COLUMNS: { id: BreakpointColumn; shortOption: string; header: string }[] = [
  { id: 'name', shortOption: 'n', header: 'Name' },
  { id: 'labels', shortOption: 'l', header: 'Labels' },
  { id: 'condition', shortOption: 'c', header: 'Condition' },
  { id: 'hitCount', shortOption: 'h', header: 'Hit Count' },
  { id: 'filter', shortOption: 'f', header: 'Filter' },
  { id: 'whenHit', shortOption: 'w', header: 'When Hit' },
  { id: 'module', shortOption: 'm', header: 'Module' },
]

/** A row of the window: a code breakpoint, or one of this port's breakpoints by method name. */
export type BreakpointRow =
  | { kind: 'line'; id: string; order: number; enabled: boolean; breakpoint: LineBreakpoint }
  | { kind: 'function'; id: string; order: number; enabled: boolean; breakpoint: FunctionBreakpoint }

export const breakpointRows = (lines: LineBreakpoint[], functions: FunctionBreakpoint[]): BreakpointRow[] => [
  ...lines.map((breakpoint): BreakpointRow => ({ kind: 'line', id: breakpoint.id, order: breakpoint.order, enabled: breakpoint.enabled, breakpoint })),
  // A name breakpoint is listed after the code breakpoints, in the order it was added.
  ...functions.map((breakpoint, index): BreakpointRow => ({ kind: 'function', id: `fn:${breakpoint.name}`, order: Number.MAX_SAFE_INTEGER / 2 + index, enabled: breakpoint.enabled, breakpoint })),
]

export const rowSettings = (row: BreakpointRow): BreakpointSettings | undefined => row.breakpoint.settings

/** The image the Name column and the margin draw a breakpoint with. */
export const rowImage = (row: BreakpointRow): string =>
  breakpointImage(breakpointKind({ enabled: row.enabled, settings: rowSettings(row), severity: row.kind === 'line' ? row.breakpoint.severity : undefined }))

/** What the Name column's formatter is asked to write: dnSpy's DbgCodeBreakpointDisplaySettings as bookmark options. */
export const breakpointLocationFormat = (settings: BreakpointDisplaySettings): BookmarkLocationFormat => ({
  showTokens: settings.showTokens,
  showModuleNames: settings.showModuleNames,
  showParameterTypes: settings.showParameterTypes,
  showParameterNames: settings.showParameterNames,
  showDeclaringTypes: settings.showDeclaringTypes,
  showReturnTypes: settings.showReturnTypes,
  showNamespaces: settings.showNamespaces,
  showIntrinsicTypeKeywords: settings.showIntrinsicTypeKeywords,
})

/**
 * The Name column: DbgBreakpointLocationFormatterImpl's text — the token, the method and " + 0x0012" — as the backend
 * wrote it, or, while it has not, the method's name the breakpoint carries and the offset after it.
 */
export const rowNameParts = (row: BreakpointRow, written: BookmarkLocationText | undefined, showTokens: boolean): TextPart[] => {
  if (row.kind === 'function')
    return [{ text: row.breakpoint.name, color: 'text' }]
  if (written?.resolved)
    return written.parts
  const breakpoint = row.breakpoint
  const parts: TextPart[] = []
  if (breakpoint.metadataToken !== undefined && showTokens)
    parts.push({ text: `0x${(breakpoint.metadataToken >>> 0).toString(16).toUpperCase().padStart(8, '0')}`, color: 'number' }, { text: ' ', color: 'text' })
  parts.push({ text: breakpoint.description ?? (breakpoint.metadataToken !== undefined ? '???' : `Line ${breakpoint.line}`), color: 'text' })
  if (breakpoint.ilOffset !== undefined)
    parts.push({ text: ' ', color: 'text' }, { text: '+', color: 'operator' }, { text: ' ', color: 'text' }, { text: formatIlOffset(breakpoint.ilOffset), color: 'number' })
  return parts
}

/** BreakpointConditionsFormatter's Condition column. */
export const conditionText = (settings: BreakpointSettings | undefined, t: Translate): string => {
  const condition = settings?.condition
  if (!condition)
    return t('(no condition)')
  return condition.kind === 'whenChanged'
    ? t("when '{expression}' has changed", { expression: condition.expression })
    : t("when '{expression}' is true", { expression: condition.expression })
}

/** The Hit Count column; while a debugger runs it says how many hits there have been — none counts as 0. */
export const hitCountText = (settings: BreakpointSettings | undefined, hitCount: number | undefined, debugging: boolean, t: Translate): string => {
  const hit = settings?.hitCount
  let text: string
  if (!hit)
    text = t('break always')
  else if (hit.kind === 'multipleOf')
    text = t('when hit count is a multiple of {count}', { count: hit.count })
  else if (hit.kind === 'greaterThanOrEquals')
    text = t('when hit count is greater than or equal to {count}', { count: hit.count })
  else
    text = t('when hit count is equal to {count}', { count: hit.count })
  return debugging ? `${text} (${t('currently {count}', { count: hitCount ?? 0 })})` : text
}

export const filterText = (settings: BreakpointSettings | undefined, t: Translate): string =>
  settings?.filter ? settings.filter : t('(none)')

export const whenHitText = (settings: BreakpointSettings | undefined, t: Translate): string => {
  const trace = settings?.trace
  if (!trace)
    return t('Break')
  return trace.continue
    ? t("Print message '{message}'", { message: trace.message })
    : t("Break and print message '{message}'", { message: trace.message })
}

/** dnSpy's labels: the parts written with ", " between them, and typed text split on commas. */
export const labelsText = (settings: BreakpointSettings | undefined): string => (settings?.labels ?? []).join(', ')

export const parseLabels = (text: string): string[] => text.split(',').map((label) => label.trim()).filter((label) => label !== '')

/** The Module column: the module's file name. */
export const moduleText = (row: BreakpointRow): string =>
  row.kind === 'line' && row.breakpoint.modulePath ? row.breakpoint.modulePath.split(/[\\/]/).at(-1) ?? '' : ''

/** A row's text per column, in the window's column order: what the search reads, sorts by and copies. */
export const rowTexts = (row: BreakpointRow, name: TextPart[], debugging: boolean, t: Translate): Record<BreakpointColumn, string> => {
  const settings = rowSettings(row)
  return {
    name: partsText(name),
    labels: labelsText(settings),
    condition: conditionText(settings, t),
    hitCount: hitCountText(settings, row.breakpoint.hitCount, debugging, t),
    filter: filterText(settings, t),
    whenHit: whenHitText(settings, t),
    module: moduleText(row),
  }
}

/** A column sort, or the insertion order when there is none — dnSpy's Default direction. */
export interface BreakpointSort {
  column: BreakpointColumn
  descending: boolean
}

/** GridViewColumnSorter: a header click cycles a column through ascending, descending and the default order. */
export const nextBreakpointSort = (current: BreakpointSort | undefined, column: BreakpointColumn): BreakpointSort | undefined => {
  if (current?.column !== column)
    return { column, descending: false }
  return current.descending ? undefined : { column, descending: true }
}

/** CodeBreakpointsVM's comparer: the column's text ignoring case, ties by insertion order; descending turns the lot. */
export const sortBreakpointRows = (rows: BreakpointRow[], sort: BreakpointSort | undefined, textOf: (row: BreakpointRow) => Record<BreakpointColumn, string>): BreakpointRow[] => {
  const sorted = [...rows]
  sorted.sort((left, right) => {
    let result = 0
    if (sort) {
      const a = textOf(left)[sort.column].toUpperCase()
      const b = textOf(right)[sort.column].toUpperCase()
      result = a < b ? -1 : a > b ? 1 : 0
    }
    if (result === 0)
      result = left.order - right.order
    return sort?.descending ? -result : result
  })
  return sorted
}

/** CodeBreakpointsOperations.Copy: a line per row, the visible columns in the order shown, tab-separated. */
export const breakpointsCopyText = (rows: Record<BreakpointColumn, string>[], columns: BreakpointColumn[]): string =>
  rows.map((row) => columns.map((column) => row[column]).join('\t')).join('\n')

/** The IL offset of a code breakpoint as dnSpy writes it after the method. */
export const breakpointOffsetText = (row: BreakpointRow): string =>
  row.kind === 'line' && row.breakpoint.ilOffset !== undefined ? formatIlOffset(row.breakpoint.ilOffset) : ''
