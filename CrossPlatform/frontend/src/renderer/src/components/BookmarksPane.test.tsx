import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeStatement } from '../../../shared/protocol'
import { statementIdentity, useAppStore } from '../app-store'
import type { Bookmark } from '../app-store'
import { translate } from '../localization'
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
    // The location reads the way dnSpy's does, with the offset in hex.
    expect(screen.getByText('System.Void Ns.Type::M(): IL_0007')).toBeVisible()
    // Only the file name of the module fits in the column.
    expect(screen.getByText('Other.dll')).toBeVisible()
    expect(screen.getByText(translate('{count} bookmark(s)', { count: 3 }))).toBeVisible()
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

  it('removes only the rows the filter left in view', () => {
    render(<BookmarksPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search bookmarks' }), { target: { value: 'm:other.dll' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Matching Bookmarks' }))

    expect(useAppStore.getState().bookmarks.map((item) => item.id)).toEqual(['b1', 'b2'])
  })
})
