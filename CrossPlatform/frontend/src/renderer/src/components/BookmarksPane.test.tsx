import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeStatement } from '../../../shared/protocol'
import { statementIdentity, useAppStore } from '../app-store'
import type { Bookmark } from '../app-store'
import { translate } from '../localization'
import { defaultAppOptions, saveAppOptions } from './app-options'
import { BookmarksPane } from './BookmarksPane'

const statement = (startLine: number, ilOffset: number): CodeStatement => ({
  startLine,
  endLine: startLine,
  startColumn: 1,
  endColumn: 80,
  ilOffset,
  ilEndOffset: ilOffset,
  sequencePointIlOffset: ilOffset,
  modulePath: '/app/DebugTarget.dll',
  metadataToken: 0x06000001,
  sourceMethodToken: 0x06000001,
  description: 'System.Void Ns.Type::M()',
  isHidden: false,
})

const bookmark = (extra: Partial<Bookmark> = {}): Bookmark => ({
  id: 'bookmark1',
  kind: 'body',
  nodeId: 'method-1',
  identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 4),
  modulePath: '/app/DebugTarget.dll',
  metadataToken: 0x06000001,
  ilOffset: 4,
  line: 4,
  description: 'System.Void Ns.Type::M()',
  name: 'First',
  labels: [],
  enabled: true,
  order: 1,
  ...extra,
})

const openNodeById = vi.fn(async (nodeId: string) => nodeId)

beforeEach(() => {
  localStorage.clear()
  openNodeById.mockClear()
  useAppStore.setState({
    bookmarks: [
      bookmark({ id: 'b1', order: 1 }),
      bookmark({
        id: 'b2',
        order: 2,
        line: 9,
        ilOffset: 7,
        identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
        labels: ['hot', 'loop'],
      }),
      bookmark({
        id: 'b3',
        order: 3,
        nodeId: 'method-2',
        modulePath: '/app/Other.dll',
        metadataToken: 0x06000003,
        ilOffset: 1,
        identity: statementIdentity('/app/Other.dll', 0x06000003, 1),
        description: 'System.Void Other.Type::N()',
        name: 'Elsewhere',
        enabled: false,
      }),
    ],
    activeBookmarkId: undefined,
    caretReveal: undefined,
    openNodeById,
    documents: {
      'method-1': {
        nodeId: 'method-1',
        title: 'M',
        language: 'csharp',
        text: '',
        spans: [],
        diagnostics: [],
        codeStatements: [statement(4, 4), statement(9, 7)],
        loading: false,
        requestedLanguage: 'cSharp',
      } as never,
    },
  })
})

afterEach(() => {
  cleanup()
})

const pane = (): HTMLElement => {
  const root = document.querySelector('.bookmarks-pane')
  if (!(root instanceof HTMLElement))
    throw new Error('the pane is not rendered')
  return root
}

const rows = (): HTMLElement[] => [...pane().querySelectorAll<HTMLElement>('.bookmark-row')]

const cellOf = (rowText: string, column: 'location' | 'module'): string =>
  rowFor(rowText).querySelector(`.bookmark-${column}-cell`)?.textContent ?? ''

const rowFor = (name: string): HTMLElement => {
  const row = rows().find((candidate) => candidate.textContent?.includes(name))
  if (!row)
    throw new Error(`no row for ${name}`)
  return row
}

describe('BookmarksPane', () => {
  it('lists every bookmark with its four columns', () => {
    render(<BookmarksPane />)

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Name', 'Labels', 'Location', 'Module'])
    expect(rows()).toHaveLength(3)
    expect(rowFor('First')).toBeVisible()
    expect(screen.getByText('hot, loop')).toBeVisible()
    // Until the backend has written the Location column, the member stored with the bookmark stands in, with
    // the token in front and the offset in hex — dnSpy's "+ 0x0007".
    expect(cellOf('hot, loop', 'location')).toBe('0x06000001 System.Void Ns.Type::M() + 0x0007')
    // The Module column is the whole path, the way dnSpy's WriteFilename writes it.
    expect(cellOf('Elsewhere', 'module')).toBe('/app/Other.dll')
    expect(screen.getByText(translate('{count} bookmark(s)', { count: 3 }))).toBeVisible()
  })

  it('writes the Location column the backend formats, with the display options, and searches it', async () => {
    const formatBookmarkLocations = vi.fn(async (_workspaceId: string | undefined, locations: { ilOffset?: number | null }[]) => locations.map((location) => ({
      parts: [{ text: 'void', color: 'keyword' }, { text: ` Type.M() + 0x${(location.ilOffset ?? 0).toString(16).padStart(4, '0')}`, color: 'text' }],
      resolved: true,
    })))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, formatBookmarkLocations } })
    try {
      render(<BookmarksPane />)

      await vi.waitFor(() => expect(cellOf('hot, loop', 'location')).toBe('void Type.M() + 0x0007'))
      // One question per location, in the shape dnSpy's display settings have by default.
      expect(formatBookmarkLocations).toHaveBeenCalledWith(undefined, expect.arrayContaining([{ modulePath: '/app/Other.dll', metadataToken: 0x06000003, ilOffset: 1 }]), expect.objectContaining({ showTokens: true, showModuleNames: false, showNamespaces: false }))
      // The keyword wears its color while syntax highlighting is on.
      expect(rowFor('First').querySelector('.bookmark-location-cell .tc-keyword')?.textContent).toBe('void')

      // `o:` searches what the column shows, not what was stored.
      fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'o:0x0007' } })
      expect(rows()).toHaveLength(1)
    } finally {
      Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, formatBookmarkLocations: undefined } })
    }
  })

  it('drops the colors when the options page turns syntax highlighting off', () => {
    render(<BookmarksPane />)
    expect(rowFor('Elsewhere').querySelector('.bookmark-module-cell .tc-fileExtension')?.textContent).toBe('dll')
    expect(rowFor('Elsewhere').querySelector('.tc-bookmarkName')).not.toBeNull()

    act(() => saveAppOptions({ ...defaultAppOptions, bookmarks: { ...defaultAppOptions.bookmarks, syntaxHighlight: false } }))

    expect(pane().querySelector('[class^="tc-"], [class*=" tc-"]')).toBeNull()
    expect(cellOf('Elsewhere', 'module')).toBe('/app/Other.dll')
    // The options snapshot outlives the test; the next one starts from the defaults again.
    act(() => saveAppOptions(defaultAppOptions))
  })

  it('sorts by a column header, the other way round, and back to the order they were made', () => {
    render(<BookmarksPane />)
    const names = (): string[] => rows().map((row) => row.querySelector('.bookmark-name-cell span')?.textContent ?? '')
    const header = screen.getByRole('columnheader', { name: /^Name/ })

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(names()).toEqual(['Elsewhere', 'First', 'First'])

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(names()).toEqual(['First', 'First', 'Elsewhere'])

    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'none')
    expect(rows().map((row) => row.textContent?.includes('hot, loop'))).toEqual([false, true, false])
  })

  it('checks off an enabled bookmark and re-enables a disabled one from its checkbox', () => {
    const { container } = render(<BookmarksPane />)
    expect(container.querySelectorAll('.bookmark-disabled')).toHaveLength(1)

    fireEvent.click(within(rowFor('First')).getByRole('checkbox'))

    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b1')?.enabled).toBe(false)
    expect(container.querySelectorAll('.bookmark-disabled')).toHaveLength(2)

    fireEvent.click(within(rowFor('Elsewhere')).getByRole('checkbox'))
    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b3')?.enabled).toBe(true)
  })

  it('filters the rows with the search box and reports what it hid', () => {
    render(<BookmarksPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'l:loop' } })

    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('hot, loop')])
    expect(screen.getByText(translate('{count} filtered out', { count: 2 }))).toBeVisible()
    expect(screen.getByText(translate('{count} bookmark(s)', { count: 1 }))).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Reset Search' }))
    expect(rows()).toHaveLength(3)
  })

  it('goes to the bookmark under a double click', async () => {
    render(<BookmarksPane />)

    fireEvent.doubleClick(rowFor('First'))

    expect(useAppStore.getState().activeBookmarkId).toBe('b1')
    await vi.waitFor(() => expect(useAppStore.getState().caretReveal).toMatchObject({ documentId: 'method-1', line: 4, column: 1 }))
    expect(openNodeById).toHaveBeenCalledWith('method-1')
  })

  it('keeps the go-to button disabled until a row is picked', () => {
    render(<BookmarksPane />)
    const goTo = screen.getByRole('button', { name: 'Go To' })
    expect(goTo).toBeDisabled()

    fireEvent.mouseDown(rowFor('First'))
    expect(goTo).toBeEnabled()

    fireEvent.click(goTo)
    expect(useAppStore.getState().activeBookmarkId).toBe('b1')
  })

  it('removes the selected rows with Delete', () => {
    render(<BookmarksPane />)

    fireEvent.mouseDown(rowFor('First'))
    fireEvent.keyDown(pane(), { key: 'Delete' })

    expect(useAppStore.getState().bookmarks.map((item) => item.id)).toEqual(['b2', 'b3'])
  })

  it('renames a row in place with F2', () => {
    render(<BookmarksPane />)

    fireEvent.mouseDown(rowFor('First'))
    fireEvent.keyDown(pane(), { key: 'F2' })

    const input = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(input, { target: { value: 'Loop head' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b1')?.name).toBe('Loop head')
    expect(rowFor('Loop head')).toBeVisible()
  })

  it('turns every row in view off from the footer, and back on again', () => {
    render(<BookmarksPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable/Disable Matching Bookmarks' }))
    expect(useAppStore.getState().bookmarks.every((item) => !item.enabled)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Enable/Disable Matching Bookmarks' }))
    expect(useAppStore.getState().bookmarks.every((item) => item.enabled)).toBe(true)
  })

  it('goes to the bookmark in a tab of its own on a Shift or Ctrl double click', async () => {
    const openNodeInNewTabById = vi.fn(async (nodeId: string) => nodeId)
    useAppStore.setState({ openNodeInNewTabById })
    render(<BookmarksPane />)

    fireEvent.doubleClick(rowFor('First'), { shiftKey: true })

    await vi.waitFor(() => expect(openNodeInNewTabById).toHaveBeenCalledWith('method-1'))
    expect(openNodeById).not.toHaveBeenCalled()
  })

  it('switches the selection with Space and edits its labels with Ctrl+2', () => {
    render(<BookmarksPane />)

    fireEvent.mouseDown(rowFor('hot, loop'))
    fireEvent.keyDown(pane(), { key: ' ' })
    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b2')?.enabled).toBe(false)
    fireEvent.keyDown(pane(), { key: ' ' })
    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b2')?.enabled).toBe(true)

    fireEvent.keyDown(pane(), { key: '2', ctrlKey: true })
    const input = screen.getByRole('textbox', { name: 'Labels' })
    fireEvent.change(input, { target: { value: 'cold' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useAppStore.getState().bookmarks.find((item) => item.id === 'b2')?.labels).toEqual(['cold'])
  })

  it('exports dnSpy\'s bookmark file and reads one back', async () => {
    const exportBookmarks = vi.fn(async () => '<settings />')
    const saveCode = vi.fn(async () => '/tmp/bookmarks.xml')
    const readTextFile = vi.fn(async () => '<?xml version="1.0"?><settings />')
    const importBookmarks = vi.fn(async () => ({
      bookmarks: [
        { modulePath: '/app/Third.dll', metadataToken: 0x02000004, ilOffset: null, name: 'Type', labels: ['x'], enabled: true, description: 'Ns.Third' },
        { modulePath: '/app/Other.dll', metadataToken: 0x06000003, ilOffset: 1, name: 'Again', labels: [], enabled: true, description: null },
      ],
      skipped: 1,
    }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, exportBookmarks, saveCode, readTextFile, importBookmarks } })
    render(<BookmarksPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Export Bookmarks' }))
    await vi.waitFor(() => expect(saveCode).toHaveBeenCalledWith('bookmarks.xml', '<settings />'))
    // Every row in view, in the order they were made, the way dnSpy's file lists them.
    expect(exportBookmarks).toHaveBeenCalledWith(undefined, [
      expect.objectContaining({ modulePath: '/app/DebugTarget.dll', ilOffset: 4, name: 'First' }),
      expect.objectContaining({ modulePath: '/app/DebugTarget.dll', ilOffset: 7, labels: ['hot', 'loop'] }),
      expect.objectContaining({ modulePath: '/app/Other.dll', ilOffset: 1, enabled: false }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Import Bookmarks' }))
    await vi.waitFor(() => expect(screen.getByText(translate('Imported {count} bookmark(s); skipped {skipped} the file cannot place.', { count: 1, skipped: 1 }))).toBeVisible())
    // The definition is new; the body location is one the list already holds.
    expect(useAppStore.getState().bookmarks.at(-1)).toMatchObject({ kind: 'token', modulePath: '/app/Third.dll', metadataToken: 0x02000004, name: 'Type', labels: ['x'], description: 'Ns.Third' })
  })

  it('removes only the rows the filter left in view', () => {
    render(<BookmarksPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'm:other.dll' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Matching Bookmarks' }))

    expect(useAppStore.getState().bookmarks.map((item) => item.id)).toEqual(['b1', 'b2'])
  })
})
