import { afterEach, describe, expect, it } from 'vitest'
import {
  applyDocumentListChanges,
  DEFAULT_LIST_NAME,
  documentListRows,
  filterDocumentListRows,
  loadDocumentLists,
  rememberCurrentDocuments,
  saveDocumentLists,
} from './document-lists'

afterEach(() => localStorage.clear())

describe('the Open List lists', () => {
  it('starts with the default list, and keeps the open files in whichever list is selected', () => {
    expect(loadDocumentLists()).toEqual({ selected: DEFAULT_LIST_NAME, lists: [{ name: DEFAULT_LIST_NAME, files: [] }] })
    rememberCurrentDocuments(['/a.dll', '/b.dll'])
    expect(loadDocumentLists().lists).toEqual([{ name: DEFAULT_LIST_NAME, files: ['/a.dll', '/b.dll'] }])

    saveDocumentLists({ selected: 'Work', lists: [{ name: DEFAULT_LIST_NAME, files: ['/a.dll'] }, { name: 'Work', files: [] }] })
    rememberCurrentDocuments(['/c.dll'])
    expect(loadDocumentLists().lists).toEqual([{ name: DEFAULT_LIST_NAME, files: ['/a.dll'] }, { name: 'Work', files: ['/c.dll'] }])
  })

  it('reads a damaged store as the default list, and a name saved twice once', () => {
    localStorage.setItem('dnspy.documentLists.v1', '{not json')
    expect(loadDocumentLists().lists.map((list) => list.name)).toEqual([DEFAULT_LIST_NAME])
    localStorage.setItem('dnspy.documentLists.v1', JSON.stringify({ selected: 'Gone', lists: [{ name: 'A', files: [] }, { name: 'A', files: ['/x'] }, { name: 3 }] }))
    expect(loadDocumentLists()).toEqual({ selected: 'A', lists: [{ name: 'A', files: [] }] })
  })

  it('offers each list the machine has that no saved list is named after, all sorted by name', () => {
    const rows = documentListRows(
      [{ name: 'zeta', files: [] }, { name: 'Microsoft.NETCore.App 10.0.2 (x64)', files: ['/mine'] }],
      [{ name: 'microsoft.netcore.app 10.0.2 (x64)', files: ['/theirs'] }, { name: 'Microsoft.AspNetCore.App 10.0.2 (x64)', files: ['/asp'] }],
    )
    expect(rows.map((row) => [row.list.name, row.isUserList])).toEqual([
      ['Microsoft.AspNetCore.App 10.0.2 (x64)', false],
      ['Microsoft.NETCore.App 10.0.2 (x64)', true],
      ['zeta', true],
    ])
    expect(filterDocumentListRows(rows, '', true).map((row) => row.list.name)).toEqual(['Microsoft.NETCore.App 10.0.2 (x64)', 'zeta'])
    expect(filterDocumentListRows(rows, 'app asp', false).map((row) => row.list.name)).toEqual(['Microsoft.AspNetCore.App 10.0.2 (x64)'])
  })

  it('saves what OK chose: the chosen list selected, the removed ones gone but never the selected one', () => {
    const stored = { selected: 'A', lists: [{ name: 'A', files: ['/a'] }, { name: 'B', files: ['/b'] }] }
    const framework = { name: 'Microsoft.NETCore.App 10.0.2 (x64)', files: ['/f'] }
    expect(applyDocumentListChanges(stored, ['B'], [{ name: 'New', files: [] }], framework)).toEqual({
      selected: framework.name,
      lists: [{ name: 'A', files: ['/a'] }, framework, { name: 'New', files: [] }],
    })
    // Removing the list that is chosen leaves it, the way DocumentListService.Remove refuses the selected one.
    expect(applyDocumentListChanges(stored, ['A'], [], undefined)).toEqual(stored)
  })
})
