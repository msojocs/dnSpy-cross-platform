import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { LanguageProvider } from '../localization'
import { loadAppOptions, saveAppOptions } from './app-options'
import { AssemblyExplorer, composeTreeRowText } from './AssemblyExplorer'
import type { AssemblyExplorerCommands } from './AssemblyExplorerContextMenu'

const assembly: TreeNode = { id: 'assembly', kind: 'assembly', label: 'Example', hasChildren: true }

/** The shell's callbacks, all stubbed. A case only has to name the one it is about. */
const explorerCommands = (overrides: Partial<AssemblyExplorerCommands> = {}): AssemblyExplorerCommands => ({
  onOpenNode: vi.fn(),
  onOpenHex: vi.fn(),
  onShowHexAt: vi.fn(),
  onHexWriteBody: vi.fn(),
  onHexCopyBody: vi.fn(),
  onHexPasteBody: vi.fn(),
  ...overrides,
})

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ roots: [assembly], children: {}, expanded: {}, loadingNodes: {}, selectedNode: undefined })
})

afterEach(cleanup)

it('keeps double-clicking the expander from opening an assembly document', () => {
  const onOpenNode = vi.fn()
  render(<AssemblyExplorer commands={explorerCommands({ onOpenNode })} />)

  fireEvent.doubleClick(screen.getByRole('button', { name: 'Expand' }))
  expect(onOpenNode).not.toHaveBeenCalled()

  fireEvent.doubleClick(screen.getByRole('treeitem'))
  expect(onOpenNode).toHaveBeenCalledWith(assembly)
})

it('composes the dnSpy row text out of the return type and the token', () => {
  const method: TreeNode = { id: 'm', kind: 'method', label: 'get_Code()', hasChildren: false, metadataToken: 0x06000004, returnType: 'int' }
  expect(composeTreeRowText(method.label, method, true)).toBe('get_Code() : int @06000004')
  // Turning tokens off keeps the colon part — dnSpy's tree always names a member's type.
  expect(composeTreeRowText(method.label, method, false)).toBe('get_Code() : int')
})

it('appends the token only where dnSpy writes one', () => {
  const type: TreeNode = { id: 't', kind: 'type', label: 'HelloRequest', hasChildren: true, metadataToken: 0x02000002 }
  const reference: TreeNode = { id: 'r', kind: 'assemblyreference', label: 'dnSpy.Backend.Contracts', hasChildren: false, metadataToken: 0x23000001 }
  const namespaceNode: TreeNode = { id: 'n', kind: 'namespace', label: 'dnSpy.Backend.Contracts', hasChildren: true }
  // A group row is no metadata row, so a token must not leak into it even if one arrived.
  const group: TreeNode = { id: 'g', kind: 'referencesgroup', label: 'Assembly References', hasChildren: true, metadataToken: 0x1 }
  // The document rows — the assembly and the module read out of a file — keep the file name they wear and
  // no token, like dnSpy's assembly and module nodes.
  const assemblyRow: TreeNode = { id: 'a', kind: 'assembly', label: 'dnSpy.Backend.Contracts (1.0.0.0)', hasChildren: true, metadataToken: 0x20000001 }
  const moduleRow: TreeNode = { id: 'mo', kind: 'module', label: 'dnSpy.Backend.Contracts.dll', hasChildren: true, metadataToken: 0x1 }
  // A type's hierarchy rows name a metadata type reference, so they wear a token the way a type row does.
  // The two folders above them are dnSpy's resource-labelled group rows, so they wear none.
  const baseType: TreeNode = { id: 'bt', kind: 'basetype', label: 'object', hasChildren: true, metadataToken: 0x0100000F }
  const derivedType: TreeNode = { id: 'dt', kind: 'derivedtype', label: 'Worker', hasChildren: true, metadataToken: 0x02000005 }
  const baseTypeFolder: TreeNode = { id: 'bf', kind: 'basetypefolder', label: 'Base Type and Interfaces', hasChildren: true, metadataToken: 0x1 }
  const derivedTypesFolder: TreeNode = { id: 'df', kind: 'derivedtypesfolder', label: 'Derived Types', hasChildren: true, metadataToken: 0x1 }
  expect(composeTreeRowText(type.label, type, true)).toBe('HelloRequest @02000002')
  expect(composeTreeRowText(reference.label, reference, true)).toBe('dnSpy.Backend.Contracts @23000001')
  expect(composeTreeRowText(namespaceNode.label, namespaceNode, true)).toBe('dnSpy.Backend.Contracts')
  expect(composeTreeRowText(group.label, group, true)).toBe('Assembly References')
  expect(composeTreeRowText(assemblyRow.label, assemblyRow, true)).toBe('dnSpy.Backend.Contracts (1.0.0.0)')
  expect(composeTreeRowText(moduleRow.label, moduleRow, true)).toBe('dnSpy.Backend.Contracts.dll')
  expect(composeTreeRowText(baseType.label, baseType, true)).toBe('object @0100000F')
  expect(composeTreeRowText(derivedType.label, derivedType, true)).toBe('Worker @02000005')
  expect(composeTreeRowText(baseTypeFolder.label, baseTypeFolder, true)).toBe('Base Type and Interfaces')
  expect(composeTreeRowText(derivedTypesFolder.label, derivedTypesFolder, true)).toBe('Derived Types')
})

it('translates the hierarchy folders and leaves the type rows beside them alone', () => {
  const owner: TreeNode = { id: 'owner', kind: 'type', label: 'Worker', hasChildren: true }
  const baseTypeFolder: TreeNode = { id: 'bf', kind: 'basetypefolder', label: 'Base Type and Interfaces', hasChildren: true }
  const derivedTypesFolder: TreeNode = { id: 'df', kind: 'derivedtypesfolder', label: 'Derived Types', hasChildren: true }
  const baseType: TreeNode = { id: 'bt', kind: 'basetype', label: 'object', hasChildren: true, metadataToken: 0x0100000F }
  const derivedType: TreeNode = { id: 'dt', kind: 'derivedtype', label: 'SubWorker', hasChildren: false, metadataToken: 0x02000005 }
  useAppStore.setState({
    roots: [owner],
    children: { owner: [baseTypeFolder, derivedTypesFolder, baseType, derivedType] },
    expanded: { owner: true },
  })

  render(<LanguageProvider initialLanguage="zh-CN"><AssemblyExplorer commands={explorerCommands()} /></LanguageProvider>)

  // dnSpy labels the two folders from its resources, so they follow the UI language; the hierarchy rows
  // themselves name a type, and keep the name the decompiler would write whatever the language is.
  expect(screen.getByText('基类和接口')).toBeVisible()
  expect(screen.getByText('派生类型')).toBeVisible()
  expect(screen.getByText('object @0100000F')).toBeVisible()
  expect(screen.getByText('SubWorker @02000005')).toBeVisible()
})

it('does not open a document for a group folder row', () => {
  const onOpenNode = vi.fn()
  const folder: TreeNode = { id: 'df', kind: 'derivedtypesfolder', label: 'Derived Types', hasChildren: true }
  useAppStore.setState({ roots: [folder] })
  render(<AssemblyExplorer commands={explorerCommands({ onOpenNode })} />)

  // The folder is a heading rather than a document, so dnSpy's open commands leave it alone and only the
  // expander acts on it.
  fireEvent.doubleClick(screen.getByRole('treeitem'))
  expect(onOpenNode).not.toHaveBeenCalled()
})

it('re-reads the token option when it is saved', () => {
  useAppStore.setState({ roots: [{ id: 't', kind: 'type', label: 'Example', hasChildren: false, metadataToken: 0x02000001 }] })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  expect(screen.getByText('Example @02000001')).toBeInTheDocument()

  act(() => saveAppOptions({ ...loadAppOptions(), assemblyExplorer: { ...loadAppOptions().assemblyExplorer, showToken: false } }))
  expect(screen.getByText('Example')).toBeInTheDocument()
  expect(screen.queryByText('Example @02000001')).not.toBeInTheDocument()

  act(() => saveAppOptions({ ...loadAppOptions(), assemblyExplorer: { ...loadAppOptions().assemblyExplorer, showToken: true } }))
  expect(screen.getByText('Example @02000001')).toBeInTheDocument()
})

// A row the app selected on its own — the node of a document that just came to the front — can be
// anywhere in a long tree, so the tree scrolls it into sight. Only that node: every other row stays
// where the user left it.
it('scrolls the row the app selected on its own into view, and no other', () => {
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  useAppStore.setState({
    roots: [{ ...assembly, hasChildren: true }, { id: 'other', kind: 'assembly', label: 'Other', hasChildren: false }],
    expanded: { assembly: true },
    children: { assembly: [{ id: 'member', kind: 'method', label: 'Main()', hasChildren: false }] },
  })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  scrollIntoView.mockClear()

  act(() => useAppStore.setState({ selectedNode: { id: 'member', kind: 'method', label: 'Main()', hasChildren: false } }))

  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('treeitem', { selected: true }))

  scrollIntoView.mockRestore()
})
