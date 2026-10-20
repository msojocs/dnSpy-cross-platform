import { afterEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import {
  appendErrorLog,
  canExportToProject,
  initialExportLanguage,
  isValidProjectGuid,
  loadExportToProjectSettings,
  saveExportToProjectSettings,
} from './export-project'

const node = (id: string, kind: string): TreeNode => ({ id, kind, label: id, hasChildren: false })

afterEach(() => localStorage.clear())

describe('canExportToProject', () => {
  const roots = [node('asm', 'assembly'), node('net', 'module'), node('pe', 'pedocument'), node('elf', 'elfdocument')]
  const parents = { mod: 'asm', ns: 'mod', type: 'ns', peHeaders: 'pe', elfHeader: 'elf', netNs: 'net' }

  it('is enabled for any row of an assembly or of a net module opened on its own', () => {
    expect(canExportToProject([node('asm', 'assembly')], parents, roots)).toBe(true)
    expect(canExportToProject([node('type', 'type')], parents, roots)).toBe(true)
    expect(canExportToProject([node('netNs', 'namespace')], parents, roots)).toBe(true)
  })

  it('is disabled for the rows of files that are no managed module, and for nothing selected', () => {
    expect(canExportToProject([], parents, roots)).toBe(false)
    expect(canExportToProject([node('pe', 'pedocument')], parents, roots)).toBe(false)
    // A PE row has the same kind under a managed module, so it is its root that decides.
    expect(canExportToProject([node('peHeaders', 'pe')], parents, roots)).toBe(false)
    expect(canExportToProject([node('elfHeader', 'elfstructure')], parents, roots)).toBe(false)
  })

  it('is enabled when one of several selected rows names a module', () => {
    expect(canExportToProject([node('pe', 'pedocument'), node('type', 'type')], parents, roots)).toBe(true)
  })

  it('goes by the row\'s own kind when the tree has not listed its ancestors', () => {
    expect(canExportToProject([node('orphan', 'method')], {}, roots)).toBe(true)
    expect(canExportToProject([node('orphan', 'unknowndocument')], {}, roots)).toBe(false)
  })
})

describe('the dialog\'s helpers', () => {
  it('starts on the current language when it can export, and on C# otherwise', () => {
    expect(initialExportLanguage('visualBasic')).toBe('visualBasic')
    expect(initialExportLanguage('cSharp')).toBe('cSharp')
    expect(initialExportLanguage('il')).toBe('cSharp')
    expect(initialExportLanguage('ilWithCSharp')).toBe('cSharp')
  })

  it('reads a project guid the way Guid.TryParse does, and takes an empty box as none', () => {
    expect(isValidProjectGuid('')).toBe(true)
    expect(isValidProjectGuid('11111111-2222-3333-4444-555555555555')).toBe(true)
    expect(isValidProjectGuid('{11111111-2222-3333-4444-555555555555}')).toBe(true)
    expect(isValidProjectGuid('(11111111-2222-3333-4444-555555555555)')).toBe(true)
    expect(isValidProjectGuid('11111111222233334444555555555555')).toBe(true)
    expect(isValidProjectGuid('11111111-2222-3333-4444-55555555555')).toBe(false)
    expect(isValidProjectGuid('not a guid')).toBe(false)
  })

  it('keeps the error log to 8 KiB and marks the cut', () => {
    expect(appendErrorLog('', 'first')).toBe('first\n')
    const full = appendErrorLog('', 'x'.repeat(9000))
    expect(full).toBe(`${'x'.repeat(8192)}[...]`)
    expect(appendErrorLog(full, 'more')).toBe(full)
  })

  it('remembers the project version and the folder, and falls back to VS2010', () => {
    expect(loadExportToProjectSettings()).toEqual({ projectVersion: 'VS2010' })
    saveExportToProjectSettings({ projectVersion: 'VS2019', directory: '/tmp/out' })
    expect(loadExportToProjectSettings()).toEqual({ projectVersion: 'VS2019', directory: '/tmp/out' })
    localStorage.setItem('dnspy.exportToProject.v1', JSON.stringify({ projectVersion: 'VS2003' }))
    expect(loadExportToProjectSettings().projectVersion).toBe('VS2010')
  })
})
