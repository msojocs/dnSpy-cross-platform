import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StringReference, StringReferencesSearchResponse } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { useStringReferencesStore } from './string-references-store'

const reference = (literal: string): StringReference => ({
  kind: 'il',
  literal,
  formattedLiteral: `"${literal}"`,
  isVerbatim: false,
  referrerParts: [],
  referrerIcon: 'method',
  moduleName: 'A.dll',
  token: 0x06000001,
  nodeId: 'n',
  ilOffset: 0,
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('the String References store', () => {
  let resolvers: ((response: StringReferencesSearchResponse) => void)[]
  const searchStringReferences = vi.fn()
  const cancelStringReferences = vi.fn(async () => undefined)

  beforeEach(() => {
    resolvers = []
    searchStringReferences.mockReset().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    cancelStringReferences.mockClear()
    Object.assign(window.dnSpy, { searchStringReferences, cancelStringReferences })
    useAppStore.setState({ workspaceId: 'ws', selectedNodes: [], defaultLanguage: 'cSharp' })
    useStringReferencesStore.setState({ references: [], scanning: false, modulePaths: [], requestKey: undefined, focusRequested: false })
  })

  afterEach(() => {
    useAppStore.setState({ workspaceId: undefined })
  })

  it('scans the nodes\' assemblies, takes the batches that arrive, then the rest', async () => {
    useStringReferencesStore.getState().analyze(['node-1'])

    expect(searchStringReferences).toHaveBeenCalledWith('ws', { nodeIds: ['node-1'], showAllMembers: false }, expect.stringMatching(/^strings-/))
    const requestKey = useStringReferencesStore.getState().requestKey!
    expect(useStringReferencesStore.getState().scanning).toBe(true)

    useStringReferencesStore.getState().receiveProgress({ requestKey, start: 0, references: [reference('a'), reference('b')] })
    // A batch for a scan that was replaced is not taken.
    useStringReferencesStore.getState().receiveProgress({ requestKey: 'other', start: 0, references: [reference('x')] })
    resolvers[0]({ references: [reference('c')], start: 2, modulePaths: ['/A.dll'] })
    await flush()

    const state = useStringReferencesStore.getState()
    expect(state.references.map((r) => r.literal)).toEqual(['a', 'b', 'c'])
    expect(state.scanning).toBe(false)
    expect(state.modulePaths).toEqual(['/A.dll'])
  })

  it('lists the members the compiler made when the language is IL', () => {
    useAppStore.setState({ defaultLanguage: 'il' })

    useStringReferencesStore.getState().analyze(['node-1'])

    expect(searchStringReferences).toHaveBeenCalledWith('ws', { nodeIds: ['node-1'], showAllMembers: true }, expect.any(String))
  })

  it('calls off the scan a new one replaces', () => {
    useStringReferencesStore.getState().analyze(['node-1'])
    const first = useStringReferencesStore.getState().requestKey

    useStringReferencesStore.getState().analyze(['node-2'])

    expect(cancelStringReferences).toHaveBeenCalledWith(first)
    expect(useStringReferencesStore.getState().requestKey).not.toBe(first)
  })

  it('refreshes the modules it read, or scans the tree\'s selection when it has none', async () => {
    useAppStore.setState({ selectedNodes: [{ id: 'selected', kind: 'type', label: 'T', hasChildren: false } as never] })
    useStringReferencesStore.getState().refresh()
    expect(searchStringReferences).toHaveBeenLastCalledWith('ws', { nodeIds: ['selected'], showAllMembers: false }, expect.any(String))
    resolvers[0]({ references: [], start: 0, modulePaths: ['/A.dll'] })
    await flush()

    useStringReferencesStore.getState().refresh()

    expect(searchStringReferences).toHaveBeenLastCalledWith('ws', { modulePaths: ['/A.dll'], showAllMembers: false }, expect.any(String))
  })

  it('starts a scan of the selection from the search box only when it has no modules yet', () => {
    useAppStore.setState({ selectedNodes: [{ id: 'selected', kind: 'type', label: 'T', hasChildren: false } as never] })
    useStringReferencesStore.setState({ modulePaths: ['/A.dll'] })
    useStringReferencesStore.getState().startIfNotStarted()
    expect(searchStringReferences).not.toHaveBeenCalled()

    useStringReferencesStore.setState({ modulePaths: [] })
    useStringReferencesStore.getState().startIfNotStarted()
    expect(searchStringReferences).toHaveBeenCalledOnce()
  })

  it('follows the documents: an edit or a new language reads the modules again, closing empties the list', () => {
    useStringReferencesStore.setState({ modulePaths: ['/A.dll'], references: [reference('a')] })

    useAppStore.setState((state) => ({ workspaceStateId: `${state.workspaceStateId ?? ''}+` }))
    expect(searchStringReferences).toHaveBeenCalledTimes(1)
    useAppStore.setState({ defaultLanguage: 'visualBasic' })
    expect(searchStringReferences).toHaveBeenCalledTimes(2)

    useAppStore.setState({ workspaceId: undefined })
    expect(useStringReferencesStore.getState().references).toEqual([])
    expect(useStringReferencesStore.getState().modulePaths).toEqual([])
  })
})
