import { create } from 'zustand'
import type { AnalyzerNode } from '../../shared/protocol'
import type { AnalyzerRow, AnalyzerTreeState } from './analyzer-model'
import { useAppStore } from './app-store'
import { translate as t } from './localization'

// dnSpy's analyzer window. Each analyzed member is a root of its own, appended in the order it was asked
// for; a row's children are fetched the first time it is opened — a member's searches and accessors right
// away, a search's results once it has run — and kept from then on. A search still running when its row is
// closed is called off and starts over the next time, which is what dnSpy's search nodes do.

interface AnalyzerState extends AnalyzerTreeState {
  /** The selected rows, in the order they were selected. */
  selection: string[]
  /** Where a Shift range starts. */
  anchorKey?: string
  /** The row keyboard navigation moves from, and the one the tree focuses when asked to. */
  focusKey?: string
  /** Bumped to ask the pane to take the keyboard focus, the way dnSpy focuses its analyzer after Analyze. */
  focusToken: number

  /** Adds the member's row at the end and opens it, or goes to the row it already has. */
  analyze(nodeId: string): Promise<void>
  expand(key: string): Promise<void>
  collapse(key: string): void
  toggle(key: string): void
  select(keys: string[], options?: { anchorKey?: string; focusKey?: string }): void
  /** Takes rows off the top level, with everything under them; only roots can be removed. */
  removeRoots(keys: string[]): void
  /** Empties the window, calling off whatever is still running. */
  clear(): void
  /**
   * What dnSpy does when the model under the analyzer changes: every search forgets what it found and
   * closes, and a root whose member is gone goes with it. The rows still standing are written anew.
   */
  revalidate(): Promise<void>
}

let nextRowKey = 0
let nextRequestKey = 0

const newRowKey = (): string => `a${++nextRowKey}`

const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** Every key of a row's subtree that is fetched so far, the row itself first. */
const subtreeKeys = (state: AnalyzerTreeState, key: string): string[] => {
  const keys: string[] = []
  const stack = [key]
  while (stack.length > 0) {
    const current = stack.pop()!
    keys.push(current)
    const children = state.children[current]
    if (children?.status === 'loaded')
      stack.push(...children.keys)
  }
  return keys
}

/** Calls off the requests still running under the keys given and tells the caller which they were. */
const cancelLoading = (state: AnalyzerTreeState, keys: string[]): string[] => {
  const canceled: string[] = []
  for (const key of keys) {
    const children = state.children[key]
    if (children?.status === 'loading') {
      void window.dnSpy.cancelAnalyze(children.requestKey).catch(() => undefined)
      canceled.push(key)
    }
  }
  return canceled
}

const withoutKeys = <T,>(entries: Record<string, T>, keys: Iterable<string>): Record<string, T> => {
  const result = { ...entries }
  for (const key of keys)
    delete result[key]
  return result
}

const emptyTree = (): Pick<AnalyzerState, 'rootKeys' | 'rows' | 'children' | 'expanded' | 'selection' | 'anchorKey' | 'focusKey'> => ({
  rootKeys: [],
  rows: {},
  children: {},
  expanded: {},
  selection: [],
  anchorKey: undefined,
  focusKey: undefined,
})

export const useAnalyzerStore = create<AnalyzerState>((set, get) => ({
  ...emptyTree(),
  focusToken: 0,

  analyze: async (nodeId) => {
    const appStore = useAppStore.getState()
    const workspaceId = appStore.workspaceId
    if (!workspaceId)
      return
    let node: AnalyzerNode | null | undefined
    try {
      node = (await window.dnSpy.analyzeNodes(workspaceId, [nodeId])).nodes[0]
    } catch (reason) {
      appStore.appendOutput(t('Analysis failed: {message}', { message: message(reason) }))
      return
    }
    if (useAppStore.getState().workspaceId !== workspaceId)
      return
    if (!node) {
      appStore.appendOutput(t('Analysis failed: {message}', { message: t('Only types and members can be analyzed.') }))
      return
    }
    const analyzed = node
    // dnSpy keeps one root per member: analyzing it again goes back to the row it has.
    const existing = get().rootKeys.find((key) => get().rows[key]?.node.nodeId === analyzed.nodeId)
    const key = existing ?? newRowKey()
    set((state) => ({
      rootKeys: existing ? state.rootKeys : [...state.rootKeys, key],
      rows: existing ? state.rows : { ...state.rows, [key]: { key, node: analyzed } },
      selection: [key],
      anchorKey: key,
      focusKey: key,
      focusToken: state.focusToken + 1,
    }))
    await get().expand(key)
  },

  expand: async (key) => {
    const row = get().rows[key]
    if (!row?.node.hasChildren)
      return
    set((state) => ({ expanded: { ...state.expanded, [key]: true } }))
    if (get().children[key])
      return
    const workspaceId = useAppStore.getState().workspaceId
    const nodeId = row.node.nodeId
    if (!workspaceId || !nodeId) {
      set((state) => ({ children: { ...state.children, [key]: { status: 'loaded', keys: [], truncated: false } } }))
      return
    }
    const requestKey = `r${++nextRequestKey}`
    set((state) => ({ children: { ...state.children, [key]: { status: 'loading', requestKey } } }))
    // A response is only taken while the row still waits for this very request: one the row was closed
    // on, or one that outlived the workspace, is dropped.
    const stillWanted = (): boolean => {
      const current = get().children[key]
      return current?.status === 'loading' && current.requestKey === requestKey
    }
    try {
      const response = await window.dnSpy.analyzeChildren(workspaceId, {
        nodeId,
        search: row.node.search ?? undefined,
        isSetter: row.node.isSetter,
      }, requestKey)
      if (!stillWanted())
        return
      const childRows: AnalyzerRow[] = response.children.map((node) => ({ key: newRowKey(), parentKey: key, node }))
      set((state) => ({
        rows: { ...state.rows, ...Object.fromEntries(childRows.map((child) => [child.key, child])) },
        children: { ...state.children, [key]: { status: 'loaded', keys: childRows.map((child) => child.key), truncated: response.truncated } },
      }))
      if (response.truncated)
        useAppStore.getState().appendOutput(t('The analyzer stopped after {count} result(s).', { count: childRows.length }))
    } catch (reason) {
      if (!stillWanted())
        return
      set((state) => ({ children: { ...state.children, [key]: { status: 'loaded', keys: [], truncated: false } } }))
      useAppStore.getState().appendOutput(t('Analysis failed: {message}', { message: message(reason) }))
    }
  },

  collapse: (key) => {
    // A search that has not finished is called off, and opening its row again starts it over. One that
    // has finished keeps what it found.
    const state = get()
    const subtree = subtreeKeys(state, key)
    const canceled = cancelLoading(state, subtree)
    const hidden = new Set(subtree.slice(1))
    const selection = state.selection.filter((selected) => !hidden.has(selected))
    set({
      expanded: { ...state.expanded, [key]: false },
      children: withoutKeys(state.children, canceled),
      // A selected row that the collapse hides hands the selection to the row that was closed.
      selection: selection.length === state.selection.length ? state.selection : [...new Set([...selection, key])],
      focusKey: state.focusKey && hidden.has(state.focusKey) ? key : state.focusKey,
    })
  },

  toggle: (key) => {
    if (get().expanded[key])
      get().collapse(key)
    else
      void get().expand(key)
  },

  select: (keys, options = {}) => set((state) => ({
    selection: keys,
    anchorKey: options.anchorKey ?? state.anchorKey,
    focusKey: options.focusKey ?? keys[keys.length - 1] ?? state.focusKey,
  })),

  removeRoots: (keys) => {
    const state = get()
    const removing = new Set(keys.filter((key) => state.rootKeys.includes(key)))
    if (removing.size === 0)
      return
    const gone = [...removing].flatMap((key) => subtreeKeys(state, key))
    cancelLoading(state, gone)
    const rootKeys = state.rootKeys.filter((key) => !removing.has(key))
    // The selection moves to the root that took the first removed one's place, or the one before it.
    const firstIndex = state.rootKeys.findIndex((key) => removing.has(key))
    const next = rootKeys[Math.min(firstIndex, rootKeys.length - 1)]
    set({
      rootKeys,
      rows: withoutKeys(state.rows, gone),
      children: withoutKeys(state.children, gone),
      expanded: withoutKeys(state.expanded, gone),
      selection: next ? [next] : [],
      anchorKey: next,
      focusKey: next,
    })
  },

  clear: () => {
    const state = get()
    cancelLoading(state, Object.keys(state.children))
    set(emptyTree())
  },

  revalidate: async () => {
    const before = get()
    // Every search forgets what it found and closes, the roots' own rows aside.
    const searchKeys = Object.keys(before.rows).filter((key) => before.rows[key].node.kind === 'search')
    const gone = new Set(searchKeys.flatMap((key) => subtreeKeys(before, key).slice(1)))
    cancelLoading(before, [...searchKeys, ...gone])
    set((state) => ({
      rows: withoutKeys(state.rows, gone),
      children: withoutKeys(state.children, [...gone, ...searchKeys]),
      expanded: { ...withoutKeys(state.expanded, gone), ...Object.fromEntries(searchKeys.map((key) => [key, false])) },
      selection: state.selection.filter((key) => !gone.has(key)),
      focusKey: state.focusKey && gone.has(state.focusKey) ? undefined : state.focusKey,
    }))

    const workspaceId = useAppStore.getState().workspaceId
    const rootKeys = get().rootKeys
    if (!workspaceId || rootKeys.length === 0)
      return
    const nodeIds = rootKeys.map((key) => get().rows[key]?.node.nodeId ?? '')
    let nodes: (AnalyzerNode | null)[]
    try {
      nodes = (await window.dnSpy.analyzeNodes(workspaceId, nodeIds)).nodes
    } catch {
      return
    }
    if (useAppStore.getState().workspaceId !== workspaceId)
      return
    const dead = rootKeys.filter((_, index) => !nodes[index])
    if (dead.length > 0)
      get().removeRoots(dead)
    set((state) => ({
      rows: {
        ...state.rows,
        ...Object.fromEntries(rootKeys.flatMap((key, index) => {
          const node = nodes[index]
          const row = state.rows[key]
          return node && row ? [[key, { ...row, node }]] : []
        })),
      },
    }))
  },
}))

// The analyzer follows the workspace: closing or replacing it empties the window, and a change to the model
// — an edit, its undo or redo, a reload, an assembly added or removed by hand — makes it start its searches
// over. An assembly opened on demand, to follow a reference, does not: dnSpy leaves the analyzer alone for
// the documents it loads by itself.
useAppStore.subscribe((state, previous) => {
  if (state.workspaceId !== previous.workspaceId || state.workspaceGeneration !== previous.workspaceGeneration) {
    useAnalyzerStore.getState().clear()
    return
  }
  if (state.workspaceStateId !== previous.workspaceStateId || state.assemblyListRevision !== previous.assemblyListRevision)
    void useAnalyzerStore.getState().revalidate()
})
