import { describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import {
  buildAssemblyExplorerMenuItems,
  hasEmptyNamespaceSibling,
  type AssemblyExplorerCommands,
  type AssemblyExplorerMenuContext,
} from './AssemblyExplorerContextMenu'
import type { TreeNode } from '../../../shared/protocol'

const typeNode: TreeNode = { id: 'n-type', kind: 'type', label: 'Console', hasChildren: true, description: 'System.Console', metadataToken: 0x02000002 }
const methodNode: TreeNode = { id: 'n-method', kind: 'method', label: 'WriteLine()', hasChildren: false, description: 'System.Void System.Console::WriteLine(System.String)', metadataToken: 0x06000001 }
const moduleNode: TreeNode = { id: 'n-module', kind: 'module', label: 'Example.dll', hasChildren: true, description: '/tmp/Example.dll', metadataToken: 0x00000001 }
const assemblyNode: TreeNode = { id: 'n-assembly', kind: 'assembly', label: 'Example', hasChildren: true, metadataToken: 0x20000001 }
const namespaceNode: TreeNode = { id: 'n-ns', kind: 'namespace', label: 'System', hasChildren: true }

/** Every callback the tree wires today, so a case only has to say what it is *about*. */
const commands = (): AssemblyExplorerCommands => ({
  onOpenNode: vi.fn(),
  onOpenInNewTab: vi.fn(),
  onDeleteNode: vi.fn(),
  onEditNode: vi.fn(),
  onCreateMember: vi.fn(),
  onEditMethodBody: vi.fn(),
  onReplaceMethodBodyWithStub: vi.fn(),
  onEditResource: vi.fn(),
  onRenameNamespace: vi.fn(),
  onMoveTypesToEmptyNamespace: vi.fn(),
  onSortAssemblies: vi.fn(),
  onAddMethodBreakpoints: vi.fn(),
  onAnalyze: vi.fn(),
  onOpenUrl: vi.fn(),
  copyText: vi.fn(),
  onShowModuleInfo: vi.fn(),
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
const context = (overrides: Partial<AssemblyExplorerMenuContext> = {}): AssemblyExplorerMenuContext => {
  const ctx: AssemblyExplorerMenuContext = {
    t: (message) => message,
    node: typeNode,
    hasEmptyNamespaceSibling: false,
    ...commands(),
  }
  Object.assign(ctx, overrides)
  return ctx
}

/** The entries, in the order they are laid out. Separators are dropped here — `separators` reads them. */
const menuKeys = (ctx: AssemblyExplorerMenuContext): string[] =>
  buildAssemblyExplorerMenuItems(ctx).filter((item) => item.type !== 'divider').map((item) => item.key)

/** The separator keys, which say where the groups fell: an empty group leaves none behind. */
const separators = (ctx: AssemblyExplorerMenuContext): string[] =>
  buildAssemblyExplorerMenuItems(ctx).filter((item) => item.type === 'divider').map((item) => item.key)

const runEntry = (ctx: AssemblyExplorerMenuContext, key: string): void => {
  const item = buildAssemblyExplorerMenuItems(ctx).find((entry) => entry.type !== 'divider' && entry.key === key)
  if (!item || item.type === 'divider' || !item.onSelect)
    throw new Error(`Missing entry ${key}`)
  item.onSelect(item)
}

/** The label a built entry wears; `menuContent` lays the content out as icon, label, then shortcut. */
const labelOf = (ctx: AssemblyExplorerMenuContext, key: string): string => {
  const item = buildAssemblyExplorerMenuItems(ctx).find((entry) => entry.type !== 'divider' && entry.key === key)
  if (!item || item.type === 'divider' || item.content === undefined)
    throw new Error(`Missing entry ${key}`)
  const children = (item.content as ReactElement<{ children: ReactNode[] }>).props.children
  return (children[1] as ReactElement<{ children: string }>).props.children
}

/** The hex target of a node that names no method and no resource — the two parts most nodes have none of. */
const plainTarget = (moduleId: string) => ({ moduleId, fileLength: 4096, method: null, fieldInitialValue: null, resource: null })

// The commands this port has no equivalent for. dnSpy puts them in the menu; here they must never show,
// which is asserted against a context rich enough to make everything else appear.
const UNIMPLEMENTED = [
  'remove-netmodule',
  'delete-resource-entry',
  'convert-netmodule-to-assembly',
  'create-assembly',
  'add-new-netmodule',
  'add-existing-netmodule',
  'create-netmodule',
  'create-file-resource',
  'create-multi-file-resource',
  'create-assembly-linked-resource',
  'create-file-linked-resource',
  'create-bitmap-resource',
  'create-imagelist-resource',
  'create-byte-array-resource',
  'create-stream-resource',
  'create-resource',
  'edit-assembly',
  'edit-module',
  'edit-resource-entry',
  'edit-method-code',
  'edit-assembly-attributes-code',
  'edit-class-code',
  'add-class-members-code',
  'add-class-code',
  'go-to-resource',
  'disable-mmap-io',
  'break-when-exception-thrown',
  'find-string-references',
]

/** A context rich enough to show everything the port can run, on the node a case names. */
const richContext = (node: TreeNode, overrides: Partial<AssemblyExplorerMenuContext> = {}): AssemblyExplorerMenuContext => context({
  node,
  hexTarget: plainTarget('n-module'),
  ...overrides,
})

describe('buildAssemblyExplorerMenuItems', () => {
  it('lays a type node out in dnSpy group and order', () => {
    expect(menuKeys(richContext(typeNode))).toEqual([
      // 0 — tabs
      'open-in-new-tab',
      // 2000 — delete
      'delete-type',
      // 4000 — create
      'create-type',
      'create-nested-type',
      'create-method',
      'create-field',
      'create-property',
      'create-event',
      // 5000 — settings
      'edit-type',
      // 7000 — tokens
      'copy-md-token',
      'copy-full-name',
      // 9000 — hex: empty for a type, since the file command is off the menu for it and the rest of the
      // group needs a resolved target this node has none of
      // 11000 — other
      'analyze',
      'search-msdn',
      'sort-assemblies',
    ])
  })

  it('separates the groups the entries fell into, leaving the empty ones no separator', () => {
    expect(separators(richContext(typeNode))).toEqual([
      'separator-2000',
      'separator-4000',
      'separator-5000',
      'separator-7000',
      'separator-11000',
    ])
  })

  it('opens the hex editor from the rows that are documents, and from no others', () => {
    // dnSpy's file command answers for a `DsDocumentNode` — the assembly, the module, a PE-only file, an
    // ELF image and a file nothing could be read from — and for nothing below one: a namespace or a
    // member is a part inside a file, and the file the command opens is not what was clicked.
    for (const kind of ['assembly', 'module', 'pedocument', 'elfdocument', 'unknowndocument'])
      expect(menuKeys(richContext({ id: 'n-doc', kind, label: 'Example.dll', hasChildren: true })), `for a ${kind} row`).toContain('hex-0')
    for (const kind of ['namespace', 'type', 'method', 'field', 'property', 'event', 'resource', 'resourceentry', 'pe', 'elf'])
      expect(menuKeys(richContext({ id: 'n-part', kind, label: 'Part', hasChildren: true })), `for a ${kind} row`).not.toContain('hex-0')
  })

  it('gives a method the method commands and no create command for a nested type', () => {
    const keys = menuKeys(richContext(methodNode, {
      hexTarget: {
        moduleId: 'n-module',
        fileLength: 4096,
        method: { bodyOffset: 32, bodySize: 12, codeOffset: 40, codeSize: 5, returnTrueBody: 'AA==', returnFalseBody: null, emptyBody: null },
        fieldInitialValue: null,
        resource: null,
      },
    }))
    expect(keys.filter((key) => key.startsWith('delete-'))).toEqual(['delete-method'])
    expect(keys.filter((key) => key.startsWith('create-'))).toEqual(['create-nested-type', 'create-method', 'create-field', 'create-property', 'create-event'])
    expect(keys).toContain('edit-method')
    expect(keys).toContain('edit-method-body')
    expect(keys).toContain('replace-method-body-with-stub')
    expect(keys).toContain('add-method-breakpoint')
    // The method's bytes are what the hex group points at, so the group is at its widest here — bar the
    // file command, which a method row is not a file for.
    expect(keys.filter((key) => key.startsWith('hex-'))).toEqual(['hex-50', 'hex-60', 'hex-90', 'hex-120', 'hex-130'])
  })

  it('offers a module the module commands, which is where its tools and its dependencies live', () => {
    const keys = menuKeys(richContext(moduleNode))
    expect(keys).toEqual([
      'open-in-new-tab',
      'create-type',
      'copy-md-token',
      'hex-0',
      'module-information',
      'sort-assemblies',
    ])
  })

  it('keeps the module commands off a namespace, which owns no bytes of its own', () => {
    // The commands are supplied here precisely so that their absence says "the node is wrong for this
    // command" rather than "the shell cannot run it yet".
    const keys = menuKeys(richContext(namespaceNode, { onShowModuleInfo: vi.fn(), onOpenContainingFolder: vi.fn(), onGoToEntryPoint: vi.fn() }))
    expect(keys).not.toContain('module-information')
    expect(keys).not.toContain('open-containing-folder')
    expect(keys).not.toContain('go-to-entry-point')
    // A namespace owns no bytes of its own, so the hex group has nothing on it at all — not even the file
    // command, which answers for a document row and not for a part inside one.
    expect(keys.filter((key) => key.startsWith('hex-'))).toEqual([])
  })

  it('names a delete after the node it would remove, and the namespace one after itself', () => {
    // dnSpy's `DeleteX` header is "Delete {0}", filled in with the node's own name.
    const named = richContext(typeNode, { t: (message, values) => (values ? message.replace('{name}', String(values.name)) : message) })
    expect(labelOf(named, 'delete-type')).toBe('Delete Console')
    // The namespace command has a fixed header, because a namespace is not a named member.
    expect(labelOf(richContext(namespaceNode), 'delete-namespace')).toBe('Delete Namespace')
  })

  it('never shows a command this port has no equivalent for', () => {
    for (const key of UNIMPLEMENTED)
      expect(menuKeys(richContext(assemblyNode))).not.toContain(key)
  })

  it('leaves a command this port cannot run yet out until the shell can supply it', () => {
    // "Remove {name}" and the two conversion commands sit on the module; nothing runs them until the
    // backend grows the calls, and until then the entries must not be on screen at all.
    const without = richContext(moduleNode)
    expect(menuKeys(without)).not.toContain('remove-document')
    expect(menuKeys(without)).not.toContain('convert-assembly-to-netmodule')
    expect(menuKeys(without)).not.toContain('load-dependencies')
    expect(menuKeys(without)).not.toContain('open-containing-folder')

    const withCommands = richContext(moduleNode, {
      onRemoveAssembly: vi.fn(),
      onConvertModule: vi.fn(),
      onLoadDependencies: vi.fn(),
      onOpenContainingFolder: vi.fn(),
      onGoToEntryPoint: vi.fn(),
      onGoToGlobalCctor: vi.fn(),
      onGoToToken: vi.fn(),
    })
    expect(menuKeys(withCommands)).toEqual([
      'open-in-new-tab',
      'remove-document',
      'convert-assembly-to-netmodule',
      'create-type',
      'load-dependencies',
      'load-dependencies-recursively',
      'go-to-entry-point',
      'go-to-global-cctor',
      'go-to-token',
      'copy-md-token',
      'hex-0',
      'module-information',
      'open-containing-folder',
      'sort-assemblies',
    ])

    // Supplying the callback is what puts the entry on the menu *and* what it runs: the command is handed
    // the row it was opened on, whichever row inside the module that is.
    runEntry(withCommands, 'convert-assembly-to-netmodule')
    expect(withCommands.onConvertModule).toHaveBeenCalledWith(moduleNode)
  })

  it('offers the two Save commands on a resource node, and only there', () => {
    const resource: TreeNode = { id: 'n-res', kind: 'resource', label: 'sample-resource.txt', hasChildren: false }
    const entry: TreeNode = { id: 'n-entry', kind: 'resourceentry', label: 'Title', hasChildren: false }
    // Until the shell can save, the entries are not on the menu at all.
    expect(menuKeys(richContext(resource))).not.toContain('save-resource')
    expect(menuKeys(richContext(resource, { onSaveResource: vi.fn() }))).toContain('save-resource')

    // The label is dnSpy's own — "Save {name}" — and the two entries differ only in which command they run.
    const ctx = richContext(entry, { onSaveResource: vi.fn(), t: (message, values) => values ? message.replace('{name}', String(values.name)) : message })
    expect(labelOf(ctx, 'save-resource')).toBe('Save Title')
    expect(labelOf(ctx, 'save-raw-resource')).toBe('Raw Save Title')
    runEntry(ctx, 'save-raw-resource')
    expect(ctx.onSaveResource).toHaveBeenCalledWith(entry, true)

    // A module row holds no resource bytes, so saving is not offered on it even with the shell ready.
    expect(menuKeys(richContext(moduleNode, { onSaveResource: vi.fn() }))).not.toContain('save-resource')
  })

  it('offers "Move Types to Empty Namespace" only where there is an empty namespace to move into', () => {
    expect(menuKeys(richContext(namespaceNode))).not.toContain('move-types-to-empty-namespace')
    expect(menuKeys(richContext(namespaceNode, { hasEmptyNamespaceSibling: true }))).toContain('move-types-to-empty-namespace')
    // The empty namespace itself is where the types would go, so it does not offer the command.
    expect(menuKeys(richContext({ ...namespaceNode, label: '-' }, { hasEmptyNamespaceSibling: true }))).not.toContain('move-types-to-empty-namespace')
  })

  it('offers Load Dependencies on everything inside a module, and the two forms differ by their argument', () => {
    // Both entries gate on the callback, so neither is on the menu until the shell can run them.
    expect(menuKeys(richContext(moduleNode))).not.toContain('load-dependencies')

    // dnSpy's CanExecute is "the node has a module", which the assembly root satisfies through its module
    // child just as a method does through its parent.
    for (const node of [assemblyNode, moduleNode, namespaceNode, typeNode, methodNode]) {
      const ctx = richContext(node, { onLoadDependencies: vi.fn() })
      expect(menuKeys(ctx)).toContain('load-dependencies')
      expect(menuKeys(ctx)).toContain('load-dependencies-recursively')
      runEntry(ctx, 'load-dependencies')
      expect(ctx.onLoadDependencies).toHaveBeenCalledWith(node, false)
      runEntry(ctx, 'load-dependencies-recursively')
      expect(ctx.onLoadDependencies).toHaveBeenCalledWith(node, true)
    }
  })

  it('offers Add Class Breakpoint on the type it would break in, and on nothing else', () => {
    // dnSpy's CanExecute reads an ITypeDefOrRef off the row: a method row is a member, not a type, and the
    // rows above it name no type at all, so the command is offered only where there is a class to break in.
    const withClass = (node: TreeNode) => richContext(node, { onAddClassBreakpoint: vi.fn() })
    for (const node of [assemblyNode, moduleNode, namespaceNode, methodNode])
      expect(menuKeys(withClass(node))).not.toContain('add-class-breakpoint')
    expect(menuKeys(richContext(typeNode))).not.toContain('add-class-breakpoint')

    const ctx = withClass(typeNode)
    expect(menuKeys(ctx)).toContain('add-class-breakpoint')
    runEntry(ctx, 'add-class-breakpoint')
    expect(ctx.onAddClassBreakpoint).toHaveBeenCalledWith(typeNode)
  })

  it('offers Add Class Tracepoint beside the class breakpoint, on the same rows', () => {
    const withTracepoint = (node: TreeNode) => richContext(node, { onAddClassBreakpoint: vi.fn(), onAddClassTracepoint: vi.fn() })
    for (const node of [assemblyNode, moduleNode, namespaceNode, methodNode])
      expect(menuKeys(withTracepoint(node))).not.toContain('add-class-tracepoint')

    const ctx = withTracepoint(typeNode)
    const keys = menuKeys(ctx)
    // dnSpy orders it 101, right after the class breakpoint's 100.
    expect(keys.indexOf('add-class-tracepoint')).toBe(keys.indexOf('add-class-breakpoint') + 1)
    runEntry(ctx, 'add-class-tracepoint')
    expect(ctx.onAddClassTracepoint).toHaveBeenCalledWith(typeNode)
  })

  it('writes the token and the full name where dnSpy does', () => {
    const ctx = richContext(methodNode)
    runEntry(ctx, 'copy-md-token')
    expect(ctx.copyText).toHaveBeenCalledWith('0x06000001')
    runEntry(ctx, 'copy-full-name')
    expect(ctx.copyText).toHaveBeenCalledWith('System.Void System.Console::WriteLine(System.String)')
    runEntry(ctx, 'search-msdn')
    expect(ctx.onOpenUrl).toHaveBeenCalledWith('https://learn.microsoft.com/dotnet/api/System.Console.WriteLine')
  })

  it('offers Add Method Breakpoint on the rows dnSpy reads methods off, and hands it the row', () => {
    // dnSpy's GetMethodReferences takes a method, and a property or an event for the accessors it stands
    // for; a type has its class breakpoint instead, and a field names no method at all.
    const property: TreeNode = { id: 'n-prop', kind: 'property', label: 'Out', hasChildren: true, description: 'System.IO.TextWriter System.Console::Out()', metadataToken: 0x17000001 }
    const event: TreeNode = { id: 'n-event', kind: 'event', label: 'CancelKeyPress', hasChildren: true, description: 'System.ConsoleCancelEventHandler System.Console::CancelKeyPress', metadataToken: 0x14000001 }
    const field: TreeNode = { id: 'n-field', kind: 'field', label: 's_out', hasChildren: false, description: 'System.IO.TextWriter System.Console::s_out', metadataToken: 0x04000001 }
    for (const node of [property, event])
      expect(menuKeys(richContext(node))).toContain('add-method-breakpoint')
    for (const node of [typeNode, field, moduleNode])
      expect(menuKeys(richContext(node))).not.toContain('add-method-breakpoint')

    const ctx = richContext(property)
    runEntry(ctx, 'add-method-breakpoint')
    expect(ctx.onAddMethodBreakpoints).toHaveBeenCalledWith([property])
  })

  it('offers no full name on a row that has none', () => {
    const keys = menuKeys(richContext(moduleNode))
    expect(keys).not.toContain('copy-full-name')
    expect(keys).not.toContain('search-msdn')
    // A module still carries a token, which is what its copy command writes.
    expect(keys).toContain('copy-md-token')
  })

  it('hands each command the node the menu was opened on', () => {
    const ctx = richContext(methodNode)
    runEntry(ctx, 'delete-method')
    expect(ctx.onDeleteNode).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'edit-method')
    expect(ctx.onEditNode).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'edit-method-body')
    expect(ctx.onEditMethodBody).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'add-method-breakpoint')
    expect(ctx.onAddMethodBreakpoints).toHaveBeenCalledWith([methodNode])
    runEntry(ctx, 'open-in-new-tab')
    expect(ctx.onOpenInNewTab).toHaveBeenCalledWith(methodNode)
    runEntry(ctx, 'create-method')
    expect(ctx.onCreateMember).toHaveBeenCalledWith('method', false, methodNode)
    runEntry(ctx, 'create-nested-type')
    expect(ctx.onCreateMember).toHaveBeenCalledWith('type', true, methodNode)
  })

  it('opens the module in a new tab with the row it was clicked on', () => {
    const ctx = richContext(moduleNode)
    runEntry(ctx, 'hex-0')
    expect(ctx.onOpenHex).toHaveBeenCalled()
    runEntry(ctx, 'module-information')
    expect(ctx.onShowModuleInfo).toHaveBeenCalledWith(moduleNode)
  })

  it('leaves the group folders alone, since they name no document of their own', () => {
    for (const kind of ['referencesgroup', 'resourcesgroup', 'typereferencesgroup', 'basetypefolder', 'derivedtypesfolder'])
      expect(menuKeys(richContext({ id: 'g', kind, label: 'Assembly References', hasChildren: true }))).not.toContain('open-in-new-tab')
  })
})

describe('hasEmptyNamespaceSibling', () => {
  const tree = {
    parents: { 'n-ns': 'n-module' } as Record<string, string | undefined>,
    children: {
      'n-module': [
        { id: 'n-ns', kind: 'namespace', label: 'System', hasChildren: true },
        { id: 'n-empty', kind: 'namespace', label: '-', hasChildren: true },
      ],
    } as Record<string, TreeNode[] | undefined>,
  }

  it('answers for a namespace from the siblings the tree holds', () => {
    expect(hasEmptyNamespaceSibling(namespaceNode, tree.children, tree.parents)).toBe(true)
  })

  it('says no for a node that is not a namespace, and for a module with no empty one', () => {
    expect(hasEmptyNamespaceSibling(moduleNode, tree.children, tree.parents)).toBe(false)
    expect(hasEmptyNamespaceSibling(namespaceNode, { 'n-module': [{ id: 'n-ns', kind: 'namespace', label: 'System', hasChildren: true }] }, tree.parents)).toBe(false)
    expect(hasEmptyNamespaceSibling(undefined, tree.children, tree.parents)).toBe(false)
  })
})
