import { describe, expect, it } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { deleteHeader, deletionTargets } from './delete-commands'

const node = (id: string, kind: string, label = id): TreeNode => ({ id, kind, label, hasChildren: false })
const t = (message: string, values?: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ''))

describe('the delete commands', () => {
  it('take the whole selection when it is all of the row\'s kind, else the row alone', () => {
    const a = node('a', 'method'), b = node('b', 'method'), f = node('f', 'field')
    expect(deletionTargets(a, [a, b], {})).toEqual([a, b])
    expect(deletionTargets(a, [a, f], {})).toEqual([a])
    // A row outside the selection is what a menu over another row acts on.
    expect(deletionTargets(f, [a, b], {})).toEqual([f])
  })

  it('leave out a row whose ancestor is selected too, and the global type', () => {
    const outer = node('outer', 'type', 'Outer'), inner = node('inner', 'type', 'Inner'), global = node('g', 'type', '<Module>')
    expect(deletionTargets(outer, [outer, inner, global], { inner: 'outer' })).toEqual([outer])
    expect(deletionTargets(global, [global], {})).toEqual([])
  })

  it('are headed by the one row, or by how many there are', () => {
    const a = node('a', 'type', 'Alpha'), b = node('b', 'type', 'Beta')
    expect(deleteHeader(t, 'type', [a], a)).toBe('Delete Alpha')
    expect(deleteHeader(t, 'type', [a, b], a)).toBe('Delete 2 types')
    expect(deleteHeader(t, 'property', [a, b], a)).toBe('Delete 2 properties')
    expect(deleteHeader(t, 'namespace', [a], a)).toBe('Delete Namespace')
    expect(deleteHeader(t, 'namespace', [a, b], a)).toBe('Delete 2 Namespaces')
    expect(deleteHeader(t, 'resourceentry', [a, b], a)).toBe('Delete 2 resources')
  })
})
