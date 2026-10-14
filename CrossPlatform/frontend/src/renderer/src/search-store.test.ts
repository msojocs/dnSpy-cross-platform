import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchRequest, SearchResponse, SearchResult } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { defaultAppOptions, loadAppOptions, saveAppOptions } from './components/app-options'
import { SEARCH_DELAY_MS, updateSearchSettings, useSearchStore } from './search-store'

const result = (name: string): SearchResult => ({ nodeId: `n-${name}`, kind: 'type', name, location: 'Ns' })

const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

let pending: ReturnType<typeof deferred<SearchResponse>>[] = []
const search = vi.fn((_workspaceId: string, _request: SearchRequest, _requestKey: string): Promise<SearchResponse> => {
  const next = deferred<SearchResponse>()
  pending.push(next)
  return next.promise
})
const cancelSearch = vi.fn(async () => undefined)

const state = () => useSearchStore.getState()
const lastRequestKey = (): string => search.mock.calls.at(-1)![2]

beforeEach(() => {
  Object.assign(window.dnSpy, { search, cancelSearch })
  saveAppOptions(defaultAppOptions)
  useAppStore.setState({ workspaceId: 'ws', workspaceGeneration: 0, workspaceStateId: 's1', assemblyListRevision: 0, output: [], selectedNode: undefined })
  state().clear()
  pending = []
  search.mockClear()
  cancelSearch.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  state().clear()
  localStorage.clear()
})

describe('search store', () => {
  it('searches half a second after the typing stops', () => {
    vi.useFakeTimers()
    state().setQuery('He')
    vi.advanceTimersByTime(SEARCH_DELAY_MS - 1)
    state().setQuery('Hello')
    vi.advanceTimersByTime(SEARCH_DELAY_MS - 1)
    expect(search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0][1]).toMatchObject({ query: 'Hello' })
    expect(state().searching).toBe(true)
  })

  it('asks for what the settings and the tree\'s selection say', () => {
    saveAppOptions({ ...loadAppOptions(), search: { ...loadAppOptions().search, searchType: 'literal', location: 'selectedType', caseSensitive: true, searchFrameworkAssemblies: false } })
    const selectedNode = { id: 'n7', kind: 'type', label: 'T', hasChildren: false }
    useAppStore.setState({ selectedNode, selectedNodes: [selectedNode] })
    useSearchStore.setState({ query: '42' })
    state().restart()
    expect(search).toHaveBeenCalledWith('ws', {
      query: '42',
      searchType: 'literal',
      location: 'selectedType',
      selectedNodeIds: ['n7'],
      caseSensitive: true,
      matchWholeWords: false,
      matchAnySearchTerm: false,
      searchDecompiledData: true,
      searchFrameworkAssemblies: false,
      searchCompilerGeneratedMembers: true,
      maxResults: 10_000,
    }, expect.any(String))
  })

  it('takes the batches a search sends ahead, then the rest with its answer', async () => {
    useSearchStore.setState({ query: 'x' })
    state().restart()
    const requestKey = lastRequestKey()
    state().receiveProgress({ requestKey, start: 0, results: [result('A'), result('B')] })
    // A batch for another request is not this search's.
    state().receiveProgress({ requestKey: 'other', start: 2, results: [result('Z')] })
    state().receiveProgress({ requestKey, start: 2, results: [result('C')] })
    expect(state().results.map((item) => item.name)).toEqual(['A', 'B', 'C'])
    pending[0].resolve({ results: [result('D')], truncated: true, start: 3 })
    await vi.waitFor(() => expect(state().searching).toBe(false))
    expect(state().results.map((item) => item.name)).toEqual(['A', 'B', 'C', 'D'])
    expect(state().tooManyResults).toBe(true)
  })

  it('calls off the search still running when it starts over, and forgets what that one finds', async () => {
    useSearchStore.setState({ query: 'x' })
    state().restart()
    const first = lastRequestKey()
    useSearchStore.setState({ query: 'y' })
    state().restart()
    expect(cancelSearch).toHaveBeenCalledWith(first)
    pending[0].resolve({ results: [result('Old')], truncated: false })
    state().receiveProgress({ requestKey: first, start: 0, results: [result('Old')] })
    pending[1].resolve({ results: [result('New')], truncated: false })
    await vi.waitFor(() => expect(state().searching).toBe(false))
    expect(state().results.map((item) => item.name)).toEqual(['New'])
  })

  it('reports a search that failed in the output window', async () => {
    useSearchStore.setState({ query: 'x' })
    state().restart()
    pending[0].reject(new Error('boom'))
    await vi.waitFor(() => expect(state().searching).toBe(false))
    expect(useAppStore.getState().output.at(-1)).toContain('Search failed: boom')
  })

  it('empties the list for an empty query without asking', () => {
    useSearchStore.setState({ query: '', results: [result('A')] })
    state().restart()
    expect(search).not.toHaveBeenCalled()
    expect(state().results).toEqual([])
  })

  it('starts over when what it looks for changes, but not for the syntax highlighting', () => {
    useSearchStore.setState({ query: 'x' })
    updateSearchSettings({ syntaxHighlight: false })
    expect(search).not.toHaveBeenCalled()
    expect(loadAppOptions().search.syntaxHighlight).toBe(false)
    updateSearchSettings({ matchWholeWords: true })
    expect(search).toHaveBeenCalledTimes(1)
    updateSearchSettings({ matchWholeWords: true })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('starts over when the workspace changes under it, and empties when it closes', () => {
    useSearchStore.setState({ query: 'x' })
    useAppStore.setState({ workspaceStateId: 's2' })
    expect(search).toHaveBeenCalledTimes(1)
    useAppStore.setState({ assemblyListRevision: 1 })
    expect(search).toHaveBeenCalledTimes(2)
    useAppStore.setState({ workspaceId: undefined })
    expect(state().query).toBe('')
    expect(state().results).toEqual([])
    expect(cancelSearch).toHaveBeenCalled()
  })
})
