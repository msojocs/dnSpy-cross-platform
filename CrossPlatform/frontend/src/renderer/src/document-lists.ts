import type { DocumentListDto } from '../../shared/protocol'

/**
 * dnSpy's Open List: named lists of files to open together. One list is the selected one, and it always
 * holds what the tree has open — dnSpy's DocumentListLoader saves the current documents into it before the
 * dialog opens and when the window closes — so picking another list swaps one set of files for another.
 */
export interface DocumentList {
  name: string
  files: string[]
}

export interface StoredDocumentLists {
  /** The list the open files belong to. */
  selected: string
  lists: DocumentList[]
}

/** DocumentList.DEFAULT_NAME: the list there is when the user never made one. */
export const DEFAULT_LIST_NAME = '(Default)'

const storageKey = 'dnspy.documentLists.v1'

const isList = (value: unknown): value is DocumentList =>
  typeof value === 'object' && value !== null
  && typeof (value as DocumentList).name === 'string'
  && Array.isArray((value as DocumentList).files)
  && (value as DocumentList).files.every((file) => typeof file === 'string')

/**
 * DocumentListService.Load: the saved lists, a name seen twice kept once, and the selected one by name —
 * the first list when the name is gone. With no list at all there is the default one, empty.
 */
export const loadDocumentLists = (): StoredDocumentLists => {
  let parsed: unknown
  try {
    parsed = typeof localStorage === 'undefined' ? undefined : JSON.parse(localStorage.getItem(storageKey) ?? 'null')
  } catch {
    parsed = undefined
  }
  const raw = typeof parsed === 'object' && parsed !== null ? parsed as Partial<StoredDocumentLists> : {}
  const names = new Set<string>()
  const lists = (Array.isArray(raw.lists) ? raw.lists : []).filter(isList).filter((list) => {
    if (names.has(list.name))
      return false
    names.add(list.name)
    return true
  }).map((list) => ({ name: list.name, files: [...list.files] }))
  if (lists.length === 0)
    lists.push({ name: DEFAULT_LIST_NAME, files: [] })
  const selected = typeof raw.selected === 'string' && names.has(raw.selected) ? raw.selected : lists[0].name
  return { selected, lists }
}

export const saveDocumentLists = (stored: StoredDocumentLists): void => {
  if (typeof localStorage !== 'undefined')
    localStorage.setItem(storageKey, JSON.stringify(stored))
}

/** DocumentListLoader.SaveCurrentDocumentsToList: the selected list takes the files the tree has open. */
export const rememberCurrentDocuments = (paths: readonly string[]): StoredDocumentLists => {
  const stored = loadDocumentLists()
  const updated = { ...stored, lists: stored.lists.map((list) => list.name === stored.selected ? { ...list, files: [...paths] } : list) }
  saveDocumentLists(updated)
  return updated
}

/** One row of the dialog: a saved list (a user list), or one the machine offers that nobody saved yet. */
export interface DocumentListRow {
  list: DocumentList
  isUserList: boolean
}

/**
 * OpenDocumentListVM's rows: the saved lists, then each list the machine offers whose name no saved list
 * has already (ignoring case), sorted by name the way DocumentListVM_Comparer sorts them.
 */
export const documentListRows = (saved: readonly DocumentList[], defaults: readonly DocumentListDto[]): DocumentListRow[] => {
  const names = new Set(saved.map((list) => list.name.toLowerCase()))
  const rows: DocumentListRow[] = saved.map((list) => ({ list, isUserList: true }))
  for (const list of defaults) {
    if (!names.has(list.name.toLowerCase()))
      rows.push({ list: { name: list.name, files: [...list.files] }, isUserList: false })
  }
  return rows.sort((left, right) => compareNames(left.list.name, right.list.name))
}

const compareNames = (left: string, right: string): number => {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * OpenDocumentListVM.CalculateIsVisible: with "Saved lists" on, only the user's own lists; and a list only
 * when every space-separated word of the search is in its name, ignoring case.
 */
export const filterDocumentListRows = (rows: readonly DocumentListRow[], search: string, savedOnly: boolean): DocumentListRow[] => {
  const words = search.trim().toUpperCase().split(' ').filter((word) => word.length > 0)
  return rows.filter((row) => {
    if (savedOnly && !row.isUserList)
      return false
    const name = row.list.name.toUpperCase()
    return words.every((word) => name.includes(word))
  })
}

/**
 * What OK does — OpenListCommand.Execute and OpenDocumentListVM.Save: the chosen list is added and becomes
 * the selected one, the lists the user removed go (never the one now selected), and the ones they made are
 * kept. Cancel keeps none of it, so this only runs for OK.
 */
export const applyDocumentListChanges = (
  stored: StoredDocumentLists,
  removed: readonly string[],
  created: readonly DocumentList[],
  chosen: DocumentList | undefined,
): StoredDocumentLists => {
  const lists = [...stored.lists]
  const has = (name: string): boolean => lists.some((list) => list.name === name)
  if (chosen && !has(chosen.name))
    lists.push(chosen)
  const selected = chosen?.name ?? stored.selected
  const kept = lists.filter((list) => list.name === selected || !removed.includes(list.name))
  for (const list of created) {
    if (!removed.includes(list.name) && !kept.some((existing) => existing.name === list.name))
      kept.push(list)
  }
  return { selected, lists: kept }
}
