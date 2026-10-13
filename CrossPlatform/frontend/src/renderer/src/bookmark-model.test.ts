import { describe, expect, it } from 'vitest'
import { statementIdentity } from './app-store'
import type { Bookmark } from './app-store'
import { bookmarkLocationParts, bookmarksCopyText, fallbackBookmarkLocation, formatIlOffset, modulePathParts, nextBookmarkSort, partsText } from './bookmark-model'

const bookmark = (extra: Partial<Bookmark> = {}): Bookmark => ({
  id: 'b1',
  kind: 'body',
  nodeId: 'n1',
  identity: statementIdentity('/app/A.dll', 0x06000001, 0x12),
  modulePath: '/app/A.dll',
  metadataToken: 0x06000001,
  ilOffset: 0x12,
  line: 3,
  description: 'System.Void Ns.Type::M()',
  name: 'Bookmark 1',
  labels: [],
  enabled: true,
  order: 1,
  ...extra,
})

describe('the Bookmarks window columns', () => {
  it('cycles a column through up, down and unsorted, and starts over on another column', () => {
    const up = nextBookmarkSort(undefined, 'name')
    expect(up).toEqual({ column: 'name', descending: false })
    const down = nextBookmarkSort(up, 'name')
    expect(down).toEqual({ column: 'name', descending: true })
    expect(nextBookmarkSort(down, 'name')).toBeUndefined()
    expect(nextBookmarkSort(down, 'module')).toEqual({ column: 'module', descending: false })
  })

  it('writes an IL offset in four digits until it needs eight', () => {
    expect(formatIlOffset(7)).toBe('0x0007')
    expect(formatIlOffset(0x12345)).toBe('0x00012345')
  })

  it('stands the stored member in for a location the backend could not write', () => {
    expect(partsText(fallbackBookmarkLocation(bookmark(), true))).toBe('0x06000001 System.Void Ns.Type::M() + 0x0012')
    expect(partsText(fallbackBookmarkLocation(bookmark(), false))).toBe('System.Void Ns.Type::M() + 0x0012')
    // A definition has no offset, and without a stored member there is only the token — dnSpy's own fallback.
    expect(partsText(fallbackBookmarkLocation(bookmark({ kind: 'token', description: '' }), false))).toBe('0x06000001')
    expect(fallbackBookmarkLocation(bookmark({ kind: 'line' }), true)).toEqual([])
  })

  it('prefers what the backend wrote, unless it could only write the token of a bookmark that knows more', () => {
    const written = { parts: [{ text: 'void Type.M() + 0x0012', color: 'text' }], resolved: true }
    expect(partsText(bookmarkLocationParts(bookmark(), written, true))).toBe('void Type.M() + 0x0012')
    const unresolved = { parts: [{ text: '0x06000001 ???', color: 'text' }], resolved: false }
    expect(partsText(bookmarkLocationParts(bookmark(), unresolved, true))).toBe('0x06000001 System.Void Ns.Type::M() + 0x0012')
    expect(partsText(bookmarkLocationParts(bookmark({ description: '' }), unresolved, true))).toBe('0x06000001 ???')
  })

  it('splits a module path into the parts WriteFilename colors, keeping its separators', () => {
    expect(modulePathParts('/app/bin/A.Core.dll')).toEqual([
      { text: '/', color: 'text' },
      { text: 'app', color: 'directoryPart' },
      { text: '/', color: 'text' },
      { text: 'bin', color: 'directoryPart' },
      { text: '/', color: 'text' },
      { text: 'A.Core', color: 'fileNameNoExtension' },
      { text: '.', color: 'text' },
      { text: 'dll', color: 'fileExtension' },
    ])
    expect(partsText(modulePathParts('C:\\dnSpy\\Test.exe'))).toBe('C:\\dnSpy\\Test.exe')
  })

  it('copies a row per line, its cells separated by tabs', () => {
    expect(bookmarksCopyText([
      { name: 'Bookmark 1', labels: 'a, b', location: 'void Type.M() + 0x0012', module: '/app/A.dll' },
      { name: 'Bookmark 2', labels: '', location: '', module: '' },
    ])).toBe('Bookmark 1\ta, b\tvoid Type.M() + 0x0012\t/app/A.dll\nBookmark 2\t\t\t\n')
  })
})
