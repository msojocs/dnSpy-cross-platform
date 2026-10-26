import type { editor as MonacoEditor, IDisposable } from 'monaco-editor'

/**
 * dnSpy's virtual space (the text editor's "Use virtual space" option, `TextCaret` and `EditorOperations` with
 * `IsVirtualSpaceEnabled`): the caret may stand past the end of a line, as a `VirtualSnapshotPoint` — the line's
 * end plus a count of virtual spaces. Monaco has no such position (microsoft/monaco-editor#919), so the count is
 * kept here beside Monaco's caret, which stays at the line's end: the caret is drawn that many space widths
 * further right, and the moves dnSpy makes differently with the option on are made here instead.
 */

/** Where a caret is in dnSpy's terms: a Monaco position and the virtual spaces past it. */
export interface VirtualCaret {
  lineNumber: number
  column: number
  virtualSpaces: number
}

/** The screen column (0-based, a tab reaching the next tab stop) before the 1-based `column` of `text`. */
export const visualColumnOf = (text: string, column: number, tabSize: number): number => {
  let visual = 0
  for (let index = 0; index < column - 1 && index < text.length; index++)
    visual = text[index] === '\t' ? visual + tabSize - (visual % tabSize) : visual + 1
  return visual
}

/**
 * dnSpy's `GetInsertionBufferPositionFromXCoordinate` in screen columns: the character boundary nearest the
 * screen column `visual`, and past the line's end, the end and the virtual spaces that make up the rest.
 */
export const caretAtVisualColumn = (text: string, visual: number, tabSize: number): { column: number; virtualSpaces: number } => {
  let before = 0
  for (let index = 0; index < text.length; index++) {
    const after = text[index] === '\t' ? before + tabSize - (before % tabSize) : before + 1
    if (visual < after)
      return { column: visual - before <= after - visual ? index + 1 : index + 2, virtualSpaces: 0 }
    before = after
  }
  return { column: text.length + 1, virtualSpaces: Math.max(0, visual - before) }
}

/** dnSpy's `(int)Math.Round((x - TextRight) / VirtualSpaceWidth)`: the virtual spaces a point past the end stands at. */
export const virtualSpacesAt = (distance: number, spaceWidth: number): number =>
  spaceWidth > 0 && distance > 0 ? Math.round(distance / spaceWidth) : 0

/**
 * The part of a stream selection that lies in virtual space on the line of its end, in virtual spaces past that
 * line's end, the way dnSpy's MarkerHelper draws it — or nothing when the selection does not reach past the end.
 * `start` is the earlier of the two points, `end` the later.
 */
export const virtualSelectionExtent = (
  start: VirtualCaret,
  end: VirtualCaret,
  maxColumnOfEndLine: number,
): { line: number; from: number; to: number } | undefined => {
  if (end.virtualSpaces === 0 || end.column !== maxColumnOfEndLine)
    return undefined
  const from = start.lineNumber === end.lineNumber && start.column === maxColumnOfEndLine ? start.virtualSpaces : 0
  return end.virtualSpaces > from ? { line: end.lineNumber, from, to: end.virtualSpaces } : undefined
}

const comparePoints = (left: VirtualCaret, right: VirtualCaret): number =>
  left.lineNumber - right.lineNumber || left.column - right.column || left.virtualSpaces - right.virtualSpaces

export interface VirtualSpaceController extends IDisposable {
  /** The virtual spaces the caret stands past its line's end. */
  virtualSpaces(): number
  /** Puts the caret at a column, one past the line's end standing for a virtual space each (dnSpy's saved CaretVirtualSpaces). */
  placeCaret(lineNumber: number, column: number): void
  /** The option or word wrap changed: with virtual space off, the caret goes back to the end of its line. */
  refresh(): void
}

const controllers = new WeakMap<MonacoEditor.ICodeEditor, VirtualSpaceController>()

/** The virtual spaces of an editor's caret, 0 for an editor that keeps no virtual space. */
export const virtualSpacesOf = (editor: MonacoEditor.ICodeEditor): number => controllers.get(editor)?.virtualSpaces() ?? 0

type MonacoApi = typeof import('monaco-editor')

/**
 * Keeps dnSpy's virtual space for one editor. `enabled` says whether the option is on (word wrap off — the
 * Options dialog makes the two take turns); `onChange` hears of every change of the virtual spaces.
 */
export const installVirtualSpace = (
  editor: MonacoEditor.IStandaloneCodeEditor,
  monaco: MonacoApi,
  enabled: () => boolean,
  onChange: () => void,
): VirtualSpaceController => {
  const { EditorOption, MouseTargetType } = monaco.editor
  const { KeyCode } = monaco
  let caretSpaces = 0
  let anchorSpaces = 0
  // The screen column the Up and Down keys aim at — dnSpy's preferredXCoordinate — kept across vertical moves and
  // dropped by any other; without it they aim at the caret's own screen column.
  let preferredVisual: number | undefined
  // Set while this controller moves Monaco's caret, so the change is not taken for a move of somebody else's.
  let applying = false
  // A vertical move Monaco is about to make: the screen column it should land in, and whether it extends the selection.
  let pendingVertical: { visual: number; extend: boolean } | undefined
  let selectionChanges = 0
  let lastSelection = editor.getSelection()
  let baseScrollBeyondLastColumn = editor.getOption(EditorOption.scrollBeyondLastColumn)
  let widenedScrolling = false

  const spaceWidth = (): number => editor.getOption(EditorOption.fontInfo).spaceWidth || 8
  const tabSize = (): number => editor.getModel()?.getOptions().tabSize ?? 4
  const lineText = (lineNumber: number): string => editor.getModel()?.getLineContent(lineNumber) ?? ''
  const maxColumn = (lineNumber: number): number => editor.getModel()?.getLineMaxColumn(lineNumber) ?? 1

  // The selection's two ends in dnSpy's terms.
  const points = (): { anchor: VirtualCaret; active: VirtualCaret } | undefined => {
    const selection = editor.getSelection()
    if (!selection)
      return undefined
    return {
      anchor: { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn, virtualSpaces: anchorSpaces },
      active: { lineNumber: selection.positionLineNumber, column: selection.positionColumn, virtualSpaces: caretSpaces },
    }
  }

  const caretVisual = (): number => {
    const position = editor.getPosition()
    return position ? visualColumnOf(lineText(position.lineNumber), position.column, tabSize()) + caretSpaces : 0
  }

  // The caret is Monaco's own, moved right by the virtual spaces; the selection's part in virtual space is a
  // band of the selection color of its own, drawn over the empty space past the line's end.
  const band = window.document.createElement('div')
  band.className = 'virtual-space-selection'
  const layer = window.document.createElement('div')
  layer.className = 'virtual-space-layer'
  layer.appendChild(band)
  const widget: MonacoEditor.IOverlayWidget = {
    getId: () => `dnspy.virtualSpace.${editor.getId()}`,
    getDomNode: () => layer,
    getPosition: () => null,
  }
  editor.addOverlayWidget(widget)

  const render = (): void => {
    const node = editor.getDomNode()
    node?.style.setProperty('--virtual-caret-offset', `${caretSpaces * spaceWidth()}px`)
    band.style.display = 'none'
    const ends = points()
    if (!ends)
      return
    const [start, end] = comparePoints(ends.anchor, ends.active) <= 0 ? [ends.anchor, ends.active] : [ends.active, ends.anchor]
    const extent = virtualSelectionExtent(start, end, maxColumn(end.lineNumber))
    if (!extent)
      return
    const visible = editor.getScrolledVisiblePosition({ lineNumber: extent.line, column: maxColumn(extent.line) })
    if (!visible)
      return
    const layout = editor.getLayoutInfo()
    const left = Math.max(visible.left + extent.from * spaceWidth(), layout.contentLeft)
    const right = Math.min(visible.left + extent.to * spaceWidth(), layout.contentLeft + layout.contentWidth - layout.verticalScrollbarWidth)
    if (right <= left || visible.top + visible.height < 0 || visible.top > layout.height)
      return
    band.style.display = 'block'
    band.style.left = `${left}px`
    band.style.top = `${visible.top}px`
    band.style.width = `${right - left}px`
    band.style.height = `${visible.height}px`
  }

  // dnSpy's Caret.EnsureVisible across: the view scrolls sideways to a caret past the end, and its scroll range
  // reaches as far as the caret does (WpfTextView's ViewportLeft takes Caret.Right into its maximum).
  const ensureCaretVisible = (): void => {
    const position = editor.getPosition()
    if (!position)
      return
    const end = editor.getScrolledVisiblePosition({ lineNumber: position.lineNumber, column: maxColumn(position.lineNumber) })
    const layout = editor.getLayoutInfo()
    const width = spaceWidth()
    if (!end)
      return
    const caretRight = end.left + caretSpaces * width + width
    const viewRight = layout.contentLeft + layout.contentWidth - layout.verticalScrollbarWidth
    const needed = editor.getScrollLeft() + caretRight - layout.contentLeft
    const fontInfo = editor.getOption(EditorOption.fontInfo)
    const columnWidth = fontInfo.typicalHalfwidthCharacterWidth || width
    // The view scrolls at most to its scroll width less the text area's width; the caret's right edge needs
    // the scroll width to reach this far.
    const reach = editor.getScrollWidth() - layout.verticalScrollbarWidth
    if (caretSpaces > 0 && needed > reach) {
      const extra = Math.ceil((needed - reach) / columnWidth) + 1
      widenedScrolling = true
      editor.updateOptions({ scrollBeyondLastColumn: editor.getOption(EditorOption.scrollBeyondLastColumn) + extra })
    }
    if (caretRight > viewRight)
      editor.setScrollLeft(editor.getScrollLeft() + caretRight - viewRight)
    else if (end.left + caretSpaces * width < layout.contentLeft)
      editor.setScrollLeft(Math.max(0, editor.getScrollLeft() - (layout.contentLeft - (end.left + caretSpaces * width))))
  }

  const changed = (scroll: boolean): void => {
    render()
    // Out of virtual space the scroll range is the text's again.
    if (caretSpaces === 0 && widenedScrolling) {
      widenedScrolling = false
      editor.updateOptions({ scrollBeyondLastColumn: baseScrollBeyondLastColumn })
    }
    if (scroll) {
      ensureCaretVisible()
      // A widened scroll range takes effect on the next layout; the scroll that needs it waits for that.
      if (widenedScrolling)
        requestAnimationFrame(() => {
          ensureCaretVisible()
          render()
        })
    }
    onChange()
  }

  /** Moves Monaco's caret (and the selection's active end) to `active`, keeping `anchor` or collapsing to it. */
  const setPoints = (anchor: VirtualCaret, active: VirtualCaret): void => {
    applying = true
    try {
      editor.setSelection({
        selectionStartLineNumber: anchor.lineNumber,
        selectionStartColumn: anchor.column,
        positionLineNumber: active.lineNumber,
        positionColumn: active.column,
      })
    }
    finally {
      applying = false
    }
    lastSelection = editor.getSelection()
    anchorSpaces = anchor.virtualSpaces
    caretSpaces = active.virtualSpaces
  }

  const reset = (): void => {
    if (caretSpaces === 0 && anchorSpaces === 0 && preferredVisual === undefined)
      return
    caretSpaces = 0
    anchorSpaces = 0
    preferredVisual = undefined
    changed(true)
  }

  const disposables: IDisposable[] = []

  disposables.push(editor.onDidChangeCursorSelection((event) => {
    selectionChanges++
    const previous = lastSelection
    lastSelection = event.selection
    if (applying)
      return
    if (pendingVertical !== undefined && enabled()) {
      // Monaco has moved to the line; the column is dnSpy's, the screen column the caret had, past the end if
      // the line is shorter.
      const { visual, extend } = pendingVertical
      pendingVertical = undefined
      const selection = event.selection
      const line = selection.positionLineNumber
      const caret = caretAtVisualColumn(lineText(line), visual, tabSize())
      const active = { lineNumber: line, column: caret.column, virtualSpaces: caret.virtualSpaces }
      // With Shift the anchor stays where it was, its virtual spaces with it.
      const anchor = extend
        ? { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn, virtualSpaces: anchorSpaces }
        : active
      setPoints(anchor, active)
      // The next vertical move aims at the same screen column, whatever this line made of it (a tab rounds).
      preferredVisual = visual
      changed(true)
      return
    }
    // A move of Monaco's own — a click, Home, a word move — lands on a real position. A selection's anchor keeps
    // its virtual spaces while it stays where it was; a selection that starts from a caret in virtual space starts
    // there, as with no selection the anchor's spaces are the caret's.
    const anchorStayed = previous !== null
      && previous.selectionStartLineNumber === event.selection.selectionStartLineNumber
      && previous.selectionStartColumn === event.selection.selectionStartColumn
    const nextAnchor = anchorStayed && !event.selection.isEmpty() ? anchorSpaces : 0
    if (caretSpaces === 0 && anchorSpaces === nextAnchor && preferredVisual === undefined)
      return
    caretSpaces = 0
    anchorSpaces = nextAnchor
    preferredVisual = undefined
    changed(false)
  }))

  // dnSpy's EditorOperations in an editable view: text typed (or pasted) in virtual space first fills it with the
  // white space of the editor's tab settings (GetWhitespaceForVirtualSpace), so it lands where the caret is drawn.
  const fillVirtualSpace = (): void => {
    const position = editor.getPosition()
    if (!position || caretSpaces === 0)
      return
    const line = position.lineNumber
    const end = maxColumn(line)
    const from = visualColumnOf(lineText(line), end, tabSize())
    const to = from + caretSpaces
    let text = ''
    if (editor.getModel()?.getOptions().insertSpaces ?? true)
      text = ' '.repeat(caretSpaces)
    else {
      let visual = from
      for (let next = (Math.floor(visual / tabSize()) + 1) * tabSize(); next <= to; next += tabSize()) {
        text += '\t'
        visual = next
      }
      text += ' '.repeat(to - visual)
    }
    applying = true
    try {
      editor.executeEdits('dnSpy.virtualSpace', [{ range: new monaco.Range(line, end, line, end), text, forceMoveMarkers: true }])
      editor.setPosition({ lineNumber: line, column: end + text.length })
    }
    finally {
      applying = false
    }
    lastSelection = editor.getSelection()
    caretSpaces = 0
    anchorSpaces = 0
    preferredVisual = undefined
    changed(false)
  }

  disposables.push(editor.onKeyDown((event) => {
    if (!enabled())
      return
    const browserEvent = event.browserEvent
    if (caretSpaces > 0 && !editor.getOption(EditorOption.readOnly) && editor.getSelection()?.isEmpty()) {
      const command = browserEvent.ctrlKey || browserEvent.metaKey
      const typing = !command && !browserEvent.altKey && browserEvent.key.length === 1
      const pasting = (command && !browserEvent.altKey && event.keyCode === KeyCode.KeyV) || (browserEvent.shiftKey && event.keyCode === KeyCode.Insert)
      if (typing || pasting || (!command && (event.keyCode === KeyCode.Tab || event.keyCode === KeyCode.Delete))) {
        fillVirtualSpace()
        return
      }
      if (!command && !browserEvent.altKey && event.keyCode === KeyCode.Backspace) {
        // dnSpy's DeleteCharacterToLeft in virtual space takes one virtual space off and leaves the text.
        event.preventDefault()
        event.stopPropagation()
        const position = editor.getPosition()!
        const active = { lineNumber: position.lineNumber, column: position.column, virtualSpaces: caretSpaces - 1 }
        setPoints(active, active)
        preferredVisual = active.virtualSpaces > 0 ? caretVisual() : undefined
        changed(true)
        return
      }
    }
    if (browserEvent.ctrlKey || browserEvent.altKey || browserEvent.metaKey)
      return
    const shift = browserEvent.shiftKey
    const position = editor.getPosition()
    const ends = points()
    if (!position || !ends)
      return
    const stop = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const lineEnd = maxColumn(position.lineNumber)
    const hasSelection = comparePoints(ends.anchor, ends.active) !== 0
    switch (event.keyCode) {
    case KeyCode.RightArrow: {
      // dnSpy's MoveToNextCharacter: without Shift a selection collapses to its end; at or past the end of a line
      // the caret goes one more virtual space right instead of on to the next line.
      if (!shift && hasSelection) {
        stop()
        const end = comparePoints(ends.anchor, ends.active) > 0 ? ends.anchor : ends.active
        setPoints(end, end)
        preferredVisual = end.virtualSpaces > 0 ? caretVisual() : undefined
        changed(true)
        return
      }
      if (position.column < lineEnd)
        return
      stop()
      const active = { lineNumber: position.lineNumber, column: lineEnd, virtualSpaces: caretSpaces + 1 }
      setPoints(shift ? ends.anchor : active, active)
      preferredVisual = caretVisual()
      changed(true)
      return
    }
    case KeyCode.LeftArrow: {
      // dnSpy's MoveToPreviousCharacter: a selection collapses to its start; in virtual space the caret goes one
      // virtual space back, and at the start of a line it stays there rather than going up to the line before.
      if (!shift && hasSelection) {
        stop()
        const start = comparePoints(ends.anchor, ends.active) <= 0 ? ends.anchor : ends.active
        setPoints(start, start)
        preferredVisual = start.virtualSpaces > 0 ? caretVisual() : undefined
        changed(true)
        return
      }
      if (caretSpaces > 0) {
        stop()
        const active = { lineNumber: position.lineNumber, column: position.column, virtualSpaces: caretSpaces - 1 }
        setPoints(shift ? ends.anchor : active, active)
        preferredVisual = active.virtualSpaces > 0 ? caretVisual() : undefined
        changed(true)
        return
      }
      if (position.column === 1)
        stop()
      return
    }
    case KeyCode.UpArrow:
    case KeyCode.DownArrow:
    case KeyCode.PageUp:
    case KeyCode.PageDown:
      // Monaco moves to the line; the column it lands in is put right once it has (see the selection listener).
      // Its keybindings hear the key as it bubbles on to the editor's container — after a microtask checkpoint —
      // so what is left for them to do is only forgotten on the next task.
      pendingVertical = { visual: preferredVisual ?? caretVisual(), extend: shift }
      setTimeout(() => {
        pendingVertical = undefined
      })
      return
    case KeyCode.Home:
    case KeyCode.End: {
      // Both go to a real position; on a line whose end is already where Monaco would go, Monaco does not move
      // and says nothing, so the virtual spaces are dropped here.
      if (caretSpaces === 0)
        return
      const before = selectionChanges
      setTimeout(() => {
        if (selectionChanges !== before)
          return
        const active = { lineNumber: position.lineNumber, column: position.column, virtualSpaces: 0 }
        setPoints(shift ? ends.anchor : active, active)
        preferredVisual = undefined
        changed(true)
      })
      return
    }
    case KeyCode.Escape:
      // Esc clears the selection and leaves the caret where it is, in virtual space too: the viewer's own Esc
      // then finds nothing left to collapse.
      if (hasSelection) {
        setPoints(ends.active, ends.active)
        changed(false)
      }
      return
    default:
      return
    }
  }))

  // dnSpy's SelectToMousePosition: a press past the end of a line puts the caret there, in virtual space, and the
  // drag that follows takes the selection's end along — Monaco has already moved its caret to the line's end.
  let dragging: { move: (event: MouseEvent) => void; up: () => void } | undefined
  const stopDragging = (): void => {
    if (!dragging)
      return
    window.removeEventListener('mousemove', dragging.move, true)
    window.removeEventListener('mouseup', dragging.up, true)
    dragging = undefined
  }
  const spacesAtPointer = (clientX: number, lineNumber: number): number => {
    const end = editor.getScrolledVisiblePosition({ lineNumber, column: maxColumn(lineNumber) })
    const node = editor.getDomNode()
    if (!end || !node)
      return 0
    return virtualSpacesAt(clientX - node.getBoundingClientRect().left - end.left, spaceWidth())
  }
  const placeAtPointer = (clientX: number, target: MonacoEditor.IMouseTarget | null, extend: boolean): boolean => {
    const selection = editor.getSelection()
    if (!target || !selection || target.type !== MouseTargetType.CONTENT_EMPTY || !target.position)
      return false
    const line = selection.positionLineNumber
    if (line !== target.position.lineNumber || selection.positionColumn !== maxColumn(line))
      return false
    const spaces = spacesAtPointer(clientX, line)
    const active = { lineNumber: line, column: selection.positionColumn, virtualSpaces: spaces }
    if (spaces === caretSpaces && (extend || anchorSpaces === spaces))
      return true
    const anchor = extend
      ? { lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn, virtualSpaces: anchorSpaces }
      : active
    anchorSpaces = anchor.virtualSpaces
    caretSpaces = spaces
    preferredVisual = spaces > 0 ? caretVisual() : undefined
    changed(true)
    return true
  }
  disposables.push(editor.onMouseDown((event) => {
    stopDragging()
    if (!enabled())
      return
    const browserEvent = event.event.browserEvent
    if (event.event.rightButton) {
      // dnSpy's right button moves the caret as the left one does, unless it lands inside the selection.
      if (editor.getSelection()?.isEmpty() && anchorSpaces === caretSpaces)
        placeAtPointer(browserEvent.clientX, event.target, false)
      return
    }
    if (!event.event.leftButton || browserEvent.detail > 1 || event.event.altKey)
      return
    const extend = event.event.shiftKey
    placeAtPointer(browserEvent.clientX, event.target, extend)
    if (event.target.type !== MouseTargetType.CONTENT_TEXT && event.target.type !== MouseTargetType.CONTENT_EMPTY)
      return
    const move = (moveEvent: MouseEvent): void => {
      if ((moveEvent.buttons & 1) === 0) {
        stopDragging()
        return
      }
      const target = editor.getTargetAtClientPoint(moveEvent.clientX, moveEvent.clientY)
      if (!placeAtPointer(moveEvent.clientX, target, true) && caretSpaces > 0) {
        caretSpaces = 0
        preferredVisual = undefined
        changed(false)
      }
    }
    dragging = { move, up: stopDragging }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', stopDragging, true)
  }))

  disposables.push(editor.onDidScrollChange(() => render()))
  disposables.push(editor.onDidLayoutChange(() => render()))
  disposables.push(editor.onDidChangeConfiguration((event) => {
    if (event.hasChanged(EditorOption.scrollBeyondLastColumn) && !widenedScrolling)
      baseScrollBeyondLastColumn = editor.getOption(EditorOption.scrollBeyondLastColumn)
    render()
  }))
  disposables.push(editor.onDidChangeModelDecorations(() => render()))

  const controller: VirtualSpaceController = {
    virtualSpaces: () => caretSpaces,
    placeCaret: (lineNumber, column) => {
      const model = editor.getModel()
      if (!model)
        return
      const line = Math.min(Math.max(lineNumber, 1), model.getLineCount())
      const end = model.getLineMaxColumn(line)
      const real = { lineNumber: line, column: Math.min(Math.max(column, 1), end), virtualSpaces: enabled() ? Math.max(0, column - end) : 0 }
      setPoints(real, real)
      preferredVisual = real.virtualSpaces > 0 ? caretVisual() : undefined
      changed(true)
    },
    refresh: () => {
      if (!enabled())
        reset()
    },
    dispose: () => {
      stopDragging()
      for (const disposable of disposables)
        disposable.dispose()
      editor.removeOverlayWidget(widget)
      editor.getDomNode()?.style.removeProperty('--virtual-caret-offset')
      controllers.delete(editor)
    },
  }
  controllers.set(editor, controller)
  return controller
}
