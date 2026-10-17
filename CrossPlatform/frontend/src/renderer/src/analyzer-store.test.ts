import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeChildrenRequest, AnalyzeChildrenResponse, AnalyzerNode } from '../../shared/protocol'
import { useAnalyzerStore } from './analyzer-store'
import { useAppStore } from './app-store'

const node = (extra: Partial<AnalyzerNode>): AnalyzerNode => ({
  kind: 'method',
  label: 'NS.Type.M() : void',
  hasChildren: true,
  isSetter: false,
  hidesParent: false,
  isPublic: true,
  ...extra,
})

const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const analyzeNodes = vi.fn(async (_workspaceId: string, nodeIds: string[]) => ({ nodes: nodeIds.map((id) => id.startsWith('gone') ? null : node({ nodeId: id, label: `Label ${id}` })) }))
const analyzeChildren = vi.fn(async (_workspaceId: string, request: AnalyzeChildrenRequest, _requestKey: string): Promise<AnalyzeChildrenResponse> => ({
  children: request.search
    ? [node({ nodeId: `${request.nodeId}-hit`, label: 'Found.M() : void' })]
    : [node({ kind: 'search', label: 'Used By', search: 'usedBy', nodeId: request.nodeId, isSetter: request.isSetter ?? false })],
  truncated: false,
}))
const cancelAnalyze = vi.fn(async () => undefined)

const state = () => useAnalyzerStore.getState()

beforeEach(() => {
  Object.assign(window.dnSpy, { analyzeNodes, analyzeChildren, cancelAnalyze })
  analyzeNodes.mockClear()
  analyzeChildren.mockClear()
  cancelAnalyze.mockClear()
  useAppStore.setState({ workspaceId: 'ws', workspaceGeneration: 0, workspaceStateId: 's1', assemblyListRevision: 0, output: [], defaultLanguage: 'cSharp' })
  state().clear()
})

afterEach(() => {
  state().clear()
})

describe('analyzer store', () => {
  it('adds an analyzed member as a root at the end, opens it, and goes back to it when it is analyzed again', async () => {
    await state().analyze('n1')
    await state().analyze('n2')
    expect(state().rootKeys.map((key) => state().rows[key].node.nodeId)).toEqual(['n1', 'n2'])
    const [first, second] = state().rootKeys
    expect(state().expanded[first]).toBe(true)
    expect(state().children[first]).toMatchObject({ status: 'loaded' })
    expect(state().selection).toEqual([second])

    state().collapse(first)
    const focusToken = state().focusToken
    await state().analyze('n1')
    expect(state().rootKeys).toHaveLength(2)
    expect(state().selection).toEqual([first])
    expect(state().expanded[first]).toBe(true)
    expect(state().focusToken).toBe(focusToken + 1)
    // The row's own children are kept: going back to it asks for nothing again.
    expect(analyzeChildren).toHaveBeenCalledTimes(2)
  })

  it('says so when the node is not something to analyze', async () => {
    await state().analyze('gone-1')
    expect(state().rootKeys).toEqual([])
    expect(useAppStore.getState().output.at(-1)?.text).toContain('Only types and members can be analyzed.')
  })

  it('runs a search when its row is opened, and keeps what it found', async () => {
    await state().analyze('n1')
    const root = state().rootKeys[0]
    const search = (state().children[root] as { keys: string[] }).keys[0]
    await state().expand(search)
    expect(analyzeChildren).toHaveBeenLastCalledWith('ws', { nodeId: 'n1', search: 'usedBy', isSetter: false, language: 'cSharp', decompileAnonymousMethods: true }, expect.any(String))
    const found = (state().children[search] as { keys: string[] }).keys
    expect(found.map((key) => state().rows[key].node.label)).toEqual(['Found.M() : void'])
    expect(state().rows[found[0]].parentKey).toBe(search)

    state().collapse(search)
    await state().expand(search)
    expect(analyzeChildren).toHaveBeenCalledTimes(2)
  })

  it('calls off a search whose row is closed before it finished, and starts it over when it is opened again', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    const pending = deferred<AnalyzeChildrenResponse>()
    analyzeChildren.mockImplementationOnce(() => pending.promise)
    const running = state().expand(search)
    const requestKey = (state().children[search] as { requestKey: string }).requestKey

    state().collapse(search)
    expect(cancelAnalyze).toHaveBeenCalledWith(requestKey)
    expect(state().children[search]).toBeUndefined()
    // The answer the canceled request still gets is not taken.
    pending.resolve({ children: [node({ label: 'Late' })], truncated: false })
    await running
    expect(state().children[search]).toBeUndefined()

    await state().expand(search)
    expect((state().children[search] as { keys: string[] }).keys).toHaveLength(1)
  })

  it('calls off a running search when an ancestor is closed', async () => {
    await state().analyze('n1')
    const root = state().rootKeys[0]
    const search = (state().children[root] as { keys: string[] }).keys[0]
    analyzeChildren.mockImplementationOnce(() => new Promise(() => undefined))
    void state().expand(search)

    state().collapse(root)

    expect(cancelAnalyze).toHaveBeenCalledTimes(1)
    expect(state().children[search]).toBeUndefined()
  })

  it('shows what a running search found so far, and takes from its answer only what was not sent ahead', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    const pending = deferred<AnalyzeChildrenResponse>()
    analyzeChildren.mockImplementationOnce(() => pending.promise)
    const running = state().expand(search)
    const requestKey = (state().children[search] as { requestKey: string }).requestKey
    const labels = (): string[] => (state().children[search] as { keys: string[] }).keys.map((key) => state().rows[key].node.label)

    state().receiveProgress({ requestKey, start: 0, children: [node({ label: 'First' }), node({ label: 'Second' })] })
    expect(state().children[search]).toMatchObject({ status: 'loading' })
    expect(labels()).toEqual(['First', 'Second'])
    // A batch for another request, or one the row already holds, adds nothing.
    state().receiveProgress({ requestKey: 'other', start: 2, children: [node({ label: 'Elsewhere' })] })
    state().receiveProgress({ requestKey, start: 0, children: [node({ label: 'First' })] })
    state().receiveProgress({ requestKey, start: 1, children: [node({ label: 'Second' }), node({ label: 'Third' })] })
    expect(labels()).toEqual(['First', 'Second', 'Third'])
    const streamed = (state().children[search] as { keys: string[] }).keys

    pending.resolve({ children: [node({ label: 'Last' })], truncated: false, start: 3 })
    await running
    expect(state().children[search]).toMatchObject({ status: 'loaded', truncated: false })
    expect(labels()).toEqual(['First', 'Second', 'Third', 'Last'])
    // The rows sent ahead keep their keys, so a selection made while the search ran survives its end.
    expect((state().children[search] as { keys: string[] }).keys.slice(0, 3)).toEqual(streamed)
  })

  it('forgets what a search found so far when its row is closed before it finished', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    analyzeChildren.mockImplementationOnce(() => new Promise(() => undefined))
    void state().expand(search)
    const requestKey = (state().children[search] as { requestKey: string }).requestKey
    state().receiveProgress({ requestKey, start: 0, children: [node({ label: 'Partial' })] })
    const partial = (state().children[search] as { keys: string[] }).keys[0]
    state().select([partial])

    state().collapse(search)

    expect(state().rows[partial]).toBeUndefined()
    expect(state().selection).toEqual([search])
    // A batch that was already on its way when the search was called off has nowhere to go.
    state().receiveProgress({ requestKey, start: 1, children: [node({ label: 'Late' })] })
    expect(state().children[search]).toBeUndefined()
  })

  it('carries a setter row\'s flag into the searches under it', async () => {
    analyzeNodes.mockResolvedValueOnce({ nodes: [node({ nodeId: 'set', label: 'set', accessor: 'set', isSetter: true })] })
    await state().analyze('set')
    expect(analyzeChildren).toHaveBeenLastCalledWith('ws', expect.objectContaining({ nodeId: 'set', search: undefined, isSetter: true }), expect.any(String))
  })

  it('reports a search that failed and leaves its row empty', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    analyzeChildren.mockRejectedValueOnce(new Error('boom'))
    await state().expand(search)
    expect(state().children[search]).toEqual({ status: 'loaded', keys: [], truncated: false })
    expect(useAppStore.getState().output.at(-1)?.text).toContain('boom')
  })

  it('removes only roots, with everything under them', async () => {
    await state().analyze('n1')
    await state().analyze('n2')
    const [first, second] = state().rootKeys
    const search = (state().children[first] as { keys: string[] }).keys[0]

    state().removeRoots([search])
    expect(state().rootKeys).toHaveLength(2)

    state().removeRoots([first])
    expect(state().rootKeys).toEqual([second])
    expect(state().rows[search]).toBeUndefined()
    expect(state().selection).toEqual([second])
  })

  it('starts the searches over and drops the roots that are gone when the model changes', async () => {
    await state().analyze('n1')
    await state().analyze('n3')
    expect(state().rootKeys).toHaveLength(2)
    const [first] = state().rootKeys
    const search = (state().children[first] as { keys: string[] }).keys[0]
    await state().expand(search)
    analyzeNodes.mockImplementationOnce(async (_workspaceId, nodeIds) => ({
      nodes: nodeIds.map((id) => id === 'n1' ? node({ nodeId: 'n1', label: 'Renamed' }) : null),
    }))

    useAppStore.setState({ workspaceStateId: 's2' })
    await vi.waitFor(() => expect(state().rootKeys).toEqual([first]))

    expect(state().rows[first].node.label).toBe('Renamed')
    expect(state().children[search]).toBeUndefined()
    expect(state().expanded[search]).toBe(false)
    // The root's own rows stay; only what the searches found is forgotten.
    expect(state().rows[search]).toBeDefined()
  })

  it('starts the searches over when assemblies are added or removed by hand', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    await state().expand(search)

    useAppStore.setState({ assemblyListRevision: 1 })
    await vi.waitFor(() => expect(state().children[search]).toBeUndefined())
  })

  it('writes its rows and its searches in the language the decompiler box names', async () => {
    useAppStore.setState({ defaultLanguage: 'il' })
    await state().analyze('n1')
    expect(analyzeNodes).toHaveBeenLastCalledWith('ws', ['n1'], 'il')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    await state().expand(search)
    expect(analyzeChildren).toHaveBeenLastCalledWith('ws', expect.objectContaining({ search: 'usedBy', language: 'il' }), expect.any(String))
  })

  it('writes every member row anew, once per member, when another decompiler is chosen', async () => {
    await state().analyze('n1')
    const root = state().rootKeys[0]
    const search = (state().children[root] as { keys: string[] }).keys[0]
    await state().expand(search)
    const [hit] = (state().children[search] as { keys: string[] }).keys
    analyzeNodes.mockClear()
    analyzeNodes.mockImplementationOnce(async (_workspaceId, nodeIds) => ({
      nodes: nodeIds.map((id) => node({ nodeId: id, label: `VB ${id}`, labelParts: [{ text: `VB ${id}`, color: 'text' }] })),
    }))

    useAppStore.setState({ defaultLanguage: 'visualBasic' })

    await vi.waitFor(() => expect(state().rows[root].node.label).toBe('VB n1'))
    // A search row is its header in any language, so only the members are asked for.
    expect(analyzeNodes).toHaveBeenCalledTimes(1)
    expect(analyzeNodes).toHaveBeenLastCalledWith('ws', ['n1', 'n1-hit'], 'visualBasic')
    expect(state().rows[hit].node.label).toBe('VB n1-hit')
    expect(state().rows[hit].node.labelParts).toEqual([{ text: 'VB n1-hit', color: 'text' }])
    expect(state().rows[search].node.label).toBe('Used By')
    // What the search found stays found.
    expect(state().children[search]).toMatchObject({ status: 'loaded' })
  })

  it('writes anew what a search finds after the language changed under it', async () => {
    await state().analyze('n1')
    const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
    const answer = deferred<AnalyzeChildrenResponse>()
    analyzeChildren.mockImplementationOnce(() => answer.promise)
    const expanding = state().expand(search)
    useAppStore.setState({ defaultLanguage: 'il' })
    analyzeNodes.mockClear()
    analyzeNodes.mockImplementationOnce(async (_workspaceId, nodeIds) => ({ nodes: nodeIds.map((id) => node({ nodeId: id, label: `IL ${id}` })) }))
    answer.resolve({ children: [node({ nodeId: 'late', label: 'C# late' })], truncated: false })
    await expanding
    const [late] = (state().children[search] as { keys: string[] }).keys
    await vi.waitFor(() => expect(state().rows[late].node.label).toBe('IL late'))
    expect(analyzeNodes).toHaveBeenLastCalledWith('ws', ['late'], 'il')
  })

  it('lists a lambda as itself when the C# decompiler does not decompile anonymous methods', async () => {
    const { loadAppOptions, saveAppOptions } = await import('./components/app-options')
    const options = loadAppOptions()
    saveAppOptions({ ...options, decompiler: { ...options.decompiler, cSharp: { ...options.decompiler.cSharp, anonymousMethods: false } } })
    try {
      await state().analyze('n1')
      const search = (state().children[state().rootKeys[0]] as { keys: string[] }).keys[0]
      await state().expand(search)
      expect(analyzeChildren).toHaveBeenLastCalledWith('ws', expect.objectContaining({ decompileAnonymousMethods: false }), expect.any(String))
    } finally {
      saveAppOptions(options)
    }
  })

  it('empties itself when the workspace goes', async () => {
    await state().analyze('n1')
    useAppStore.setState({ workspaceId: undefined })
    expect(state().rootKeys).toEqual([])
  })
})
