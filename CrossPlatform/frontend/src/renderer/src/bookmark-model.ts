import type { BookmarkLocationFormat, BookmarkLocationText, TextPart } from '../../shared/protocol'
import type { Bookmark } from './app-store'
import type { BookmarkSettings } from './components/app-options'

// The Bookmarks window's columns as dnSpy's BookmarksVM writes, matches and sorts them. The Location column
// is the C# formatter's text, which the backend writes; everything else is the window's own.

export type BookmarkColumn = 'name' | 'labels' | 'location' | 'module'

/** A column the list is sorted by, or none — dnSpy's GridViewColumnSorter cycles none → up → down → none. */
export interface BookmarkSort {
  column: BookmarkColumn
  descending: boolean
}

export const nextBookmarkSort = (current: BookmarkSort | undefined, column: BookmarkColumn): BookmarkSort | undefined => {
  if (current?.column !== column)
    return { column, descending: false }
  return current.descending ? undefined : { column, descending: true }
}

/** The display options the Location column is written with — `GetBookmarkLocationFormatterOptions`. */
export const bookmarkLocationFormat = (settings: BookmarkSettings): BookmarkLocationFormat => ({
  showTokens: settings.showTokens,
  showModuleNames: settings.showModuleNames,
  showParameterTypes: settings.showParameterTypes,
  showParameterNames: settings.showParameterNames,
  showDeclaringTypes: settings.showDeclaringTypes,
  showReturnTypes: settings.showReturnTypes,
  showNamespaces: settings.showNamespaces,
  showIntrinsicTypeKeywords: settings.showIntrinsicTypeKeywords,
})

const hex = (value: number, digits: number): string => `0x${(value >>> 0).toString(16).toUpperCase().padStart(digits, '0')}`

/** An IL offset the way dnSpy writes one: four digits, eight once it no longer fits. */
export const formatIlOffset = (offset: number): string => hex(offset, offset <= 0xffff ? 4 : 8)

/**
 * The Location cell of a bookmark the backend could not write — its module is not on this machine, or the
 * token names nothing in it any more. dnSpy shows only the token then; the member's name that was stored
 * with the bookmark says more, so it stands where dnSpy would put the member.
 */
export const fallbackBookmarkLocation = (bookmark: Bookmark, showTokens: boolean): TextPart[] => {
  if (bookmark.kind === 'line')
    return []
  const parts: TextPart[] = []
  if (showTokens || !bookmark.description)
    parts.push({ text: hex(bookmark.metadataToken, 8), color: 'number' })
  if (bookmark.description) {
    if (parts.length > 0)
      parts.push({ text: ' ', color: 'text' })
    parts.push({ text: bookmark.description, color: 'text' })
  }
  if (bookmark.kind === 'body')
    parts.push({ text: ' ', color: 'text' }, { text: '+', color: 'operator' }, { text: ' ', color: 'text' }, { text: formatIlOffset(bookmark.ilOffset), color: 'number' })
  return parts
}

/** What the Location cell shows: the backend's text once it has it, the stored fallback otherwise. */
export const bookmarkLocationParts = (bookmark: Bookmark, written: BookmarkLocationText | undefined, showTokens: boolean): TextPart[] =>
  written && (written.resolved || !bookmark.description) ? written.parts : fallbackBookmarkLocation(bookmark, showTokens)

export const partsText = (parts: TextPart[]): string => parts.map((part) => part.text).join('')

/**
 * A module path in the parts dnSpy's `WriteFilename` colors: the directories, the file's name and its
 * extension, with the separators left as the path has them.
 */
export const modulePathParts = (path: string): TextPart[] => {
  const parts: TextPart[] = []
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const directory = path.slice(0, separator + 1)
  for (const piece of directory.split(/([\\/])/)) {
    if (piece)
      parts.push({ text: piece, color: piece === '/' || piece === '\\' ? 'text' : 'directoryPart' })
  }
  const name = path.slice(separator + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0)
    parts.push({ text: name, color: 'fileNameNoExtension' })
  else
    parts.push({ text: name.slice(0, dot), color: 'fileNameNoExtension' }, { text: '.', color: 'text' }, { text: name.slice(dot + 1), color: 'fileExtension' })
  return parts.filter((part) => part.text !== '')
}

/** One row's four cells as text — what the search box matches, the sort compares and Copy writes. */
export interface BookmarkRowText {
  name: string
  labels: string
  location: string
  module: string
}

export const bookmarkRowText = (bookmark: Bookmark, location: TextPart[]): BookmarkRowText => ({
  name: bookmark.name,
  labels: bookmark.labels.join(', '),
  location: partsText(location),
  module: bookmark.modulePath,
})

const compareText = (left: string, right: string): number => {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The rows in the window's order (BookmarksVM.Compare): by the sorted column without regard to case, ties
 * — and an unsorted list — in the order the bookmarks were made.
 */
export const sortBookmarkRows = (rows: Bookmark[], sort: BookmarkSort | undefined, textOf: (bookmark: Bookmark) => BookmarkRowText): Bookmark[] => {
  const sorted = [...rows]
  sorted.sort((left, right) => {
    let difference = sort ? compareText(textOf(left)[sort.column], textOf(right)[sort.column]) : 0
    if (difference === 0)
      difference = left.order - right.order
    return sort?.descending ? -difference : difference
  })
  return sorted
}

/** The rows as Copy writes them: the four cells tab-separated, one row per line. */
export const bookmarksCopyText = (rows: BookmarkRowText[]): string =>
  rows.map((row) => `${[row.name, row.labels, row.location, row.module].join('\t')}\n`).join('')
