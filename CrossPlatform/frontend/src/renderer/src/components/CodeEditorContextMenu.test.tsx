import { describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { buildCodeEditorMenuItems, searchMsdnUrl, type CodeEditorMenuContext } from './CodeEditorContextMenu'
import type { CodeStatement, DebugCodeTargets, TextSpan, TreeNode } from '../../../shared/protocol'
import type { LineBreakpoint } from '../app-store'

const methodNode: TreeNode = { id: 'n-method', label: 'WriteLine', kind: 'method', hasChildren: false, description: 'System.Void System.Console::WriteLine(System.String)', metadataToken: 0x06000001 }
const typeNode: TreeNode = { id: 'n-type', label: 'Console', kind: 'type', hasChildren: true, description: 'System.Console' }

const statement = (overrides: Partial<CodeStatement> = {}): CodeStatement => ({
  startLine: 8,
  endLine: 12,
  startColumn: 1,
  endColumn: 2,
  ilOffset: 0,
  ilEndOffset: 5,
  sequencePointIlOffset: 0,
  modulePath: '/tmp/DebugTarget.dll',
  metadataToken: 0x06000002,
  sourceMethodToken: 0x06000002,
  description: 'System.Void DebugTarget.Program::Main(System.String[])',
  isHidden: false,
  ...overrides,
})

/** A reference under the caret, which is what dnSpy's "Open in New Tab" acts on. */
const referenceSpan: TextSpan = { start: 20, length: 12, kind: 'reference', targetNodeId: 'n-method' }

const breakpoint: LineBreakpoint = {
  id: 'bp-1',
  nodeId: 'doc-node',
  identity: '/tmp/DebugTarget.dll|100664322|0',
  requestedLine: 10,
  line: 10,
  endLine: 10,
  state: 'bound',
  enabled: true,
  modulePath: '/tmp/DebugTarget.dll',
  ilOffset: 0,
  metadataToken: 0x06000002,
  order: 1,
}

/** What the backend answers for a method reference: the method, which is no type and no exception. */
const methodTargets: DebugCodeTargets = { methods: [{ modulePath: '/lib/System.Console.dll', metadataToken: 0x06000001, description: 'System.Void System.Console::WriteLine(System.String)', hasBody: true }] }
/** And for a type reference: no method of its own, the type's methods. */
const typeTargets: DebugCodeTargets = { methods: [], typeMethods: methodTargets.methods, typeName: 'System.Console' }

/** Every callback the menu can ask for, so a case only has to say what it is *about*. */
const commands = () => ({
  onOpenInNewTab: vi.fn(),
  onStartDebug: vi.fn(),
  onShowDisassembly: vi.fn(),
  onToggleBreakpoint: vi.fn(),
  onSetBreakpointEnabled: vi.fn(),
  onShowNextStatement: vi.fn(),
  onSetNextStatement: vi.fn(),
  onRunToCursor: vi.fn(),
  onAddMethodBreakpoints: vi.fn(),
  onAddClassBreakpoint: vi.fn(),
  onAddClassTracepoint: vi.fn(),
  onDeleteNode: vi.fn(),
  onEditNode: vi.fn(),
  onCreateMember: vi.fn(),
  onEditMethodBody: vi.fn(),
  onReplaceMethodBodyWithStub: vi.fn(),
  onAnalyze: vi.fn(),
  onAnalyzeReference: vi.fn(),
  onOpenUrl: vi.fn(),
  copyText: vi.fn(),
  onCopy: vi.fn(),
  onFind: vi.fn(),
  onOpenHex: vi.fn(),
  onShowHexAt: vi.fn(),
  onHexWriteBody: vi.fn(),
  onHexCopyBody: vi.fn(),
  onHexPasteBody: vi.fn(),
})

/**
 * A context with every callback stubbed. The overrides are applied to the finished object rather than
 * spread into it: spreading a `Partial` would leave every property optional in the result, and the hex
 * group's callbacks are not.
 */
const context = (overrides: Partial<CodeEditorMenuContext> = {}): CodeEditorMenuContext => {
  const ctx: CodeEditorMenuContext = {
    t: (message) => message,
    // This menu is always a code document viewer's, which is what `DocumentView` says when it builds one:
    // the file command has a document to open whatever the tree happens to have selected.
    documentAvailable: true,
    hasSelection: false,
    debugState: 'inactive',
    stopped: false,
    canStartDebug: false,
    ...commands(),
  }
  Object.assign(ctx, overrides)
  return ctx
}

/** The entries, in the order they are laid out. Separators are dropped here — `separators` reads them. */
const menuKeys = (ctx: CodeEditorMenuContext): string[] =>
  buildCodeEditorMenuItems(ctx).filter((item) => item.type !== 'divider').map((item) => item.key)

/** The separator keys, which say where the groups fell: an empty group leaves none behind. */
const separators = (ctx: CodeEditorMenuContext): string[] =>
  buildCodeEditorMenuItems(ctx).filter((item) => item.type === 'divider').map((item) => item.key)

const runEntry = (ctx: CodeEditorMenuContext, key: string): void => {
  const item = buildCodeEditorMenuItems(ctx).find((entry) => entry.type !== 'divider' && entry.key === key)
  if (!item || item.type === 'divider' || !item.onSelect)
    throw new Error(`Missing entry ${key}`)
  item.onSelect(item)
}

/** A C# document whose caret sits on a method reference, which is the menu's fullest case. */
const methodReferenceContext = (overrides: Partial<CodeEditorMenuContext> = {}): CodeEditorMenuContext => context({
  referenceNode: methodNode,
  referenceTarget: referenceSpan,
  documentNode: methodNode,
  statement: statement(),
  breakpoint,
  canStartDebug: true,
  hexTarget: {
    moduleId: 'module-1',
    fileLength: 4096,
    method: { bodyOffset: 32, bodySize: 12, codeOffset: 40, codeSize: 5, returnTrueBody: 'AA==', returnFalseBody: null, emptyBody: null },
    fieldInitialValue: null,
    resource: null,
  },
  hexStatement: { moduleId: 'module-1', range: { offset: 40, length: 5 } },
  selectionKind: 'method',
  debugTargets: methodTargets,
  ...overrides,
})

// The commands this port has no equivalent for. dnSpy puts them in the menu; here they must never show,
// which is asserted against a context rich enough to make everything else appear.
const UNIMPLEMENTED = [
  'edit-il-instructions',
]

describe('buildCodeEditorMenuItems', () => {
  it('offers Disassemble BAML on a BAML entry\'s tab only, checked while the records are shown', () => {
    const onToggleDisassembleBaml = vi.fn()
    expect(menuKeys(context({ onToggleDisassembleBaml }))).not.toContain('disassemble-baml')
    const ctx = context({ bamlDocument: true, disassembleBaml: true, onToggleDisassembleBaml })
    // DisassembleBamlCommand sits in GROUP_CTX_FILES_BAML_OPTIONS (500), before the debugger's group.
    expect(menuKeys(ctx)[0]).toBe('disassemble-baml')
    render(<>{(buildCodeEditorMenuItems(ctx)[0] as { content: React.ReactNode }).content}</>)
    expect(document.querySelector('.ds-menu-check-panel')).not.toBeNull()
    runEntry(ctx, 'disassemble-baml')
    expect(onToggleDisassembleBaml).toHaveBeenCalledOnce()
  })

  it('offers Go to Resource on a reference to a member that reads a .resources entry', () => {
    const property: TreeNode = { id: 'n-title', label: 'Title', kind: 'property', hasChildren: true, description: 'System.String Resources::Title()' }
    const onGoToResource = vi.fn()
    expect(menuKeys(context({ referenceNode: property, onGoToResource }))).not.toContain('go-to-resource')
    const ctx = context({ referenceNode: property, readsResource: true, onGoToResource })
    expect(menuKeys(ctx)).toContain('go-to-resource')
    runEntry(ctx, 'go-to-resource')
    expect(onGoToResource).toHaveBeenCalledWith(property)
  })

  it('lays a method reference out in dnSpy group and order', () => {
    expect(menuKeys(methodReferenceContext())).toEqual([
      // 0 — tabs
      'open-in-new-tab',
      // 1000 — debug
      'start-debugging',
      'toggle-breakpoint',
      'enable-breakpoint',
      'add-method-breakpoint',
      // 3000 — delete
      'delete-method',
      // 4000 — create
      'create-method',
      'create-field',
      'create-property',
      'create-event',
      // 5000 — settings
      'edit-method',
      // 6000 — IL edits
      'edit-method-body',
      'replace-method-body-with-stub',
      // 7000 — tokens
      'copy-md-token',
      'copy-full-name',
      // 9000 — hex
      'hex-0',
      'hex-50',
      'hex-60',
      'hex-90',
      'hex-120',
      'hex-130',
      // 14000 — other
      'analyze',
      'search-msdn',
      // 15000 — editor
      'find',
    ])
  })

  it('separates the groups the entries fell into, leaving the empty ones no separator', () => {
    expect(separators(methodReferenceContext())).toEqual([
      'separator-1000',
      'separator-3000',
      'separator-4000',
      'separator-5000',
      'separator-6000',
      'separator-7000',
      'separator-9000',
      'separator-14000',
      'separator-15000',
    ])
  })

  it('swaps the member commands for the type ones when the reference is a type', () => {
    const keys = menuKeys(methodReferenceContext({ referenceNode: typeNode }))
    expect(keys.filter((key) => key.startsWith('delete-'))).toEqual(['delete-type'])
    expect(keys.filter((key) => key.startsWith('create-'))).toEqual(['create-nested-type', 'create-method', 'create-field', 'create-property', 'create-event'])
    // A type reference names no method body, so the IL edit commands go with the member ones.
    expect(keys.filter((key) => key.startsWith('edit-'))).toEqual(['edit-type'])
    expect(keys).toContain('analyze')
  })

  it('keeps to the statement\'s and the document\'s commands when the caret is not on a reference', () => {
    // A caret that landed between references — on the whitespace to the right of a line, say. The line
    // breakpoint reads the statement, and the method body commands the document's method, as dnSpy's do.
    // Everything that reads the TextReference at the caret is left out: the copies, Search MSDN, Add Method
    // Breakpoint, the node's own delete, create and edit commands, Analyze, and "Open in New Tab".
    const keys = menuKeys(context({ statement: statement(), documentNode: methodNode }))
    expect(keys).toEqual([
      'toggle-breakpoint',
      'edit-method-body',
      'replace-method-body-with-stub',
      'hex-0',
      'find',
    ])
  })

  it('offers only the method body and the editor commands in a document with neither spans nor statements', () => {
    // VB and IL are decompiled without spans and without an IL map, so the caret resolves to neither a
    // reference nor a statement. The commands left are the ones that read the document's own node — and
    // the file command, which reads the document itself: this viewer is showing a file.
    expect(menuKeys(context({ documentNode: methodNode }))).toEqual([
      'edit-method-body',
      'replace-method-body-with-stub',
      'hex-0',
      'find',
    ])
  })

  it('offers "Open in New Tab" on a reference under the caret, and not without one', () => {
    // dnSpy's document viewer entry is the one command that follows the TextReference the caret is on, so
    // it is the reference that decides whether it shows — a caret between references leaves it out. It
    // runs on that reference, and a reference into a module the workspace does not hold is one too.
    expect(menuKeys(methodReferenceContext())).toContain('open-in-new-tab')
    expect(menuKeys(context({ documentNode: methodNode, statement: statement() }))).not.toContain('open-in-new-tab')
    expect(menuKeys(context({ referenceTarget: { start: 0, length: 9, kind: 'method', targetModulePath: '/lib/System.Console.dll', targetMetadataToken: 0x06000123 } }))).toContain('open-in-new-tab')

    const ctx = methodReferenceContext()
    runEntry(ctx, 'open-in-new-tab')
    expect(ctx.onOpenInNewTab).toHaveBeenCalledWith(referenceSpan)
  })

  it('shows the gesture "Open in New Tab" was reached by: Ctrl+F12 from the keyboard, Ctrl+Click from the mouse', () => {
    const shortcut = (ctx: CodeEditorMenuContext): string | undefined => {
      const item = buildCodeEditorMenuItems(ctx).find((entry) => entry.type !== 'divider' && entry.key === 'open-in-new-tab')
      const { container } = render(<>{item && item.type !== 'divider' ? item.content : null}</>)
      const text = container.querySelector('.document-tab-menu-shortcut')?.textContent ?? undefined
      cleanup()
      return text
    }
    expect(shortcut(methodReferenceContext())).toBe('Ctrl+Click')
    expect(shortcut(methodReferenceContext({ openInNewTabFromKeyboard: true }))).toBe('Ctrl+F12')
    // A local is a reference the command follows too: into a copy of the document, with the caret on its declaration.
    expect(menuKeys(context({ referenceTarget: { start: 0, length: 3, kind: 'reference', localId: 'L0' } }))).toContain('open-in-new-tab')
  })

  it('offers the token group\'s Go to commands for the document\'s module, the first two only when it has their member', () => {
    const goTo = { onGoToEntryPoint: vi.fn(), onGoToGlobalCctor: vi.fn(), onGoToToken: vi.fn() }
    expect(menuKeys(context({ documentNode: methodNode, ...goTo })).filter((key) => key.startsWith('go-to-'))).toEqual(['go-to-token'])
    const ctx = context({ documentNode: methodNode, hasEntryPoint: true, hasGlobalCctor: true, ...goTo })
    expect(menuKeys(ctx).filter((key) => key.startsWith('go-to-'))).toEqual(['go-to-entry-point', 'go-to-global-cctor', 'go-to-token'])
    runEntry(ctx, 'go-to-entry-point')
    runEntry(ctx, 'go-to-global-cctor')
    runEntry(ctx, 'go-to-token')
    expect(goTo.onGoToEntryPoint).toHaveBeenCalledWith(methodNode)
    expect(goTo.onGoToGlobalCctor).toHaveBeenCalledWith(methodNode)
    expect(goTo.onGoToToken).toHaveBeenCalledWith(methodNode)
    expect(menuKeys(context({ hasEntryPoint: true, ...goTo })).filter((key) => key.startsWith('go-to-'))).toEqual([])
  })

  it('offers Analyze on a member of a module the workspace does not hold, and hands it the reference', () => {
    // dnSpy shows Analyze for any member reference under the caret and resolves it only when it runs, so a
    // reference with no node here — one into a framework assembly — still gets it. A token outside the member
    // tables names no member to analyze: a TypeRef that never resolved, a module, an assembly reference.
    const external: TextSpan = { start: 0, length: 9, kind: 'method', targetModulePath: '/lib/System.Console.dll', targetMetadataToken: 0x06000123 }
    const ctx = context({ referenceTarget: external })
    expect(menuKeys(ctx)).toContain('analyze')
    runEntry(ctx, 'analyze')
    expect(ctx.onAnalyzeReference).toHaveBeenCalledWith(external)
    expect(ctx.onAnalyze).not.toHaveBeenCalled()

    for (const token of [0x01000005, 0x23000001, 0x00000001])
      expect(menuKeys(context({ referenceTarget: { ...external, targetMetadataToken: token } }))).not.toContain('analyze')
    expect(menuKeys(context({ referenceTarget: { start: 0, length: 9, kind: 'method' } }))).not.toContain('analyze')
    expect(menuKeys(context({ referenceTarget: external, onAnalyzeReference: undefined }))).not.toContain('analyze')
  })

  it('analyzes the node a reference names before the reference itself', () => {
    const ctx = methodReferenceContext({ referenceTarget: { ...referenceSpan, targetModulePath: '/lib/System.Console.dll', targetMetadataToken: 0x06000123 } })
    runEntry(ctx, 'analyze')
    expect(ctx.onAnalyze).toHaveBeenCalledWith(methodNode)
    expect(ctx.onAnalyzeReference).not.toHaveBeenCalled()
  })

  it('never shows a command this port has no equivalent for', () => {
    const keys = menuKeys(methodReferenceContext({ stopped: true, debugState: 'stopped' }))
    for (const key of UNIMPLEMENTED)
      expect(keys).not.toContain(key)
  })

  it('names the breakpoint commands after what the line already holds', () => {
    const breakpointKeys = (ctx: CodeEditorMenuContext): string[] =>
      menuKeys(ctx).filter((key) => key.includes('breakpoint'))
    // No breakpoint on the line yet: add one. Once there is one, Ctrl+F9 can drop it or raise it again.
    expect(breakpointKeys(context({ statement: statement() }))).toEqual(['toggle-breakpoint'])
    expect(breakpointKeys(context({ statement: statement(), breakpoint }))).toEqual(['toggle-breakpoint', 'enable-breakpoint'])
    // The header flips with the breakpoint's state, and so does the command it runs.
    const disable = context({ statement: statement(), breakpoint })
    runEntry(disable, 'enable-breakpoint')
    expect(disable.onSetBreakpointEnabled).toHaveBeenCalledWith(false)
    const enable = context({ statement: statement(), breakpoint: { ...breakpoint, enabled: false } })
    runEntry(enable, 'enable-breakpoint')
    expect(enable.onSetBreakpointEnabled).toHaveBeenCalledWith(true)
  })

  it('offers the commands that jump to the instruction pointer only while a frame is stopped', () => {
    expect(menuKeys(context({ statement: statement() }))).not.toContain('show-next-statement')
    expect(menuKeys(context({ statement: statement(), stopped: true, debugState: 'stopped' }))).toEqual([
      'toggle-breakpoint',
      'show-next-statement',
      'set-next-statement',
      'run-to-cursor',
      'go-to-disassembly',
      'hex-0',
      'find',
    ])
  })

  it('offers Copy only with a selection, since the menu replaces Monaco\'s own', () => {
    expect(menuKeys(context({ hasSelection: false }))).toEqual(['hex-0', 'find'])
    expect(menuKeys(context({ hasSelection: true }))).toEqual(['hex-0', 'copy', 'find'])
  })

  it('writes the token, the full name and the docs address where dnSpy does', () => {
    const ctx = methodReferenceContext()
    runEntry(ctx, 'copy-md-token')
    expect(ctx.copyText).toHaveBeenCalledWith('0x06000001')
    runEntry(ctx, 'copy-full-name')
    expect(ctx.copyText).toHaveBeenCalledWith('System.Void System.Console::WriteLine(System.String)')
    runEntry(ctx, 'search-msdn')
    expect(ctx.onOpenUrl).toHaveBeenCalledWith('https://learn.microsoft.com/dotnet/api/System.Console.WriteLine')
    runEntry(ctx, 'find')
    expect(ctx.onFind).toHaveBeenCalled()
  })

  it('hands each command the node the menu named, not the selection', () => {
    const ctx = methodReferenceContext()
    runEntry(ctx, 'delete-method')
    expect(ctx.onDeleteNode).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'edit-method-body')
    expect(ctx.onEditMethodBody).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'add-method-breakpoint')
    expect(ctx.onAddMethodBreakpoints).toHaveBeenCalledWith([methodNode])
  })

  it('adds a method breakpoint for the reference\'s method, or for the accessors a property or an event stands for', () => {
    // dnSpy's GetMethodReferences reads the TextReference at the caret: a property or an event stands for its
    // accessors, and a reference to a type or a field names no method at all.
    const property: TreeNode = { id: 'n-prop', label: 'Out', kind: 'property', hasChildren: true, description: 'System.IO.TextWriter System.Console::Out()' }
    const onProperty = methodReferenceContext({ referenceNode: property })
    runEntry(onProperty, 'add-method-breakpoint')
    expect(onProperty.onAddMethodBreakpoints).toHaveBeenCalledWith([property])
    expect(menuKeys(methodReferenceContext({ referenceNode: typeNode, debugTargets: typeTargets }))).not.toContain('add-method-breakpoint')
    // A reference into a module the workspace does not hold is handed over as its file and token.
    const external = context({ referenceTarget: { start: 0, length: 9, kind: 'reference', targetModulePath: '/lib/System.Console.dll', targetMetadataToken: 0x06000001 }, debugTargets: methodTargets })
    runEntry(external, 'add-method-breakpoint')
    expect(external.onAddMethodBreakpoints).toHaveBeenCalledWith([{ modulePath: '/lib/System.Console.dll', metadataToken: 0x06000001 }])
  })

  it('offers the class breakpoint and tracepoint on a type reference, for that type', () => {
    // dnSpy's GetTypeRef reads an ITypeDefOrRef off the reference at the caret; a method reference is no type.
    expect(menuKeys(methodReferenceContext())).not.toContain('add-class-breakpoint')
    const ctx = methodReferenceContext({ referenceNode: typeNode, debugTargets: typeTargets })
    const keys = menuKeys(ctx).filter((key) => key.startsWith('add-'))
    expect(keys).toEqual(['add-class-breakpoint', 'add-class-tracepoint'])
    runEntry(ctx, 'add-class-breakpoint')
    expect(ctx.onAddClassBreakpoint).toHaveBeenCalledWith(typeNode)
    runEntry(ctx, 'add-class-tracepoint')
    expect(ctx.onAddClassTracepoint).toHaveBeenCalledWith(typeNode)
  })

  it('offers Break When Thrown on an exception type, and turns it on by the type\'s name', () => {
    expect(menuKeys(methodReferenceContext({ referenceNode: typeNode, debugTargets: typeTargets }))).not.toContain('break-when-exception-thrown')
    const onBreakWhenThrown = vi.fn()
    const ctx = methodReferenceContext({ referenceNode: typeNode, debugTargets: { ...typeTargets, exceptionTypeName: 'System.InvalidOperationException' }, onBreakWhenThrown })
    runEntry(ctx, 'break-when-exception-thrown')
    expect(onBreakWhenThrown).toHaveBeenCalledWith('System.InvalidOperationException')
  })

  it('names the breakpoint commands after every breakpoint the statement has', () => {
    const disabled = { ...breakpoint, id: 'bp-2', enabled: false }
    const label = (ctx: CodeEditorMenuContext, key: string): string | undefined => {
      const item = buildCodeEditorMenuItems(ctx).find((entry) => entry.type !== 'divider' && entry.key === key)
      const { container } = render(<>{item && item.type !== 'divider' ? item.content : null}</>)
      const text = container.querySelector('.document-tab-menu-label')?.textContent ?? undefined
      cleanup()
      return text
    }
    expect(label(context({ statement: statement() }), 'toggle-breakpoint')).toBe('Add Breakpoint')
    expect(label(context({ statement: statement(), breakpoints: [breakpoint] }), 'toggle-breakpoint')).toBe('Delete Breakpoint')
    // One that is off among them makes F9 enable them, and Ctrl+F9 too.
    expect(label(context({ statement: statement(), breakpoints: [breakpoint, disabled] }), 'toggle-breakpoint')).toBe('Enable Breakpoint')
    expect(label(context({ statement: statement(), breakpoints: [breakpoint, disabled] }), 'enable-breakpoint')).toBe('Enable Breakpoint')
  })

  it('copies the token of a reference into a module the workspace does not hold', () => {
    // The reference carries its token whether or not the tree has a node for it, and the entry has no
    // shortcut of its own: Ctrl+C copies the selected text.
    const external: TextSpan = { start: 0, length: 9, kind: 'reference', targetModulePath: '/lib/System.Console.dll', targetMetadataToken: 0x06000123 }
    const ctx = context({ referenceTarget: external })
    runEntry(ctx, 'copy-md-token')
    expect(ctx.copyText).toHaveBeenCalledWith('0x06000123')
    const entry = buildCodeEditorMenuItems(ctx).find((item) => item.type !== 'divider' && item.key === 'copy-md-token')
    expect(JSON.stringify(entry && 'content' in entry ? entry.content : '')).not.toContain('Ctrl+C')
  })

  it('shows no bookmark entry and no Select All', () => {
    const keys = menuKeys(methodReferenceContext({ hasSelection: true }))
    expect(keys.filter((key) => key.includes('bookmark'))).toEqual([])
    expect(keys).not.toContain('select-all')
  })
})

describe('searchMsdnUrl', () => {
  it('turns a member full name into a docs address', () => {
    expect(searchMsdnUrl('System.Void System.Console::WriteLine(System.String)')).toBe('https://learn.microsoft.com/dotnet/api/System.Console.WriteLine')
    expect(searchMsdnUrl('System.Collections.Generic.List`1')).toBe('https://learn.microsoft.com/dotnet/api/System.Collections.Generic.List-1')
    expect(searchMsdnUrl('Ns.Outer/Inner')).toBe('https://learn.microsoft.com/dotnet/api/Ns.Outer.Inner')
  })

  it('falls back to a search for a name that is not a member', () => {
    expect(searchMsdnUrl('')).toBe('https://learn.microsoft.com/search/?q=')
  })
})

describe('the document viewer\'s Go to MD Table Row commands', () => {
  it('ask for a token in the document\'s module, or go to the row of the reference under the caret', () => {
    const onGoToMdTableRow = vi.fn()
    const ctx = methodReferenceContext({ onGoToMdTableRow })
    const keys = menuKeys(ctx)
    expect(keys.indexOf('go-to-md-table-row')).toBeGreaterThan(keys.indexOf('go-to-token'))
    expect(keys.indexOf('go-to-md-table-row-token')).toBeLessThan(keys.indexOf('copy-md-token'))
    runEntry(ctx, 'go-to-md-table-row')
    expect(onGoToMdTableRow).toHaveBeenLastCalledWith(methodNode)
    runEntry(ctx, 'go-to-md-table-row-token')
    expect(onGoToMdTableRow).toHaveBeenLastCalledWith(methodNode, 0x06000001)
    expect(menuKeys(context({ documentNode: methodNode, onGoToMdTableRow }))).not.toContain('go-to-md-table-row-token')
  })
})
