import { describe, expect, it } from 'vitest'
import type { GacAssemblyDto } from '../../../shared/protocol'
import { filterGacRows, gacRowsOf } from './OpenFromGacDialog'

const file = (name: string, version: string, path: string, culture = ''): GacAssemblyDto =>
  ({ name, version, culture, publicKeyToken: 'b77a5c561934e089', path })

describe('the Open from GAC list', () => {
  it('sorts by name and then version part by part, and marks the second copy of an assembly a duplicate', () => {
    // The .NET 4 cache comes first, so its copy is the one that stays; culture is not part of the identity.
    const rows = gacRowsOf([
      file('System', '4.0.0.0', '/gac4/System.dll'),
      file('Accessibility', '10.0.0.0', '/gac4/Accessibility10.dll'),
      file('Accessibility', '9.0.0.0', '/gac4/Accessibility9.dll'),
      file('System', '4.0.0.0', '/gac2/System.dll', 'en'),
    ])
    expect(rows.map((row) => [row.path, row.isDuplicate])).toEqual([
      ['/gac4/Accessibility9.dll', false],
      ['/gac4/Accessibility10.dll', false],
      ['/gac4/System.dll', false],
      ['/gac2/System.dll', true],
    ])
  })

  it('hides duplicates unless asked for, and keeps a row only when every word is in its name or version', () => {
    const rows = gacRowsOf([
      file('System.Xml', '4.0.0.0', '/a'),
      file('System.Core', '3.5.0.0', '/b'),
      file('System.Xml', '4.0.0.0', '/c'),
    ])
    expect(filterGacRows(rows, '', false).map((row) => row.path)).toEqual(['/b', '/a'])
    expect(filterGacRows(rows, '', true).map((row) => row.path)).toEqual(['/b', '/a', '/c'])
    expect(filterGacRows(rows, 'xml  4.0', false).map((row) => row.path)).toEqual(['/a'])
    expect(filterGacRows(rows, 'CORE 4.0', false)).toEqual([])
  })
})
