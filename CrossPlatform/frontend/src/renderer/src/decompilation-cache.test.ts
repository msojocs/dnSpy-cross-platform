import { describe, expect, it } from 'vitest'
import type { DecompileResponse, TreeNode } from '../../shared/protocol'
import { DecompilationCache, OLD_ITEM_MS } from './decompilation-cache'
import { decompilerRefreshOf, settingsKeyOf } from './decompiler-settings'
import { documentIdOf, documentShowsNode, nodeIdsOfDocument, topLevelSelection } from './document-ids'
import { loadAppOptions } from './components/app-options'

const document = (extra: Partial<DecompileResponse> = {}): DecompileResponse => ({ title: 'T', language: 'csharp', text: '', spans: [], diagnostics: [], ...extra })

describe('DecompilationCache', () => {
  it('drops what nothing asked for in five minutes, and keeps what was hit', () => {
    let now = 0
    const cache = new DecompilationCache(() => now)
    cache.cache('old', document(), { roots: ['r'] })
    cache.cache('used', document(), { roots: ['r'] })
    now = OLD_ITEM_MS
    expect(cache.lookup('used')).toBeDefined()
    now = OLD_ITEM_MS + 1
    cache.clearOld()
    expect(cache.lookup('old')).toBeUndefined()
    expect(cache.lookup('used')).toBeDefined()
    cache.clearAll()
  })

  it('forgets the documents of modified modules and the documents that refer into them', () => {
    const cache = new DecompilationCache()
    cache.cache('in-a', document(), { roots: ['a'] })
    cache.cache('in-b', document(), { roots: ['b'] })
    cache.cache('refers-to-a', document({ spans: [{ start: 0, length: 1, kind: 'reference', targetNodeId: 'n-a' }] }), { roots: ['c'] })
    cache.cache('refers-to-a-file', document({ spans: [{ start: 0, length: 1, kind: 'definition', targetModulePath: '/a.dll', targetMetadataToken: 1 }] }), { roots: ['c'] })
    cache.cache('unknown', document(), { roots: undefined })

    cache.clearModules({ roots: new Set(['a']), modulePaths: new Set(['/a.dll']), rootOf: (nodeId) => nodeId === 'n-a' ? 'a' : undefined })

    expect(cache.lookup('in-a')).toBeUndefined()
    expect(cache.lookup('refers-to-a')).toBeUndefined()
    expect(cache.lookup('refers-to-a-file')).toBeUndefined()
    expect(cache.lookup('unknown')).toBeUndefined()
    expect(cache.lookup('in-b')).toBeDefined()
    cache.clearAll()
  })

  it('keys a document by workspace, language, nodes and settings', () => {
    expect(DecompilationCache.keyOf('w', 'cSharp', ['n1'], 's')).not.toBe(DecompilationCache.keyOf('w', 'il', ['n1'], 's'))
    expect(DecompilationCache.keyOf('w', 'cSharp', ['n1', 'n2'], 's')).not.toBe(DecompilationCache.keyOf('w', 'cSharp', ['n2', 'n1'], 's'))
    expect(DecompilationCache.keyOf('w', 'cSharp', ['n1'], 's')).not.toBe(DecompilationCache.keyOf('v', 'cSharp', ['n1'], 's'))
  })
})

describe('decompiler settings', () => {
  it('refreshes the languages DecompilerAppSettingsModifiedListener names for each page', () => {
    const before = loadAppOptions()
    const cSharp = { ...before, decompiler: { ...before.decompiler, cSharp: { ...before.decompiler.cSharp, sortMembers: !before.decompiler.cSharp.sortMembers } } }
    expect([...decompilerRefreshOf(before, cSharp).languages].sort()).toEqual(['cSharp', 'ilWithCSharp', 'visualBasic'])
    const il = { ...before, decompiler: { ...before.decompiler, il: { ...before.decompiler.il, showILBytes: !before.decompiler.il.showILBytes } } }
    expect([...decompilerRefreshOf(before, il).languages].sort()).toEqual(['il', 'ilWithCSharp'])
    const baml = { ...before, baml: { ...before.baml, useTabs: !before.baml.useTabs } }
    expect(decompilerRefreshOf(before, baml)).toEqual({ languages: new Set(), baml: true })
  })

  it('keys C# and Visual Basic by the C# page and IL by the IL page', () => {
    const before = loadAppOptions()
    const il = { ...before, decompiler: { ...before.decompiler, il: { ...before.decompiler.il, showILBytes: !before.decompiler.il.showILBytes } } }
    expect(settingsKeyOf('cSharp', il)).toBe(settingsKeyOf('cSharp', before))
    expect(settingsKeyOf('visualBasic', il)).toBe(settingsKeyOf('visualBasic', before))
    expect(settingsKeyOf('il', il)).not.toBe(settingsKeyOf('il', before))
    expect(settingsKeyOf('ilWithCSharp', il)).not.toBe(settingsKeyOf('ilWithCSharp', before))
  })
})

describe('document ids', () => {
  it('keeps the id of a one-node document and joins the nodes of several', () => {
    expect(documentIdOf(['n1'])).toBe('n1')
    expect(documentIdOf(['n1', 'n2'])).toBe('n1+n2')
    expect(nodeIdsOfDocument('n1+n2')).toEqual(['n1', 'n2'])
    expect(documentShowsNode('n1+n2', 'n2')).toBe(true)
    expect(documentShowsNode('n12', 'n1')).toBe(false)
  })

  it('leaves out the rows under another selected row, in the order they were selected', () => {
    const row = (id: string): TreeNode => ({ id, kind: 'type', label: id, hasChildren: false })
    const parents = { m: 't', t: 'ns', other: 'ns' }
    expect(topLevelSelection([row('other'), row('m'), row('t')], parents).map((node) => node.id)).toEqual(['other', 't'])
    expect(topLevelSelection([row('m'), row('ns')], parents).map((node) => node.id)).toEqual(['ns'])
  })
})
