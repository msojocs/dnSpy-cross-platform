/**
 * The hex view's keyboard: dnSpy's `DefaultHexEditorCommandInfoProvider`, the hex `CommandInfoProvider`
 * and the standard commands of `DefaultCommandInfoProvider` the view answers (copy, paste, find), each key or
 * two-key chord mapped to the command it runs.
 */

export type HexCommand =
  | 'left' | 'leftExt' | 'right' | 'rightExt' | 'up' | 'upExt' | 'down' | 'downExt'
  | 'pageUp' | 'pageUpExt' | 'pageDown' | 'pageDownExt'
  | 'bol' | 'bolExt' | 'eol' | 'eolExt' | 'home' | 'homeExt' | 'end' | 'endExt'
  | 'topLine' | 'topLineExt' | 'bottomLine' | 'bottomLineExt' | 'scrollUp' | 'scrollDown'
  | 'wordNext' | 'wordNextExt' | 'wordPrev' | 'wordPrevExt'
  | 'selectAll' | 'selectCurrentWord' | 'swapAnchor' | 'tab' | 'cancel' | 'delete'
  | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'quickInfo'
  | 'copyText' | 'copyUtf8String' | 'copyUnicodeString' | 'copyCSharpArray' | 'copyVisualBasicArray' | 'copyOffset' | 'copyValue'
  | 'copyUInt32' | 'copyFileOffset' | 'copyAbsoluteFileOffset' | 'copyRva'
  | 'pasteUtf8String' | 'pasteUtf8StringLength' | 'pasteUnicodeString' | 'pasteUnicodeStringLength' | 'pasteBlob'
  | 'showAllBytes' | 'showOnlySelectedBytes' | 'refresh'
  | 'moveToNextValidStartEnd' | 'moveToNextValidStartEndExt' | 'moveToPreviousValidStartEnd' | 'moveToPreviousValidStartEndExt'
  | 'goToCodeOrStructure' | 'followFieldValueReference' | 'selectNestedFile' | 'selectFile' | 'selectStructure'
  | 'goToPosition' | 'goToMetadata' | 'select' | 'saveSelection' | 'toggleUseRelativePositions'
  | 'copy' | 'paste' | 'cut' | 'find' | 'replace' | 'incrementalSearchForward' | 'incrementalSearchBackward'
  | 'findNext' | 'findPrevious' | 'findNextSelected' | 'findPreviousSelected'
  | 'backspace' | 'return'

/** The first key of a two-key chord: Ctrl+E (selections) or Ctrl+K (paste with a length, Quick Info). */
export type HexChordPrefix = 'e' | 'k'

interface Modifiers { ctrl: boolean; shift: boolean; alt: boolean }

const modifiersOf = (event: KeyboardEvent | React.KeyboardEvent): Modifiers => ({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, alt: event.altKey })

const is = (m: Modifiers, ctrl: boolean, shift: boolean, alt: boolean): boolean => m.ctrl === ctrl && m.shift === shift && m.alt === alt

/** The second key of a chord, or undefined when it completes none. */
export function hexChordCommand(prefix: HexChordPrefix, event: KeyboardEvent | React.KeyboardEvent): HexCommand | undefined {
  const m = modifiersOf(event)
  if (m.shift || m.alt)
    return undefined
  const code = event.code
  if (prefix === 'e') {
    if (code === 'KeyA') return 'swapAnchor'
    if (m.ctrl && code === 'KeyN') return 'selectNestedFile'
    if (m.ctrl && code === 'KeyF') return 'selectFile'
    if (m.ctrl && code === 'KeyS') return 'selectStructure'
    return undefined
  }
  if (code === 'KeyI') return 'quickInfo'
  if (code === 'Digit8' || code === 'Numpad8') return 'pasteUtf8StringLength'
  if (code === 'KeyU') return 'pasteUnicodeStringLength'
  return undefined
}

/** Whether a key starts a chord. */
export function hexChordPrefix(event: KeyboardEvent | React.KeyboardEvent): HexChordPrefix | undefined {
  const m = modifiersOf(event)
  if (!is(m, true, false, false))
    return undefined
  return event.code === 'KeyE' ? 'e' : event.code === 'KeyK' ? 'k' : undefined
}

/** The command a single key runs in the hex view, or undefined when the view leaves the key alone. */
export function hexKeyCommand(event: KeyboardEvent | React.KeyboardEvent): HexCommand | undefined {
  const m = modifiersOf(event)
  const key = event.key
  const code = event.code
  const plain = is(m, false, false, false)
  const shift = is(m, false, true, false)
  const ctrl = is(m, true, false, false)
  const ctrlShift = is(m, true, true, false)
  const ctrlAlt = is(m, true, false, true)
  const alt = is(m, false, false, true)
  const shiftAlt = is(m, false, true, true)
  switch (key) {
    case 'Backspace': return plain || shift ? 'backspace' : undefined
    case 'Tab': return plain ? 'tab' : undefined
    case 'Escape': return plain ? 'cancel' : undefined
    case 'Delete': return plain ? 'delete' : shift ? 'cut' : undefined
    case 'Enter': return plain ? 'return' : undefined
    case 'Insert': return ctrl ? 'copy' : shift ? 'paste' : undefined
    case 'ArrowLeft': return plain ? 'left' : shift ? 'leftExt' : ctrl ? 'wordPrev' : ctrlShift ? 'wordPrevExt' : undefined
    case 'ArrowRight': return plain ? 'right' : shift ? 'rightExt' : ctrl ? 'wordNext' : ctrlShift ? 'wordNextExt' : undefined
    case 'ArrowUp': return plain ? 'up' : shift ? 'upExt' : ctrl ? 'scrollUp' : alt ? 'moveToPreviousValidStartEnd' : shiftAlt ? 'moveToPreviousValidStartEndExt' : undefined
    case 'ArrowDown': return plain ? 'down' : shift ? 'downExt' : ctrl ? 'scrollDown' : alt ? 'moveToNextValidStartEnd' : shiftAlt ? 'moveToNextValidStartEndExt' : undefined
    case 'PageUp': return plain ? 'pageUp' : shift ? 'pageUpExt' : ctrl ? 'topLine' : ctrlShift ? 'topLineExt' : undefined
    case 'PageDown': return plain ? 'pageDown' : shift ? 'pageDownExt' : ctrl ? 'bottomLine' : ctrlShift ? 'bottomLineExt' : undefined
    case 'Home': return plain ? 'bol' : shift ? 'bolExt' : ctrl ? 'home' : ctrlShift ? 'homeExt' : undefined
    case 'End': return plain ? 'eol' : shift ? 'eolExt' : ctrl ? 'end' : ctrlShift ? 'endExt' : undefined
    case 'F3': return plain ? 'findNext' : shift ? 'findPrevious' : ctrl ? 'findNextSelected' : ctrlShift ? 'findPreviousSelected' : undefined
    case 'F5': return plain ? 'refresh' : undefined
    case 'F12': return plain ? 'goToCodeOrStructure' : ctrl ? 'followFieldValueReference' : undefined
    default: break
  }
  if (ctrl) {
    switch (code) {
      case 'KeyA': return 'selectAll'
      case 'KeyW': return 'selectCurrentWord'
      case 'KeyC': return 'copy'
      case 'KeyV': return 'paste'
      case 'KeyX': return 'cut'
      case 'KeyF': return 'find'
      case 'KeyH': return 'replace'
      case 'KeyI': return 'incrementalSearchForward'
      case 'KeyG': return 'goToPosition'
      case 'KeyM': return 'goToMetadata'
      case 'KeyL': return 'select'
      case 'KeyR': return 'toggleUseRelativePositions'
      case 'KeyU': return 'pasteUnicodeString'
      case 'KeyB': return 'pasteBlob'
      case 'KeyD': return 'showOnlySelectedBytes'
      case 'Digit8': return 'pasteUtf8String'
      case 'Equal': case 'NumpadAdd': return 'zoomIn'
      case 'Minus': case 'NumpadSubtract': return 'zoomOut'
      case 'Digit0': case 'Numpad0': return 'zoomReset'
      default: return undefined
    }
  }
  if (ctrlShift) {
    switch (code) {
      case 'KeyW': return 'selectCurrentWord'
      case 'KeyI': return 'incrementalSearchBackward'
      case 'KeyC': return 'copyText'
      case 'Digit8': return 'copyUtf8String'
      case 'KeyU': return 'copyUnicodeString'
      case 'KeyH': return 'copyCSharpArray'
      case 'KeyB': return 'copyVisualBasicArray'
      case 'KeyV': return 'copyValue'
      case 'KeyQ': return 'copyUInt32'
      case 'KeyO': return 'copyFileOffset'
      // dnSpy binds Ctrl+Shift+A to Copy Absolute Offset first and Select All Bytes Block second; the first wins.
      case 'KeyA': return 'copyAbsoluteFileOffset'
      case 'KeyR': return 'copyRva'
      case 'KeyD': return 'showAllBytes'
      case 'Period': return 'zoomIn'
      case 'Comma': return 'zoomOut'
      default: return undefined
    }
  }
  if (ctrlAlt) {
    switch (code) {
      case 'KeyO': return 'copyOffset'
      case 'KeyS': return 'saveSelection'
      default: return undefined
    }
  }
  return undefined
}
