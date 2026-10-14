import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { LanguageProvider } from '../localization'
import { loadAppOptions, resetAppOptions, saveAppOptions } from './app-options'
import { AssemblyExplorer, composeTreeRowText, dsImageName, iconFamily, orderTypeChildren, TreeTextSearch } from './AssemblyExplorer'
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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
  const assemblyRow: TreeNode = { id: 'a', kind: 'assembly', label: 'dnSpy.Backend.Contracts', hasChildren: true, metadataToken: 0x20000001, assemblyVersion: '1.0.0.0' }
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

it('writes a row the backend colored in its colors, and plain text with syntax highlighting off', () => {
  useAppStore.setState({ roots: [{
    id: 'm', kind: 'method', label: 'Run(int)', hasChildren: false, metadataToken: 0x06000002, returnType: 'void',
    labelParts: [{ text: 'Run', color: 'staticMethod' }, { text: '(', color: 'punctuation' }, { text: 'int', color: 'keyword' }, { text: ')', color: 'punctuation' }],
    returnTypeParts: [{ text: 'void', color: 'keyword' }],
  }] })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  const label = (): Element => screen.getByRole('treeitem').querySelector('.tree-label')!
  expect(label().textContent).toBe('Run(int) : void @06000002')
  expect([...label().querySelectorAll('span')].map((span) => [span.textContent, span.className])).toEqual([
    ['Run', 'tc-staticMethod'], ['(', 'tc-punctuation'], ['int', 'tc-keyword'], [')', 'tc-punctuation'],
    [' ', 'tc-text'], [':', 'tc-punctuation'], [' ', 'tc-text'], ['void', 'tc-keyword'],
    [' ', 'tc-text'], ['@', 'tc-operator'], ['06000002', 'tc-number'],
  ])

  act(() => saveAppOptions({ ...loadAppOptions(), assemblyExplorer: { ...loadAppOptions().assemblyExplorer, syntaxHighlight: false } }))
  expect(label().querySelector('span')).toBeNull()
  expect(label().textContent).toBe('Run(int) : void @06000002')
  // The snapshot the tree reads outlives the storage the next case clears.
  act(() => saveAppOptions(resetAppOptions()))
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

  const selectedNode = { id: 'member', kind: 'method', label: 'Main()', hasChildren: false }
  act(() => useAppStore.setState({ selectedNode, selectedNodes: [selectedNode] }))

  expect(scrollIntoView).toHaveBeenCalledTimes(1)
  expect(scrollIntoView.mock.instances[0]).toBe(screen.getByRole('treeitem', { selected: true }))

  scrollIntoView.mockRestore()
})

it('writes the assembly version and public key token the options ask for', () => {
  const row: TreeNode = { id: 'a', kind: 'assembly', label: 'mscorlib', hasChildren: true, assemblyVersion: '4.0.0.0', publicKeyToken: 'b77a5c561934e089' }
  const options = { showToken: true, showAssemblyVersion: true, showAssemblyPublicKeyToken: false }
  // dnSpy's defaults: the version, and no token.
  expect(composeTreeRowText(row.label, row, options)).toBe('mscorlib (4.0.0.0)')
  expect(composeTreeRowText(row.label, row, { ...options, showAssemblyPublicKeyToken: true })).toBe('mscorlib (4.0.0.0, b77a5c561934e089)')
  expect(composeTreeRowText(row.label, row, { ...options, showAssemblyVersion: false, showAssemblyPublicKeyToken: true })).toBe('mscorlib (b77a5c561934e089)')
  expect(composeTreeRowText(row.label, row, { ...options, showAssemblyVersion: false })).toBe('mscorlib')
  // An assembly with no public key has no token to write, even when the option asks for one.
  expect(composeTreeRowText(row.label, { ...row, publicKeyToken: null }, { ...options, showAssemblyPublicKeyToken: true })).toBe('mscorlib (4.0.0.0)')
})

it('leaves the compiler\'s inventions out unless the decompiler shows them', () => {
  const owner: TreeNode = { id: 'owner', kind: 'type', label: 'Worker', hasChildren: true }
  const run: TreeNode = { id: 'run', kind: 'method', label: 'Run()', hasChildren: false }
  const closure: TreeNode = { id: 'closure', kind: 'type', label: '<>c', hasChildren: true, compilerGenerated: true }
  useAppStore.setState({ roots: [owner], children: { owner: [run, closure] }, expanded: { owner: true } })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  expect(screen.getByText('Run()')).toBeInTheDocument()
  expect(screen.queryByText('<>c')).not.toBeInTheDocument()

  const options = loadAppOptions()
  act(() => saveAppOptions({ ...options, decompiler: { ...options.decompiler, cSharp: { ...options.decompiler.cSharp, forceShowAllMembers: true } } }))
  expect(screen.getByText('<>c')).toBeInTheDocument()
  act(() => saveAppOptions(resetAppOptions()))
})

it('puts a type\'s member groups in the order the options give, keeping each group as the backend sorted it', () => {
  const folder: TreeNode = { id: 'bf', kind: 'basetypefolder', label: 'Base Type and Interfaces', hasChildren: true }
  const method: TreeNode = { id: 'm', kind: 'method', label: 'A()', hasChildren: false }
  const method2: TreeNode = { id: 'm2', kind: 'method', label: 'B()', hasChildren: false }
  const field: TreeNode = { id: 'f', kind: 'field', label: 'x', hasChildren: false }
  const nested: TreeNode = { id: 'n', kind: 'type', label: 'Inner', hasChildren: false }
  const children = [folder, method, method2, field, nested]
  expect(orderTypeChildren(children, ['nestedTypes', 'fields', 'events', 'properties', 'methods']).map((node) => node.id)).toEqual(['bf', 'n', 'f', 'm', 'm2'])
  expect(orderTypeChildren(children, ['methods', 'properties', 'events', 'fields', 'nestedTypes']).map((node) => node.id)).toEqual(['bf', 'm', 'm2', 'f', 'n'])
})

it('expands a row on a single click while the option is on, and only selects it once it is off', () => {
  const toggleNode = vi.fn(async () => undefined)
  useAppStore.setState({ toggleNode })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  fireEvent.click(screen.getByRole('treeitem'), { detail: 1 })
  expect(toggleNode).toHaveBeenCalledWith(assembly)

  toggleNode.mockClear()
  act(() => saveAppOptions({ ...loadAppOptions(), assemblyExplorer: { ...loadAppOptions().assemblyExplorer, singleClickExpandsTreeViewChildren: false } }))
  fireEvent.click(screen.getByRole('treeitem'), { detail: 1 })
  expect(toggleNode).not.toHaveBeenCalled()
  act(() => saveAppOptions(resetAppOptions()))
})

it('activates a row that names something elsewhere instead of opening it', async () => {
  const onOpenNode = vi.fn()
  const baseType: TreeNode = { id: 'bt', kind: 'basetype', label: 'object', hasChildren: true }
  const activateNode = vi.fn(async () => true)
  useAppStore.setState({ roots: [baseType], activateNode })
  render(<AssemblyExplorer commands={explorerCommands({ onOpenNode })} />)

  fireEvent.doubleClick(screen.getByRole('treeitem'))
  await vi.waitFor(() => expect(activateNode).toHaveBeenCalledWith(baseType))
  expect(onOpenNode).not.toHaveBeenCalled()

  // A row whose target nothing on this machine provides opens as the row it is.
  activateNode.mockResolvedValueOnce(false)
  fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'Enter' })
  await vi.waitFor(() => expect(onOpenNode).toHaveBeenCalledWith(baseType))
})

it('opens files dropped on the tree in front of the root they land on, through the dragged-items filter', () => {
  const second: TreeNode = { id: 'second', kind: 'assembly', label: 'Second', hasChildren: false }
  const dropFiles = vi.fn(async () => undefined)
  useAppStore.setState({ roots: [assembly, second], dropFiles })
  Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, pathForFile: (file: File) => `/tmp/${file.name}` } })
  render(<AssemblyExplorer commands={explorerCommands()} />)

  const files = [new File([], 'a.dll'), new File([], 'b.dll')]
  fireEvent.drop(screen.getAllByRole('treeitem')[1], { dataTransfer: { types: ['Files'], files } })
  expect(dropFiles).toHaveBeenCalledWith(['/tmp/a.dll', '/tmp/b.dll'], 1, 'allSupported')

  // Below the last row is the end of the list.
  fireEvent.drop(screen.getByRole('tree'), { dataTransfer: { types: ['Files'], files } })
  expect(dropFiles).toHaveBeenLastCalledWith(['/tmp/a.dll', '/tmp/b.dll'], 2, 'allSupported')
})

it('draws dnSpy\'s image names with the family they belong to', () => {
  expect(iconFamily('ClassPublic')).toBe('class')
  expect(iconFamily('InterfacePrivate')).toBe('interface')
  expect(iconFamily('EnumerationItemPublic')).toBe('enum-item')
  expect(iconFamily('EnumerationInternal')).toBe('enum')
  expect(iconFamily('AssemblyExe')).toBe('assembly-exe')
  expect(iconFamily('AssemblyError')).toBe('error')
  expect(iconFamily('BinaryFile')).toBe('binary')
  expect(iconFamily('Template')).toBe('class')
  // The short names the search window's type box uses pass through.
  expect(iconFamily('parameter')).toBe('parameter')
  expect(iconFamily(undefined)).toBe('item')
})

it('moves the roots dragged onto another root in front of it', () => {
  const second: TreeNode = { id: 'second', kind: 'assembly', label: 'Second', hasChildren: false }
  const moveRoots = vi.fn(async () => [])
  useAppStore.setState({ roots: [assembly, second], selectedNodes: [], moveRoots })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  const store: Record<string, string> = {}
  const dataTransfer = {
    get types() { return Object.keys(store) },
    setData: (type: string, value: string) => { store[type] = value },
    getData: (type: string) => store[type] ?? '',
  }
  const [first, last] = screen.getAllByRole('treeitem')
  fireEvent.dragStart(last, { dataTransfer })
  fireEvent.drop(first, { dataTransfer })
  expect(moveRoots).toHaveBeenCalledWith(['second'], 0)
})

it('draws an assembly row\'s colored name without its version part, and keeps a row that has none whole', () => {
  const versioned: TreeNode = {
    id: 'a', kind: 'assembly', label: 'Example', hasChildren: true, assemblyVersion: '1.0.0.0',
    labelParts: [{ text: 'Example', color: 'assembly' }, { text: ' ', color: 'text' }, { text: '(', color: 'punctuation' }, { text: '1.0.0.0', color: 'number' }, { text: ')', color: 'punctuation' }],
  }
  // After Convert Assembly to NetModule the root names the module file, in one part with no version.
  const converted: TreeNode = { id: 'c', kind: 'assembly', label: 'Example.dll', hasChildren: true, labelParts: [{ text: 'Example.dll', color: 'assemblyModule' }] }
  useAppStore.setState({ roots: [versioned, converted] })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  const [first, second] = screen.getAllByRole('treeitem').map((row) => row.querySelector('.tree-label')!.textContent)
  expect(first).toBe('Example (1.0.0.0)')
  expect(second).toBe('Example.dll')
})

describe('the tree keys', () => {
  const root: TreeNode = { id: 'root', kind: 'assembly', label: 'Root', hasChildren: true }
  const alpha: TreeNode = { id: 'alpha', kind: 'type', label: 'Alpha', hasChildren: false }
  const beta: TreeNode = { id: 'beta', kind: 'type', label: 'Beta', hasChildren: false }
  const gamma: TreeNode = { id: 'gamma', kind: 'type', label: 'Gamma', hasChildren: false }
  const other: TreeNode = { id: 'other', kind: 'assembly', label: 'Other', hasChildren: false }

  const renderTree = (onOpenNode = vi.fn()): ReturnType<typeof vi.fn> => {
    useAppStore.setState({
      roots: [root, other],
      children: { root: [alpha, beta, gamma] },
      parents: { alpha: 'root', beta: 'root', gamma: 'root' },
      expanded: { root: true },
      selectedNode: alpha,
      selectedNodes: [alpha],
      selectionAnchorId: 'alpha',
    })
    render(<AssemblyExplorer commands={explorerCommands({ onOpenNode })} />)
    return onOpenNode
  }
  const row = (label: string): HTMLElement => screen.getByRole('treeitem', { name: new RegExp(`^${label}`) })
  const selected = (): string[] => useAppStore.getState().selectedNodes.map((node) => node.id)

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  })

  it('moves the selection with the arrows, Home and End, and spans a range with Shift from the anchor', () => {
    renderTree()
    fireEvent.keyDown(row('Alpha'), { key: 'ArrowDown' })
    expect(selected()).toEqual(['beta'])
    expect(document.activeElement).toBe(row('Beta'))
    fireEvent.keyDown(row('Beta'), { key: 'ArrowDown', shiftKey: true })
    expect(selected()).toEqual(['beta', 'gamma'])
    // The anchor stays on the row selected on its own, so the range grows and shrinks from there.
    fireEvent.keyDown(row('Gamma'), { key: 'ArrowDown', shiftKey: true })
    expect(selected()).toEqual(['beta', 'gamma', 'other'])
    fireEvent.keyDown(row('Other'), { key: 'Home', shiftKey: true })
    expect(selected()).toEqual(['root', 'alpha', 'beta'])
    fireEvent.keyDown(row('Root'), { key: 'End' })
    expect(selected()).toEqual(['other'])
    fireEvent.keyDown(row('Other'), { key: 'ArrowUp' })
    expect(selected()).toEqual(['gamma'])
  })

  it('moves only the focus with Ctrl, and toggles the focused row with Ctrl+Space', () => {
    renderTree()
    fireEvent.keyDown(row('Alpha'), { key: 'ArrowDown', ctrlKey: true })
    fireEvent.keyDown(row('Beta'), { key: 'ArrowDown', ctrlKey: true })
    expect(selected()).toEqual(['alpha'])
    expect(document.activeElement).toBe(row('Gamma'))
    fireEvent.keyDown(row('Gamma'), { key: ' ', ctrlKey: true })
    expect(selected()).toEqual(['alpha', 'gamma'])
    fireEvent.keyDown(row('Gamma'), { key: 'a', ctrlKey: true })
    expect(selected()).toEqual(['root', 'alpha', 'beta', 'gamma', 'other'])
  })

  it('goes up to the parent with Left, collapses an open row, and opens and enters one with Right', () => {
    const expandNode = vi.fn(async () => undefined)
    const toggleNode = vi.fn(async () => undefined)
    renderTree()
    useAppStore.setState({ expandNode, toggleNode })
    fireEvent.keyDown(row('Alpha'), { key: 'ArrowLeft' })
    expect(selected()).toEqual(['root'])
    fireEvent.keyDown(row('Root'), { key: 'ArrowLeft' })
    expect(toggleNode).toHaveBeenCalledWith(root)
    // An open row's Right goes to its first child.
    fireEvent.keyDown(row('Root'), { key: 'ArrowRight' })
    expect(selected()).toEqual(['alpha'])
    act(() => useAppStore.setState({ expanded: {} }))
    fireEvent.keyDown(row('Root'), { key: 'ArrowRight' })
    expect(expandNode).toHaveBeenCalledWith(root)
    // The keypad's + and * open a row too, and its − closes one.
    expandNode.mockClear()
    fireEvent.keyDown(row('Root'), { key: '*', code: 'NumpadMultiply' })
    expect(expandNode).toHaveBeenCalledWith(root)
  })

  it('activates the one selected row with Enter or Space', () => {
    const onOpenNode = renderTree()
    fireEvent.keyDown(row('Alpha'), { key: 'Enter' })
    expect(onOpenNode).toHaveBeenCalledWith(alpha)
    onOpenNode.mockClear()
    fireEvent.keyDown(row('Alpha'), { key: ' ' })
    expect(onOpenNode).toHaveBeenCalledWith(alpha)
    // With more than one row selected there is no one row to activate.
    onOpenNode.mockClear()
    act(() => useAppStore.setState({ selectedNodes: [alpha, beta] }))
    fireEvent.keyDown(row('Alpha'), { key: 'Enter' })
    expect(onOpenNode).not.toHaveBeenCalled()
  })

  it('selects the row whose text starts with what was typed, stepping through rows on the same letter', () => {
    renderTree()
    fireEvent.keyDown(row('Alpha'), { key: 'g' })
    expect(selected()).toEqual(['gamma'])
    fireEvent.keyDown(row('Gamma'), { key: 'o' })
    // "go" starts no row; the search keeps what it had.
    expect(selected()).toEqual(['gamma'])
    fireEvent.keyDown(row('Gamma'), { key: 'Backspace' })
    fireEvent.keyDown(row('Gamma'), { key: 'R' })
    expect(selected()).toEqual(['root'])
  })

  it('leaves the key that ends a bookmark chord to the chord', () => {
    renderTree()
    const chord = vi.fn()
    window.addEventListener('keydown', chord)
    fireEvent.keyDown(row('Alpha'), { key: 'k', ctrlKey: true })
    fireEvent.keyDown(row('Alpha'), { key: 'g' })
    // The tree selected nothing, and the shell saw both keys.
    expect(selected()).toEqual(['alpha'])
    expect(chord).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', chord)
  })
})

describe('TreeTextSearch', () => {
  it('matches a growing prefix, and steps on a repeated letter', () => {
    const search = new TreeTextSearch(60_000)
    const rows = ['Alpha', 'Beta', 'Bravo', 'Bets', 'Charlie']
    expect(search.search(rows, 'b', 0)).toBe(1)
    // The prefix grows: "be" is still the row it is on, so nothing moves.
    expect(search.search(rows, 'e', 1)).toBe(-1)
    expect(search.search(rows, 't', 1)).toBe(-1)
    expect(search.search(rows, 's', 1)).toBe(3)
    search.clear()
    expect(search.search(rows, 'b', 0)).toBe(1)
    // The same letter again: no row starts "bb", so the next one starting "b" is taken.
    expect(search.search(rows, 'b', 1)).toBe(2)
    expect(search.search(rows, 'b', 2)).toBe(3)
    search.clear()
  })
})

it('draws dnSpy\'s own image for a row, and a family drawing for a name it has none for', () => {
  useAppStore.setState({ roots: [
    { id: 'c', kind: 'type', label: 'Private', hasChildren: false, icon: 'ClassPrivate' },
    { id: 'x', kind: 'type', label: 'Unknown', hasChildren: false, icon: 'NoSuchImage' },
  ] })
  render(<AssemblyExplorer commands={explorerCommands()} />)
  const [known, unknown] = screen.getAllByRole('treeitem')
  expect(known.querySelector('.ds-image.dsi-ClassPrivate')).not.toBeNull()
  // The image itself is the rule the shared stylesheet holds for its class.
  expect(document.head.querySelector('style[data-ds-images]')?.textContent).toMatch(/\.dsi-ClassPrivate\{background-image:url\("data:image\/svg\+xml/)
  expect(unknown.querySelector('.ds-image')).toBeNull()
  expect(unknown.querySelector('svg')).not.toBeNull()
  expect(dsImageName('FolderClosed', true)).toBe('FolderOpened')
  expect(dsImageName('class')).toBe('ClassPublic')
})
