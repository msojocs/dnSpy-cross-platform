import { create } from 'zustand'
import type { DecompilerLanguage, SearchProgress, SearchRequest, SearchResult, TreeNode } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { loadAppOptions, saveAppOptions, type SearchSettings } from './components/app-options'
import { translate as t } from './localization'
import { MAX_SEARCH_RESULTS } from './search-model'

// dnSpy's search window. The query is searched for half a second after the last keystroke, and again from
// scratch whenever one of the boxes or the options changes, or the assemblies it looks through do; a search
// that is still running then is called off. What a search finds arrives in batches while it runs, written
// through the toolbar's language; choosing another one writes the list again without searching again.

/** SearchControlVM.DEFAULT_DELAY_SEARCH_MS. */
export const SEARCH_DELAY_MS = 500

interface SearchState {
  query: string
  /** In the order the search found them; the window sorts them. */
  results: SearchResult[]
  searching: boolean
  /** The search stopped at the limit — dnSpy's TooManyResults, which puts a red border round the list. */
  tooManyResults: boolean
  /** The request still running, which a batch has to name to be taken. */
  requestKey?: string
  /** The request the list holds the results of, running or not, which writing them again names. */
  resultsKey?: string
  /** Counts the searches started and the lists emptied: a new value is a new list, whose rows are new. */
  generation: number
  /** Set when the window is asked to take the keyboard focus, and cleared once its text box has it. */
  focusRequested: boolean

  /** Changes the query, and searches for it once the typing stops. */
  setQuery(query: string): void
  /** Searches for the query now, calling off whatever is still running. */
  restart(): void
  /** Empties the query and the list, the way dnSpy clears the window when every assembly is closed. */
  clear(): void
  receiveProgress(progress: SearchProgress): void
  /** dnSpy's DecompilerChanged: the results `count` from `start` written again through the toolbar's language. */
  relabel(start?: number, count?: number): Promise<void>
  /** dnSpy's ISearchService.Focus: the text box takes the focus with its text selected. */
  requestFocus(): void
  focusHandled(): void
}

let nextRequestKey = 0
/** The language the running search was asked with, which its batches are written in. */
let requestLanguage: DecompilerLanguage | undefined
let delayed: ReturnType<typeof setTimeout> | undefined

const cancelDelayed = (): void => {
  if (delayed !== undefined) {
    clearTimeout(delayed)
    delayed = undefined
  }
}

const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** The part of a batch the list does not hold yet: the batch starts at `start` among everything found. */
const unseen = (batch: SearchResult[], start: number, held: number): SearchResult[] => batch.slice(Math.max(held - start, 0))

const currentLanguage = (): DecompilerLanguage => useAppStore.getState().defaultLanguage

/**
 * The tree nodes a search through the selection starts from. "Selected Type" searches the type each selected row
 * is in or is — dnSpy's GetAncestorOrSelf<TypeNode> — and a row of a type's base type or derived types folders
 * is in the type the folder hangs off, which only the tree knows.
 */
export const searchSelectionOf = (location: SearchSettings['location'], selected: readonly TreeNode[], parents: Readonly<Record<string, string>>, nodeById: (id: string) => TreeNode | undefined): string[] => {
  if (location !== 'selectedType')
    return selected.map((node) => node.id)
  const ids = selected.map((node) => {
    for (let current: TreeNode | undefined = node; current; current = parents[current.id] ? nodeById(parents[current.id]) : undefined) {
      if (current.kind === 'type')
        return current.id
    }
    return node.id
  })
  return [...new Set(ids)]
}

export const searchRequestOf = (query: string, settings: SearchSettings, selectedNodeIds: string[], language?: DecompilerLanguage): SearchRequest => ({
  query,
  searchType: settings.searchType,
  location: settings.location,
  selectedNodeIds,
  caseSensitive: settings.caseSensitive,
  matchWholeWords: settings.matchWholeWords,
  matchAnySearchTerm: settings.matchAnySearchTerm,
  searchDecompiledData: settings.searchDecompiledData,
  searchFrameworkAssemblies: settings.searchFrameworkAssemblies,
  searchCompilerGeneratedMembers: settings.searchCompilerGeneratedMembers,
  maxResults: MAX_SEARCH_RESULTS,
  language,
})

/** A node the tree has listed, by its id. */
const treeNodeById = (id: string): TreeNode | undefined => {
  const { roots, children } = useAppStore.getState()
  return roots.find((node) => node.id === id) ?? Object.values(children).flat().find((node) => node.id === id)
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  searching: false,
  tooManyResults: false,
  requestKey: undefined,
  resultsKey: undefined,
  generation: 0,
  focusRequested: false,

  setQuery: (query) => {
    set({ query })
    cancelDelayed()
    delayed = setTimeout(() => {
      delayed = undefined
      get().restart()
    }, SEARCH_DELAY_MS)
  },

  restart: () => {
    cancelDelayed()
    const previous = get().requestKey
    if (previous)
      void window.dnSpy.cancelSearch(previous).catch(() => undefined)
    const { query } = get()
    const { workspaceId, selectedNodes, parents } = useAppStore.getState()
    if (!workspaceId || query.length === 0) {
      set((state) => ({ results: [], searching: false, tooManyResults: false, requestKey: undefined, resultsKey: undefined, generation: state.generation + 1 }))
      return
    }
    const requestKey = `search-${++nextRequestKey}`
    set((state) => ({ results: [], searching: true, tooManyResults: false, requestKey, resultsKey: requestKey, generation: state.generation + 1 }))
    const settings = loadAppOptions().search
    const language = currentLanguage()
    requestLanguage = language
    const request = searchRequestOf(query, settings, searchSelectionOf(settings.location, selectedNodes, parents, treeNodeById), language)
    window.dnSpy.search(workspaceId, request, requestKey).then((response) => {
      if (get().requestKey !== requestKey)
        return
      const start = get().results.length
      const fresh = unseen(response.results, response.start ?? 0, start)
      set((state) => ({
        results: [...state.results, ...fresh],
        searching: false,
        tooManyResults: response.truncated,
        requestKey: undefined,
      }))
      if (fresh.length > 0 && language !== currentLanguage())
        void get().relabel(start, fresh.length)
    }, (reason: unknown) => {
      // A search called off, or started over, has no one waiting for it.
      if (get().requestKey !== requestKey)
        return
      set({ searching: false, requestKey: undefined })
      useAppStore.getState().appendOutput(t('Search failed: {message}', { message: message(reason) }))
    })
  },

  clear: () => {
    cancelDelayed()
    const previous = get().requestKey
    if (previous)
      void window.dnSpy.cancelSearch(previous).catch(() => undefined)
    set((state) => ({ query: '', results: [], searching: false, tooManyResults: false, requestKey: undefined, resultsKey: undefined, generation: state.generation + 1 }))
  },

  receiveProgress: (progress) => {
    if (progress.requestKey !== get().requestKey)
      return
    const start = get().results.length
    const fresh = unseen(progress.results, progress.start, start)
    set((state) => ({ results: [...state.results, ...fresh] }))
    // A batch is written in the language the search was asked with, which may have been changed since.
    if (fresh.length > 0 && requestLanguage !== currentLanguage())
      void get().relabel(start, fresh.length)
  },

  relabel: async (start = 0, count = get().results.length) => {
    const workspaceId = useAppStore.getState().workspaceId
    const { resultsKey, generation } = get()
    if (!workspaceId || !resultsKey || count <= 0)
      return
    const language = currentLanguage()
    let response
    try {
      response = await window.dnSpy.relabelSearch(workspaceId, resultsKey, language, start, count)
    } catch {
      // A search the backend let go of, or one the workspace changed under, is about to be searched again.
      return
    }
    // A list replaced since, or a language chosen since, which asks again, has no use for the answer.
    if (get().generation !== generation || currentLanguage() !== language)
      return
    const from = response.start ?? start
    set((state) => {
      const results = [...state.results]
      response.results.forEach((result, offset) => {
        if (from + offset < results.length)
          results[from + offset] = result
      })
      return { results }
    })
  },

  requestFocus: () => set({ focusRequested: true }),
  focusHandled: () => set({ focusRequested: false }),
}))

// A running search sends what it finds in batches, each for the request it was asked with.
window.dnSpy?.onSearchProgress?.((progress) => useSearchStore.getState().receiveProgress(progress))

// The search follows the workspace: closing it empties the window, and opening another, an edit, its undo
// or redo, a reload, or an assembly added or removed by hand starts the search over — dnSpy restarts it on
// every change to the documents it looks through.
useAppStore.subscribe((state, previous) => {
  if (state.workspaceId !== previous.workspaceId && !state.workspaceId) {
    useSearchStore.getState().clear()
    return
  }
  if (state.workspaceId !== previous.workspaceId
    || state.workspaceGeneration !== previous.workspaceGeneration
    || state.workspaceStateId !== previous.workspaceStateId
    || state.assemblyListRevision !== previous.assemblyListRevision)
    useSearchStore.getState().restart()
  // dnSpy's DecompilerChanged: the list is written through the language chosen.
  else if (state.defaultLanguage !== previous.defaultLanguage)
    void useSearchStore.getState().relabel()
})

const searchKey = (settings: SearchSettings): string => JSON.stringify({ ...settings, syntaxHighlight: undefined })

/**
 * Changes the search window's settings, which the window and its context menu do. A change to what the search
 * looks for starts it over; the syntax highlighting only changes how the list is drawn.
 */
export const updateSearchSettings = (patch: Partial<SearchSettings>): void => {
  const options = loadAppOptions()
  const settings = { ...options.search, ...patch }
  saveAppOptions({ ...options, search: settings })
  if (searchKey(settings) !== searchKey(options.search))
    useSearchStore.getState().restart()
}
