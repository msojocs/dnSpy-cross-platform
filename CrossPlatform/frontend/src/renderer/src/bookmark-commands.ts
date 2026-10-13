import { useAppStore } from './app-store'
import { activeDocumentPosition } from './editor-registry'

// The bookmark commands dnSpy puts on its View menu, its shortcuts and its window's toolbar. They live
// in one place because all three have to agree on the target: "the bookmark at the caret" means the
// caret of the code editor the user last typed in, which only the editor registry knows.

export const toggleBookmarkAtCaret = (): void => {
  const position = activeDocumentPosition()
  if (position)
    useAppStore.getState().toggleBookmark(position.documentId, position.line)
}

export const toggleBookmarkEnabledAtCaret = (): void => {
  const position = activeDocumentPosition()
  if (position)
    useAppStore.getState().toggleBookmarkEnabledAt(position.documentId, position.line)
}

/** Walks the bookmarks: every enabled one, those of the current document, or those sharing a label. */
export const stepBookmark = (direction: 1 | -1, scope: 'all' | 'document' | 'label' = 'all'): void => {
  const state = useAppStore.getState()
  if (scope === 'label') {
    void (direction > 0 ? state.selectNextBookmarkWithSameLabel() : state.selectPreviousBookmarkWithSameLabel())
    return
  }
  const position = activeDocumentPosition()
  if (scope === 'document') {
    if (position)
      void (direction > 0 ? state.selectNextBookmarkInDocument(position.documentId, position.line) : state.selectPreviousBookmarkInDocument(position.documentId, position.line))
    return
  }
  void (direction > 0 ? state.selectNextBookmark(position) : state.selectPreviousBookmark(position))
}

/** Removes every bookmark, the way dnSpy's Clear Bookmarks does — silently, with no confirmation. */
export const clearBookmarks = (): void => useAppStore.getState().clearBookmarks()

/** Removes the bookmarks of the document the user is in, leaving every other one alone. */
export const clearBookmarksInDocument = (): void => {
  const position = activeDocumentPosition()
  if (position)
    useAppStore.getState().removeAllBookmarksInDocument(position.documentId)
}

export const showBookmarksWindow = (): void => useAppStore.getState().openToolWindow?.('bookmarks')

/**
 * A bookmark key chord the way dnSpy's document viewer binds them (`DocumentViewerCommandInfoProvider`): Ctrl+K
 * or Ctrl+B arms it, and the second key runs the command — with Ctrl held, or, where dnSpy binds it that way
 * too, without (`plain`). Ctrl+K Ctrl+E is this port's own, kept beside dnSpy's Ctrl+B Ctrl+E.
 */
export interface BookmarkChord {
  prefix: 'k' | 'b'
  key: string
  plain: boolean
  label: string
  run(): void
}

const previousBookmark = (): void => stepBookmark(-1)
const nextBookmark = (): void => stepBookmark(1)

export const bookmarkChords: BookmarkChord[] = [
  { prefix: 'k', key: 'k', plain: false, label: 'Toggle Bookmark', run: toggleBookmarkAtCaret },
  { prefix: 'k', key: 't', plain: true, label: 'Toggle Bookmark', run: toggleBookmarkAtCaret },
  { prefix: 'b', key: 't', plain: true, label: 'Toggle Bookmark', run: toggleBookmarkAtCaret },
  { prefix: 'k', key: 'p', plain: true, label: 'Previous Bookmark', run: previousBookmark },
  { prefix: 'b', key: 'p', plain: true, label: 'Previous Bookmark', run: previousBookmark },
  { prefix: 'k', key: 'n', plain: true, label: 'Next Bookmark', run: nextBookmark },
  { prefix: 'b', key: 'n', plain: true, label: 'Next Bookmark', run: nextBookmark },
  { prefix: 'k', key: 'l', plain: false, label: 'Clear Bookmarks', run: clearBookmarks },
  { prefix: 'b', key: 'c', plain: true, label: 'Clear Bookmarks', run: clearBookmarks },
  { prefix: 'k', key: 'e', plain: false, label: 'Enable/Disable Bookmark', run: toggleBookmarkEnabledAtCaret },
  { prefix: 'b', key: 'e', plain: true, label: 'Enable/Disable Bookmark', run: toggleBookmarkEnabledAtCaret },
  { prefix: 'k', key: 'w', plain: false, label: 'Bookmarks Window', run: showBookmarksWindow },
]

/** The single keys dnSpy's document viewer adds: F2 and Shift+F2 walk the bookmarks, Ctrl+F2 toggles one,
 * Ctrl+Shift+F2 clears them all. Only the code viewer has them — F2 elsewhere renames. */
export const bookmarkFunctionKeys: { ctrl: boolean; shift: boolean; label: string; run(): void }[] = [
  { ctrl: false, shift: false, label: 'Next Bookmark', run: nextBookmark },
  { ctrl: false, shift: true, label: 'Previous Bookmark', run: previousBookmark },
  { ctrl: true, shift: false, label: 'Toggle Bookmark', run: toggleBookmarkAtCaret },
  { ctrl: true, shift: true, label: 'Clear Bookmarks', run: clearBookmarks },
]
