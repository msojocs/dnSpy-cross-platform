import { describe, expect, it, vi } from 'vitest'
import type { AnalyzerNode } from '../../../shared/protocol'
import type { AnalyzerRow } from '../analyzer-model'
import { buildAnalyzerMenuItems, type AnalyzerMenuContext } from './AnalyzerContextMenu'

const row = (key: string, extra: Partial<AnalyzerNode> = {}): AnalyzerRow => ({
  key,
  node: {
    kind: 'method',
    label: 'NS.Type.M() : void',
    hasChildren: true,
    nodeId: `node-${key}`,
    metadataToken: 0x06000012,
    fullName: 'System.Void NS.Type::M()',
    isSetter: false,
    hidesParent: false,
    isPublic: true,
    ...extra,
  },
})

const context = (selection: AnalyzerRow[], extra: Partial<AnalyzerMenuContext> = {}): AnalyzerMenuContext => ({
  t: (message) => message,
  selection,
  isRoot: (key) => key.startsWith('root'),
  showToken: true,
  syntaxHighlight: true,
  singleClickExpandsChildren: false,
  follow: vi.fn(),
  copySelection: vi.fn(),
  copyText: vi.fn(),
  openUrl: vi.fn(),
  analyze: vi.fn(),
  removeRoots: vi.fn(),
  setShowToken: vi.fn(),
  setSyntaxHighlight: vi.fn(),
  setSingleClickExpandsChildren: vi.fn(),
  ...extra,
})

const keys = (ctx: AnalyzerMenuContext): string[] => buildAnalyzerMenuItems(ctx).map((item) => 'type' in item ? '|' : item.key)

const run = (ctx: AnalyzerMenuContext, key: string): void => {
  const item = buildAnalyzerMenuItems(ctx).find((entry) => !('type' in entry) && entry.key === key)
  if (!item || 'type' in item)
    throw new Error(`No ${key} entry.`)
  item.onSelect?.(item)
}

describe('buildAnalyzerMenuItems', () => {
  it('lays a result found in a body out the way dnSpy does', () => {
    const found = row('hit', { source: { methodNodeId: 'm', modulePath: '/a.dll', methodToken: 1, ilOffset: 4, targets: [] } })
    expect(keys(context([found]))).toEqual([
      'show-reference', 'show-reference-new-tab', 'go-to-reference', 'go-to-reference-new-tab', '|',
      'copy', 'copy-md-token', 'copy-full-name', '|',
      'analyze', 'search-msdn', '|',
      'show-tokens', 'syntax-highlight', 'single-click-expands',
    ])
  })

  it('offers Remove for roots and Analyze for anything else', () => {
    expect(keys(context([row('root1')]))).toContain('remove')
    expect(keys(context([row('root1')]))).not.toContain('analyze')
    expect(keys(context([row('root1'), row('hit')]))).toEqual(expect.arrayContaining(['analyze']))
    expect(keys(context([row('root1'), row('hit')]))).not.toContain('remove')
  })

  it('keeps Copy and the options for an empty selection, and leaves out what needs a row', () => {
    const ctx = context([])
    expect(keys(ctx)).toEqual(['copy', '|', 'show-tokens', 'syntax-highlight', 'single-click-expands'])
    const copy = buildAnalyzerMenuItems(ctx).find((item) => !('type' in item) && item.key === 'copy')
    expect(copy && !('type' in copy) && copy.disabled).toBe(true)
  })

  it('offers no following, token or MSDN entries for a search row', () => {
    expect(keys(context([row('search', { kind: 'search', label: 'Used By', metadataToken: undefined, fullName: undefined, isPublic: false })]))).toEqual([
      'copy', '|', 'show-tokens', 'syntax-highlight', 'single-click-expands',
    ])
  })

  it('offers the debugger\'s breakpoints for the members the selection names, once the shell supplies them', () => {
    const debug = { addClassBreakpoint: vi.fn(), addMethodBreakpoints: vi.fn() }
    const type = row('type', { kind: 'type', label: 'Type', fullName: 'NS.Type' })
    const method = row('hit')
    const property = row('prop', { kind: 'property', label: 'NS.Type.P : int' })
    const field = row('field', { kind: 'field', label: 'NS.Type.F : int' })
    const search = row('search', { kind: 'search', label: 'Used By' })

    // dnSpy's debug group sits between the copy commands and Analyze.
    expect(keys(context([type, method], debug))).toEqual([
      'copy', 'copy-md-token', 'copy-full-name', '|',
      'add-class-breakpoint', 'add-method-breakpoint', '|',
      'analyze', 'search-msdn', '|',
      'show-tokens', 'syntax-highlight', 'single-click-expands',
    ])
    // The class breakpoint reads the first member selected; a search row in front of it is no member.
    expect(keys(context([method, type], debug))).not.toContain('add-class-breakpoint')
    expect(keys(context([search, type], debug))).toContain('add-class-breakpoint')
    // A field has no method to break in.
    expect(keys(context([field], debug))).not.toContain('add-method-breakpoint')
    // Nothing to add them to, nothing offered.
    expect(keys(context([type, method]))).not.toContain('add-class-breakpoint')
    expect(keys(context([type, method]))).not.toContain('add-method-breakpoint')

    const ctx = context([search, type, method, field, property], debug)
    run(ctx, 'add-class-breakpoint')
    expect(debug.addClassBreakpoint).toHaveBeenCalledWith(type)
    run(ctx, 'add-method-breakpoint')
    expect(debug.addMethodBreakpoints).toHaveBeenCalledWith([method, property])
  })

  it('runs its entries against the selection', () => {
    const found = row('hit', { source: { methodNodeId: 'm', modulePath: '/a.dll', methodToken: 1, ilOffset: 4, targets: [] } })
    const ctx = context([found])
    run(ctx, 'show-reference-new-tab')
    expect(ctx.follow).toHaveBeenCalledWith(found, true, true)
    run(ctx, 'go-to-reference')
    expect(ctx.follow).toHaveBeenCalledWith(found, false, false)
    run(ctx, 'copy-md-token')
    expect(ctx.copyText).toHaveBeenCalledWith('0x06000012')
    run(ctx, 'search-msdn')
    expect(ctx.openUrl).toHaveBeenCalledWith(expect.stringContaining('NS.Type.M'))
    run(ctx, 'show-tokens')
    expect(ctx.setShowToken).toHaveBeenCalledWith(false)
    run(ctx, 'syntax-highlight')
    expect(ctx.setSyntaxHighlight).toHaveBeenCalledWith(false)
    run(ctx, 'analyze')
    expect(ctx.analyze).toHaveBeenCalledWith([found])
  })
})
