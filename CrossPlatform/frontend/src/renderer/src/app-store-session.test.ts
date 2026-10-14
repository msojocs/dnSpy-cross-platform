import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecompileResponse, TreeNode } from '../../shared/protocol'
import { buildSession, loadSession, useAppStore } from './app-store'

const root: TreeNode = { id: 'root', key: 'module:/A.dll', kind: 'module', label: 'A.dll', hasChildren: true }
const child: TreeNode = { id: 'child', key: 'module:/A.dll:type:1', kind: 'type', label: 'Type', hasChildren: false }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

describe('closing a workspace during session restoration', () => {
  beforeEach(() => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      workspaceId: 'old-workspace',
      modules: [{ id: 'root', path: '/A.dll', name: 'A', hasPdb: false }],
      roots: [root],
      restoringSession: true,
    })
    localStorage.setItem('dnspy.session.v1', JSON.stringify({ version: 1, paths: ['/A.dll'], nodes: [], documents: [] }))
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, closeWorkspace: vi.fn(async () => undefined) },
    })
  })

  it('saves the empty session before backend cleanup finishes, even before startup enables persistence', async () => {
    const cleanup = deferred<void>()
    vi.mocked(window.dnSpy.closeWorkspace).mockReturnValue(cleanup.promise)
    const closing = useAppStore.getState().closeWorkspace()

    expect(loadSession()).toMatchObject({ paths: [], nodes: [], documents: [] })
    expect(useAppStore.getState()).toMatchObject({
      workspaceId: undefined, modules: [], roots: [], children: {}, loadingNodes: {},
      documents: {}, documentOrder: [], activeDocumentId: undefined, restoringSession: false,
    })
    cleanup.resolve()
    await closing
  })

  it('cancels an older scheduled save instead of resurrecting it after close', async () => {
    vi.useFakeTimers()
    try {
      useAppStore.setState({ restoringSession: false, children: { root: Array.from({ length: 17 }, () => child) } })
      await useAppStore.getState().closeWorkspace()
      await vi.runAllTimersAsync()
      expect(loadSession()?.paths).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['success', 'failure'])('ignores a late tree %s after closing and opening another workspace', async (result) => {
    const pending = deferred<{ nodes: TreeNode[] }>()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getChildren: vi.fn(() => pending.promise) },
    })
    const loading = useAppStore.getState().loadChildren(root)
    await useAppStore.getState().closeWorkspace()
    useAppStore.setState({ workspaceId: 'new-workspace', error: undefined })
    if (result === 'success') pending.resolve({ nodes: [child] })
    else pending.reject(new Error('The workspace no longer exists.'))
    await loading

    expect(useAppStore.getState()).toMatchObject({ children: {}, parents: {}, loadingNodes: {}, error: undefined })
    expect(loadSession()).toMatchObject({ paths: [], nodes: [], documents: [] })
  })

  it.each(['success', 'failure'])('ignores a late decompilation %s without restoring a document or error', async (result) => {
    const pending = deferred<DecompileResponse>()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, decompile: vi.fn(() => pending.promise) },
    })
    const loading = useAppStore.getState().openDocument(child)
    await useAppStore.getState().closeWorkspace()
    if (result === 'success') pending.resolve({ title: 'Type', text: 'class Type {}', language: 'csharp', spans: [], diagnostics: [] })
    else pending.reject(new Error('The workspace no longer exists.'))
    await loading

    expect(useAppStore.getState()).toMatchObject({ documents: {}, selectedNode: undefined, error: undefined })
    expect(loadSession()).toMatchObject({ paths: [], nodes: [], documents: [] })
  })

  it('disposes a workspace whose open request finishes after Close All', async () => {
    const opened = deferred<{ workspaceId: string; modules: []; stateId: string }>()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, openWorkspace: vi.fn(() => opened.promise), getRoots: vi.fn() },
    })
    useAppStore.setState({ workspaceId: undefined })
    const opening = useAppStore.getState().openPaths(['/A.dll'])
    await useAppStore.getState().closeWorkspace()
    opened.resolve({ workspaceId: 'late-workspace', modules: [], stateId: 'state' })
    await opening

    expect(window.dnSpy.closeWorkspace).toHaveBeenCalledWith('late-workspace')
    expect(window.dnSpy.getRoots).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ workspaceId: undefined, roots: [], busy: false })
    expect(loadSession()?.paths).toEqual([])
  })
})

describe('session editor state persistence', () => {
  const docNode: TreeNode = { id: 'doc', key: 'module:/A.dll:type:1:method:1', kind: 'method', label: 'Method', hasChildren: false }

  beforeEach(() => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      workspaceId: 'test-workspace',
      modules: [{ id: 'root', path: '/A.dll', name: 'A', hasPdb: false }],
      roots: [root],
      children: {},
      parents: {},
    })
  })

  it('saves cursor position and scroll when updating editor state', () => {
    useAppStore.setState({
      documents: {
        doc: {
          nodeId: 'doc',
          loading: false,
          requestedLanguage: 'cSharp',
          title: 'Method',
          text: 'void Method() {}',
          language: 'csharp',
          spans: [],
          diagnostics: [],
        },
      },
      documentOrder: ['doc'],
    })

    useAppStore.getState().updateDocumentEditorState('doc', 10, 5, 120)

    expect(useAppStore.getState().documents.doc).toMatchObject({
      cursorLine: 10,
      cursorColumn: 5,
      scrollTop: 120,
    })
  })

  it('includes editor state in session when building', () => {
    useAppStore.setState({
      documents: {
        doc: {
          nodeId: 'doc',
          loading: false,
          requestedLanguage: 'cSharp',
          title: 'Method',
          text: 'void Method() {}',
          language: 'csharp',
          spans: [],
          diagnostics: [],
          cursorLine: 15,
          cursorColumn: 8,
          scrollTop: 200,
        },
      },
      documentOrder: ['doc'],
      children: { root: [docNode] },
      parents: { doc: 'root' },
    })

    const session = buildSession(useAppStore.getState())

    expect(session.documents).toEqual([{
      key: 'module:/A.dll:type:1:method:1',
      language: 'cSharp',
      cursorLine: 15,
      cursorColumn: 8,
      scrollTop: 200,
    }])
  })

  it('loads editor state from session', () => {
    localStorage.setItem('dnspy.session.v1', JSON.stringify({
      version: 1,
      paths: ['/A.dll'],
      nodes: [],
      documents: [{
        key: 'module:/A.dll:type:1',
        language: 'cSharp',
        cursorLine: 20,
        cursorColumn: 12,
        scrollTop: 300,
      }],
    }))

    const session = loadSession()

    expect(session?.documents).toEqual([{
      key: 'module:/A.dll:type:1',
      language: 'cSharp',
      cursorLine: 20,
      cursorColumn: 12,
      scrollTop: 300,
    }])
  })

  it('handles missing editor state gracefully', () => {
    localStorage.setItem('dnspy.session.v1', JSON.stringify({
      version: 1,
      paths: ['/A.dll'],
      nodes: [],
      documents: [{
        key: 'module:/A.dll:type:1',
        language: 'cSharp',
      }],
    }))

    const session = loadSession()

    expect(session?.documents).toEqual([{
      key: 'module:/A.dll:type:1',
      language: 'cSharp',
    }])
  })
})

