import { create } from 'zustand'
import type { SearchProgress, SearchRequest, SearchResult } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { loadAppOptions, saveAppOptions, type SearchSettings } from './components/app-options'
import { translate as t } from './localization'
import { MAX_SEARCH_RESULTS } from './search-model'

// dnSpy's search window. The query is searched for half a second after the last keystroke, and again from
// scratch whenever one of the boxes or the options changes, or the assemblies it looks through do; a search
// that is still running then is called off. What a search finds arrives in batches while it runs.

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
  /** Set when the window is asked to take the keyboard focus, and cleared once its text box has it. */
  focusRequested: boolean

  /** Changes the query, and searches for it once the typing stops. */
  setQuery(query: string): void
  /** Searches for the query now, calling off whatever is still running. */
  restart(): void
  /** Empties the query and the list, the way dnSpy clears the window when every assembly is closed. */
  clear(): void
  receiveProgress(progress: SearchProgress): void
  /** dnSpy's ISearchService.Focus: the text box takes the focus with its text selected. */
  requestFocus(): void
  focusHandled(): void
}

let nextRequestKey = 0
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

export const searchRequestOf = (query: string, settings: SearchSettings, selectedNodeIds: string[]): SearchRequest => ({
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
})

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  searching: false,
  tooManyResults: false,
  requestKey: undefined,
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
    const { workspaceId, selectedNodes } = useAppStore.getState()
    if (!workspaceId || query.length === 0) {
      set({ results: [], searching: false, tooManyResults: false, requestKey: undefined })
      return
    }
    const requestKey = `search-${++nextRequestKey}`
    set({ results: [], searching: true, tooManyResults: false, requestKey })
    const request = searchRequestOf(query, loadAppOptions().search, selectedNodes.map(node => node.id))
    window.dnSpy.search(workspaceId, request, requestKey).then((response) => {
      if (get().requestKey !== requestKey)
        return
      set((state) => ({
        results: [...state.results, ...unseen(response.results, response.start ?? 0, state.results.length)],
        searching: false,
        tooManyResults: response.truncated,
        requestKey: undefined,
      }))
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
    set({ query: '', results: [], searching: false, tooManyResults: false, requestKey: undefined })
  },

  receiveProgress: (progress) => {
    if (progress.requestKey !== get().requestKey)
      return
    set((state) => ({ results: [...state.results, ...unseen(progress.results, progress.start, state.results.length)] }))
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
