import { useCallback, useEffect, useRef, useState } from 'react'
import { createSearchPattern, isSearchDataValid, tryParseData, type HexDataKind, type HexSearchPattern } from './hex-search'
import type { HexViewModel } from './hex-view-model'
import type { HexSearchState } from './components/HexSearchControl'

/** Find options as dnSpy's search service passes them to `FindAll`. */
export interface HexSearchRun {
  rangeStart: number
  rangeEnd: number
  start: number
  reverse: boolean
  wrap: boolean
  noOverlaps: boolean
  maxResults: number
}

export type HexSearchRunner = (pattern: HexSearchPattern, run: HexSearchRun) => Promise<number[]>

/** dnSpy's `SearchSettings`: the last search, shared by every hex view and kept across sessions. */
const settingsKey = 'dnspy.hexSearch.v1'

interface StoredSettings { searchString: string; replaceString: string; matchCase: boolean; bigEndian: boolean; dataKind: HexDataKind }

const loadSettings = (): StoredSettings => {
  const defaults: StoredSettings = { searchString: '', replaceString: '', matchCase: false, bigEndian: false, dataKind: 'bytes' }
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(settingsKey) ?? '{}') as Partial<StoredSettings>) }
  }
  catch {
    return defaults
  }
}

const saveSettings = (state: HexSearchState): void => {
  try {
    const { searchString, replaceString, matchCase, bigEndian, dataKind } = state
    localStorage.setItem(settingsKey, JSON.stringify({ searchString, replaceString, matchCase, bigEndian, dataKind }))
  }
  catch {
    // A full store loses the settings, not the search.
  }
}

const MAX_SELECTION_BYTES = 1024

const isIncremental = (kind: HexSearchState['kind']): boolean => kind === 'incrementalForward' || kind === 'incrementalBackward'

/**
 * dnSpy's `HexViewSearchServiceImpl`: Find, Replace and incremental search over the view's bytes, the search
 * control's state, and the matches in view that the markers draw.
 */
export function useHexSearch({ model, run, readBytes, write, canWrite, focusView, visibleRange }: {
  model: HexViewModel
  run: HexSearchRunner | undefined
  readBytes(offset: number, count: number): Promise<Uint8Array>
  write(offset: number, data: Uint8Array): Promise<boolean>
  canWrite: boolean
  focusView(): void
  /** The bytes on screen, which the match markers are looked for in. */
  visibleRange: { start: number; end: number }
}): {
  visible: boolean
  state: HexSearchState
  focusRequest: { target: 'search' | 'replace'; token: number }
  markers: { start: number; length: number }[]
  canReplace: boolean
  showFind(): void
  showReplace(): void
  showIncremental(forward: boolean): void
  findNext(forward: boolean): void
  findNextSelected(forward: boolean): void
  replaceNext(): void
  replaceAll(): void
  toggleReplace(): void
  change(change: Partial<HexSearchState>): void
  close(): void
  /** Lets incremental search take a key typed in the view; answers whether it did. */
  incrementalKey(key: string, command: string | undefined): boolean
  /** The caret moved: an incremental search that did not move it ends. */
  caretMoved(): void
} {
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<HexSearchState>(() => ({ ...loadSettings(), kind: 'find', foundMatch: true, searching: false }))
  const [focusRequest, setFocusRequest] = useState<{ target: 'search' | 'replace'; token: number }>({ target: 'search', token: 0 })
  const [markers, setMarkers] = useState<{ start: number; length: number }[]>([])
  const stateRef = useRef(state)
  stateRef.current = state
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const incrementalStart = useRef<number | undefined>(undefined)
  const searchMovesCaret = useRef(false)
  const searchToken = useRef(0)

  const update = useCallback((change: Partial<HexSearchState>): void => {
    setState((current) => {
      const next = { ...current, ...change }
      saveSettings(next)
      return next
    })
  }, [])

  const patternOf = (current: HexSearchState, matchCase: boolean): HexSearchPattern | undefined | null =>
    createSearchPattern(current.dataKind, current.searchString, matchCase, current.bigEndian)

  /** `GetFindOptions`: incremental search matches case when the text has an upper case letter. */
  const matchCaseOf = (current: HexSearchState): boolean =>
    isIncremental(current.kind) ? /\p{Lu}/u.test(current.searchString) : current.matchCase

  /** `GetStartingPosition`. */
  const startingPosition = (reverse: boolean, restart: boolean, wrap: boolean): number | undefined => {
    if (isIncremental(stateRef.current.kind))
      return incrementalStart.current
    if (model.isSelectionEmpty)
      return model.caretPosition
    if (restart)
      return reverse ? model.selectionEnd : model.selectionStart
    if (reverse) {
      if (model.selectionEnd >= model.bufferStart + 2)
        return model.selectionEnd - 2
      return wrap ? model.bufferEnd : undefined
    }
    if (model.selectionStart < model.bufferEnd)
      return model.selectionStart + 1
    return wrap ? model.bufferStart : undefined
  }

  /** `FindNextCore`: the first match from a position, which is selected and scrolled to. */
  const findCore = useCallback(async (pattern: HexSearchPattern, start: number, reverse: boolean, wrap: boolean): Promise<number | undefined> => {
    if (!run)
      return undefined
    const token = ++searchToken.current
    setState((current) => ({ ...current, searching: true }))
    try {
      const found = await run(pattern, { rangeStart: model.bufferStart, rangeEnd: model.bufferEnd, start, reverse, wrap, noOverlaps: false, maxResults: 1 })
      if (token !== searchToken.current)
        return undefined
      return found[0]
    }
    finally {
      if (token === searchToken.current)
        setState((current) => ({ ...current, searching: false }))
    }
  }, [model, run])

  const showResult = (start: number, length: number): void => {
    searchMovesCaret.current = true
    try {
      model.selectAndMoveCaret(start, start + length)
    }
    finally {
      searchMovesCaret.current = false
    }
  }

  const search = useCallback(async (reverse: boolean, restart: boolean, options?: { matchCase?: boolean; current?: HexSearchState }): Promise<void> => {
    const current = options?.current ?? stateRef.current
    const pattern = patternOf(current, options?.matchCase ?? matchCaseOf(current))
    if (!pattern) {
      setState((old) => ({ ...old, foundMatch: current.searchString.length === 0 }))
      return
    }
    const start = startingPosition(reverse, restart, true)
    if (start === undefined)
      return
    const found = await findCore(pattern, start, reverse, true)
    setState((old) => ({ ...old, foundMatch: found !== undefined }))
    if (found !== undefined)
      showResult(found, pattern.pattern.length)
  }, [findCore]) // eslint-disable-line react-hooks/exhaustive-deps

  // `UpdateHexMarkerSearch`: the matches on screen, looked for again whenever the search or the screen changes.
  useEffect(() => {
    if (!visible || !run) {
      setMarkers([])
      return
    }
    const pattern = patternOf(state, matchCaseOf(state))
    if (!pattern) {
      setMarkers([])
      return
    }
    let current = true
    const length = pattern.pattern.length
    const handle = setTimeout(() => {
      const rangeStart = Math.max(model.bufferStart, visibleRange.start - (length - 1))
      const rangeEnd = Math.min(model.bufferEnd, visibleRange.end + (length - 1))
      if (rangeEnd <= rangeStart)
        return
      void run(pattern, { rangeStart, rangeEnd, start: rangeStart, reverse: false, wrap: false, noOverlaps: false, maxResults: 10000 })
        .then((offsets) => { if (current) setMarkers(offsets.map((start) => ({ start, length }))) }, () => { if (current) setMarkers([]) })
    }, 30)
    return () => {
      current = false
      clearTimeout(handle)
    }
  }, [visible, run, state.searchString, state.matchCase, state.bigEndian, state.dataKind, state.kind, visibleRange.start, visibleRange.end, model]) // eslint-disable-line react-hooks/exhaustive-deps

  /** `TryGetSearchStringFromSelection`: the selected bytes as hex digits, at most 1024 of them. */
  const searchStringFromSelection = async (): Promise<string | undefined> => {
    if (model.isSelectionEmpty)
      return undefined
    const bytes = await readBytes(model.selectionStart, Math.min(MAX_SELECTION_BYTES, model.selectionEnd - model.selectionStart))
    return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('')
  }

  const show = async (kind: 'find' | 'replace'): Promise<void> => {
    const fromSelection = await searchStringFromSelection()
    incrementalStart.current = undefined
    const next: Partial<HexSearchState> = { kind }
    if (fromSelection !== undefined)
      next.searchString = fromSelection
    if (!visibleRef.current)
      Object.assign(next, loadSettings(), fromSelection !== undefined ? { searchString: fromSelection } : {})
    update(next)
    setVisible(true)
    setFocusRequest((old) => ({ target: 'search', token: old.token + 1 }))
  }

  const close = useCallback((): void => {
    incrementalStart.current = undefined
    searchToken.current++
    setVisible(false)
    setState((current) => ({ ...current, kind: 'find', searching: false }))
    focusView()
  }, [focusView])

  const showIncremental = (forward: boolean): void => {
    const kind = forward ? 'incrementalForward' : 'incrementalBackward'
    if (visibleRef.current && isIncremental(stateRef.current.kind) && !model.isSelectionEmpty) {
      // Pressed again while searching: the next match from the one selected.
      const start = forward
        ? (model.selectionStart >= model.bufferEnd ? model.bufferStart : model.selectionStart + 1)
        : ((model.selectionEnd === 0 ? 0 : model.selectionEnd - 1) <= model.bufferStart ? model.bufferEnd : model.selectionEnd - 2)
      incrementalStart.current = start
      const current = { ...stateRef.current, kind } as HexSearchState
      setState(current)
      void search(!forward, true, { current })
      return
    }
    incrementalStart.current = model.caretPosition
    update({ kind, searchString: '' })
    setVisible(true)
    focusView()
  }

  const change = (next: Partial<HexSearchState>): void => {
    const current = { ...stateRef.current, ...next }
    update(next)
    const restart = next.searchString !== undefined || next.matchCase !== undefined || next.bigEndian !== undefined || next.dataKind !== undefined
    if (restart && current.searchString.length > 0)
      void search(current.kind === 'incrementalBackward', true, { current })
    else if (restart)
      setState((old) => ({ ...old, foundMatch: true }))
  }

  const replacementFor = (length: number): Uint8Array | undefined => {
    const current = stateRef.current
    const data = tryParseData(current.replaceString, current.dataKind, current.bigEndian)
    if (!data)
      return undefined
    if (data.length === length)
      return data
    const resized = new Uint8Array(length)
    resized.set(data.subarray(0, Math.min(data.length, length)))
    return resized
  }

  const canReplace = state.kind === 'replace' && canWrite
  const replaceReady = (): boolean => {
    const current = stateRef.current
    return current.kind === 'replace' && canWrite && isSearchDataValid(current.dataKind, current.searchString, current.bigEndian)
      && tryParseData(current.replaceString, current.dataKind, current.bigEndian) !== undefined
  }

  /** `ReplaceNext`: the selected match is replaced and the next one selected; without one, the next is found. */
  const replaceNext = async (): Promise<void> => {
    if (!replaceReady())
      return
    const current = stateRef.current
    const pattern = patternOf(current, current.matchCase)
    if (!pattern)
      return
    const start = startingPosition(false, true, true)
    if (start === undefined)
      return
    const found = await findCore(pattern, start, false, true)
    if (found === undefined)
      return
    const length = pattern.pattern.length
    if (!model.isSelectionEmpty && model.selectionStart === found && model.selectionEnd === found + length) {
      const data = replacementFor(length)
      if (!data || !await write(found, data))
        return
      model.clearSelection()
      model.moveCaretTo(length === 0 ? found : found + length - 1)
      const next = await findCore(pattern, startingPosition(false, true, true) ?? found, false, true)
      if (next !== undefined)
        showResult(next, length)
    }
    else
      showResult(found, length)
  }

  /** `ReplaceAll`: every match, none overlapping another, replaced as one edit. */
  const replaceAll = async (): Promise<void> => {
    if (!replaceReady() || !run)
      return
    const current = stateRef.current
    const pattern = patternOf(current, current.matchCase)
    if (!pattern)
      return
    const length = pattern.pattern.length
    const offsets = await run(pattern, { rangeStart: model.bufferStart, rangeEnd: model.bufferEnd, start: model.bufferStart, reverse: false, wrap: false, noOverlaps: true, maxResults: 0x7FFFFFFF })
    const data = replacementFor(length)
    if (!data || offsets.length === 0)
      return
    for (const offset of offsets) {
      if (!await write(offset, data))
        break
    }
    model.clearSelection()
    model.ensureCaretVisible()
  }

  return {
    visible,
    state,
    focusRequest,
    markers,
    canReplace,
    showFind: () => { void show('find') },
    showReplace: () => { void show('replace') },
    showIncremental,
    findNext: (forward) => {
      if (!visibleRef.current)
        Object.assign(stateRef.current, loadSettings())
      void search(!forward, false)
    },
    findNextSelected: (forward) => {
      void (async () => {
        const fromSelection = await searchStringFromSelection()
        if (fromSelection === undefined)
          return
        const current = { ...stateRef.current, kind: 'find' as const, searchString: fromSelection }
        update({ kind: 'find', searchString: fromSelection })
        setVisible(true)
        // This search does not use the control's options: it matches case and wraps.
        await search(!forward, false, { matchCase: true, current })
      })()
    },
    replaceNext: () => { void replaceNext() },
    replaceAll: () => { void replaceAll() },
    toggleReplace: () => update({ kind: stateRef.current.kind === 'replace' ? 'find' : 'replace' }),
    change,
    close,
    incrementalKey: (key, command) => {
      if (!visibleRef.current || !isIncremental(stateRef.current.kind))
        return false
      if (command === 'cancel') {
        model.clearSelection()
        close()
        return true
      }
      if (command === 'scrollUp' || command === 'scrollDown')
        return false
      if (command === 'incrementalSearchForward' || command === 'incrementalSearchBackward')
        return false
      const current = stateRef.current
      let text: string | undefined
      if (command === 'backspace')
        text = current.searchString.slice(0, -1)
      else if (command === 'tab')
        text = current.searchString + '\t'
      else if (command === 'return') {
        close()
        return true
      }
      else if (command === undefined && key.length === 1)
        text = current.searchString + key
      if (text === undefined) {
        close()
        return false
      }
      const next = { ...current, searchString: text }
      update({ searchString: text })
      if (text.length > 0)
        void search(current.kind === 'incrementalBackward', true, { current: next })
      return true
    },
    caretMoved: () => {
      if (!searchMovesCaret.current && visibleRef.current && isIncremental(stateRef.current.kind))
        close()
    },
  }
}
