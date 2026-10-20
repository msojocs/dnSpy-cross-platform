import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecompileResponse, DecompilerLanguage, TreeNode } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { loadAppOptions, resetAppOptions, saveAppOptions } from './components/app-options'
import { decompilationCache } from './decompilation-cache'

// The store's side of dnSpy's document tabs: a document of several nodes, the decompilation cache, the wait
// adorner's Cancel and what a canceled or failed decompilation leaves, and the documents decompiled again when an
// option or an edit asks for it.

const root: TreeNode = { id: 'r', kind: 'assembly', label: 'Example', hasChildren: true }
const first: TreeNode = { id: 'n1', kind: 'type', label: 'First', hasChildren: true, toolTip: 'Ns.First' }
const second: TreeNode = { id: 'n2', kind: 'type', label: 'Second', hasChildren: true, toolTip: 'Ns.Second' }

const response = (title: string, extra: Partial<DecompileResponse> = {}): DecompileResponse => ({
  title, language: 'csharp', text: `class ${title} {}\n`, spans: [], diagnostics: [], ...extra,
})

interface Pending {
  resolve(value: DecompileResponse): void
  reject(reason: Error): void
}

let decompile: ReturnType<typeof vi.fn>
let cancelDecompile: ReturnType<typeof vi.fn>

const install = (overrides: Record<string, unknown> = {}): void => {
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, decompile, cancelDecompile, ...overrides },
  })
}

beforeEach(() => {
  localStorage.clear()
  resetAppOptions()
  decompilationCache.clearAll()
  decompile = vi.fn(async (_workspaceId: string, nodeId: string | string[]) => response(Array.isArray(nodeId) ? nodeId.join(', ') : nodeId))
  cancelDecompile = vi.fn(async () => undefined)
  install()
  useAppStore.setState({
    workspaceId: 'w',
    roots: [root],
    children: { r: [first, second] },
    parents: { n1: 'r', n2: 'r' },
    modules: [{ id: 'r', name: 'Example.dll', path: '/x/Example.dll', hasPdb: false }],
    documents: {},
    documentOrder: [],
    selectedNodes: [],
    selectedNode: undefined,
    bookmarks: [],
    lineBreakpoints: [],
    error: undefined,
  })
})

afterEach(() => {
  decompilationCache.clearAll()
})

describe('a document of several nodes', () => {
  it('is asked for in one request and keyed by every node', async () => {
    const documentId = await useAppStore.getState().openNodesDocument([first, second], 'cSharp')

    expect(documentId).toBe('n1+n2')
    expect(decompile).toHaveBeenCalledWith('w', ['n1', 'n2'], 'cSharp', expect.anything(), expect.any(String))
    const document = useAppStore.getState().documents[documentId]
    expect(document.nodeId).toBe('n1')
    expect(document.nodeIds).toEqual(['n1', 'n2'])
    expect(document.toolTip).toBe('Ns.First\n\nNs.Second')
    expect(document.loading).toBe(false)
    // The selection stays what it was: every node of the document.
    expect(useAppStore.getState().selectedNodes.map((node) => node.id)).toEqual(['n1', 'n2'])
  })

  it('is titled with every node while it decompiles', async () => {
    let pending: Pending | undefined
    decompile.mockImplementationOnce(() => new Promise((resolve, reject) => { pending = { resolve, reject } }))
    const opening = useAppStore.getState().openNodesDocument([first, second], 'cSharp')
    expect(useAppStore.getState().documents['n1+n2']).toMatchObject({ loading: true, title: 'First, Second' })
    pending!.resolve(response('First, Second'))
    await opening
  })
})

describe('the decompilation cache', () => {
  it('shows a document decompiled before at once, without asking the backend', async () => {
    await useAppStore.getState().openDocument(first, 'cSharp')
    await useAppStore.getState().openDocument(second, 'cSharp')
    await useAppStore.getState().openDocument(first, 'cSharp')

    expect(decompile).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().documents.n1).toMatchObject({ loading: false, text: 'class n1 {}\n' })
  })

  it('keys a document by its language and the settings that language reads', async () => {
    await useAppStore.getState().openDocument(first, 'cSharp')
    await useAppStore.getState().openDocument(first, 'il')
    expect(decompile).toHaveBeenCalledTimes(2)

    // The IL page is not read by C#, so changing it keeps the C# document.
    const options = loadAppOptions()
    saveAppOptions({ ...options, decompiler: { ...options.decompiler, il: { ...options.decompiler.il, showILBytes: !options.decompiler.il.showILBytes } } })
    await useAppStore.getState().openDocument(first, 'cSharp')
    expect(decompile).toHaveBeenCalledTimes(2)
    await useAppStore.getState().openDocument(first, 'il')
    expect(decompile).toHaveBeenCalledTimes(3)
  })

  it('forgets the documents of a module an edit touched, and decompiles the open ones again', async () => {
    await useAppStore.getState().openDocument(first, 'cSharp')
    await useAppStore.getState().openDocument(second, 'cSharp')
    useAppStore.setState({ documentOrder: ['n1', 'n2'], canUndo: true })
    install({
      undoEdit: vi.fn(async () => ({ version: 2, stateId: 's2', changedNodeIds: ['n1'], canUndo: false, canRedo: true })),
      getNode: vi.fn(async (_workspaceId: string, nodeId: string) => nodeId === 'n1' ? first : second),
      getChildren: vi.fn(async () => ({ nodes: [first, second] })),
      getRoots: vi.fn(async () => ({ nodes: [root] })),
    })

    await useAppStore.getState().undoEdit()

    // n1 changed and n2 is in the same module: both are decompiled again, and the cache had neither left.
    expect(decompile).toHaveBeenCalledTimes(4)
    expect(decompile.mock.calls.slice(2).map((call) => call[1]).sort()).toEqual(['n1', 'n2'])
  })
})

describe('canceling and failing', () => {
  it('cancels the backend request and leaves the canceled message in the error color', async () => {
    let pending: Pending | undefined
    decompile.mockImplementationOnce(() => new Promise((resolve, reject) => { pending = { resolve, reject } }))
    const opening = useAppStore.getState().openDocument(first, 'cSharp')
    const key = decompile.mock.calls[0][4] as string

    useAppStore.getState().cancelDocument('n1')
    expect(cancelDecompile).toHaveBeenCalledWith(key)
    pending!.reject(new Error("Error invoking remote method 'document:decompile': Error: document/decompile was canceled."))
    await opening

    const document = useAppStore.getState().documents.n1
    expect(document).toMatchObject({ loading: false, failure: 'canceled', text: 'The operation was canceled' })
    expect(document.spans).toEqual([{ start: 0, length: 'The operation was canceled'.length, kind: 'text', color: 'error' }])
    expect(useAppStore.getState().error).toBeUndefined()
  })

  it('writes a failure and the exception under it', async () => {
    decompile.mockImplementationOnce(async () => { throw new Error('boom') })
    await useAppStore.getState().openDocument(first, 'cSharp')

    const document = useAppStore.getState().documents.n1
    expect(document).toMatchObject({ failure: 'error', text: 'An error occurred\nboom' })
    expect(document.spans[0]).toMatchObject({ start: 0, length: 'An error occurred'.length, color: 'error' })
  })

  it('calls off the request a newer one for the same document replaces, and shows only the newer one', async () => {
    let pending: Pending | undefined
    decompile.mockImplementationOnce(() => new Promise((resolve, reject) => { pending = { resolve, reject } }))
    const older = useAppStore.getState().openDocument(first, 'cSharp')
    const olderKey = decompile.mock.calls[0][4] as string
    await useAppStore.getState().openDocument(first, 'il')

    expect(cancelDecompile).toHaveBeenCalledWith(olderKey)
    pending!.resolve(response('stale'))
    await older
    expect(useAppStore.getState().documents.n1).toMatchObject({ requestedLanguage: 'il', text: 'class n1 {}\n' })
  })
})

describe('options that change how documents decompile', () => {
  const open = async (node: TreeNode, language: DecompilerLanguage): Promise<void> => {
    await useAppStore.getState().openDocument(node, language)
  }

  it('decompiles the tabs of the languages that read the changed page again, keeping their caret', async () => {
    await open(first, 'cSharp')
    await open(second, 'il')
    useAppStore.getState().updateDocumentEditorState('n1', 7, 3, 120)
    useAppStore.setState({ documentOrder: ['n1', 'n2'] })
    decompile.mockClear()

    const before = loadAppOptions()
    const after = { ...before, decompiler: { ...before.decompiler, cSharp: { ...before.decompiler.cSharp, sortMembers: !before.decompiler.cSharp.sortMembers } } }
    // The dialog saves the options first; the documents are then keyed by what it saved.
    saveAppOptions(after)
    await useAppStore.getState().refreshDocumentsForOptions(before, after)

    expect(decompile.mock.calls.map((call) => call[1])).toEqual(['n1'])
    expect(useAppStore.getState().documents.n1).toMatchObject({ cursorLine: 7, cursorColumn: 3, scrollTop: 120 })
  })

  it('refreshes nothing for DecompileFullType', async () => {
    await open(first, 'cSharp')
    useAppStore.setState({ documentOrder: ['n1'] })
    decompile.mockClear()
    const before = loadAppOptions()
    const after = { ...before, environmentGeneral: { ...before.environmentGeneral, decompileFullType: !before.environmentGeneral.decompileFullType } }
    await useAppStore.getState().refreshDocumentsForOptions(before, after)
    expect(decompile).not.toHaveBeenCalled()
  })
})
