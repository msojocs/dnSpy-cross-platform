import { create } from 'zustand'
import type { StringReference, StringReferencesProgress } from '../../shared/protocol'
import { useAppStore } from './app-store'
import { translate as t } from './localization'

// dnSpy's String References window (StringReferencesService). A scan reads every module of the assemblies it was
// asked about and fills the list while it runs; it remembers those modules, so Refresh — and every change to
// the documents, or a switch of language — reads them again. A scan started while one runs replaces it.

interface StringReferencesState {
  /** In the order the scan found them; the window filters and sorts them. */
  references: StringReference[]
  scanning: boolean
  /** The modules the last scan read — dnSpy's `selectedModules` — which a refresh reads again. */
  modulePaths: string[]
  /** The scan still running, which a batch has to name to be taken. */
  requestKey?: string
  /** Set when the window is asked to take the keyboard focus, and cleared once its search box has it. */
  focusRequested: boolean

  /** dnSpy's Analyze(modules): scans every module of the assemblies the nodes are in. */
  analyze(nodeIds: string[]): void
  /** Scans the modules of the last scan again; with none, the assembly tree's selection — dnSpy's Refresh. */
  refresh(): void
  /** Starts a scan of the tree's selection unless the window already has modules — StartSearchIfNotStarted. */
  startIfNotStarted(): void
  /** Empties the list, the way dnSpy's window empties when every document is closed. */
  clear(): void
  receiveProgress(progress: StringReferencesProgress): void
  requestFocus(): void
  focusHandled(): void
}

let nextRequestKey = 0

const message = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** The part of a batch the list does not hold yet: the batch starts at `start` among everything found. */
const unseen = (batch: StringReference[], start: number, held: number): StringReference[] => batch.slice(Math.max(held - start, 0))

/** dnSpy asks the decompiler which members it shows: IL shows the ones the compiler made, C# and VB do not. */
const showsAllMembers = (): boolean => {
  const language = useAppStore.getState().defaultLanguage
  return language === 'il' || language === 'ilWithCSharp'
}

const scan = (request: { nodeIds?: string[]; modulePaths?: string[] }): void => {
  const store = useStringReferencesStore
  const previous = store.getState().requestKey
  if (previous)
    void window.dnSpy.cancelStringReferences(previous).catch(() => undefined)
  const { workspaceId } = useAppStore.getState()
  if (!workspaceId) {
    store.setState({ references: [], scanning: false, requestKey: undefined })
    return
  }
  const requestKey = `strings-${++nextRequestKey}`
  store.setState({ references: [], scanning: true, requestKey })
  window.dnSpy.searchStringReferences(workspaceId, { ...request, showAllMembers: showsAllMembers() }, requestKey).then((response) => {
    if (store.getState().requestKey !== requestKey)
      return
    store.setState((state) => ({
      references: [...state.references, ...unseen(response.references, response.start, state.references.length)],
      modulePaths: response.modulePaths,
      scanning: false,
      requestKey: undefined,
    }))
  }, (reason: unknown) => {
    // A scan called off, or replaced, has no one waiting for it.
    if (store.getState().requestKey !== requestKey)
      return
    store.setState({ scanning: false, requestKey: undefined })
    useAppStore.getState().appendOutput(t('String references scan failed: {message}', { message: message(reason) }))
  })
}

export const useStringReferencesStore = create<StringReferencesState>((set, get) => ({
  references: [],
  scanning: false,
  modulePaths: [],
  requestKey: undefined,
  focusRequested: false,

  analyze: (nodeIds) => {
    if (nodeIds.length === 0)
      return
    scan({ nodeIds })
  },

  refresh: () => {
    const { modulePaths } = get()
    if (modulePaths.length > 0)
      scan({ modulePaths })
    else
      get().analyze(useAppStore.getState().selectedNodes.map((node) => node.id))
  },

  startIfNotStarted: () => {
    if (get().modulePaths.length === 0 && !get().scanning)
      get().analyze(useAppStore.getState().selectedNodes.map((node) => node.id))
  },

  clear: () => {
    const previous = get().requestKey
    if (previous)
      void window.dnSpy.cancelStringReferences(previous).catch(() => undefined)
    set({ references: [], scanning: false, modulePaths: [], requestKey: undefined })
  },

  receiveProgress: (progress) => {
    if (progress.requestKey !== get().requestKey)
      return
    set((state) => ({ references: [...state.references, ...unseen(progress.references, progress.start, state.references.length)] }))
  },

  requestFocus: () => set({ focusRequested: true }),
  focusHandled: () => set({ focusRequested: false }),
}))

window.dnSpy?.onStringReferencesProgress?.((progress) => useStringReferencesStore.getState().receiveProgress(progress))

// The window follows the documents: closing the workspace empties it, and an edit, its undo or redo, a reload or
// an assembly added or removed reads its modules again — dnSpy refreshes on DocumentModified and drops the modules
// of a removed document. A new decompiler changes how rows are written and which members are listed, so a switch
// of language refreshes too.
useAppStore.subscribe((state, previous) => {
  if (state.workspaceId !== previous.workspaceId) {
    useStringReferencesStore.getState().clear()
    return
  }
  const strings = useStringReferencesStore.getState()
  if (strings.modulePaths.length === 0)
    return
  if (state.workspaceGeneration !== previous.workspaceGeneration
    || state.workspaceStateId !== previous.workspaceStateId
    || state.assemblyListRevision !== previous.assemblyListRevision
    || state.defaultLanguage !== previous.defaultLanguage)
    strings.refresh()
})
