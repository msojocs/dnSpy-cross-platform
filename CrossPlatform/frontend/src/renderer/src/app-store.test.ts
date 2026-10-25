import { Actions, DockLocation, Model, TabSetNode } from 'flexlayout-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { CodeStatement, DebugBreakpoint, DebugCodeTargets, DebugMethodTarget, DebugStackFrame, DecompilerLanguage, HexMethodTarget, HexTargetResponse, SaveDocumentsResponse, TextSpan, TreeNode } from '../../shared/protocol'
import { isNavigableSpan } from '../../shared/protocol'
import { bookmarkEntries, bookmarkLineInDocument, bookmarkMarkers, breakpointImage, breakpointKind, breakpointsFile, buildSession, bytesToHex, clipboardHexLength, codeHexContextOf, codeStatementAt, enableSessionPersistence, filterBookmarks, lineBreakpointEntries, lineBreakpointMarkers, loadRecentFiles, loadSession, methodBreakpointName, rememberRecentFiles, memoryModulePathOf, orderedDocumentKeys, resetDebugSessionTracking, ownerTypeIdOf, parseBookmarkEntries, parseHexText, parseLineBreakpointEntries, statementIdentity, suggestCodeFilename, syncDockTabStrips, useAppStore } from './app-store'
import type { Bookmark, DocumentState, LineBreakpoint, SessionSource } from './app-store'
import { moduleSaveOptions } from './components/save-options-fixtures'
import { translate } from './localization'

// Session ids repeat from test to test; what one test ended must not silence the next one's events.
beforeEach(() => resetDebugSessionTracking())

describe('suggestCodeFilename', () => {
  it.each([
    ['Example', 'csharp', 'Example.cs'],
    ['Example', 'visual-basic', 'Example.vb'],
    ['Example', 'il', 'Example.il'],
    ['View.xaml', 'xml', 'View.xaml.xml'],
    ['Resource', 'plaintext', 'Resource.txt'],
    // BamlTabSaver: a BAML entry saves as its XAML, or as its records when disassembled (BamlResourceElementNode.GetFilename).
    ['view.baml', 'xaml', 'view.xaml'],
    ['view.baml', 'baml', 'view.baml'],
    ['themes/generic.baml', 'xaml', 'generic.xaml'],
    ['view.xaml', 'baml', 'view.baml'],
    ['view.bin', 'xaml', 'view.bin.xaml'],
  ])('uses the current document language for %s', (title, language, expected) => {
    expect(suggestCodeFilename(title, language)).toBe(expected)
  })

  it('removes characters that are invalid in native save dialogs', () => {
    expect(suggestCodeFilename('A/B:C*? ', 'csharp')).toBe('A_B_C__.cs')
    expect(suggestCodeFilename('...', 'il')).toBe('code.il')
  })
})

describe('methodBreakpointName', () => {
  it.each([
    ['System.Void DebugTarget.Program::Calculate(System.Int32,System.Int32)', 'DebugTarget.Program.Calculate'],
    ['System.Void System.Resources.ResourceManager::.ctor(System.Type)', 'System.Resources.ResourceManager..ctor'],
    ['System.Collections.Generic.List`1<System.Int32> Ns.Type::M()', 'Ns.Type.M'],
    ['System.Int32[] Ns.Type::M()', 'Ns.Type.M'],
    ['System.Void Ns.Outer/Inner::M()', 'Ns.Outer.Inner.M'],
    ['DebugTarget.Program.Calculate', 'DebugTarget.Program.Calculate'],
    ['DebugTarget.Program.Calculate(System.Int32)', 'DebugTarget.Program.Calculate'],
    ['', undefined],
    ['   ', undefined],
    [undefined, undefined],
  ])('normalizes %s', (description, expected) => {
    expect(methodBreakpointName(description)).toBe(expected)
  })
})

const statement = (startLine: number, endLine: number, extra: Partial<CodeStatement> = {}): CodeStatement => ({
  startLine,
  endLine,
  startColumn: 1,
  endColumn: 80,
  ilOffset: startLine,
  ilEndOffset: endLine,
  sequencePointIlOffset: startLine,
  modulePath: '/app/DebugTarget.dll',
  metadataToken: 0x06000001,
  sourceMethodToken: 0x06000001,
  description: 'System.Void Ns.Type::M()',
  isHidden: false,
  ...extra,
})

describe('codeStatementAt', () => {
  const outer = statement(3, 20)
  const inner = statement(8, 10, { description: 'System.Void Ns.Type::Inner()' })

  it('picks the innermost statement that contains the line', () => {
    expect(codeStatementAt([outer, inner], 9)).toBe(inner)
    expect(codeStatementAt([inner, outer], 4)).toBe(outer)
  })

  it('treats the first and last line of a range as inside it', () => {
    expect(codeStatementAt([outer], 3)).toBe(outer)
    expect(codeStatementAt([outer], 20)).toBe(outer)
  })

  it('snaps a click between statements to the nearest one below it', () => {
    const above = statement(2, 2)
    const below = statement(6, 6)
    expect(codeStatementAt([above, below], 4)).toBe(below)
    // A tie goes downwards, matching the backend's snapping.
    expect(codeStatementAt([statement(3, 3), statement(5, 5)], 4)?.startLine).toBe(5)
  })

  it('falls back to the nearest statement above when nothing is below', () => {
    expect(codeStatementAt([statement(2, 2)], 9)?.startLine).toBe(2)
  })

  it('uses the column to tell single-line statements apart', () => {
    const left = statement(4, 4, { startColumn: 1, endColumn: 10, ilOffset: 1 })
    const right = statement(4, 4, { startColumn: 12, endColumn: 30, ilOffset: 2 })
    expect(codeStatementAt([left, right], 4, 5)).toBe(left)
    expect(codeStatementAt([left, right], 4, 20)).toBe(right)
  })

  it('never snaps onto a hidden statement', () => {
    const hidden = statement(4, 4, { isHidden: true })
    const visible = statement(9, 9)
    expect(codeStatementAt([hidden, visible], 4)).toBe(visible)
  })

  it('returns nothing when there is nothing to snap to', () => {
    expect(codeStatementAt([], 3)).toBeUndefined()
    expect(codeStatementAt(undefined, 3)).toBeUndefined()
  })
})

describe('lineBreakpointMarkers', () => {
  const breakpoint = (extra: Partial<LineBreakpoint> = {}): LineBreakpoint => ({
    id: 'line1',
    nodeId: 'method-1',
    identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
    requestedLine: 9,
    line: 9,
    endLine: 9,
    state: 'bound',
    enabled: true,
    modulePath: '/app/DebugTarget.dll',
    metadataToken: 0x06000001,
    ilOffset: 7,
    order: 1,
    ...extra,
  })

  it('draws a breakpoint on the statement its code location is in', () => {
    const statements = [statement(5, 6, { ilOffset: 3, ilEndOffset: 7 }), statement(7, 8, { ilOffset: 7, ilEndOffset: 12 })]
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint()]).map((marker) => marker.line)).toEqual([7])
    // An instruction in the middle of a statement — an IL view's breakpoint — is drawn on the statement that holds it.
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint({ ilOffset: 9 })]).map((marker) => marker.line)).toEqual([7])
    // A method's entry, before its first statement, is drawn on the first statement after it.
    expect(lineBreakpointMarkers('method-1', [statement(5, 6, { ilOffset: 3, ilEndOffset: 7, sequencePointIlOffset: 3 })], [breakpoint({ ilOffset: 0 })]).map((marker) => marker.line)).toEqual([5])
  })

  it('draws a pending breakpoint at the line the user clicked', () => {
    const markers = lineBreakpointMarkers('method-1', [statement(7, 8, { ilOffset: 7 })], [
      breakpoint({ state: 'pending', modulePath: undefined, ilOffset: undefined }),
    ])
    expect(markers.map((marker) => marker.line)).toEqual([9])
  })

  it('draws nothing in a document that is not the breakpoint’s', () => {
    const statements = [statement(7, 8, { ilOffset: 7 })]
    // Another method's location has no statement here, and there is no requested line to fall back on.
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint({ metadataToken: 0x06000002 })])).toEqual([])
    // Not yet bound, and requested from a different node.
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint({ nodeId: 'method-2', modulePath: undefined, ilOffset: undefined })])).toEqual([])
  })
})

describe('breakpointKind', () => {
  it('picks dnSpy\'s glyph from the settings and the bound message', () => {
    expect(breakpointKind({ enabled: true })).toBe('BreakpointEnabled')
    expect(breakpointKind({ enabled: false })).toBe('BreakpointDisabled')
    expect(breakpointKind({ enabled: true, settings: { hitCount: { kind: 'equals', count: 2 } } })).toBe('AdvancedBreakpointEnabled')
    // A trace that continues makes a tracepoint; one that breaks is still a breakpoint.
    expect(breakpointKind({ enabled: true, settings: { trace: { message: 'x', continue: true } } })).toBe('TracepointEnabled')
    expect(breakpointKind({ enabled: true, settings: { trace: { message: 'x', continue: false } } })).toBe('BreakpointEnabled')
    expect(breakpointKind({ enabled: true, severity: 'warning' })).toBe('BreakpointWarning')
    expect(breakpointKind({ enabled: true, severity: 'error', settings: { filter: 'ThreadId == 1' } })).toBe('AdvancedBreakpointError')
    // The advanced warning and error kinds have no images of their own.
    expect(breakpointImage('AdvancedBreakpointError')).toBe('BreakpointError')
    expect(breakpointImage('AdvancedTracepointWarning')).toBe('TracepointWarning')
    expect(breakpointImage('AdvancedTracepointEnabled')).toBe('AdvancedTracepointEnabled')
  })
})

describe('toggleLineBreakpoint', () => {
  const setBreakpoints = vi.fn(async () => [])

  beforeEach(() => {
    setBreakpoints.mockClear()
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, setBreakpoints } })
    const document = { nodeId: 'method-1', language: 'il', codeStatements: [statement(4, 4, { ilOffset: 2, ilEndOffset: 3 }), statement(5, 5, { ilOffset: 3, ilEndOffset: 8 })] } as unknown as DocumentState
    useAppStore.setState({ lineBreakpoints: [], debugSessionId: undefined, documents: { 'method-1': document } })
  })

  it('adds a breakpoint at an IL instruction, deletes it when every one there is enabled and enables one that is not', async () => {
    await useAppStore.getState().toggleLineBreakpoint('method-1', 5)
    const [added] = useAppStore.getState().lineBreakpoints
    expect(added).toMatchObject({ modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 3, enabled: true })

    useAppStore.setState({ lineBreakpoints: [{ ...added, enabled: false }] })
    await useAppStore.getState().toggleLineBreakpoint('method-1', 5)
    expect(useAppStore.getState().lineBreakpoints).toMatchObject([{ id: added.id, enabled: true }])

    await useAppStore.getState().toggleLineBreakpoint('method-1', 5)
    expect(useAppStore.getState().lineBreakpoints).toEqual([])
  })
})

describe('function breakpoints', () => {
  const setFunctionBreakpoints = vi.fn(async () => ({}))

  beforeEach(() => {
    setFunctionBreakpoints.mockClear()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, setFunctionBreakpoints },
    })
    useAppStore.setState({ functionBreakpoints: [], debugSessionId: 'session' })
  })

  it('adds, toggles and removes breakpoints', async () => {
    await useAppStore.getState().addFunctionBreakpoint(' Ns.Type.A ')
    await useAppStore.getState().addFunctionBreakpoint('Ns.Type.A')
    expect(useAppStore.getState().functionBreakpoints).toEqual([{ name: 'Ns.Type.A', enabled: true }])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ id: 'fn:Ns.Type.A', name: 'Ns.Type.A' }])

    await useAppStore.getState().toggleFunctionBreakpoint('Ns.Type.A')
    expect(useAppStore.getState().functionBreakpoints).toEqual([])

    await useAppStore.getState().toggleFunctionBreakpoint('Ns.Type.B')
    expect(useAppStore.getState().functionBreakpoints).toEqual([{ name: 'Ns.Type.B', enabled: true }])
  })

  it('sends only enabled breakpoints to the debug adapter, with their settings', async () => {
    useAppStore.setState({
      functionBreakpoints: [
        { name: 'Ns.Type.A', enabled: true, settings: { condition: { kind: 'isTrue', expression: 'Code > 1' } } },
        { name: 'Ns.Type.B', enabled: false },
      ],
    })
    await useAppStore.getState().addFunctionBreakpoint('Ns.Type.C')
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [
      { id: 'fn:Ns.Type.A', name: 'Ns.Type.A', settings: { condition: { kind: 'isTrue', expression: 'Code > 1' } } },
      { id: 'fn:Ns.Type.C', name: 'Ns.Type.C' },
    ])
  })

  it('enables and disables every breakpoint', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }, { name: 'Ns.Type.B', enabled: false }] })

    await useAppStore.getState().setAllFunctionBreakpointsEnabled(false)
    expect(useAppStore.getState().functionBreakpoints.every((breakpoint) => !breakpoint.enabled)).toBe(true)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [])

    await useAppStore.getState().setAllFunctionBreakpointsEnabled(true)
    expect(useAppStore.getState().functionBreakpoints.every((breakpoint) => breakpoint.enabled)).toBe(true)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ id: 'fn:Ns.Type.A', name: 'Ns.Type.A' }, { id: 'fn:Ns.Type.B', name: 'Ns.Type.B' }])
  })

  it('enables and disables a single breakpoint', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }, { name: 'Ns.Type.B', enabled: false }] })

    await useAppStore.getState().setFunctionBreakpointEnabled('Ns.Type.B', true)
    expect(useAppStore.getState().functionBreakpoints).toEqual([
      { name: 'Ns.Type.A', enabled: true },
      { name: 'Ns.Type.B', enabled: true },
    ])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ id: 'fn:Ns.Type.A', name: 'Ns.Type.A' }, { id: 'fn:Ns.Type.B', name: 'Ns.Type.B' }])

    await useAppStore.getState().setFunctionBreakpointEnabled('Ns.Type.A', false)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ id: 'fn:Ns.Type.B', name: 'Ns.Type.B' }])
  })

  it('deletes every breakpoint', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }] })
    await useAppStore.getState().deleteAllFunctionBreakpoints()
    expect(useAppStore.getState().functionBreakpoints).toEqual([])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [])
  })

  it('keeps breakpoints without sending them when no debug session is active', async () => {
    useAppStore.setState({ debugSessionId: undefined })
    await useAppStore.getState().addFunctionBreakpoint('Ns.Type.A')
    expect(useAppStore.getState().functionBreakpoints).toEqual([{ name: 'Ns.Type.A', enabled: true }])
    expect(setFunctionBreakpoints).not.toHaveBeenCalled()
  })
})

describe('method and class breakpoints', () => {
  const setBreakpoints = vi.fn(async () => [])
  const getDebugCodeTargets = vi.fn()

  const typeNode: TreeNode = { id: 'n-type', kind: 'type', label: 'Console', hasChildren: true }
  const method = (token: number, description: string, hasBody = true): DebugMethodTarget => ({ modulePath: '/app/A.dll', metadataToken: token, description, hasBody })

  const install = (targets: DebugCodeTargets): void => {
    getDebugCodeTargets.mockReset().mockImplementation(async () => targets)
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getDebugCodeTargets, setBreakpoints },
    })
  }

  beforeEach(() => {
    setBreakpoints.mockClear()
    useAppStore.setState({ workspaceId: 'ws1', lineBreakpoints: [], debugSessionId: 'session' })
  })

  it('breaks at the entry of every method of the type that has code, in one request', async () => {
    install({ methods: [], typeMethods: [method(0x06000001, 'System.Void Ns.Type::.ctor()'), method(0x06000002, 'System.Int32 Ns.Type::Get()'), method(0x06000003, 'System.Void Ns.Type::Abstract()', false)], typeName: 'Ns.Type' })

    await useAppStore.getState().addClassBreakpoint(typeNode)

    expect(getDebugCodeTargets).toHaveBeenCalledWith('ws1', [{ nodeId: 'n-type' }])
    expect(useAppStore.getState().lineBreakpoints.map((breakpoint) => [breakpoint.metadataToken, breakpoint.ilOffset, breakpoint.description])).toEqual([
      [0x06000001, 0, 'System.Void Ns.Type::.ctor()'],
      [0x06000002, 0, 'System.Int32 Ns.Type::Get()'],
    ])
    expect(setBreakpoints).toHaveBeenCalledTimes(1)
  })

  it('leaves a location that already has a breakpoint alone, and puts a class tracepoint\'s settings on the others', async () => {
    install({ methods: [], typeMethods: [method(0x06000001, 'System.Void Ns.Type::Get()'), method(0x06000002, 'System.Void Ns.Type::Put()')] })
    await useAppStore.getState().addMethodBreakpoints([{ modulePath: '/app/A.dll', metadataToken: 0x06000002 }])
    install({ methods: [method(0x06000002, 'System.Void Ns.Type::Put()')], typeMethods: [method(0x06000001, 'System.Void Ns.Type::Get()'), method(0x06000002, 'System.Void Ns.Type::Put()')] })
    const settings = { trace: { message: 'entered {$FUNCTION}', continue: true } }
    useAppStore.setState({ lineBreakpoints: [] })
    await useAppStore.getState().addMethodBreakpoints([{ modulePath: '/app/A.dll', metadataToken: 0x06000002 }])

    await useAppStore.getState().addClassBreakpoint(typeNode, settings)

    expect(useAppStore.getState().lineBreakpoints.map((breakpoint) => [breakpoint.metadataToken, breakpoint.settings])).toEqual([
      [0x06000002, undefined],
      [0x06000001, settings],
    ])
  })

  it('adds a method breakpoint for each method the references collect, never taking one away', async () => {
    install({ methods: [method(0x06000005, 'System.Int32 Ns.Type::get_Code()'), method(0x06000006, 'System.Void Ns.Type::set_Code(System.Int32)')] })
    const property: TreeNode = { id: 'n-code', kind: 'property', label: 'Code', hasChildren: true }

    await useAppStore.getState().addMethodBreakpoints([property])
    await useAppStore.getState().addMethodBreakpoints([property])

    expect(getDebugCodeTargets).toHaveBeenLastCalledWith('ws1', [{ nodeId: 'n-code' }])
    expect(useAppStore.getState().lineBreakpoints.map((breakpoint) => breakpoint.metadataToken)).toEqual([0x06000005, 0x06000006])
  })
})

describe('collapseTreeViewNodes', () => {
  const node = (id: string, kind = 'type'): TreeNode => ({ id, label: id, kind, hasChildren: true })

  const seed = (overrides: Partial<ReturnType<typeof useAppStore.getState>> = {}): void => {
    useAppStore.setState({
      // assembly > ns > type > method, all expanded.
      expanded: { assembly: true, ns: true, type: true, method: true, other: true },
      parents: { ns: 'assembly', type: 'ns', method: 'type', other: 'assembly' },
      children: { assembly: [node('ns')], ns: [node('type')], type: [node('method')] },
      selectedNode: node('method', 'method'),
      ...overrides,
    })
  }

  it('keeps the selected node and its ancestors expanded and collapses the rest', () => {
    seed()
    useAppStore.getState().collapseTreeViewNodes()
    expect(useAppStore.getState().expanded).toEqual({
      assembly: true,
      ns: true,
      type: true,
      method: true,
      other: false,
    })
  })

  it('collapses everything when nothing is selected', () => {
    seed({ selectedNode: undefined })
    useAppStore.getState().collapseTreeViewNodes()
    expect(Object.values(useAppStore.getState().expanded).every((value) => !value)).toBe(true)
  })

  it('keeps an ancestor expanded even when it was never toggled, as long as its children are loaded', () => {
    seed({ expanded: { method: true, other: true }, selectedNode: node('method', 'method') })
    useAppStore.getState().collapseTreeViewNodes()
    expect(useAppStore.getState().expanded).toEqual({
      assembly: true,
      ns: true,
      type: true,
      method: true,
      other: false,
    })
  })

  it('leaves an unwanted ancestor collapsed when its children were never loaded', () => {
    // `ns` is on the path to the selection but has no cached children, so expanding it would need a
    // backend round trip the collapse never asked for.
    seed({ expanded: { method: true }, parents: { type: 'ns', method: 'type' }, children: { type: [node('method')] } })
    useAppStore.getState().collapseTreeViewNodes()
    expect(useAppStore.getState().expanded).toEqual({ type: true, method: true })
  })
})

describe('ownerTypeIdOf', () => {
  const node = (id: string, kind: string): TreeNode => ({ id, label: id, kind, hasChildren: false })
  const parents = { ns: 'module', type: 'ns', method: 'type', field: 'type', property: 'type', event: 'type' }
  const nodesById = new Map(
    [['module', 'module'], ['ns', 'namespace'], ['type', 'type'], ['method', 'method'], ['field', 'field'], ['property', 'property'], ['event', 'event']]
      .map(([id, kind]): [string, TreeNode] => [id, node(id, kind)]),
  )

  it('is the node itself for a selected type', () => {
    expect(ownerTypeIdOf(nodesById, parents, node('type', 'type'))).toBe('type')
  })

  it.each(['method', 'field', 'property', 'event'])('is the declaring type for a selected %s', (kind) => {
    expect(ownerTypeIdOf(nodesById, parents, node(kind, kind))).toBe('type')
  })

  it('is the declaring type for an accessor nested under its property', () => {
    const nested = new Map(nodesById)
    nested.set('get_code', node('get_code', 'method'))
    expect(ownerTypeIdOf(nested, { ...parents, get_code: 'property' }, node('get_code', 'method'))).toBe('type')
  })

  it.each(['namespace', 'module', 'referencesgroup', 'resource'])('has no owner for a %s', (kind) => {
    expect(ownerTypeIdOf(nodesById, parents, node('other', kind))).toBeUndefined()
  })

  it('has no owner with nothing selected', () => {
    expect(ownerTypeIdOf(nodesById, parents, undefined)).toBeUndefined()
  })

  it('has no owner for a member the tree never linked to a parent', () => {
    expect(ownerTypeIdOf(nodesById, {}, node('method', 'method'))).toBeUndefined()
  })

  it('has no owner for a member whose listed ancestors hold no type', () => {
    expect(ownerTypeIdOf(nodesById, { method: 'namespace' }, node('method', 'method'))).toBeUndefined()
  })
})

describe('line breakpoints', () => {
  const statements = [statement(4, 4, { ilOffset: 5 }), statement(9, 9, { ilOffset: 7 })]
  const setBreakpoints = vi.fn(async (_sessionId: string, requested: { id: string; line: number; enabled: boolean }[]): Promise<DebugBreakpoint[]> =>
    requested.map((breakpoint) => ({
      id: breakpoint.id,
      verified: true,
      state: 'bound',
      line: 9,
      endLine: 9,
      column: 1,
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 7,
      description: 'System.Void Ns.Type::M()',
      enabled: breakpoint.enabled,
    })))

  const document = (codeStatements: CodeStatement[] | undefined): never => ({
    nodeId: 'method-1',
    title: 'M',
    language: 'csharp',
    text: '',
    spans: [],
    diagnostics: [],
    codeStatements,
    loading: false,
    requestedLanguage: 'cSharp',
  }) as never

  beforeEach(() => {
    setBreakpoints.mockClear()
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, setBreakpoints } })
    useAppStore.setState({
      lineBreakpoints: [],
      functionBreakpoints: [],
      debugSessionId: 'session',
      documents: { 'method-1': document(statements) },
    })
  })

  it('snaps a click to the nearest statement and records what the engine answered', async () => {
    // Line 6 is blank; the nearest statement below it is the one on line 9.
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)
    const [breakpoint] = useAppStore.getState().lineBreakpoints
    expect(breakpoint.requestedLine).toBe(6)
    expect(breakpoint.line).toBe(9)
    expect(breakpoint.state).toBe('bound')
    expect(breakpoint.identity).toBe(statementIdentity('/app/DebugTarget.dll', 0x06000001, 7))
    expect(setBreakpoints).toHaveBeenLastCalledWith('session', [{
      id: breakpoint.id,
      nodeId: 'method-1',
      line: 6,
      enabled: true,
      // The click already knew an IL location — its own guess at the nearest statement — and it is
      // sent so a breakpoint that outlives its node id can still be resolved. The engine's answer
      // below overrides it.
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 5,
    }])
  })

  it('adopts the engine’s answer when the document has no IL map of its own', async () => {
    // An IL view has no statement table, so the client cannot snap the click itself and starts from the raw line.
    useAppStore.setState({ documents: { 'method-1': document(undefined) } })
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)
    expect(useAppStore.getState().lineBreakpoints[0]).toMatchObject({
      requestedLine: 6,
      line: 9,
      state: 'bound',
      identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
    })
  })

  it('removes a breakpoint when the same statement is clicked again', async () => {
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)
    // The user now clicks the dot where it was drawn, not the line they originally clicked.
    await useAppStore.getState().toggleLineBreakpoint('method-1', 9)
    expect(useAppStore.getState().lineBreakpoints).toEqual([])
  })

  it('sends disabled breakpoints too, so the engine can disarm them in place', async () => {
    await useAppStore.getState().toggleLineBreakpoint('method-1', 9)
    const [breakpoint] = useAppStore.getState().lineBreakpoints
    await useAppStore.getState().setLineBreakpointEnabled(breakpoint.id, false)
    expect(setBreakpoints).toHaveBeenLastCalledWith('session', [{
      id: breakpoint.id,
      nodeId: 'method-1',
      line: 9,
      enabled: false,
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 7,
    }])
    expect(useAppStore.getState().lineBreakpoints[0].enabled).toBe(false)
  })

  it('deletes line and function breakpoints together', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }] })
    await useAppStore.getState().toggleLineBreakpoint('method-1', 9)
    await useAppStore.getState().deleteAllBreakpoints()
    expect(useAppStore.getState().lineBreakpoints).toEqual([])
    expect(useAppStore.getState().functionBreakpoints).toEqual([])
    expect(setBreakpoints).toHaveBeenLastCalledWith('session', [])
  })

  it('keeps breakpoints without sending them when no debug session is active', async () => {
    useAppStore.setState({ debugSessionId: undefined })
    await useAppStore.getState().toggleLineBreakpoint('method-1', 9)
    expect(useAppStore.getState().lineBreakpoints).toHaveLength(1)
    expect(setBreakpoints).not.toHaveBeenCalled()
  })
})

describe('breakpoint persistence', () => {
  const statements = [statement(4, 4, { ilOffset: 5 }), statement(9, 9, { ilOffset: 7 })]
  const setBreakpoints = vi.fn(async (_sessionId: string, requested: { id: string; enabled: boolean }[]): Promise<DebugBreakpoint[]> =>
    requested.map((breakpoint) => ({
      id: breakpoint.id,
      verified: true,
      state: 'bound',
      line: 9,
      endLine: 9,
      column: 1,
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 7,
      description: 'System.Void Ns.Type::M()',
      enabled: breakpoint.enabled,
    })))

  const document = (codeStatements: CodeStatement[] | undefined): never => ({
    nodeId: 'method-1',
    title: 'M',
    language: 'csharp',
    text: '',
    spans: [],
    diagnostics: [],
    codeStatements,
    loading: false,
    requestedLanguage: 'cSharp',
  }) as never

  const stored = (): unknown => JSON.parse(localStorage.getItem('dnspy.breakpoints.v1') ?? 'null')

  beforeEach(() => {
    localStorage.clear()
    setBreakpoints.mockClear()
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, setBreakpoints, setFunctionBreakpoints: vi.fn(async () => ({})) } })
    useAppStore.setState({
      lineBreakpoints: [],
      functionBreakpoints: [],
      debugSessionId: 'session',
      documents: { 'method-1': document(statements) },
    })
  })

  it('writes the IL location a restart needs, and reads it back', async () => {
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)

    const entry = {
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 7,
      line: 9,
      enabled: true,
      description: 'System.Void Ns.Type::M()',
    }
    expect(stored()).toEqual({ version: 1, breakpoints: [entry], functions: [] })
    expect(parseLineBreakpointEntries(stored())).toEqual([entry])
    expect(lineBreakpointEntries(useAppStore.getState().lineBreakpoints)).toEqual([entry])
  })

  it('leaves out a breakpoint the engine never gave a location', async () => {
    // Nothing resolved it — no session, and an IL view with no statement table to snap against — so
    // there is no module or offset to point a restored breakpoint at.
    useAppStore.setState({ debugSessionId: undefined, documents: { 'method-1': document(undefined) } })
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)

    expect(useAppStore.getState().lineBreakpoints).toHaveLength(1)
    expect(stored()).toMatchObject({ breakpoints: [] })
  })

  it('writes function breakpoints alongside the line ones', async () => {
    await useAppStore.getState().addFunctionBreakpoint('Ns.Type.M')

    expect(stored()).toMatchObject({
      functions: [{ name: 'Ns.Type.M', enabled: true }],
    })
  })

  it('accepts both the exported wrapper and a bare array when reading a file', () => {
    const entries = [{
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000001,
      ilOffset: 7,
      line: 9,
      enabled: true,
      description: 'System.Void Ns.Type::M()',
    }]
    expect(parseLineBreakpointEntries({ version: 1, breakpoints: entries })).toEqual(entries)
    expect(parseLineBreakpointEntries(entries)).toEqual(entries)
    expect(parseLineBreakpointEntries({ nope: true })).toEqual([])
    // A row with no module, no token or no offset has no location to bind and is dropped.
    expect(parseLineBreakpointEntries([{ modulePath: '/a.dll' }, { modulePath: '', metadataToken: 6, ilOffset: 0 }, 'junk', null])).toEqual([])
  })

  it('defaults the fields a damaged row can do without', () => {
    const [parsed] = parseLineBreakpointEntries([{ modulePath: '/a.dll', metadataToken: 6, ilOffset: 3 }])
    // Written before the source method was tracked: the body's own token is the right answer
    // everywhere except inside a state machine.
    expect(parsed).toEqual({ modulePath: '/a.dll', metadataToken: 6, sourceMethodToken: 6, ilOffset: 3, line: 0, enabled: true, description: undefined })
  })

  it('adds imported breakpoints to the ones already there, skipping duplicates', async () => {
    await useAppStore.getState().toggleLineBreakpoint('method-1', 6)
    await useAppStore.getState().addFunctionBreakpoint('Ns.Type.M')
    const file = breakpointsFile(useAppStore.getState())

    // Importing the file that was just exported changes nothing.
    expect(await useAppStore.getState().importBreakpoints(file)).toBe(0)

    const added = await useAppStore.getState().importBreakpoints({
      breakpoints: parseLineBreakpointEntries([{ modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000002, sourceMethodToken: 0x06000002, ilOffset: 3, line: 20, enabled: false }]),
      functions: [{ name: 'Ns.Type.N', enabled: true }],
    })
    expect(added).toBe(2)
    expect(useAppStore.getState().lineBreakpoints).toHaveLength(2)
    expect(useAppStore.getState().functionBreakpoints.map((breakpoint) => breakpoint.name)).toEqual(['Ns.Type.M', 'Ns.Type.N'])
  })
})

// Breakpoints are read while the module is still being evaluated — the same moment the bookmarks are,
// and the same moment it is easiest to get wrong.
describe('breakpoints at startup', () => {
  const seed = (value: unknown): void => localStorage.setItem('dnspy.breakpoints.v1', JSON.stringify(value))

  beforeEach(() => localStorage.clear())

  it('restores line and function breakpoints together', async () => {
    seed({
      version: 1,
      breakpoints: [
        { modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, sourceMethodToken: 0x06000003, ilOffset: 7, line: 9, enabled: false, description: 'System.Void Ns.Type::M()' },
        { modulePath: '', metadataToken: 0, ilOffset: 0 },
      ],
      functions: [{ name: 'Ns.Type.M', enabled: true }, { name: '  ' }],
    })
    vi.resetModules()

    const reloaded = await import('./app-store')

    const breakpoints = reloaded.useAppStore.getState().lineBreakpoints
    expect(breakpoints).toHaveLength(1)
    expect(breakpoints[0]).toMatchObject({
      // The workspace that issued the node id is gone; the IL identity is what binds it again.
      nodeId: '',
      identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      sourceMethodToken: 0x06000003,
      ilOffset: 7,
      requestedLine: 9,
      line: 9,
      state: 'pending',
      enabled: false,
      description: 'System.Void Ns.Type::M()',
    })
    expect(reloaded.useAppStore.getState().functionBreakpoints).toEqual([{ name: 'Ns.Type.M', enabled: true }])
  })

  it('survives a storage entry it cannot parse', async () => {
    localStorage.setItem('dnspy.breakpoints.v1', '{ not json')
    vi.resetModules()

    const reloaded = await import('./app-store')

    expect(reloaded.useAppStore.getState().lineBreakpoints).toEqual([])
    expect(reloaded.useAppStore.getState().functionBreakpoints).toEqual([])
  })
})

// The exception list belongs to the engine, and it outlives every debug session. What the client keeps
// is the change it made against the defaults, which it replays to get the list back.
describe('exception settings', () => {
  const applyExceptionSettings = vi.fn()
  const getExceptionSettings = vi.fn()
  const resetExceptionSettings = vi.fn()

  const list = (name: string, stopFirstChance: boolean) => ({
    categories: [{ name: 'DotNet', displayName: 'Common Language Runtime Exceptions', shortDisplayName: '.NET', hasCode: false, decimalCode: false, unsignedCode: false }],
    exceptions: [{
      key: `DotNet\u0001${name}`,
      category: 'DotNet',
      name,
      code: null,
      description: null,
      defaultStopFirstChance: false,
      defaultStopSecondChance: true,
      stopFirstChance,
      stopSecondChance: true,
      conditions: [],
    }],
  })

  beforeEach(() => {
    localStorage.clear()
    applyExceptionSettings.mockReset().mockResolvedValue(list('System.InvalidOperationException', true))
    getExceptionSettings.mockReset().mockResolvedValue(list('System.InvalidOperationException', false))
    resetExceptionSettings.mockReset().mockResolvedValue(list('System.InvalidOperationException', false))
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, applyExceptionSettings, getExceptionSettings, resetExceptionSettings },
    })
    useAppStore.setState({
      exceptionDiff: {},
      exceptionSettings: list('System.InvalidOperationException', false).exceptions,
      exceptionCategories: list('System.InvalidOperationException', false).categories,
      exceptionSettingsLoaded: false,
      exceptionSettingsError: undefined,
    })
  })

  it('replays the stored diff rather than asking for the defaults', async () => {
    const diff = { updated: [{ category: 'DotNet', name: 'System.InvalidOperationException', stopFirstChance: true }] }
    useAppStore.setState({ exceptionDiff: diff })

    await useAppStore.getState().loadExceptionSettings()

    expect(applyExceptionSettings).toHaveBeenCalledWith(diff)
    expect(getExceptionSettings).not.toHaveBeenCalled()
    expect(useAppStore.getState().exceptionSettings[0]?.stopFirstChance).toBe(true)
    expect(useAppStore.getState().exceptionSettingsLoaded).toBe(true)
  })

  it('asks for the defaults when nothing has been changed', async () => {
    await useAppStore.getState().loadExceptionSettings()

    expect(getExceptionSettings).toHaveBeenCalled()
    expect(applyExceptionSettings).not.toHaveBeenCalled()
    expect(useAppStore.getState().exceptionCategories).toHaveLength(1)
  })

  it('turns a type on by writing it into the diff the engine is sent', async () => {
    await useAppStore.getState().setExceptionBreakWhenThrown(['DotNet\u0001System.InvalidOperationException'], true)

    expect(applyExceptionSettings).toHaveBeenCalledWith({
      updated: [expect.objectContaining({ category: 'DotNet', name: 'System.InvalidOperationException', stopFirstChance: true })],
    })
  })

  it('removes a type the definitions name and drops one the user added', async () => {
    const custom = list('My.Custom.Exception', true).exceptions[0]
    useAppStore.setState({
      exceptionDiff: { added: [custom] },
      exceptionSettings: [...list('System.InvalidOperationException', false).exceptions, custom],
    })
    // The engine answers with the whole list, so the type it was told to add comes back in it.
    applyExceptionSettings.mockImplementation(async (diff: unknown) => {
      const added = (diff as { added?: typeof custom[] }).added ?? []
      return { ...list('x', false), exceptions: [...list('System.InvalidOperationException', false).exceptions, ...added] }
    })

    await useAppStore.getState().removeExceptionDefinitions(['DotNet\u0001System.InvalidOperationException'])
    expect(applyExceptionSettings).toHaveBeenLastCalledWith({
      added: [expect.objectContaining({ name: 'My.Custom.Exception' })],
      removed: [expect.objectContaining({ name: 'System.InvalidOperationException' })],
    })

    await useAppStore.getState().removeExceptionDefinitions(['DotNet\u0001My.Custom.Exception'])
    // A type the client itself added needs no removal order — dropping it from `added` is the removal.
    expect(useAppStore.getState().exceptionDiff.added).toBeUndefined()
    expect(useAppStore.getState().exceptionDiff.removed).toHaveLength(1)
  })

  it('reports a failed read instead of throwing, so a launch it rides along with survives', async () => {
    getExceptionSettings.mockRejectedValueOnce(new Error('The backend is not running.'))

    await expect(useAppStore.getState().loadExceptionSettings()).resolves.toBeUndefined()
    expect(useAppStore.getState().exceptionSettingsError).toBe('The backend is not running.')
  })

  it('restores the defaults and forgets the diff', async () => {
    useAppStore.setState({ exceptionDiff: { updated: [{ category: 'DotNet', name: 'System.InvalidOperationException', stopFirstChance: true }] } })

    await useAppStore.getState().restoreDefaultExceptionSettings()

    expect(resetExceptionSettings).toHaveBeenCalled()
    expect(useAppStore.getState().exceptionDiff).toEqual({})
    expect(useAppStore.getState().exceptionSettings[0]?.stopFirstChance).toBe(false)
  })

  it('writes the diff to storage and reads it back on the next run', async () => {
    await useAppStore.getState().setExceptionBreakWhenThrown(['DotNet\u0001System.InvalidOperationException'], true)
    const stored = JSON.parse(localStorage.getItem('dnspy.exceptions.v1') ?? 'null')
    expect(stored.updated).toHaveLength(1)
    expect(stored.updated[0].name).toBe('System.InvalidOperationException')

    // A damaged entry reads as "nothing was changed", which is the default list.
    localStorage.setItem('dnspy.exceptions.v1', '{ not json')
    vi.resetModules()
    const reloaded = await import('./app-store')
    expect(reloaded.useAppStore.getState().exceptionDiff).toEqual({})
  })
})

describe('C# Interactive', () => {
  const evaluateScript = vi.fn()
  const resetScript = vi.fn()
  const banner = { kind: 'banner', text: 'Microsoft (R) Roslyn C# Compiler version 4.14.0' }

  beforeEach(() => {
    evaluateScript.mockReset().mockResolvedValue({ entries: [{ kind: 'result', text: '2' }], generation: 1 })
    resetScript.mockReset().mockResolvedValue({ entries: [banner], generation: 1 })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, evaluateScript, resetScript } })
    useAppStore.setState({ scriptEntries: [], scriptRunning: false, scriptHistory: [], scriptStarted: false, scriptGeneration: 0 })
  })

  it('echoes a submission and appends what the host returned', async () => {
    await useAppStore.getState().evaluateScript('  1 + 1  ')

    expect(evaluateScript).toHaveBeenCalledWith('1 + 1')
    expect(useAppStore.getState().scriptEntries).toEqual([
      { kind: 'echo', text: '1 + 1' },
      { kind: 'result', text: '2' },
    ])
    expect(useAppStore.getState().scriptRunning).toBe(false)
  })

  it('keeps the colors the input had on its echo, moved to the trimmed text', async () => {
    await useAppStore.getState().evaluateScript('  x + 1', [
      { start: 2, length: 1, color: 'local' },
      { start: 4, length: 1, color: 'operator' },
      { start: 6, length: 1, color: 'number' },
    ])

    expect(useAppStore.getState().scriptEntries[0]).toEqual({
      kind: 'echo',
      text: 'x + 1',
      colors: [
        { start: 0, length: 1, color: 'local' },
        { start: 2, length: 1, color: 'operator' },
        { start: 4, length: 1, color: 'number' },
      ],
    })
  })

  it('colors the echo before running the submission when the input had no colors yet', async () => {
    const classifyScript = vi.fn().mockResolvedValue({ spans: [{ start: 0, length: 1, color: 'error' }] })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, classifyScript } })

    await useAppStore.getState().evaluateScript('y')

    expect(classifyScript).toHaveBeenCalledWith('y')
    expect(classifyScript.mock.invocationCallOrder[0]).toBeLessThan(evaluateScript.mock.invocationCallOrder[0])
    expect(useAppStore.getState().scriptEntries[0]).toEqual({ kind: 'echo', text: 'y', colors: [{ start: 0, length: 1, color: 'error' }] })
  })

  it('still runs a submission whose colors could not be worked out', async () => {
    const classifyScript = vi.fn().mockRejectedValue(new Error('backend gone'))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, classifyScript } })

    await useAppStore.getState().evaluateScript('1 + 1')

    expect(evaluateScript).toHaveBeenCalledWith('1 + 1')
    expect(useAppStore.getState().scriptEntries[0]).toEqual({ kind: 'echo', text: '1 + 1' })
  })

  it('ignores a blank submission', async () => {
    await useAppStore.getState().evaluateScript('   ')

    expect(evaluateScript).not.toHaveBeenCalled()
    expect(useAppStore.getState().scriptEntries).toEqual([])
    expect(useAppStore.getState().scriptHistory).toEqual([])
  })

  it.each(['#clear', '#cls'])('clears the log for %s without asking the host', async (command) => {
    useAppStore.setState({ scriptEntries: [{ kind: 'output', text: 'earlier' }] })

    await useAppStore.getState().evaluateScript(command)

    expect(evaluateScript).not.toHaveBeenCalled()
    expect(useAppStore.getState().scriptEntries).toEqual([])
  })

  it('prints the help text without asking the host', async () => {
    await useAppStore.getState().evaluateScript('#help')

    expect(evaluateScript).not.toHaveBeenCalled()
    const entries = useAppStore.getState().scriptEntries
    expect(entries[0]).toEqual({ kind: 'echo', text: '#help' })
    expect(entries.some((entry) => entry.text.includes('#reset'))).toBe(true)
    expect(entries.some((entry) => entry.text.includes('#load'))).toBe(true)
    // HelpCommand prints the command names in the preprocessor-keyword color and the rest in the output color.
    const reset = entries.find((entry) => entry.text.includes('#reset'))
    expect(reset).toMatchObject({
      kind: 'output',
      color: 'replOutputText',
      colors: [{ start: 2, length: 6, color: 'preprocessorKeyword' }],
    })
    expect(reset?.text.startsWith('  #reset ')).toBe(true)
    // A command with two names colors each name and leaves the comma between them the output color.
    const clear = entries.find((entry) => entry.text.includes('#clear'))
    expect(clear?.colors).toEqual([
      { start: 2, length: 6, color: 'preprocessorKeyword' },
      { start: 10, length: 4, color: 'preprocessorKeyword' },
    ])
  })

  it('resets the session for #reset and reports the new banner', async () => {
    await useAppStore.getState().evaluateScript('#reset')

    expect(resetScript).toHaveBeenCalledOnce()
    expect(useAppStore.getState().scriptEntries).toEqual([
      { kind: 'echo', text: '#reset' },
      { kind: 'output', text: translate('Resetting execution engine.') },
      banner,
    ])
  })

  it('passes noconfig to the reset, which drops the response file', async () => {
    await useAppStore.getState().evaluateScript('#reset noconfig')

    expect(resetScript).toHaveBeenCalledWith({ loadConfig: false, showBanner: false })
  })

  it('leaves an unknown #command to the host', async () => {
    await useAppStore.getState().evaluateScript('#nonsense')

    expect(evaluateScript).toHaveBeenCalledWith('#nonsense')
  })

  it('keeps a history of submissions, without consecutive duplicates', async () => {
    await useAppStore.getState().evaluateScript('1 + 1')
    await useAppStore.getState().evaluateScript('1 + 1')
    await useAppStore.getState().evaluateScript('2 + 2')

    expect(useAppStore.getState().scriptHistory).toEqual(['1 + 1', '2 + 2'])
  })

  it('narrates an explicit reset and prints the fresh banner', async () => {
    await useAppStore.getState().resetScript()

    expect(resetScript).toHaveBeenCalledWith({ loadConfig: true, showBanner: false })
    expect(useAppStore.getState().scriptEntries).toEqual([
      { kind: 'output', text: translate('Resetting execution engine.') },
      banner,
    ])
    expect(useAppStore.getState().scriptGeneration).toBe(1)
  })

  it('appends the lines the host streams while a submission runs', () => {
    useAppStore.setState({ scriptGeneration: 3 })

    useAppStore.getState().appendScriptOutput({ generation: 3, entry: { kind: 'output', text: 'tick' } })

    expect(useAppStore.getState().scriptEntries).toEqual([{ kind: 'output', text: 'tick' }])
  })

  it('does not move the generation back when a response arrives after a reset', async () => {
    evaluateScript.mockResolvedValue({ entries: [], generation: 1 })
    useAppStore.setState({ scriptGeneration: 2 })

    await useAppStore.getState().evaluateScript('x')

    expect(useAppStore.getState().scriptGeneration).toBe(2)
  })

  it('drops output from the session a reset replaced', () => {
    useAppStore.setState({ scriptGeneration: 4, scriptEntries: [{ kind: 'output', text: 'current' }] })

    useAppStore.getState().appendScriptOutput({ generation: 3, entry: { kind: 'output', text: 'stale' } })

    expect(useAppStore.getState().scriptEntries).toEqual([{ kind: 'output', text: 'current' }])
  })

  it('builds the session once, printing the banner and the help hint', async () => {
    await useAppStore.getState().startScript()
    await useAppStore.getState().startScript()

    expect(resetScript).toHaveBeenCalledOnce()
    expect(resetScript).toHaveBeenCalledWith({ loadConfig: true, showBanner: true })
    const entries = useAppStore.getState().scriptEntries
    expect(entries[0]).toEqual(banner)
    expect(entries[entries.length - 1]).toEqual({ kind: 'help', text: translate('Type "#help" for more information.') })
  })

  it('drops the failure of a submission a reset cancelled', async () => {
    evaluateScript.mockImplementation(async () => {
      // The reset replaced the session while this submission waited behind the old one.
      useAppStore.setState({ scriptGeneration: 2 })
      throw new Error('The operation was canceled.')
    })

    await useAppStore.getState().evaluateScript('x')

    expect(useAppStore.getState().scriptEntries.some((entry) => entry.kind === 'error')).toBe(false)
    expect(useAppStore.getState().scriptRunning).toBe(false)
  })

  it('reports a host failure as an error line', async () => {
    evaluateScript.mockRejectedValue(new Error('backend is gone'))

    await useAppStore.getState().evaluateScript('1 + 1')

    expect(useAppStore.getState().scriptEntries[1]).toEqual({
      kind: 'error',
      text: translate('Script failed: {message}', { message: 'backend is gone' }),
    })
    expect(useAppStore.getState().scriptRunning).toBe(false)
  })
})

describe('bookmarks', () => {
  // The token the snap produces has to be the statement's IL offset, not the line that was clicked.
  const statements: CodeStatement[] = [
    statement(4, 4, { ilOffset: 4 }),
    statement(9, 9, { ilOffset: 7 }),
    statement(14, 14, { ilOffset: 11, metadataToken: 0x06000002, sourceMethodToken: 0x06000002, description: 'System.Void Ns.Type::N()' }),
  ]

  const doc = (codeStatements: CodeStatement[] | undefined): never => ({
    nodeId: 'method-1',
    title: 'M',
    language: 'csharp',
    text: '',
    spans: [],
    diagnostics: [],
    codeStatements,
    loading: false,
    requestedLanguage: 'cSharp',
  }) as never

  const bookmark = (extra: Partial<Bookmark> = {}): Bookmark => ({
    id: 'bookmark1',
    kind: 'body',
    nodeId: 'method-1',
    identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 4),
    modulePath: '/app/DebugTarget.dll',
    metadataToken: 0x06000001,
    ilOffset: 4,
    line: 4,
    description: 'System.Void Ns.Type::M()',
    name: 'First',
    labels: [],
    enabled: true,
    order: 1,
    ...extra,
  })

  const openNodeById = vi.fn(async (nodeId: string) => nodeId)

  beforeEach(() => {
    localStorage.clear()
    openNodeById.mockClear()
    useAppStore.setState({
      bookmarks: [],
      activeBookmarkId: undefined,
      caretReveal: undefined,
      output: [],
      workspaceId: 'ws1',
      openNodeById,
      documents: { 'method-1': doc(statements) },
    })
  })

  const stored = (): unknown => JSON.parse(localStorage.getItem('dnspy.bookmarks.v1') ?? 'null')

  it('names a bookmark by the statement on the line', () => {
    useAppStore.getState().toggleBookmark('method-1', 9)

    const [created] = useAppStore.getState().bookmarks
    expect(created).toMatchObject({
      kind: 'body',
      nodeId: 'method-1',
      identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      ilOffset: 7,
      line: 9,
      labels: [],
      enabled: true,
    })
    expect(created.name).toBe(translate('Bookmark {number}', { number: created.order }))
    // Making one selects it, so "next bookmark" has somewhere to continue from.
    expect(useAppStore.getState().activeBookmarkId).toBe(created.id)
  })

  it('removes the bookmark when the same statement is clicked again', () => {
    useAppStore.getState().toggleBookmark('method-1', 9)
    useAppStore.getState().toggleBookmark('method-1', 9)

    expect(useAppStore.getState().bookmarks).toEqual([])
    expect(useAppStore.getState().activeBookmarkId).toBeUndefined()
  })

  it('puts nothing on a line that holds no statement and starts no definition', () => {
    // dnSpy does not borrow another line's statement: the line is blank and nothing is defined after it.
    useAppStore.getState().toggleBookmark('method-1', 8)

    expect(useAppStore.getState().bookmarks).toEqual([])
  })

  // `class C` on line 1, `void M()` on line 3 with its body below — the two definitions carry their module
  // and token, the way the backend writes a definition span.
  const declared = (): never => {
    const text = 'class C\n{\n\tvoid M()\n\t{\n\t\tCall();\n\t}\n\n\tint P => 5;\n}\n'
    const spanOf = (name: string, token: number): TextSpan => ({
      start: text.indexOf(name),
      length: name.length,
      kind: 'definition',
      targetNodeId: `n${token}`,
      targetModulePath: '/app/DebugTarget.dll',
      targetMetadataToken: token,
    })
    return {
      ...(doc([
        statement(5, 5, { startColumn: 3, endColumn: 10, ilOffset: 1, sequencePointIlOffset: 1, ilEndOffset: 6 }),
        statement(8, 8, { startColumn: 11, endColumn: 12, ilOffset: 0, sequencePointIlOffset: 0, ilEndOffset: 2, metadataToken: 0x06000002, sourceMethodToken: 0x06000002 }),
      ]) as DocumentState),
      text,
      spans: [spanOf('C', 0x02000002), spanOf('M', 0x06000001), spanOf('P', 0x17000001)],
    } as never
  }

  it('bookmarks the member a declaration line defines, and writes it down by token alone', () => {
    useAppStore.setState({ documents: { 'method-1': declared() } })

    useAppStore.getState().toggleBookmark('method-1', 3)

    const [created] = useAppStore.getState().bookmarks
    expect(created).toMatchObject({ kind: 'token', modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 0, line: 3, description: 'M' })
    expect(stored()).toEqual([{ kind: 'token', modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, description: 'M', name: created.name, labels: [], enabled: true }])
    expect(bookmarkLineInDocument('method-1', declared(), { ...created, nodeId: '' })).toBe(3)

    // The second toggle on the line finds it again.
    useAppStore.getState().toggleBookmark('method-1', 3)
    expect(useAppStore.getState().bookmarks).toEqual([])
  })

  it('takes the next definition for a blank line, and the definition that starts before the statement', () => {
    useAppStore.setState({ documents: { 'method-1': declared() } })

    // Line 7 is blank: dnSpy looks for a definition from the start of the line on, and finds P.
    useAppStore.getState().toggleBookmark('method-1', 7)
    // `int P => 5;` starts its definition before the expression's statement, so the line is P's too.
    useAppStore.getState().toggleBookmark('method-1', 8)
    expect(useAppStore.getState().bookmarks).toHaveLength(0)

    // The body statement on line 5 starts before any definition after it.
    useAppStore.getState().toggleBookmark('method-1', 5)
    expect(useAppStore.getState().bookmarks).toEqual([expect.objectContaining({ kind: 'body', ilOffset: 1, line: 5 })])
  })

  it('shows a spot another view made on the statement whose IL holds it', () => {
    // An IL view's bookmark sits on an instruction inside the C# statement that runs from offset 1 to 6.
    const fromIl = bookmark({ id: 'b1', nodeId: '', line: 0, ilOffset: 3, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 3) })

    expect(bookmarkLineInDocument('method-1', declared(), fromIl)).toBe(5)
    // A state machine's statements belong to another body, where offset 3 means something else.
    const asyncBody = { ...(doc([statement(5, 5, { ilOffset: 1, sequencePointIlOffset: 1, ilEndOffset: 6, metadataToken: 0x06000009 })]) as DocumentState), text: '', spans: [] } as never
    expect(bookmarkLineInDocument('method-1', asyncBody, fromIl)).toBeUndefined()
  })

  it('keeps a bookmark whose line has no statement, but only for this session', () => {
    useAppStore.setState({ documents: { 'method-1': doc(undefined) } })
    useAppStore.getState().toggleBookmark('method-1', 30)

    expect(useAppStore.getState().bookmarks[0]).toMatchObject({
      kind: 'line',
      identity: 'method-1|30',
      modulePath: '',
      metadataToken: 0,
      line: 30,
    })
    // There is nothing stable to write down, so it never reaches storage.
    expect(stored()).toEqual([])
  })

  it('writes what a restart needs and reads it back', () => {
    useAppStore.getState().toggleBookmark('method-1', 9)
    const [created] = useAppStore.getState().bookmarks

    const entries = stored()
    expect(entries).toEqual([
      {
        modulePath: '/app/DebugTarget.dll',
        metadataToken: 0x06000001,
        ilOffset: 7,
        description: 'System.Void Ns.Type::M()',
        name: created.name,
        labels: [],
        enabled: true,
      },
    ])
    expect(parseBookmarkEntries(entries)).toEqual(entries)
    expect(bookmarkEntries([created])).toEqual(entries)
  })

  it('accepts both the exported wrapper and a bare array when reading a file', () => {
    const entry = bookmarkEntries([bookmark()])
    expect(parseBookmarkEntries({ version: 1, bookmarks: entry })).toEqual(entry)
    expect(parseBookmarkEntries(entry)).toEqual(entry)
    expect(parseBookmarkEntries({ nope: true })).toEqual([])
    expect(parseBookmarkEntries([{ modulePath: '/a.dll' }, 'junk', null])).toEqual([])
  })

  it('drops the fields a damaged row cannot do without, and defaults the rest', () => {
    const [parsed] = parseBookmarkEntries([{ modulePath: '/a.dll', metadataToken: 6, ilOffset: 3 }])
    expect(parsed).toEqual({ modulePath: '/a.dll', metadataToken: 6, ilOffset: 3, description: '', name: translate('Bookmark'), labels: [], enabled: true })
  })

  it('flips the enabled flag from the marker and from the pane', () => {
    useAppStore.getState().toggleBookmark('method-1', 9)
    const [created] = useAppStore.getState().bookmarks

    useAppStore.getState().toggleBookmarkEnabledAt('method-1', 9)
    expect(useAppStore.getState().bookmarks[0].enabled).toBe(false)

    useAppStore.getState().toggleBookmarkEnabledAt('method-1', 9)
    expect(useAppStore.getState().bookmarks[0].enabled).toBe(true)

    useAppStore.getState().setBookmarkEnabled(created.id, false)
    expect(useAppStore.getState().bookmarks[0].enabled).toBe(false)
    useAppStore.getState().setAllBookmarksEnabled(true)
    expect(useAppStore.getState().bookmarks[0].enabled).toBe(true)
  })

  it('toggles a marker that does not exist without creating one', () => {
    useAppStore.getState().toggleBookmarkEnabledAt('method-1', 9)
    expect(useAppStore.getState().bookmarks).toEqual([])
  })

  it('removes one, several, or every bookmark in a document', () => {
    useAppStore.setState({
      bookmarks: [
        bookmark({ id: 'b1', order: 1 }),
        bookmark({ id: 'b2', order: 2, line: 9, ilOffset: 7, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
        bookmark({ id: 'b3', order: 3, nodeId: 'method-2', modulePath: '/app/Other.dll' }),
      ],
    })

    useAppStore.getState().removeBookmark('b1')
    expect(useAppStore.getState().bookmarks.map((item) => item.id)).toEqual(['b2', 'b3'])

    useAppStore.getState().removeBookmarks(['b2', 'missing'])
    expect(useAppStore.getState().bookmarks.map((item) => item.id)).toEqual(['b3'])

    useAppStore.setState({ bookmarks: [...useAppStore.getState().bookmarks, bookmark({ id: 'b4', nodeId: 'method-2' })] })
    useAppStore.getState().removeAllBookmarksInDocument('method-2')
    expect(useAppStore.getState().bookmarks).toEqual([])
  })

  it('clears the selection when the bookmark it points at is removed', () => {
    useAppStore.setState({
      bookmarks: [bookmark({ id: 'b1' }), bookmark({ id: 'b2', order: 2 })],
      activeBookmarkId: 'b1',
    })

    useAppStore.getState().removeBookmark('b1')
    expect(useAppStore.getState().activeBookmarkId).toBeUndefined()

    useAppStore.setState({ activeBookmarkId: 'b2' })
    useAppStore.getState().clearBookmarks()
    expect(useAppStore.getState().bookmarks).toEqual([])
    expect(useAppStore.getState().activeBookmarkId).toBeUndefined()
  })

  it('trims a name and refuses a blank one', () => {
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1' })] })

    useAppStore.getState().renameBookmark('b1', '  Loop head  ')
    expect(useAppStore.getState().bookmarks[0].name).toBe('Loop head')

    useAppStore.getState().renameBookmark('b1', '   ')
    expect(useAppStore.getState().bookmarks[0].name).toBe('Loop head')
  })

  it('splits labels on their commas, trims them and drops duplicates', () => {
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1' })] })

    useAppStore.getState().setBookmarkLabels('b1', [' hot ', 'hot', '', '  ', 'loop'])
    expect(useAppStore.getState().bookmarks[0].labels).toEqual(['hot', 'loop'])
  })

  it('merges an import by IL identity and reports how many rows were new', () => {
    useAppStore.getState().toggleBookmark('method-1', 9)
    const existing = bookmarkEntries(useAppStore.getState().bookmarks)

    const added = useAppStore.getState().importBookmarks([
      ...existing,
      { modulePath: '/app/Other.dll', metadataToken: 0x06000003, ilOffset: 1, description: 'System.Void Ns.Type::Other()', name: 'Elsewhere', labels: ['x'], enabled: false },
    ])

    expect(added).toBe(1)
    const bookmarks = useAppStore.getState().bookmarks
    expect(bookmarks).toHaveLength(2)
    expect(bookmarks[1]).toMatchObject({ modulePath: '/app/Other.dll', nodeId: '', line: 0, name: 'Elsewhere', labels: ['x'], enabled: false })
  })

  it('walks the enabled bookmarks in order and skips the disabled ones', async () => {
    useAppStore.setState({
      bookmarks: [
        bookmark({ id: 'b1', order: 1, line: 4 }),
        bookmark({ id: 'b2', order: 2, line: 9, ilOffset: 7, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
        bookmark({ id: 'b3', order: 3, line: 14, metadataToken: 0x06000002, ilOffset: 11, identity: statementIdentity('/app/DebugTarget.dll', 0x06000002, 11), enabled: false }),
      ],
    })

    await useAppStore.getState().selectNextBookmark({ documentId: 'method-1', line: 5 })
    expect(useAppStore.getState().activeBookmarkId).toBe('b2')
    expect(useAppStore.getState().caretReveal).toMatchObject({ documentId: 'method-1', line: 9 })

    // With no caret to go on, next means "after the one the last go-to landed on" — and it wraps.
    await useAppStore.getState().selectNextBookmark()
    expect(useAppStore.getState().activeBookmarkId).toBe('b1')

    await useAppStore.getState().selectPreviousBookmark()
    expect(useAppStore.getState().activeBookmarkId).toBe('b2')
  })

  it('confines the in-document walk to the document the caret is in', async () => {
    useAppStore.setState({
      bookmarks: [
        bookmark({ id: 'b1', order: 1, line: 4 }),
        bookmark({ id: 'b2', order: 2, line: 30, nodeId: 'method-2', modulePath: '/app/Other.dll' }),
      ],
    })

    await useAppStore.getState().selectNextBookmarkInDocument('method-1', 0)
    expect(useAppStore.getState().activeBookmarkId).toBe('b1')
    expect(useAppStore.getState().caretReveal).toMatchObject({ documentId: 'method-1', line: 4 })
  })

  it('steps between the bookmarks sharing the active one’s label', async () => {
    useAppStore.setState({
      bookmarks: [
        bookmark({ id: 'b1', order: 1, line: 4, labels: ['hot'] }),
        bookmark({ id: 'b2', order: 2, line: 9, ilOffset: 7, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
        bookmark({ id: 'b3', order: 3, line: 14, metadataToken: 0x06000002, ilOffset: 11, identity: statementIdentity('/app/DebugTarget.dll', 0x06000002, 11), labels: ['hot'] }),
      ],
      activeBookmarkId: 'b1',
    })

    await useAppStore.getState().selectNextBookmarkWithSameLabel()
    expect(useAppStore.getState().activeBookmarkId).toBe('b3')
  })

  it('does nothing for a label walk while the active bookmark has no labels', async () => {
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1', labels: [] })], activeBookmarkId: 'b1' })

    await useAppStore.getState().selectNextBookmarkWithSameLabel()
    expect(useAppStore.getState().caretReveal).toBeUndefined()
  })

  it('asks the backend for the node again when the cached one is gone', async () => {
    const findMember = vi.fn(async () => ({ nodeId: 'n42', label: 'M', description: 'System.Void Ns.Type::M()' }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, findMember } })
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1', nodeId: 'n1', line: 0 })], openNodeById: vi.fn(async () => undefined) })

    await useAppStore.getState().goToBookmark('b1')

    // The token, not the dead node id, is what survives a restart.
    expect(findMember).toHaveBeenCalledWith('ws1', '/app/DebugTarget.dll', 0x06000001)
    expect(useAppStore.getState().bookmarks[0].nodeId).toBe('n42')
  })

  it('does not follow a cached node id that no longer names the bookmark’s document', async () => {
    const findMember = vi.fn(async () => ({ nodeId: 'n42', label: 'M', description: 'System.Void Ns.Type::M()' }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, findMember } })
    useAppStore.setState({
      bookmarks: [bookmark({ id: 'b1', nodeId: 'n1', line: 0 })],
      // The id is still valid — the counter restarted, so it now names a different method entirely.
      openNodeById: vi.fn(async () => 'method-9'),
      documents: { 'method-9': doc([statement(2, 2, { ilOffset: 99, metadataToken: 0x06000009, sourceMethodToken: 0x06000009 })]) },
    })

    await useAppStore.getState().goToBookmark('b1')

    expect(findMember).toHaveBeenCalledOnce()
    expect(useAppStore.getState().bookmarks[0].nodeId).toBe('n42')
  })

  it('reports a bookmark whose module is not loaded instead of failing silently', async () => {
    const findMember = vi.fn(async () => ({ nodeId: null, label: null, description: null }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, findMember } })
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1', nodeId: 'n1', line: 0, name: 'Loop head' })], openNodeById: vi.fn(async () => undefined) })

    await useAppStore.getState().goToBookmark('b1')

    expect(useAppStore.getState().caretReveal).toBeUndefined()
    expect(useAppStore.getState().output.at(-1)?.text).toContain(translate('Bookmark "{name}" is in a module that is not loaded.', { name: 'Loop head' }))
  })

  it('finds a restored bookmark by identity once its document is open', () => {
    const restored = bookmark({ id: 'b1', nodeId: '', line: 0, ilOffset: 7, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) })

    expect(bookmarkLineInDocument('method-1', doc(statements), restored)).toBe(9)
    // A document whose IL map does not contain the identity gets no marker, even though its own
    // statements are perfectly good.
    expect(bookmarkLineInDocument('method-2', doc([statement(3, 3, { ilOffset: 2, ilEndOffset: 3, metadataToken: 0x06000002, sourceMethodToken: 0x06000002 })]), restored)).toBeUndefined()
    // Nor does a document that has not been decompiled yet, since a restored bookmark has no line.
    expect(bookmarkLineInDocument('method-1', undefined, restored)).toBeUndefined()
  })

  it('falls back to the cached line for a session-only bookmark', () => {
    const sessionOnly = bookmark({ id: 'b1', kind: 'line', nodeId: 'method-1', line: 30, identity: 'method-1|30' })

    expect(bookmarkLineInDocument('method-1', doc(statements), sessionOnly)).toBe(30)
    expect(bookmarkLineInDocument('method-2', doc(statements), sessionOnly)).toBeUndefined()
    expect(bookmarkMarkers('method-1', doc(statements), [sessionOnly])).toEqual([{ line: 30, enabled: true, message: 'First' }])
  })

  it('opens a tab of its own for the bookmark only once the node is known to be right', async () => {
    const openNodeInNewTabById = vi.fn(async (nodeId: string) => nodeId)
    const findMember = vi.fn(async () => ({ nodeId: 'n42', label: 'M', description: 'System.Void Ns.Type::M()' }))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, findMember } })
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1', nodeId: 'method-1', line: 4 })], openNodeInNewTabById })

    await useAppStore.getState().goToBookmark('b1', true)

    // The document that is up already names the bookmark, so its node gets the new tab and the plain
    // follow is never asked.
    expect(openNodeInNewTabById).toHaveBeenCalledWith('method-1')
    expect(openNodeById).not.toHaveBeenCalled()
    expect(findMember).not.toHaveBeenCalled()
    expect(useAppStore.getState().caretReveal).toMatchObject({ documentId: 'method-1', line: 4, column: 1 })

    // A node id nothing confirms is looked up again before a tab is opened for it.
    openNodeInNewTabById.mockClear()
    useAppStore.setState({ bookmarks: [bookmark({ id: 'b1', nodeId: 'gone', line: 4 })] })
    await useAppStore.getState().goToBookmark('b1', true)
    expect(findMember).toHaveBeenCalledOnce()
    expect(openNodeInNewTabById).toHaveBeenCalledOnce()
    expect(openNodeInNewTabById).toHaveBeenCalledWith('n42')
  })

  it('reads a definition row back, and refuses a body row without its offset', () => {
    expect(parseBookmarkEntries([{ kind: 'token', modulePath: '/a.dll', metadataToken: 0x02000002 }])).toEqual([
      { kind: 'token', modulePath: '/a.dll', metadataToken: 0x02000002, description: '', name: translate('Bookmark'), labels: [], enabled: true },
    ])
    expect(parseBookmarkEntries([{ modulePath: '/a.dll', metadataToken: 0x06000001 }])).toEqual([])
  })

  it('takes the token, name, location and module prefixes in the search box', () => {
    const rows = [
      bookmark({ id: 'b1', name: 'Loop head', labels: ['hot'], description: 'System.Void Ns.Type::M()', modulePath: '/app/DebugTarget.dll' }),
      bookmark({ id: 'b2', order: 2, name: 'Elsewhere', labels: ['cold'], description: 'System.Void Other.Type::N()', modulePath: '/app/Other.dll' }),
    ]

    const ids = (query: string): string[] => filterBookmarks(rows, query).map((item) => item.id)
    expect(ids('')).toEqual(['b1', 'b2'])
    expect(ids('n:loop')).toEqual(['b1'])
    expect(ids('l:cold')).toEqual(['b2'])
    expect(ids('o:other.type')).toEqual(['b2'])
    expect(ids('m:other.dll')).toEqual(['b2'])
    // No prefix searches every column, and whitespace is an implicit AND.
    expect(ids('hot')).toEqual(['b1'])
    expect(ids('debugtarget head')).toEqual(['b1'])
    expect(ids('debugtarget cold')).toEqual([])
    // A prefix with nothing after it matches everything, the way an empty box does.
    expect(ids('n:')).toEqual(['b1', 'b2'])
  })
})

// A reference is drawn and clickable only when it goes somewhere, and "somewhere" is wider than a node
// id: the editor used to leave a reference into a module the workspace does not hold undecorated, which
// is what "the references in the text do not respond to a click" looks like from the outside.
describe('navigable spans', () => {
  it('counts a reference that names only a module and token as a target', () => {
    expect(isNavigableSpan({ start: 0, length: 3, kind: 'method', targetModulePath: '/usr/share/dotnet/System.Console.dll', targetMetadataToken: 0x06000123 })).toBe(true)
    expect(isNavigableSpan({ start: 0, length: 3, kind: 'method', targetNodeId: 'n7' })).toBe(true)
  })

  it('leaves a span with nothing to go to alone', () => {
    expect(isNavigableSpan({ start: 0, length: 3, kind: 'text' })).toBe(false)
    // An empty node id is what the backend leaves behind for a span it could not place, and it is not a
    // target either.
    expect(isNavigableSpan({ start: 0, length: 3, kind: 'type', targetNodeId: '' })).toBe(false)
  })
})

// A reference the user clicks. Inside the workspace the span names the node it goes to; a reference into
// a module the workspace does not hold names the file and token it has there instead, and asking the
// backend for that pair opens that module on demand — which is how dnSpy follows a reference into an
// assembly its tree does not have. Opening one adds a root, so the tree is read again.
describe('followed references', () => {
  const consolePath = '/usr/share/dotnet/shared/Microsoft.NETCore.App/9.0.0/System.Console.dll'
  const openNodeById = vi.fn()
  const getRoots = vi.fn()
  const calls: string[] = []

  const install = (extra: Record<string, unknown>): void => {
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, getRoots, ...extra } })
  }

  beforeEach(() => {
    calls.length = 0
    openNodeById.mockReset().mockImplementation(async (nodeId: string) => { calls.push(`open:${nodeId}`); return nodeId })
    getRoots.mockReset().mockImplementation(async () => { calls.push('roots'); return { nodes: [moduleNode('n2', consolePath)] } })
    install({})
    useAppStore.setState({ workspaceId: 'ws1', openNodeById, openNodeInNewTabById: undefined, roots: [], output: [] })
  })

  it('opens a reference that names its node without asking the backend for anything', async () => {
    await useAppStore.getState().openReferenceTarget({ start: 0, length: 4, kind: 'type', targetNodeId: 'n7' })

    expect(openNodeById).toHaveBeenCalledWith('n7')
    expect(getRoots).not.toHaveBeenCalled()
  })

  it('follows a reference into a tab of its own when dnSpy\'s new-tab command asks for one', async () => {
    // The two follow commands differ only in which shell opener the target goes through, and the new-tab
    // one is the opener the shell registered for "Open in New Tab".
    const openNodeInNewTabById = vi.fn(async (nodeId: string) => nodeId)
    useAppStore.setState({ openNodeInNewTabById })

    await useAppStore.getState().openReferenceTarget({ start: 0, length: 4, kind: 'type', targetNodeId: 'n7' }, true)

    expect(openNodeInNewTabById).toHaveBeenCalledWith('n7')
    expect(openNodeById).not.toHaveBeenCalled()
  })

  it('resolves a reference into a module the workspace does not hold, then reads the tree that module was added to', async () => {
    const findMember = vi.fn(async () => ({ nodeId: 'n42', label: 'WriteLine', description: 'System.Void System.Console::WriteLine(System.Int32)' }))
    install({ findMember })

    await useAppStore.getState().openReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: consolePath, targetMetadataToken: 0x06000123 })

    // The file and token, not a node id: that identity is the one a module that is not open can name.
    expect(findMember).toHaveBeenCalledWith('ws1', consolePath, 0x06000123)
    // The tree is read before the document opens, so the root the backend just added is there to see.
    expect(calls).toEqual(['roots', 'open:n42'])
    expect(useAppStore.getState().roots).toEqual([moduleNode('n2', consolePath)])
  })

  it('reports a reference the backend has nothing for', async () => {
    install({ findMember: vi.fn(async () => ({ nodeId: undefined })) })

    await useAppStore.getState().openReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: '/app/Missing.dll', targetMetadataToken: 0x06000001 })

    expect(openNodeById).not.toHaveBeenCalled()
    expect(useAppStore.getState().output.at(-1)?.text).toContain(translate('Navigation failed: {message}', { message: '/app/Missing.dll' }))
  })

  it('reports a reference that could not be looked up at all', async () => {
    install({ findMember: vi.fn(async () => { throw new Error('the backend is gone') }) })

    await useAppStore.getState().openReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: consolePath, targetMetadataToken: 0x06000123 })

    expect(openNodeById).not.toHaveBeenCalled()
    expect(useAppStore.getState().output.at(-1)?.text).toContain('the backend is gone')
  })

  it('does nothing for a span that names no target', async () => {
    await useAppStore.getState().openReferenceTarget({ start: 0, length: 9, kind: 'text' })

    expect(openNodeById).not.toHaveBeenCalled()
    expect(useAppStore.getState().output).toEqual([])
  })

  it('resolves a reference for a command that opens no document, which is how Analyze reaches a module not open yet', async () => {
    const findMember = vi.fn(async () => ({ nodeId: 'n42', label: 'WriteLine', description: 'System.Void System.Console::WriteLine(System.Int32)' }))
    install({ findMember })
    useAppStore.setState({ openNodeById: undefined })

    await expect(useAppStore.getState().resolveReferenceTarget({ start: 0, length: 4, kind: 'type', targetNodeId: 'n7' })).resolves.toBe('n7')
    expect(findMember).not.toHaveBeenCalled()
    await expect(useAppStore.getState().resolveReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: consolePath, targetMetadataToken: 0x06000123 })).resolves.toBe('n42')
    expect(calls).toEqual(['roots'])
    await expect(useAppStore.getState().resolveReferenceTarget({ start: 0, length: 9, kind: 'text' })).resolves.toBeUndefined()

    install({ findMember: vi.fn(async () => ({ nodeId: undefined })) })
    await expect(useAppStore.getState().resolveReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: '/app/Missing.dll', targetMetadataToken: 0x06000001 })).rejects.toThrow('/app/Missing.dll')
  })
})

// Bringing a node the tree has never listed into view, which is what follows a document tab coming to the
// front. The client knows a node's ancestors only for the ones it has listed itself, and the node a
// reference was followed into was usually reached by its id alone — a member's id names its module and
// token, not the type that declares it. The backend hands back the chain instead, and remembering it as
// parents is what lets the ordinary walk answer for that node from then on.
describe('revealing a node the tree has never listed', () => {
  const modulePath = '/app/Example.dll'
  const calls: string[] = []
  const getChildren = vi.fn()
  const getNode = vi.fn()
  const getNodePath = vi.fn()

  const chain = (...ids: string[]): TreeNode[] => ids.map((id) => treeNode(id, id))

  const install = (extra: Record<string, unknown> = {}): void => {
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getChildren, getNode, getNodePath, ...extra },
    })
  }

  beforeEach(() => {
    calls.length = 0
    getNodePath.mockReset().mockImplementation(async (_workspaceId: string, nodeId: string) => {
      calls.push(`path:${nodeId}`)
      return { nodes: chain('n1', 'n2', 'n3', nodeId) }
    })
    getChildren.mockReset().mockImplementation(async (_workspaceId: string, nodeId: string) => {
      calls.push(`children:${nodeId}`)
      return { nodes: [treeNode('n9', 'n9')] }
    })
    getNode.mockReset().mockImplementation(async (_workspaceId: string, nodeId: string) => {
      calls.push(`node:${nodeId}`)
      return treeNode(nodeId, nodeId)
    })
    install()
    useAppStore.setState({
      workspaceId: 'ws1',
      roots: [treeNode('n1', `assembly:${modulePath}`, { kind: 'assembly' })],
      children: {},
      parents: {},
      expanded: {},
      loadingNodes: {},
      selectedNode: undefined,
    })
  })

  it('asks for the chain, expands it and selects the node', async () => {
    await useAppStore.getState().revealNode('n42')

    expect(getNodePath).toHaveBeenCalledWith('ws1', 'n42')
    // Every ancestor above the node is opened; the node itself is not a branch to expand.
    expect(useAppStore.getState().expanded).toEqual({ n1: true, n2: true, n3: true })
    // The rows only exist once the level above each of them has been read.
    expect(calls).toEqual(['path:n42', 'children:n1', 'children:n2', 'children:n3', 'node:n42'])
    expect(useAppStore.getState().selectedNode?.id).toBe('n42')
    // The chain records the ancestry, so the walk answers next time: `getNode` is the only read left.
    expect(useAppStore.getState().parents).toMatchObject({ n2: 'n1', n3: 'n2', n42: 'n3' })
  })

  it('walks the ancestry it has already recorded without asking for the chain again', async () => {
    useAppStore.setState({ parents: { n42: 'n3' }, expanded: {} })

    await useAppStore.getState().revealNode('n42')

    expect(getNodePath).not.toHaveBeenCalled()
    expect(useAppStore.getState().expanded).toEqual({ n3: true })
  })

  it('leaves a node the backend can place nowhere unselected', async () => {
    getNodePath.mockResolvedValue({ nodes: [] })

    await useAppStore.getState().revealNode('n42')

    expect(useAppStore.getState().selectedNode).toBeUndefined()
    expect(useAppStore.getState().output).toEqual([])
  })

  it('leaves a node the backend refuses to place unselected rather than failing', async () => {
    getNodePath.mockRejectedValue(new Error('The selected tree node no longer exists.'))

    await expect(useAppStore.getState().revealNode('n42')).resolves.toBeUndefined()

    expect(useAppStore.getState().selectedNode).toBeUndefined()
    expect(getNode).not.toHaveBeenCalled()
  })

  it('does nothing when the tree is already showing that node', async () => {
    useAppStore.setState({ selectedNode: treeNode('n42', 'n42'), parents: { n42: 'n3' }, expanded: { n3: true } })

    await useAppStore.getState().revealNode('n42')

    expect(getNodePath).not.toHaveBeenCalled()
    expect(getNode).not.toHaveBeenCalled()
  })

  // Opening a document selects the node it opens, so the store can name a node the tree has no row for at
  // all: following a reference into a module the workspace does not hold lands on exactly that. Being the
  // selection does not mean the node is on screen, and the reveal still has to open the way down to it.
  it('opens the way down to a node the store selected before the tree had its row', async () => {
    useAppStore.setState({ selectedNode: treeNode('n42', 'n42') })

    await useAppStore.getState().revealNode('n42')

    expect(getNodePath).toHaveBeenCalledWith('ws1', 'n42')
    expect(useAppStore.getState().expanded).toEqual({ n1: true, n2: true, n3: true })
    expect(useAppStore.getState().selectedNode?.id).toBe('n42')
  })
})

// A stop in a module the workspace does not hold has neither a line nor a node: the engine resolves a
// frame against the workspace, and that module is not in it. dnSpy's debugger loads the document when it
// stops at one, so the module is opened here — the stop is what the user is looking at, and stepping
// into a framework method otherwise looks like nothing happened at all.
describe('a stop in a module the workspace does not hold', () => {
  const consolePath = '/usr/share/dotnet/shared/Microsoft.NETCore.App/9.0.0/System.Console.dll'
  const consoleFrame = (line: number): DebugStackFrame => ({
    id: 1,
    name: 'System.Void System.Console::WriteLine(System.Int32)',
    line,
    column: 0,
    nodeId: line > 0 ? 'method-5' : undefined,
    source: { name: 'System.Console.dll', path: consolePath },
  })
  const addModules = vi.fn()
  const getRoots = vi.fn()
  const stack = vi.fn()
  const revealDocument = vi.fn(async () => undefined)
  // Which modules have already been asked for is remembered per workspace and outlives a test, so each
  // one gets a workspace of its own — the same thing the store does for a workspace the user opens.
  let workspaceId = ''
  let workspaces = 0

  beforeEach(() => {
    workspaceId = `ws${++workspaces}`
    addModules.mockReset().mockResolvedValue({ modules: [openedModule('n2', consolePath)], skipped: [], stateId: 's2' })
    getRoots.mockReset().mockResolvedValue({ nodes: [moduleNode('n2', consolePath)] })
    // Reading the stack again is what turns the frame into a line: the module is in the workspace now.
    stack.mockReset().mockResolvedValue([consoleFrame(12)])
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: {
        ...window.dnSpy,
        addModules,
        getRoots,
        getDebugThreads: vi.fn(async () => [{ id: 1, name: 'Main' }]),
        getDebugStackTrace: stack,
        getDebugModules: vi.fn(async () => []),
        getDebugScopes: vi.fn(async () => []),
        getDebugVariables: vi.fn(async () => []),
      },
    })
    useAppStore.setState({
      workspaceId,
      modules: [openedModule('n1', '/app/DebugTarget.dll')],
      roots: [moduleNode('n1', '/app/DebugTarget.dll')],
      debugSessionId: 'session',
      debugState: 'stopped',
      debugThreads: [],
      selectedDebugThreadId: 1,
      debugFrames: [consoleFrame(0)],
      selectedDebugFrameId: 1,
      activeDebugFrameId: 1,
      watches: [],
      stoppedLocation: undefined,
      output: [],
      revealDocument,
    })
  })

  it('loads the module and marks the line the frame resolves to once it is open', async () => {
    await useAppStore.getState().revealStoppedLocation()

    expect(addModules).toHaveBeenCalledWith(workspaceId, [consolePath])
    expect(useAppStore.getState().roots).toEqual([moduleNode('n2', consolePath)])
    expect(useAppStore.getState().output.at(-1)?.text).toContain(translate('Loaded {name} for the stopped location.', { name: 'System.Console.dll' }))
    expect(useAppStore.getState().stoppedLocation).toMatchObject({ nodeId: 'method-5', line: 12 })
    expect(revealDocument).toHaveBeenCalledWith('method-5')
  })

  it('asks for a module once per workspace, however many stops land in it', async () => {
    // The frame stays unplaced, so the second stop asks the same question and the memory is what
    // has to answer it.
    stack.mockResolvedValue([consoleFrame(0)])

    await useAppStore.getState().revealStoppedLocation()
    await useAppStore.getState().revealStoppedLocation()
    expect(addModules).toHaveBeenCalledOnce()

    // A workspace the user opens next deserves a fresh question.
    useAppStore.setState({ workspaceId: 'ws-elsewhere' })
    await useAppStore.getState().revealStoppedLocation()
    expect(addModules).toHaveBeenCalledTimes(2)
  })

  it('keeps the stop as it is when the module cannot be opened', async () => {
    addModules.mockRejectedValue(new Error('not a managed module'))

    await useAppStore.getState().revealStoppedLocation()

    // A file that is gone is not worth a word on every stop, and nothing was added, so there is no
    // reason to read the stack again either.
    expect(stack).not.toHaveBeenCalled()
    expect(useAppStore.getState().output).toEqual([])
    expect(useAppStore.getState().stoppedLocation).toBeUndefined()
  })
})

// The store is created while the module is being evaluated, which is the moment the reading of stored
// bookmarks has to happen at — and the moment it is easiest to get wrong.
describe('bookmarks at startup', () => {
  it('reads the stored bookmarks back when the store is built', async () => {
    localStorage.setItem('dnspy.bookmarks.v1', JSON.stringify([
      { modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 7, description: 'System.Void Ns.Type::M()', name: 'Loop head', labels: ['hot'], enabled: false },
      { modulePath: '', metadataToken: 0, ilOffset: 0, name: 'not worth keeping' },
    ]))
    vi.resetModules()

    const reloaded = await import('./app-store')

    const bookmarks = reloaded.useAppStore.getState().bookmarks
    expect(bookmarks).toHaveLength(1)
    expect(bookmarks[0]).toMatchObject({
      nodeId: '',
      identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7),
      modulePath: '/app/DebugTarget.dll',
      metadataToken: 0x06000001,
      ilOffset: 7,
      line: 0,
      name: 'Loop head',
      labels: ['hot'],
      enabled: false,
    })
  })

  it('survives a storage entry it cannot parse', async () => {
    localStorage.setItem('dnspy.bookmarks.v1', '{ not json')
    vi.resetModules()

    const reloaded = await import('./app-store')

    expect(reloaded.useAppStore.getState().bookmarks).toEqual([])
  })
})

describe('edit commands', () => {
  const node = (overrides: Partial<TreeNode> = {}): TreeNode => ({ id: 'n2', label: 'HelloRequest', kind: 'type', hasChildren: false, ...overrides })
  const beginEdit = vi.fn(async () => ({ transactionId: 't1', baseVersion: 1 }))
  const commitEdit = vi.fn(async () => ({ version: 2, stateId: 'state-2', changedNodeIds: ['n2'], canUndo: true, canRedo: false }))
  const rollbackEdit = vi.fn(async () => {})
  const queueDelete = vi.fn(async () => {})
  const queueSetNamespace = vi.fn(async () => {})
  const queueMethodBodyStub = vi.fn(async () => {})
  const getChildren = vi.fn(async () => ({ nodes: [] }))
  // The deleted node is gone from the backend, which is how refreshAfterEdit is told to skip it.
  const getNode = vi.fn(async () => { throw new Error('The node does not exist.') })

  beforeEach(() => {
    for (const mock of [beginEdit, commitEdit, rollbackEdit, queueDelete, queueSetNamespace, queueMethodBodyStub, getChildren, getNode])
      mock.mockClear()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, beginEdit, commitEdit, rollbackEdit, queueDelete, queueSetNamespace, queueMethodBodyStub, getChildren, getNode },
    })
    useAppStore.setState({
      workspaceId: 'w1',
      savedStateId: 'state-1',
      workspaceStateId: 'state-1',
      dirty: false,
      busy: false,
      error: undefined,
      output: [],
      documents: {},
      children: { n1: [] },
      parents: { n2: 'n1' },
      selectedNode: node(),
    })
  })

  it('deletes a node, refreshes its parent and clears the selection it pointed at', async () => {
    expect(await useAppStore.getState().deleteNode(node())).toBe(true)

    expect(queueDelete).toHaveBeenCalledWith('w1', 't1', 'n2')
    expect(commitEdit).toHaveBeenCalledWith('w1', 't1')
    expect(getChildren).toHaveBeenCalledWith('w1', 'n1')
    expect(useAppStore.getState().selectedNode).toBeUndefined()
    expect(useAppStore.getState()).toMatchObject({ dirty: true, workspaceStateId: 'state-2', canUndo: true, canRedo: false })
  })

  it('leaves another node selected when the deleted node was not the current one', async () => {
    useAppStore.setState({ selectedNode: node({ id: 'n3', label: 'Other' }) })

    await useAppStore.getState().deleteNode(node())

    expect(useAppStore.getState().selectedNode).toMatchObject({ id: 'n3' })
  })

  it('rolls the transaction back and reports the failure when a delete is rejected', async () => {
    queueDelete.mockRejectedValueOnce(new Error('The property no longer belongs to its type.'))

    expect(await useAppStore.getState().deleteNode(node({ kind: 'property' }))).toBe(false)

    expect(rollbackEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState().error).toBe('The property no longer belongs to its type.')
    expect(useAppStore.getState().selectedNode).toMatchObject({ id: 'n2' })
  })

  it('renames a namespace and relabels the selection, which the refreshed tree no longer matches', async () => {
    useAppStore.setState({ selectedNode: node({ label: 'Old.Ns', kind: 'namespace' }) })

    expect(await useAppStore.getState().renameNamespace(node({ label: 'Old.Ns', kind: 'namespace' }), 'New.Ns')).toBe(true)

    expect(queueSetNamespace).toHaveBeenCalledWith('w1', 't1', 'n2', 'New.Ns')
    expect(useAppStore.getState().selectedNode).toMatchObject({ label: 'New.Ns' })
  })

  it('moves a namespace’s types into the empty namespace with an empty new name', async () => {
    useAppStore.setState({ selectedNode: node({ label: 'Old.Ns', kind: 'namespace' }) })

    await useAppStore.getState().moveTypesToEmptyNamespace(node({ label: 'Old.Ns', kind: 'namespace' }))

    expect(queueSetNamespace).toHaveBeenCalledWith('w1', 't1', 'n2', '')
    // The empty namespace renders as '-' in the tree, which is what the selection has to say.
    expect(useAppStore.getState().selectedNode).toMatchObject({ label: '-' })
  })

  it('replaces a method body with the backend-built stub', async () => {
    expect(await useAppStore.getState().replaceMethodBodyWithStub(node({ kind: 'method', label: 'M()' }))).toBe(true)

    expect(queueMethodBodyStub).toHaveBeenCalledWith('w1', 't1', 'n2')
    expect(useAppStore.getState()).toMatchObject({ dirty: true, workspaceStateId: 'state-2', canUndo: true })
  })
})

describe('hexadecimal text', () => {
  it('writes two uppercase digits per byte and nothing in between', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0a, 0x2a, 0xff]))).toBe('000A2AFF')
  })

  it('reads that text back', () => {
    expect(Array.from(parseHexText('000A2AFF')!)).toEqual([0x00, 0x0a, 0x2a, 0xff])
  })

  it('treats a question mark as a zero nibble, as dnSpy does', () => {
    expect(Array.from(parseHexText('?A??')!)).toEqual([0x0a, 0x00])
  })

  it('refuses anything that is not an even run of hexadecimal digits', () => {
    // dnSpy's paste takes no separators and no whitespace, and an odd length has no meaning.
    expect(parseHexText('')).toBeUndefined()
    expect(parseHexText('ABC')).toBeUndefined()
    expect(parseHexText('0A 2A')).toBeUndefined()
    expect(parseHexText('0G')).toBeUndefined()
  })
})

describe('hex editor commands', () => {
  const base64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
  const returnTrue = base64([0x0a, 0x17, 0x2a])
  const returnFalse = base64([0x0a, 0x16, 0x2a])

  const methodNode: TreeNode = { id: 'm1', label: 'Run()', kind: 'method', hasChildren: false }
  // The parts a node has no target for arrive as nulls, the way System.Text.Json writes them.
  const methodTarget = (overrides: Partial<HexMethodTarget> = {}): HexTargetResponse => ({
    moduleId: 'mod1',
    fileLength: 4096,
    method: { bodyOffset: 0x200, bodySize: 3, codeOffset: 0x201, codeSize: 2, returnTrueBody: returnTrue, returnFalseBody: returnFalse, emptyBody: null, ...overrides },
    fieldInitialValue: null,
    resource: null,
  })

  const beginEdit = vi.fn(async () => ({ transactionId: 't1', baseVersion: 1 }))
  const commitEdit = vi.fn(async () => ({ version: 2, stateId: 'state-2', changedNodeIds: ['m1'], canUndo: true, canRedo: false }))
  const rollbackEdit = vi.fn(async () => {})
  const patchHex = vi.fn(async () => ({ queued: true }))
  const resolveHexTarget = vi.fn()
  const resolveHexStatement = vi.fn()
  const readHex = vi.fn()
  const getNode = vi.fn(async () => methodNode)
  const getChildren = vi.fn(async () => ({ nodes: [] }))
  const getRoots = vi.fn(async () => ({ nodes: [] }))
  const writeText = vi.fn(async () => undefined)
  const readText = vi.fn(async () => '')

  beforeEach(() => {
    for (const mock of [beginEdit, commitEdit, rollbackEdit, patchHex, resolveHexTarget, resolveHexStatement, readHex, getNode, getChildren, getRoots, writeText, readText])
      mock.mockReset()
    getRoots.mockResolvedValue({ nodes: [] })
    beginEdit.mockResolvedValue({ transactionId: 't1', baseVersion: 1 })
    commitEdit.mockResolvedValue({ version: 2, stateId: 'state-2', changedNodeIds: ['m1'], canUndo: true, canRedo: false })
    rollbackEdit.mockResolvedValue(undefined)
    patchHex.mockResolvedValue({ queued: true })
    getNode.mockResolvedValue(methodNode)
    getChildren.mockResolvedValue({ nodes: [] })
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, beginEdit, commitEdit, rollbackEdit, patchHex, resolveHexTarget, resolveHexStatement, readHex, getNode, getChildren, getRoots },
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText } })
    useAppStore.setState({
      workspaceId: 'w1',
      savedStateId: 'state-1',
      workspaceStateId: 'state-1',
      dirty: false,
      busy: false,
      error: undefined,
      output: [],
      documents: {},
      children: { n1: [] },
      parents: { m1: 'n1' },
      selectedNode: methodNode,
      hexTarget: undefined,
      hexStatement: undefined,
      hexNavigation: undefined,
      codeCaret: undefined,
      codeHexContext: undefined,
    })
  })

  it('resolves the hex target of the selected node and drops an answer that arrived too late', async () => {
    resolveHexTarget.mockResolvedValue(methodTarget())
    await useAppStore.getState().resolveHexTarget(methodNode)
    expect(resolveHexTarget).toHaveBeenCalledWith('w1', 'm1')
    expect(useAppStore.getState().hexTarget?.method?.bodyOffset).toBe(0x200)

    // The selection can move while the round trip is in flight, and the late answer must not drive the
    // menu for a node that is no longer selected.
    let release: (target: HexTargetResponse) => void = () => undefined
    resolveHexTarget.mockImplementation(() => new Promise<HexTargetResponse>((resolve) => { release = resolve }))
    const pending = useAppStore.getState().resolveHexTarget(methodNode)
    useAppStore.setState({ selectedNode: { id: 'other', label: 'X', kind: 'type', hasChildren: false } })
    release(methodTarget({ bodyOffset: 0x300 }))
    await pending

    expect(useAppStore.getState().hexTarget?.method?.bodyOffset).toBe(0x200)
  })

  it('clears the target when the selection is cleared or the backend refuses', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })

    await useAppStore.getState().resolveHexTarget(undefined)
    expect(useAppStore.getState().hexTarget).toBeUndefined()

    useAppStore.setState({ hexTarget: methodTarget() })
    resolveHexTarget.mockRejectedValue(new Error('nope'))
    await useAppStore.getState().resolveHexTarget(methodNode)
    expect(useAppStore.getState().hexTarget).toBeUndefined()
  })

  it('resolves the statement under the caret into a file range', async () => {
    resolveHexStatement.mockResolvedValue({ moduleId: 'mod1', range: { offset: 0x201, length: 2 } })
    useAppStore.setState({
      documents: { d1: { nodeId: 'm1', title: 'M', language: 'csharp', text: '', spans: [], diagnostics: [], loading: false, requestedLanguage: 'cSharp', codeStatements: [statement(5, 7, { ilOffset: 4, ilEndOffset: 9, modulePath: '/app/A.dll', metadataToken: 0x06000003 })] } as never },
    })

    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 6 })

    expect(resolveHexStatement).toHaveBeenCalledWith('w1', '/app/A.dll', 0x06000003, 4, 9)
    expect(useAppStore.getState().hexStatement).toEqual({ moduleId: 'mod1', range: { offset: 0x201, length: 2 } })
  })

  it('selects nothing for a statement whose text covers several IL ranges', async () => {
    // dnSpy's FindByTextPosition answers every statement of the text, and ShowILSpanInHexEditorCommand selects
    // nothing when there is more than one — it goes to the first of them.
    resolveHexStatement.mockResolvedValue({ moduleId: 'mod1', range: { offset: 0x201, length: 0 } })
    useAppStore.setState({
      documents: { d1: { nodeId: 'm1', text: '', spans: [], loading: false, codeStatements: [
        statement(5, 7, { ilOffset: 8, ilEndOffset: 12, modulePath: '/app/A.dll', metadataToken: 0x06000003 }),
        statement(5, 7, { ilOffset: 2, ilEndOffset: 4, modulePath: '/app/A.dll', metadataToken: 0x06000003 }),
      ] } as never },
    })

    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 6 })

    expect(resolveHexStatement).toHaveBeenCalledWith('w1', '/app/A.dll', 0x06000003, 2, 2)
  })

  it('reads the definition under the caret and the document\'s file for the hex commands', async () => {
    const definitionTarget = methodTarget({ bodyOffset: 0x300 })
    resolveHexTarget.mockImplementation(async (_workspaceId: string, nodeId: string) => (nodeId === 'm9' ? definitionTarget : { ...methodTarget(), moduleId: 'file-of-d1', method: null }))
    resolveHexStatement.mockResolvedValue({ moduleId: null, range: null })
    const text = 'int Run() {\n  return Other();\n}'
    useAppStore.setState({
      documents: { d1: { nodeId: 'n-type', nodeIds: ['n-type'], text, loading: false, codeStatements: [], spans: [
        { start: 4, length: 3, kind: 'definition', targetNodeId: 'm9' },
        { start: 21, length: 5, kind: 'reference', targetNodeId: 'm10' },
      ] } as never },
    })

    // The caret on the method's name in its declaration: GetMemberDef names it.
    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 1, column: 6 })
    expect(useAppStore.getState().codeHexContext).toEqual({ documentId: 'd1', fileModuleId: 'file-of-d1', definition: { nodeId: 'm9', target: definitionTarget } })
    expect(codeHexContextOf(useAppStore.getState(), 'd1')).toMatchObject({ hexCreator: 'code', hexFileModuleId: 'file-of-d1', hexTarget: { method: definitionTarget.method }, hexTargetNodeId: 'm9' })

    // On a call the caret names no member: the commands act on a definition, never on a reference.
    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 2, column: 11 })
    expect(useAppStore.getState().codeHexContext?.definition).toBeUndefined()
    // The document's file is read once for the document.
    expect(resolveHexTarget.mock.calls.filter(([, nodeId]) => nodeId === 'n-type')).toHaveLength(1)
    // Another document's viewer knows nothing of this caret.
    expect(codeHexContextOf(useAppStore.getState(), 'd2')).toEqual({ hexCreator: 'code', hexFileModuleId: undefined, hexTarget: undefined, hexTargetNodeId: undefined, hexStatement: undefined, addressReference: undefined })
  })

  it('drops what it read for a caret that has moved on since', async () => {
    let release: (target: HexTargetResponse) => void = () => undefined
    resolveHexTarget.mockImplementationOnce(() => new Promise<HexTargetResponse>((resolve) => { release = resolve }))
    resolveHexTarget.mockResolvedValue(methodTarget())
    useAppStore.setState({ documents: { d1: { nodeId: 'n1', text: 'x', spans: [], loading: false, codeStatements: [] } as never } })

    const first = useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 1 })
    await useAppStore.getState().setCodeCaret(undefined)
    release(methodTarget({ bodyOffset: 0x999 }))
    await first

    expect(useAppStore.getState().codeHexContext).toBeUndefined()
  })

  it('has no statement to offer when the caret leaves the code or the backend refuses', async () => {
    useAppStore.setState({ hexStatement: { moduleId: 'mod1', range: { offset: 1, length: 1 } } })
    await useAppStore.getState().setCodeCaret(undefined)
    expect(useAppStore.getState().hexStatement).toBeUndefined()

    // A document with no statement table (an IL view) has nothing to snap to, so no call is made.
    useAppStore.setState({ documents: { d1: { codeStatements: undefined } as never } })
    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 3 })
    expect(resolveHexStatement).not.toHaveBeenCalled()

    resolveHexStatement.mockRejectedValue(new Error('nope'))
    useAppStore.setState({ documents: { d1: { codeStatements: [statement(1, 9, { ilOffset: 0, ilEndOffset: 4 })] } as never } })
    await useAppStore.getState().setCodeCaret({ documentId: 'd1', line: 3 })
    expect(useAppStore.getState().hexStatement).toBeUndefined()
  })

  const bodyTarget = (overrides: Partial<HexMethodTarget> = {}) => ({ nodeId: 'm1', moduleId: 'mod1', method: methodTarget(overrides).method! })

  it('writes a canned body over the method body and commits it as an edit', async () => {
    expect(await useAppStore.getState().hexWriteMethodBody('returnTrue', bodyTarget())).toBe(true)

    // The offset is the body's, not the code's: dnSpy's templates carry the method header's byte.
    expect(patchHex).toHaveBeenCalledWith('w1', 't1', 'm1', 0x200, returnTrue)
    expect(commitEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState()).toMatchObject({ dirty: true, workspaceStateId: 'state-2', canUndo: true, busy: false })
    // dnSpy's body writers say nothing in the Output window.
    expect(useAppStore.getState().output).toEqual([])
  })

  it('writes over the method the command was given, not the tree\'s selection', async () => {
    useAppStore.setState({ selectedNode: { id: 'other', label: 'X', kind: 'type', hasChildren: false } })

    expect(await useAppStore.getState().hexWriteMethodBody('returnFalse', { ...bodyTarget(), nodeId: 'm7' })).toBe(true)

    expect(patchHex).toHaveBeenCalledWith('w1', 't1', 'm7', 0x200, returnFalse)
  })

  it('does nothing when the backend resolved no such template', async () => {
    // The backend spells "no such template" as null, so that is what the store is given here.
    expect(await useAppStore.getState().hexWriteMethodBody('empty', bodyTarget({ emptyBody: null }))).toBe(false)
    expect(beginEdit).not.toHaveBeenCalled()
  })

  it('rolls the transaction back and says so when the patch is rejected', async () => {
    patchHex.mockRejectedValue(new Error('The patch does not fit in the file.'))

    expect(await useAppStore.getState().hexWriteMethodBody('returnFalse', bodyTarget())).toBe(false)

    expect(rollbackEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState().error).toBe('The patch does not fit in the file.')
    expect(useAppStore.getState().output.at(-1)?.text).toContain('Hex edit failed: The patch does not fit in the file.')
  })

  it('copies the method body to the clipboard as hexadecimal text', async () => {
    readHex.mockResolvedValue({ base64Data: base64([0x0a, 0x17, 0x2a]) })

    expect(await useAppStore.getState().hexCopyMethodBody(bodyTarget())).toBe(true)

    expect(readHex).toHaveBeenCalledWith('w1', 'mod1', 0x200, 3)
    expect(writeText).toHaveBeenCalledWith('0A172A')
    expect(useAppStore.getState().output).toEqual([])
  })

  it('reports a copy that the backend refused', async () => {
    readHex.mockRejectedValue(new Error('gone'))

    expect(await useAppStore.getState().hexCopyMethodBody(bodyTarget())).toBe(false)
    expect(useAppStore.getState().output.at(-1)?.text).toContain('Copy failed: gone')
  })

  it('pastes the clipboard over the method body', async () => {
    readText.mockResolvedValue('0A162A')

    expect(await useAppStore.getState().hexPasteMethodBody(bodyTarget())).toBe(true)

    expect(patchHex).toHaveBeenCalledWith('w1', 't1', 'm1', 0x200, returnFalse)
    expect(useAppStore.getState().output).toEqual([])
  })

  it('writes nothing for a clipboard that is not hexadecimal bytes, or bytes that do not fit', async () => {
    // TVChangeBodyHexEditorCommand.ExecuteInternal returns without a word: the command is only on the menu for
    // bytes that are hexadecimal text and fit the body.
    readText.mockResolvedValue('0A 16')
    expect(await useAppStore.getState().hexPasteMethodBody(bodyTarget())).toBe(false)
    readText.mockResolvedValue('0A162A2A')
    expect(await useAppStore.getState().hexPasteMethodBody(bodyTarget())).toBe(false)

    expect(beginEdit).not.toHaveBeenCalled()
    expect(useAppStore.getState().output).toEqual([])
  })

  it('reports a clipboard that could not be read', async () => {
    readText.mockRejectedValue(new Error('denied'))

    expect(await useAppStore.getState().hexPasteMethodBody(bodyTarget())).toBe(false)
    expect(useAppStore.getState().output.at(-1)?.text).toContain('Paste failed: denied')
  })

  it('measures the hexadecimal bytes the clipboard holds', async () => {
    readText.mockResolvedValue('0A162A')
    expect(await clipboardHexLength()).toBe(3)
    readText.mockResolvedValue('')
    expect(await clipboardHexLength()).toBeUndefined()
    readText.mockRejectedValue(new Error('denied'))
    expect(await clipboardHexLength()).toBeUndefined()
  })

  it('bumps the navigation token so the same range can be asked for twice', () => {
    useAppStore.getState().showHexAt('mod1', 0x200, 3)
    const first = useAppStore.getState().hexNavigation

    useAppStore.getState().showHexAt('mod1', 0x200, 3)

    expect(useAppStore.getState().hexNavigation).toMatchObject({ moduleId: 'mod1', offset: 0x200, length: 3 })
    expect(useAppStore.getState().hexNavigation!.nonce).not.toBe(first!.nonce)
  })

  it('writes several runs as one edit and steps past a run the backend refuses', async () => {
    patchHex.mockResolvedValueOnce({ queued: true }).mockRejectedValueOnce(new Error('read-only')).mockResolvedValueOnce({ queued: true })

    expect(await useAppStore.getState().hexWriteBytesMany('mod1', [
      { offset: 0x10, data: new Uint8Array([1]) },
      { offset: 0x20, data: new Uint8Array([2]) },
      { offset: 0x30, data: new Uint8Array([3]) },
    ])).toBe(true)

    expect(beginEdit).toHaveBeenCalledTimes(1)
    expect(patchHex).toHaveBeenCalledTimes(3)
    expect(patchHex).toHaveBeenLastCalledWith('w1', 't1', 'mod1', 0x30, base64([3]))
    expect(commitEdit).toHaveBeenCalledTimes(1)
    expect(rollbackEdit).not.toHaveBeenCalled()
    // dnSpy's Replace All writes without a word to the Output window.
    expect(useAppStore.getState().output).toEqual([])
  })

  it('rolls back and answers false when no run lands', async () => {
    patchHex.mockRejectedValue(new Error('read-only'))

    expect(await useAppStore.getState().hexWriteBytesMany('mod1', [{ offset: 0x10, data: new Uint8Array([1]) }])).toBe(false)

    expect(commitEdit).not.toHaveBeenCalled()
    expect(rollbackEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState().busy).toBe(false)
  })
})

const treeNode = (id: string, key: string, extra: Partial<TreeNode> = {}): TreeNode => ({
  id,
  label: id,
  kind: 'type',
  hasChildren: true,
  key,
  ...extra,
})

const moduleNode = (id: string, path: string): TreeNode => treeNode(id, `module:${path}`, { label: path, kind: 'module' })

const openedModule = (id: string, path: string) => ({ id, name: path, path, hasPdb: false })

const documentState = (nodeId: string, requestedLanguage: DecompilerLanguage = 'cSharp'): DocumentState => ({
  title: nodeId,
  language: 'csharp',
  text: '',
  spans: [],
  diagnostics: [],
  nodeId,
  loading: false,
  requestedLanguage,
})

describe('openPaths', () => {
  const rootA = moduleNode('n1', '/A.dll')
  const rootB = moduleNode('n2', '/B.dll')
  const member = treeNode('n3', 'module:/A.dll:type:1', { label: 'Type' })
  const openWorkspace = vi.fn()
  const addModules = vi.fn()
  const closeWorkspace = vi.fn(async () => undefined)
  const getRoots = vi.fn()
  const getChildren = vi.fn()

  beforeEach(() => {
    openWorkspace.mockReset().mockResolvedValue({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], stateId: 's1' })
    addModules.mockReset().mockResolvedValue({ modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')], skipped: [], stateId: 's2' })
    closeWorkspace.mockClear()
    getRoots.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    getChildren.mockReset().mockResolvedValue({ nodes: [member] })
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, openWorkspace, addModules, closeWorkspace, getRoots, getChildren },
    })
    useAppStore.setState({
      workspaceId: undefined,
      modules: [],
      roots: [],
      children: {},
      parents: {},
      expanded: {},
      loadingNodes: {},
      selectedNode: undefined,
      documents: {},
      documentOrder: [],
      activeDocumentId: undefined,
      restoringSession: false,
      output: [],
      dirty: false,
      workspaceStateId: undefined,
      savedStateId: undefined,
      recentFiles: [],
    })
  })

  it('adds to the workspace that is already open instead of replacing it', async () => {
    const children = { n1: [member] }
    const documents = { n3: documentState('n3', 'il') }
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll')],
      roots: [rootA],
      children,
      parents: { n3: 'n1' },
      expanded: { n1: true },
      selectedNode: member,
      documents,
      dirty: true,
      workspaceStateId: 's1',
      savedStateId: 's1',
    })

    await useAppStore.getState().openPaths(['/B.dll'])

    expect(addModules).toHaveBeenCalledWith('w1', ['/B.dll'])
    // Nothing is closed: the workspace instance is what makes every cached node id still mean something.
    expect(closeWorkspace).not.toHaveBeenCalled()
    expect(openWorkspace).not.toHaveBeenCalled()
    const state = useAppStore.getState()
    expect(state.workspaceId).toBe('w1')
    expect(state.roots).toEqual([rootA, rootB])
    expect(state.modules).toHaveLength(2)
    expect(state.workspaceStateId).toBe('s2')
    expect(state.savedStateId).toBe('s2')
    // The branches, the open document and the unsaved edits all survive an append untouched.
    expect(state.children).toBe(children)
    expect(state.documents).toBe(documents)
    expect(state.expanded).toEqual({ n1: true })
    expect(state.dirty).toBe(true)
    // The selection follows the module that was just added.
    expect(state.selectedNode).toBe(rootB)
  })

  it('keeps the selection when nothing new arrived', async () => {
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], roots: [rootA], selectedNode: rootA })
    getRoots.mockResolvedValue({ nodes: [rootA] })
    addModules.mockResolvedValue({ modules: [openedModule('n1', '/A.dll')], skipped: ['/A.dll'], stateId: 's1' })

    await useAppStore.getState().openPaths(['/A.dll'])

    expect(useAppStore.getState().selectedNode).toBe(rootA)
    expect(useAppStore.getState().output.at(-1)?.text).toContain('already open')
  })

  it('replaces the workspace when none is open yet', async () => {
    await useAppStore.getState().openPaths(['/A.dll'])

    expect(openWorkspace).toHaveBeenCalledWith(['/A.dll'])
    expect(addModules).not.toHaveBeenCalled()
    expect(closeWorkspace).not.toHaveBeenCalled()
    const state = useAppStore.getState()
    expect(state.workspaceId).toBe('w1')
    expect(state.roots).toEqual([rootA, rootB])
    expect(state.selectedNode).toBe(rootA)
  })

  it('materialises children without expanding the node', async () => {
    useAppStore.setState({ workspaceId: 'w1', roots: [rootA] })

    await useAppStore.getState().loadChildren(rootA)

    expect(getChildren).toHaveBeenCalledWith('w1', 'n1')
    expect(useAppStore.getState().children).toEqual({ n1: [member] })
    expect(useAppStore.getState().parents).toEqual({ n3: 'n1' })
    expect(useAppStore.getState().expanded).toEqual({})

    // Asking again is free — the branch is already there.
    await useAppStore.getState().loadChildren(rootA)
    expect(getChildren).toHaveBeenCalledTimes(1)
  })

  it('expands without collapsing, which is what a restore needs', async () => {
    useAppStore.setState({ workspaceId: 'w1', roots: [rootA] })

    // The explorer expands every fresh root on its own, so a restore walks into already-expanded nodes.
    await useAppStore.getState().expandNode(rootA)
    await useAppStore.getState().expandNode(rootA)

    expect(useAppStore.getState().expanded).toEqual({ n1: true })
    expect(getChildren).toHaveBeenCalledTimes(1)

    // A toggle would have closed it again.
    await useAppStore.getState().toggleNode(rootA)
    expect(useAppStore.getState().expanded).toEqual({ n1: false })
  })
})

describe('session', () => {
  const sessionStorageKey = 'dnspy.session.v1'
  const root = moduleNode('n1', '/A.dll')
  const space = treeNode('n2', 'module:/A.dll:namespace:Ns', { label: 'Ns', kind: 'namespace' })
  const type = treeNode('n3', 'module:/A.dll:type:1', { label: 'Type' })

  const source = (extra: Partial<SessionSource> = {}): SessionSource => ({
    modules: [openedModule('n1', '/A.dll')],
    roots: [root],
    children: { n1: [space], n2: [type] },
    parents: { n2: 'n1', n3: 'n2' },
    expanded: {},
    selectedNode: undefined,
    documents: {},
    documentOrder: [],
    activeDocumentId: undefined,
    ...extra,
  })

  beforeEach(() => {
    localStorage.removeItem(sessionStorageKey)
  })

  it('records a node before the branch that holds it, marking only what was open', () => {
    const session = buildSession(source({
      expanded: { n1: true, n2: true },
      selectedNode: type,
      documents: { n3: documentState('n3', 'visualBasic') },
      documentOrder: ['n3'],
      activeDocumentId: 'n3',
    }))

    expect(session.paths).toEqual(['/A.dll'])
    expect(session.nodes).toEqual([
      { key: 'module:/A.dll', expanded: true },
      { key: 'module:/A.dll:namespace:Ns', expanded: true },
      { key: 'module:/A.dll:type:1', expanded: false },
    ])
    expect(session.documents).toEqual([{ key: 'module:/A.dll:type:1', language: 'visualBasic' }])
    expect(session.activeDocument).toBe('module:/A.dll:type:1')
    expect(session.selectedNode).toBe('module:/A.dll:type:1')
  })

  it('brings back the ancestors of a document in a branch the user never opened', () => {
    const session = buildSession(source({
      documents: { n3: documentState('n3', 'il') },
      documentOrder: ['n3'],
    }))

    expect(session.nodes).toEqual([
      { key: 'module:/A.dll', expanded: false },
      { key: 'module:/A.dll:namespace:Ns', expanded: false },
      { key: 'module:/A.dll:type:1', expanded: false },
    ])
  })

  it('keeps a hex tab by its file, with the view state the tab reported', () => {
    const state = {
      showOffsetColumn: true, showValuesColumn: true, showAsciiColumn: false, startPosition: 0, endPosition: -1, basePosition: 0,
      useRelativePositions: false, offsetBitSize: 0, valuesFormat: 'hexUInt16' as const, bytesPerLine: 0, activeColumn: 'ascii' as const,
      valuesPosition: 0x40, valuesCellPosition: 0, asciiPosition: 0x41, viewportLeft: 0, topLinePosition: 0x40, anchorPoint: 0x41, activePoint: 0x41,
    }
    const session = buildSession(source({ hexTabs: [{ moduleId: 'n1', state }, { moduleId: 'gone' }] }))
    expect(session.hexTabs).toEqual([{ path: '/A.dll', state }])
    localStorage.setItem(sessionStorageKey, JSON.stringify(session))
    expect(loadSession()?.hexTabs).toEqual([{ path: '/A.dll', state }])
  })

  it('keeps a hex tab of a file the workspace no longer holds by that file', () => {
    const session = buildSession(source({ hexTabs: [{ moduleId: 'hexfile:/gone/B.dll', index: 1 }] }))
    expect(session.hexTabs).toEqual([{ path: '/gone/B.dll', index: 1 }])
  })

  it('keeps a hex tab\'s place among the document tabs, which the restore puts it back at', () => {
    const session = buildSession(source({ hexTabs: [{ moduleId: 'n1', index: 2 }] }))
    expect(session.hexTabs).toEqual([{ path: '/A.dll', index: 2 }])
    localStorage.setItem(sessionStorageKey, JSON.stringify({ ...session, hexTabs: [{ path: '/A.dll', index: 2 }, { path: '/B.dll', index: -1 }, { path: '/C.dll', index: 1.5 }] }))
    // A place that is no place is dropped, and the tab goes at the end as a session without one would.
    expect(loadSession()?.hexTabs).toEqual([{ path: '/A.dll', index: 2 }, { path: '/B.dll' }, { path: '/C.dll' }])
  })

  it('reads back exactly what it wrote', () => {
    const session = buildSession(source({ expanded: { n1: true }, documentOrder: ['n3'], documents: { n3: documentState('n3') } }))
    localStorage.setItem(sessionStorageKey, JSON.stringify(session))

    expect(loadSession()).toEqual(session)
  })

  it('answers undefined rather than throwing on a session it cannot read', () => {
    expect(loadSession()).toBeUndefined()

    localStorage.setItem(sessionStorageKey, '{ not json')
    expect(loadSession()).toBeUndefined()

    localStorage.setItem(sessionStorageKey, JSON.stringify({ version: 99, paths: ['/A.dll'] }))
    expect(loadSession()).toBeUndefined()
  })

  it('drops damaged rows and keeps the rest', () => {
    localStorage.setItem(sessionStorageKey, JSON.stringify({
      version: 1,
      paths: ['/A.dll', 7],
      nodes: [{ key: 'k', expanded: true }, { expanded: true }, null, { key: '' }],
      documents: [{ key: 'k', language: 'nonsense' }, { language: 'cSharp' }],
      activeDocument: 5,
      // A hex tab whose view state is missing a value keeps its file but not the state (HexViewUIStateSerializer).
      hexTabs: [{ path: '/A.dll', state: { showOffsetColumn: true } }, { state: {} }],
    }))

    expect(loadSession()).toEqual({
      version: 1,
      paths: ['/A.dll'],
      nodes: [{ key: 'k', expanded: true }],
      documents: [{ key: 'k', language: 'cSharp' }],
      hexTabs: [{ path: '/A.dll', state: undefined }],
      activeDocument: undefined,
      selectedNode: undefined,
    })
  })

  it('writes only once persistence is on, and not at all during a restore', () => {
    useAppStore.setState({ ...source(), restoringSession: false, workspaceId: 'w1' })
    expect(localStorage.getItem(sessionStorageKey)).toBeNull()

    enableSessionPersistence()
    useAppStore.setState({ expanded: { n1: true } })
    const saved = localStorage.getItem(sessionStorageKey)
    expect(JSON.parse(saved!)).toMatchObject({ paths: ['/A.dll'], nodes: [{ key: 'module:/A.dll', expanded: true }] })

    useAppStore.setState({ restoringSession: true })
    useAppStore.setState({ workspaceId: 'w2', roots: [], modules: [] })
    expect(localStorage.getItem(sessionStorageKey)).toBe(saved)

    // The moment the restore ends is the one write that captures everything it put back.
    useAppStore.setState({ restoringSession: false })
    expect(JSON.parse(localStorage.getItem(sessionStorageKey)!).paths).toEqual([])
  })
})

describe('orderedDocumentKeys', () => {
  const layout = (): Model => Model.fromJson({
    global: {},
    layout: {
      type: 'row',
      children: [{
        type: 'tabset',
        id: 'ts1',
        children: [
          { type: 'tab', id: 'start', name: 'Start', component: 'start', enableClose: false },
          { type: 'tab', id: 'doc:n3', name: 'A', component: 'document', config: { documentId: 'n3' } },
          { type: 'tab', id: 'doc:n4', name: 'B', component: 'document', config: { documentId: 'n4' } },
          { type: 'tab', id: 'hex:n1', name: 'Hex', component: 'hex' },
        ],
      }],
    },
  })

  it('lists the document tabs in layout order, ignoring the special ones', () => {
    const model = layout()
    // A layout that has never been touched has no tabset the user selected, so there is no active tab
    // to report — flexlayout only marks one once a selection has been made.
    expect(orderedDocumentKeys(model)).toEqual({ order: ['n3', 'n4'], active: undefined })

    model.doAction(Actions.selectTab('doc:n3'))
    expect(orderedDocumentKeys(model)).toEqual({ order: ['n3', 'n4'], active: 'n3' })
  })

  it('reports the selected document, or nothing when a special tab has focus', () => {
    const model = layout()
    model.doAction(Actions.selectTab('doc:n4'))
    expect(orderedDocumentKeys(model)).toEqual({ order: ['n3', 'n4'], active: 'n4' })

    model.doAction(Actions.selectTab('start'))
    expect(orderedDocumentKeys(model).active).toBeUndefined()
  })
})

describe('syncDockTabStrips', () => {
  // The panes dnSpy opens in the editor rather than docking; the strip rule is about the docks.
  const documentComponents = ['document', 'hex', 'module-info', 'start']

  const layout = (): Model => Model.fromJson({
    global: {},
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          id: 'explorer-dock',
          children: [{ type: 'tab', id: 'explorer', name: 'Assembly Explorer', component: 'explorer', enableClose: true }],
        },
        {
          type: 'tabset',
          id: 'documents',
          // One document, and the editor keeps its row all the same: dnSpy's document row is what says
          // which documents are open, and the rule about single windows is the docks'.
          children: [{ type: 'tab', id: 'start', name: 'Start', component: 'start', enableClose: false }],
        },
      ],
    },
  })

  const strips = (model: Model): Record<string, boolean> => {
    const shown: Record<string, boolean> = {}
    model.visitNodes((node) => {
      if (node instanceof TabSetNode)
        shown[node.getId()] = node.isEnableTabStrip()
    })
    return shown
  }

  it('leaves a dock of one window without a tab row, and the editor with its own', () => {
    const model = layout()
    syncDockTabStrips(model, documentComponents)

    expect(strips(model)).toEqual({ 'explorer-dock': false, documents: true })
    // The window itself is still there: only the row of tabs goes away, and the pane's caption is what
    // the window is reached by.
    expect(model.getNodeById('explorer')).not.toBeUndefined()
    expect(model.getNodeById('explorer')?.getParent()?.getId()).toBe('explorer-dock')
  })

  it('brings the row back when a second window is docked into it', () => {
    const model = layout()
    syncDockTabStrips(model, documentComponents)
    expect(strips(model)['explorer-dock']).toBe(false)

    model.doAction(Actions.addNode({
      type: 'tab',
      id: 'locals',
      name: 'Locals',
      component: 'locals',
      enableClose: true,
    }, 'explorer-dock', DockLocation.CENTER, -1, true))
    syncDockTabStrips(model, documentComponents)

    expect(strips(model)['explorer-dock']).toBe(true)
  })

  it.each(documentComponents)('restores a hidden strip for a single %s tab', (component) => {
    const model = layout()
    model.doAction(Actions.updateNodeAttributes('documents', { enableTabStrip: false }))
    model.doAction(Actions.updateNodeAttributes('start', { component }))

    syncDockTabStrips(model, documentComponents)

    expect(strips(model).documents).toBe(true)
  })

  it('restores the strip when a document is moved into a dock with a hidden strip', () => {
    const model = layout()
    syncDockTabStrips(model, documentComponents)
    model.doAction(Actions.moveNode('start', 'explorer-dock', DockLocation.CENTER, -1, true))

    syncDockTabStrips(model, documentComponents)

    expect(strips(model)['explorer-dock']).toBe(true)
  })

  it('keeps the reserved editor strip while empty and after reopening a document', () => {
    const model = layout()
    model.doAction(Actions.updateNodeAttributes('documents', { enableDeleteWhenEmpty: false }))
    model.doAction(Actions.deleteTab('start'))
    model.doAction(Actions.updateNodeAttributes('documents', { enableTabStrip: false }))

    syncDockTabStrips(model, documentComponents, ['documents'])

    expect(strips(model)).toEqual({ 'explorer-dock': false, documents: true })
    model.doAction(Actions.addNode({ type: 'tab', name: 'Code', component: 'document' }, 'documents', DockLocation.CENTER, -1, true))
    syncDockTabStrips(model, documentComponents, ['documents'])
    expect(strips(model).documents).toBe(true)
  })

  it('takes the row away again when the dock is down to one window', () => {
    const model = layout()
    model.doAction(Actions.addNode({
      type: 'tab',
      id: 'locals',
      name: 'Locals',
      component: 'locals',
      enableClose: true,
    }, 'explorer-dock', DockLocation.CENTER, -1, true))
    syncDockTabStrips(model, documentComponents)
    expect(strips(model)['explorer-dock']).toBe(true)

    model.doAction(Actions.deleteTab('locals'))
    syncDockTabStrips(model, documentComponents)

    expect(strips(model)['explorer-dock']).toBe(false)
  })

  it('changes nothing, and says nothing, when every dock is already right', () => {
    const model = layout()
    syncDockTabStrips(model, documentComponents)

    const changes: unknown[] = []
    model.addChangeListener((action) => { changes.push(action) })
    syncDockTabStrips(model, documentComponents)

    // What keeps this from running a second time round: the pass over an unchanged layout dispatches
    // nothing, so the change it would answer with never comes.
    expect(changes).toEqual([])
  })
})

describe('file commands', () => {
  const rootA = moduleNode('n1', '/A.dll')
  const rootB = moduleNode('n2', '/B.dll')
  const getSaveOptions = vi.fn()
  const getModifiedDocuments = vi.fn()
  const reloadWorkspace = vi.fn()
  const sortAssemblies = vi.fn()
  const getRoots = vi.fn()

  const reset = (): void => useAppStore.setState({
    workspaceId: undefined,
    modules: [],
    roots: [],
    children: {},
    parents: {},
    expanded: {},
    loadingNodes: {},
    selectedNode: undefined,
    selectedNodes: [],
    documents: {},
    documentOrder: [],
    activeDocumentId: undefined,
    assemblyListRevision: 0,
    output: [],
    dirty: false,
    modifiedDocuments: [],
    saveRequest: undefined,
    workspaceStateId: undefined,
    savedStateId: undefined,
    canUndo: false,
    canRedo: false,
  })

  /** The answer of a save run that wrote every document it was handed. */
  const savedAll = (ids: string[]): SaveDocumentsResponse => ({
    canceled: false,
    modifiedDocuments: [],
    results: ids.map((id) => ({ documentId: id, fileName: `/${id}.dll`, saved: true, length: 10, sha256: 'aa', log: [], errorCount: 0 })),
  })

  beforeEach(() => {
    // Every row stands for the document it is in, which the backend answers with its own id.
    getSaveOptions.mockReset().mockImplementation(async (_workspaceId: string, id: string) => moduleSaveOptions({ documentId: id === 'nm' ? 'n2' : id, fileName: `/${id}.dll` }))
    getModifiedDocuments.mockReset().mockResolvedValue([])
    reloadWorkspace.mockReset().mockResolvedValue({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], stateId: 's9' })
    sortAssemblies.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    getRoots.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getSaveOptions, getModifiedDocuments, reloadWorkspace, sortAssemblies, getRoots },
    })
    reset()
  })

  it('saves the selected module through the Save Module window and the window that writes it', async () => {
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')],
      roots: [rootA, rootB],
      selectedNode: rootB,
      selectedNodes: [rootB],
      dirty: true,
      modifiedDocuments: [{ id: 'n2', name: 'B', path: '/B.dll', inMemory: false, isHexDocument: false }],
    })

    const saved = useAppStore.getState().saveModule()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest?.phase).toBe('options'))
    expect(getSaveOptions).toHaveBeenCalledWith('w1', 'n2')
    const options = useAppStore.getState().saveRequest!.documents[0]
    useAppStore.getState().acceptSaveOptions({ ...options, fileName: '/elsewhere.dll' })
    expect(useAppStore.getState().saveRequest).toMatchObject({ phase: 'run', mode: 'single', documents: [{ fileName: '/elsewhere.dll' }] })
    await useAppStore.getState().finishSave(savedAll(['n2']))
    await expect(saved).resolves.toBe(true)
    expect(useAppStore.getState().saveRequest).toBeUndefined()
    expect(useAppStore.getState().dirty).toBe(false)
  })

  it('names the selected row and lets the backend find its document', async () => {
    const method = { id: 'nm', label: 'M()', kind: 'method', hasChildren: false }
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')], roots: [rootA], selectedNode: method, selectedNodes: [method] })

    void useAppStore.getState().saveModule()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    expect(getSaveOptions).toHaveBeenCalledWith('w1', 'nm')
    expect(useAppStore.getState().saveRequest?.documents.map((document) => document.documentId)).toEqual(['n2'])
    await useAppStore.getState().finishSave(undefined)
  })

  it('saves only the modified documents of a selection that has any', async () => {
    useAppStore.setState({
      workspaceId: 'w1',
      roots: [rootA, rootB],
      selectedNode: rootA,
      selectedNodes: [rootA, rootB],
      modifiedDocuments: [{ id: 'n2', name: 'B', path: '/B.dll', inMemory: false, isHexDocument: false }],
    })

    void useAppStore.getState().saveModule()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    expect(useAppStore.getState().saveRequest?.documents.map((document) => document.documentId)).toEqual(['n2'])
    await useAppStore.getState().finishSave(undefined)
  })

  it('saves every modified document through the Save Modules window', async () => {
    getModifiedDocuments.mockResolvedValue([
      { id: 'n1', name: 'A', path: '/A.dll', inMemory: false, isHexDocument: false },
      { id: 'n2', name: 'B', path: '/B.dll', inMemory: false, isHexDocument: false },
    ])
    useAppStore.setState({ workspaceId: 'w1', roots: [rootA, rootB], dirty: true })

    const saved = useAppStore.getState().saveAllModules()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toMatchObject({ mode: 'multiple', phase: 'run' }))
    expect(useAppStore.getState().saveRequest?.documents.map((document) => document.documentId)).toEqual(['n1', 'n2'])
    await useAppStore.getState().finishSave(savedAll(['n1', 'n2']))
    await expect(saved).resolves.toBe(true)
    expect(useAppStore.getState().dirty).toBe(false)
    expect(useAppStore.getState().output.map((line) => line.text)).toEqual([
      'Saved /n1.dll (10 bytes, SHA-256 aa).',
      'Saved /n2.dll (10 bytes, SHA-256 aa).',
    ])
  })

  it('drops every node-backed part of the workspace when the assemblies are reloaded', async () => {
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')],
      roots: [rootA, rootB],
      children: { n1: [rootA] },
      parents: { n1: 'n2' },
      expanded: { n1: true },
      selectedNode: rootB,
      documents: { n1: documentState('n1') },
      documentOrder: ['n1'],
      activeDocumentId: 'n1',
      dirty: true,
      canUndo: true,
      workspaceStateId: 's2',
      savedStateId: 's1',
    })

    await expect(useAppStore.getState().reloadAllAssemblies()).resolves.toBe(true)
    const state = useAppStore.getState()
    // The workspace id survives the reload; every node id it handed out does not, so nothing that named
    // a node can be kept.
    expect(state.workspaceId).toBe('w1')
    expect(state.modules).toEqual([openedModule('n1', '/A.dll')])
    expect(state.roots).toEqual([rootA, rootB])
    expect(state.children).toEqual({})
    expect(state.parents).toEqual({})
    expect(state.expanded).toEqual({})
    expect(state.documents).toEqual({})
    expect(state.documentOrder).toEqual([])
    expect(state.activeDocumentId).toBeUndefined()
    expect(state.dirty).toBe(false)
    expect(state.canUndo).toBe(false)
    expect(state.workspaceStateId).toBe('s9')
    expect(state.savedStateId).toBe('s9')
  })

  it('takes the order the backend sorted the assemblies into', async () => {
    const sorted = [rootB, rootA]
    sortAssemblies.mockResolvedValue({ nodes: sorted })
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], roots: [rootA, rootB] })

    await expect(useAppStore.getState().sortAssemblies()).resolves.toBe(true)
    expect(sortAssemblies).toHaveBeenCalledWith('w1')
    expect(useAppStore.getState().roots).toEqual(sorted)
  })

  it('reports a failed save without clearing the modified state', async () => {
    const modified = [{ id: 'n1', name: 'A', path: '/A.dll', inMemory: false, isHexDocument: false }]
    useAppStore.setState({ workspaceId: 'w1', roots: [rootA], selectedNode: rootA, selectedNodes: [rootA], dirty: true, modifiedDocuments: modified })

    const saved = useAppStore.getState().saveModule()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    useAppStore.getState().acceptSaveOptions(useAppStore.getState().saveRequest!.documents[0])
    await useAppStore.getState().finishSave({
      canceled: false,
      modifiedDocuments: modified,
      results: [{ documentId: 'n1', fileName: '/A.dll', saved: false, length: 0, log: ['File error: disk full'], errorCount: 1, error: 'disk full' }],
    })
    await expect(saved).resolves.toBe(false)
    expect(useAppStore.getState().dirty).toBe(true)
    expect(useAppStore.getState().output.at(-1)?.text).toBe('Save failed: disk full')
  })

  it('answers not saved when the window is closed before it writes anything', async () => {
    useAppStore.setState({ workspaceId: 'w1', roots: [rootA], selectedNode: rootA, selectedNodes: [rootA] })
    const saved = useAppStore.getState().saveModule()
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    await useAppStore.getState().finishSave(undefined)
    await expect(saved).resolves.toBe(false)
  })
})

describe('Recent Files', () => {
  const rootA = moduleNode('n1', '/A.dll')
  const rootB = moduleNode('n2', '/B.dll')
  const addModules = vi.fn()
  const openWorkspace = vi.fn()
  const getRoots = vi.fn()
  const dropFiles = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    addModules.mockReset().mockResolvedValue({ modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')], skipped: [], stateId: 's2' })
    openWorkspace.mockReset().mockResolvedValue({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')], stateId: 's1' })
    getRoots.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    dropFiles.mockReset().mockResolvedValue({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')], addedPaths: ['/B.dll'], selectNodeId: 'n2', allFiltered: false, stateId: null })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, addModules, openWorkspace, getRoots, dropFiles } })
    useAppStore.setState({ workspaceId: undefined, workspaceGeneration: 0, modules: [], roots: [], selectedNode: undefined, selectedNodes: [], recentFiles: [], output: [] })
  })

  it('remembers each file the user opens, the last one first, and selects the last one\'s root', async () => {
    await useAppStore.getState().openPaths(['/A.dll', '/B.dll'], { remember: true })
    expect(useAppStore.getState().recentFiles).toEqual(['/B.dll', '/A.dll'])
    expect(loadRecentFiles()).toEqual(['/B.dll', '/A.dll'])
    // dnSpy's OpenDocumentsHelper selects the last file it loaded.
    expect(useAppStore.getState().selectedNode).toBe(rootB)
  })

  it('leaves the list alone for the files a session or a list brings back', async () => {
    await useAppStore.getState().openPaths(['/A.dll', '/B.dll'])
    expect(useAppStore.getState().recentFiles).toEqual([])
  })

  it('opens a recent file into the tree as it stands and moves it to the top', async () => {
    rememberRecentFiles(['/B.dll', '/A.dll'])
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], roots: [rootA], recentFiles: loadRecentFiles() })
    await useAppStore.getState().openRecentFile('/B.dll')
    expect(addModules).toHaveBeenCalledWith('w1', ['/B.dll'])
    expect(useAppStore.getState().recentFiles).toEqual(['/B.dll', '/A.dll'])
    expect(useAppStore.getState().selectedNode).toBe(rootB)
  })

  it('keeps thirty files, each once whatever its case', () => {
    const many = Array.from({ length: 40 }, (_, index) => `/f${index}.dll`)
    expect(rememberRecentFiles(many)).toHaveLength(30)
    expect(rememberRecentFiles(['/F39.DLL'])).toEqual(['/F39.DLL', ...many.slice(10, 39).reverse()])
  })

  it('carries over the file sets an older profile kept', () => {
    localStorage.setItem('dnspy.recentWorkspaces.v1', JSON.stringify([['/new/A.dll', '/new/B.dll'], ['/old/C.dll']]))
    expect(loadRecentFiles()).toEqual(['/new/A.dll', '/new/B.dll', '/old/C.dll'])
  })

  it('puts only the files a drop added on the list', async () => {
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], roots: [rootA] })
    await useAppStore.getState().dropFiles(['/A.dll', '/B.dll'], 1, 'allSupported')
    expect(useAppStore.getState().recentFiles).toEqual(['/B.dll'])
  })
})

describe('tree selection', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => treeNode(id, `key:${id}`))

  beforeEach(() => useAppStore.setState({ selectedNode: undefined, selectedNodes: [], selectionAnchorId: undefined }))

  it('spans a Shift range from the anchor, which the range leaves in place', () => {
    const { selectNode } = useAppStore.getState()
    selectNode(rows[1])
    selectNode(rows[3], { range: true, rows })
    expect(useAppStore.getState().selectedNodes.map((node) => node.id)).toEqual(['b', 'c', 'd'])
    selectNode(rows[0], { range: true, rows })
    expect(useAppStore.getState().selectedNodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(useAppStore.getState().selectedNode).toBe(rows[0])
    // Ctrl moves the anchor to the row it toggled.
    selectNode(rows[3], { toggle: true })
    selectNode(rows[2], { range: true, rows })
    expect(useAppStore.getState().selectedNodes.map((node) => node.id)).toEqual(['c', 'd'])
  })

  it('selects every row it is given, keeping the row the commands act on', () => {
    useAppStore.getState().selectNode(rows[2])
    useAppStore.getState().selectNodes(rows, rows[2])
    expect(useAppStore.getState().selectedNodes).toEqual(rows)
    expect(useAppStore.getState().selectedNode).toBe(rows[2])
  })
})

describe('Remove Assembly and the edit history', () => {
  const rootA = moduleNode('n1', '/A.dll')
  const rootB = moduleNode('n2', '/B.dll')
  const member = treeNode('m1', 'module:/A.dll:type:1', { label: 'Type' })
  const removeModules = vi.fn()
  const undoEdit = vi.fn()
  const redoEdit = vi.fn()
  const getRoots = vi.fn()
  const getNode = vi.fn()

  beforeEach(() => {
    removeModules.mockReset().mockResolvedValue({ removedNodeIds: ['n1', 'm1'], roots: [rootB], canUndo: true, canRedo: false })
    getRoots.mockReset()
    getNode.mockReset().mockRejectedValue(new Error('gone'))
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, removeModules, undoEdit, redoEdit, getRoots, getNode } })
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')],
      roots: [rootA, rootB],
      children: { n1: [member] },
      parents: { m1: 'n1' },
      expanded: { n1: true },
      documents: { m1: documentState('m1') },
      selectedNode: member,
      selectedNodes: [member],
      canUndo: false,
      canRedo: false,
      workspaceStateId: 's1',
      savedStateId: 's1',
      output: [],
    })
  })

  it('takes the history the removal left, and drops the module it took', async () => {
    await expect(useAppStore.getState().removeModules(['n1'])).resolves.toEqual(['n1', 'm1'])
    const state = useAppStore.getState()
    expect(state.canUndo).toBe(true)
    expect(state.modules.map((module) => module.id)).toEqual(['n2'])
    expect(state.documents).toEqual({})
    expect(state.selectedNode).toBe(rootB)
  })

  it('puts a removed document back on Undo, and answers the rows a Redo takes away again', async () => {
    await useAppStore.getState().removeModules(['n1'])
    getRoots.mockResolvedValue({ nodes: [rootA, rootB] })
    undoEdit.mockResolvedValue({ version: 3, stateId: 's1', changedNodeIds: ['n1'], canUndo: true, canRedo: true, modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')] })
    await expect(useAppStore.getState().undoEdit()).resolves.toEqual([])
    expect(useAppStore.getState().roots).toEqual([rootA, rootB])
    expect(useAppStore.getState().modules.map((module) => module.id)).toEqual(['n1', 'n2'])
    expect(useAppStore.getState().dirty).toBe(false)

    // The tree lists the document's rows again, and a redo takes them all away with it.
    useAppStore.setState({ children: { n1: [member] }, parents: { m1: 'n1' }, documents: { m1: documentState('m1') } })
    getRoots.mockResolvedValue({ nodes: [rootB] })
    redoEdit.mockResolvedValue({ version: 4, stateId: 's1', changedNodeIds: ['n1'], canUndo: true, canRedo: false, modules: [openedModule('n2', '/B.dll')] })
    const removed = await useAppStore.getState().redoEdit()
    expect(removed.sort()).toEqual(['m1', 'n1'])
    expect(useAppStore.getState().documents).toEqual({})
    expect(useAppStore.getState().modules.map((module) => module.id)).toEqual(['n2'])
  })
})

describe('saving the modules a command lets go of', () => {
  const getSaveOptions = vi.fn()
  const getModifiedDocuments = vi.fn()

  beforeEach(() => {
    getSaveOptions.mockReset().mockImplementation(async (_workspaceId: string, id: string) => moduleSaveOptions({ documentId: id, fileName: `/${id}.dll` }))
    getModifiedDocuments.mockReset().mockResolvedValue([
      { id: 'a', name: 'a', path: '/a.dll', inMemory: false, isHexDocument: false },
      { id: 'b', name: 'b', path: '/b.dll', inMemory: false, isHexDocument: false },
    ])
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, getSaveOptions, getModifiedDocuments } })
    useAppStore.setState({ workspaceId: 'w1', modules: [openedModule('a', '/a.dll'), openedModule('b', '/b.dll')], dirty: true, saveRequest: undefined, output: [] })
  })

  it('saves the modified documents among the files, and leaves the workspace modified while another one still is', async () => {
    const saved = useAppStore.getState().saveModules(['/a.dll'])
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    expect(useAppStore.getState().saveRequest?.documents.map((document) => document.documentId)).toEqual(['a'])
    useAppStore.getState().acceptSaveOptions(useAppStore.getState().saveRequest!.documents[0])
    await useAppStore.getState().finishSave({
      canceled: false,
      modifiedDocuments: [{ id: 'b', name: 'b', path: '/b.dll', inMemory: false, isHexDocument: false }],
      results: [{ documentId: 'a', fileName: '/a.dll', saved: true, length: 1, sha256: 'aa', log: [], errorCount: 0 }],
    })
    await expect(saved).resolves.toBe(true)
    expect(useAppStore.getState().dirty).toBe(true)
  })

  it('answers false when a write fails, which calls the command off', async () => {
    const saved = useAppStore.getState().saveModules(['/a.dll'])
    await vi.waitFor(() => expect(useAppStore.getState().saveRequest).toBeDefined())
    await useAppStore.getState().finishSave({
      canceled: true,
      modifiedDocuments: [],
      results: [],
    })
    await expect(saved).resolves.toBe(false)
  })
})

describe('changeLanguage', () => {
  const node = (id: string): TreeNode => ({ id, kind: 'type', label: id, hasChildren: false })
  const documentIn = (nodeId: string, language: DecompilerLanguage): DocumentState => ({
    nodeId, title: nodeId, language: language === 'cSharp' ? 'csharp' : 'il', text: '', spans: [], diagnostics: [], codeStatements: [], loading: false, requestedLanguage: language,
  })

  it('decompiles every open tab again in the language chosen, leaves the selection, and remembers it', async () => {
    const decompile = vi.fn(async (_workspaceId: string, nodeId: string, language: DecompilerLanguage) => ({
      title: nodeId, language: language === 'visualBasic' ? 'visual-basic' : 'csharp', text: `${nodeId} in ${language}`, spans: [], diagnostics: [],
    }))
    const getNode = vi.fn(async (_workspaceId: string, nodeId: string) => node(nodeId))
    Object.assign(window.dnSpy, { decompile, getNode })
    const selected = node('selected')
    useAppStore.setState({
      workspaceId: 'ws',
      roots: [node('a')],
      selectedNode: selected,
      selectedNodes: [selected],
      documents: { a: documentIn('a', 'cSharp'), b: documentIn('b', 'cSharp'), closed: documentIn('closed', 'cSharp'), already: documentIn('already', 'visualBasic'), opening: { ...documentIn('opening', 'cSharp'), loading: true } },
      documentOrder: ['a', 'b', 'a', 'already'],
      defaultLanguage: 'cSharp',
    })

    await useAppStore.getState().changeLanguage('visualBasic')

    // The open tabs that showed another language, each once, and a document a tab is still waiting for — a
    // closed one waits until it is opened again.
    expect(decompile.mock.calls.map(([, nodeId, language]) => [nodeId, language]).sort()).toEqual([['a', 'visualBasic'], ['b', 'visualBasic'], ['opening', 'visualBasic']])
    expect(useAppStore.getState().documents.a.text).toBe('a in visualBasic')
    expect(useAppStore.getState().documents.closed.requestedLanguage).toBe('cSharp')
    expect(useAppStore.getState().selectedNode).toBe(selected)
    expect(useAppStore.getState().defaultLanguage).toBe('visualBasic')
    expect(localStorage.getItem('dnspy.decompilerLanguage')).toBe('visualBasic')
    localStorage.removeItem('dnspy.decompilerLanguage')
  })
})

// The debugger's own commands beyond stepping: they act on the stopped process through the engine and read
// the windows again afterwards.
describe('debugger commands', () => {
  const disconnectDebug = vi.fn(async () => undefined)
  const setDebugExpression = vi.fn()
  const setNextStatement = vi.fn(async () => undefined)
  const runToDebugFrame = vi.fn(async () => undefined)
  const runToDebugCursor = vi.fn(async () => undefined)
  const setDebugModuleBreakpoints = vi.fn(async () => undefined)
  const getDebugVariables = vi.fn(async () => [])

  beforeEach(() => {
    for (const mock of [disconnectDebug, setDebugExpression, setNextStatement, runToDebugFrame, runToDebugCursor, setDebugModuleBreakpoints, getDebugVariables])
      mock.mockClear()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: {
        ...window.dnSpy,
        disconnectDebug,
        setDebugExpression,
        setNextStatement,
        runToDebugFrame,
        runToDebugCursor,
        setDebugModuleBreakpoints,
        getDebugScopes: vi.fn(async () => [{ name: 'Locals', variablesReference: 5, expensive: false }]),
        getDebugVariables,
        evaluateDebugExpression: vi.fn(async (_session: string, _frame: number, expression: string) => ({ name: 'engine name', value: `<${expression}>`, variablesReference: 0, evaluateName: expression })),
        showMessage: vi.fn(async () => undefined),
      },
    })
    useAppStore.setState({
      debugSessionId: 'session',
      debugState: 'stopped',
      selectedDebugThreadId: 1,
      activeDebugFrameId: 7,
      debugProcess: undefined,
      watches: [],
      watchValues: [],
      moduleBreakpoints: [],
      debugOutput: [],
      codeCaret: undefined,
      documents: {},
    })
  })

  it('detaches from a process it attached to and kills one it started', async () => {
    useAppStore.setState({ debugProcess: { id: 1, state: 'Paused', debugging: 'CoreCLR', architecture: 'X64', ownsDebuggee: false } })
    await useAppStore.getState().stopDebug()
    expect(disconnectDebug).toHaveBeenLastCalledWith('session', false)

    useAppStore.setState({ debugSessionId: 'session', debugProcess: { id: 1, state: 'Paused', debugging: 'CoreCLR', architecture: 'X64', ownsDebuggee: true } })
    await useAppStore.getState().stopDebug()
    expect(disconnectDebug).toHaveBeenLastCalledWith('session', true)

    useAppStore.setState({ debugSessionId: 'session' })
    await useAppStore.getState().terminateDebug()
    expect(disconnectDebug).toHaveBeenLastCalledWith('session', true)
    expect(useAppStore.getState().debugState).toBe('inactive')
  })

  it('writes a value in the active frame and reads the frame again', async () => {
    setDebugExpression.mockResolvedValue({ node: { name: 'x', value: '5', variablesReference: 0 }, error: null })
    const generation = useAppStore.getState().debugGeneration

    const error = await useAppStore.getState().setDebugValue('shape.Sides', '5')

    expect(error).toBeUndefined()
    expect(setDebugExpression).toHaveBeenCalledWith('session', 7, 'shape.Sides', '5')
    expect(getDebugVariables).toHaveBeenCalledWith('session', 5)
    expect(useAppStore.getState().debugGeneration).toBe(generation + 1)
  })

  it('answers the engine\'s complaint about a value it could not write', async () => {
    setDebugExpression.mockRejectedValue(new Error('Cannot convert'))
    expect(await useAppStore.getState().setDebugValue('factor', '"text"')).toBe('Cannot convert')
  })

  it('names a watch by its expression, whatever the engine calls the row', async () => {
    await useAppStore.getState().addWatch('numbers.Length')
    expect(useAppStore.getState().watchValues).toEqual([expect.objectContaining({ name: 'numbers.Length', value: '<numbers.Length>' })])

    await useAppStore.getState().editWatch('numbers.Length', 'numbers[0]')
    expect(useAppStore.getState().watches).toEqual(['numbers[0]'])
    useAppStore.getState().clearWatches()
    expect(useAppStore.getState().watches).toEqual([])
  })

  it('moves the instruction pointer to the statement under the caret', async () => {
    useAppStore.setState({
      codeCaret: { documentId: 'method-1', line: 4, column: 5 },
      documents: { 'method-1': { codeStatements: [{ startLine: 4, startColumn: 1, endLine: 4, endColumn: 20, modulePath: '/app/a.dll', metadataToken: 0x06000002, ilOffset: 12, ilEndOffset: 20 }] } as unknown as DocumentState },
    })

    await useAppStore.getState().setNextStatement()
    expect(setNextStatement).toHaveBeenCalledWith('session', 1, { modulePath: '/app/a.dll', metadataToken: 0x06000002, ilOffset: 12 })

    await useAppStore.getState().runToCursor()
    expect(runToDebugCursor).toHaveBeenCalledWith('session', { modulePath: '/app/a.dll', metadataToken: 0x06000002, ilOffset: 12 })
    // The process runs until the cursor is reached.
    expect(useAppStore.getState().debugState).toBe('running')

    useAppStore.setState({ debugState: 'stopped' })
    await useAppStore.getState().runToCursor(9)
    expect(runToDebugFrame).toHaveBeenCalledWith('session', 9)
  })

  it('sends only the enabled module breakpoints, without the window\'s own fields', async () => {
    await useAppStore.getState().addModuleBreakpoint({ moduleName: 'System.*' })
    const [row] = useAppStore.getState().moduleBreakpoints
    expect(setDebugModuleBreakpoints).toHaveBeenLastCalledWith('session', [{ moduleName: 'System.*' }])

    await useAppStore.getState().updateModuleBreakpoint(row.id, { enabled: false })
    expect(setDebugModuleBreakpoints).toHaveBeenLastCalledWith('session', [])

    await useAppStore.getState().removeModuleBreakpoints([row.id])
    expect(useAppStore.getState().moduleBreakpoints).toEqual([])
  })

  it('logs exceptions and module loads to the Debug output the way OutputLogger does', async () => {
    useAppStore.setState({ debugProcess: { id: 1, name: 'DebugTarget', state: 'Running', debugging: 'CoreCLR', architecture: 'X64', ownsDebuggee: true }, debugModules: [] })
    await useAppStore.getState().handleDebugEvent({ sessionId: 'session', event: 'exception', body: { name: 'System.InvalidOperationException', module: 'DebugTarget.dll', message: 'boom', firstChance: true } })
    await useAppStore.getState().handleDebugEvent({ sessionId: 'session', event: 'module', body: { reason: 'new', module: { id: 3, name: 'a.dll', path: '/app/a.dll', order: 3 } } })

    const lines = useAppStore.getState().debugOutput.map((line) => line.text)
    expect(lines).toContain(translate('Exception thrown: \'{name}\' in {module}', { name: 'System.InvalidOperationException', module: 'DebugTarget.dll' }))
    expect(lines).toContain(translate('Additional information: {message}', { message: 'boom' }))
    expect(lines.at(-1)).toContain('/app/a.dll')
    expect(useAppStore.getState().debugModules.map((module) => module.id)).toEqual([3])
  })
})

describe('memory modules', () => {
  const saveDebugModule = vi.fn(async () => '/tmp/dnSpy-memory-modules/7/3/Dyn')
  const removeModules = vi.fn(async () => ({ removedNodeIds: ['root'], roots: [] }))
  const addModules = vi.fn(async () => ({ modules: [{ id: 'root2', name: 'Dyn', path: '/tmp/dnSpy-memory-modules/7/3/Dyn', hasPdb: false }] }))
  const reloadModule = vi.fn(async () => ({ modules: [{ id: 'root', name: 'Dyn', path: '/tmp/dnSpy-memory-modules/7/3/Dyn', hasPdb: false }], removedNodeIds: [] as string[], changedNodeIds: ['type'], canUndo: false, canRedo: false, stateId: 'state2' }))

  beforeEach(() => {
    for (const mock of [saveDebugModule, removeModules, addModules, reloadModule])
      mock.mockClear()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, saveDebugModule, removeModules, addModules, reloadModule, getRoots: vi.fn(async () => ({ nodes: [] })), getModifiedModules: vi.fn(async () => ({ paths: [] })), getModifiedDocuments: vi.fn(async () => ({ documents: [] })) },
    })
    useAppStore.setState({
      workspaceId: 'w',
      debugSessionId: 's',
      debugSessions: [{ sessionId: 's', state: 'stopped', modules: [], threads: [], shouldDetach: false }],
      modules: [{ id: 'root', name: 'Dyn', path: '/tmp/dnSpy-memory-modules/7/3/Dyn', hasPdb: false }],
      parents: { type: 'root' },
      memoryModules: { '/tmp/dnSpy-memory-modules/7/3/Dyn': { sessionId: 's', moduleId: 3, name: 'Dyn' } },
      debugOutput: [],
    })
  })

  it('offers Reload All Method Bodies on a module read out of a process still being debugged', () => {
    expect(memoryModulePathOf(useAppStore.getState(), 'type')).toBe('/tmp/dnSpy-memory-modules/7/3/Dyn')
    useAppStore.setState({ debugSessionId: undefined, debugSessions: [] })
    expect(memoryModulePathOf(useAppStore.getState(), 'type')).toBeUndefined()
  })

  it('reads the module out of the process again and refreshes the copy in place, keeping its node ids', async () => {
    await useAppStore.getState().reloadMethodBodies('type')

    expect(saveDebugModule).toHaveBeenCalledWith('s', 3, '/tmp/dnSpy-memory-modules/7/3/Dyn')
    // MemoryModuleDefDocument.UpdateMemory updates the document it already has; it is not removed and reopened.
    expect(reloadModule).toHaveBeenCalledWith('w', 'root')
    expect(removeModules).not.toHaveBeenCalled()
    expect(addModules).not.toHaveBeenCalled()
  })

  it('reads a dynamic module again at the stop after a type was created in it, as dnSpy\'s ClassLoader does', async () => {
    await useAppStore.getState().handleDebugEvent({ sessionId: 's', event: 'module', body: { reason: 'classLoaded', module: { id: 3, name: 'Dyn' }, token: 0x02000002 } })
    expect(saveDebugModule).not.toHaveBeenCalled()
    // Being told is not a module load: the Modules window and the Output stay as they were.
    expect(useAppStore.getState().debugOutput).toEqual([])

    await useAppStore.getState().handleDebugEvent({ sessionId: 's', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } })
    await waitFor(() => expect(saveDebugModule).toHaveBeenCalledWith('s', 3, '/tmp/dnSpy-memory-modules/7/3/Dyn'))
  })
})

describe('debugging several processes', () => {
  const debugContinue = vi.fn(async () => undefined)
  const debugNext = vi.fn(async () => undefined)
  const disconnectDebug = vi.fn(async () => undefined)
  const getDebugThreads = vi.fn(async (sessionId: string) => [{ id: sessionId === 'b' ? 20 : 10, name: `${sessionId} main` }])
  const entry = (sessionId: string, state: 'running' | 'stopped', extra: Record<string, unknown> = {}) => ({ sessionId, state, modules: [], threads: [], shouldDetach: false, ...extra })

  beforeEach(() => {
    for (const mock of [debugContinue, debugNext, disconnectDebug, getDebugThreads])
      mock.mockClear()
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: {
        ...window.dnSpy,
        debugContinue,
        debugNext,
        disconnectDebug,
        getDebugThreads,
        getDebugStackTrace: vi.fn(async () => []),
        getDebugModules: vi.fn(async () => []),
        getDebugProcess: vi.fn(async () => undefined),
        getDebugScopes: vi.fn(async () => []),
        getDebugVariables: vi.fn(async () => []),
        bringWindowToFront: vi.fn(async () => undefined),
      },
    })
    useAppStore.setState({
      debugSessionId: 'a',
      debugState: 'running',
      selectedDebugThreadId: 10,
      debugSessions: [entry('a', 'running'), entry('b', 'running', { shouldDetach: true })],
      debugOutput: [],
      lineBreakpoints: [],
      documents: {},
    })
  })

  it('makes a process that breaks the current one while the current one runs', async () => {
    await useAppStore.getState().handleDebugEvent({ sessionId: 'b', event: 'stopped', body: { reason: 'breakpoint', threadId: 20 } })

    expect(useAppStore.getState()).toMatchObject({ debugSessionId: 'b', debugState: 'stopped', selectedDebugThreadId: 20 })
    expect(useAppStore.getState().debugSessions.find((candidate) => candidate.sessionId === 'b')).toMatchObject({ state: 'stopped', threadId: 20 })
  })

  it('keeps the current process when another one is paused after it broke', async () => {
    useAppStore.setState({ debugState: 'stopped', debugSessions: [entry('a', 'stopped'), entry('b', 'running')] })

    await useAppStore.getState().handleDebugEvent({ sessionId: 'b', event: 'stopped', body: { reason: 'pause', threadId: 20 } })

    expect(useAppStore.getState().debugSessionId).toBe('a')
    expect(useAppStore.getState().debugSessions.find((candidate) => candidate.sessionId === 'b')).toMatchObject({ state: 'stopped', threadId: 20, threads: [{ id: 20 }] })
  })

  it('runs every paused process on Continue, and only the current one on a step of the current process', async () => {
    useAppStore.setState({ debugState: 'stopped', debugSessions: [entry('a', 'stopped'), entry('b', 'stopped', { threadId: 20 })] })

    await useAppStore.getState().stepDebug('next', true)
    expect(debugNext).toHaveBeenCalledWith('a', 10)
    expect(debugContinue).not.toHaveBeenCalled()

    useAppStore.setState({ debugState: 'stopped', selectedDebugThreadId: 10 })
    await useAppStore.getState().continueDebug()
    expect(debugContinue).toHaveBeenCalledWith('b', 20)
    expect(debugContinue).toHaveBeenCalledWith('a', 10)
  })

  it('detaches from the processes marked so and terminates the rest when debugging stops', async () => {
    await useAppStore.getState().stopDebug()

    expect(disconnectDebug).toHaveBeenCalledWith('a', true)
    expect(disconnectDebug).toHaveBeenCalledWith('b', false)
    expect(useAppStore.getState()).toMatchObject({ debugState: 'inactive', debugSessionId: undefined, debugSessions: [] })
  })

  it('goes on with the other process when the current one exits', async () => {
    useAppStore.setState({ debugSessions: [entry('a', 'running'), entry('b', 'stopped', { threadId: 20 })] })

    await useAppStore.getState().handleDebugEvent({ sessionId: 'a', event: 'exited', body: { exitCode: 0 } })

    expect(useAppStore.getState()).toMatchObject({ debugSessionId: 'b', debugState: 'stopped', selectedDebugThreadId: 20 })
    expect(useAppStore.getState().debugSessions.map((candidate) => candidate.sessionId)).toEqual(['b'])
  })

  it('ignores what a process it let go of still sends', async () => {
    await useAppStore.getState().detachDebugProcess('b')
    await useAppStore.getState().handleDebugEvent({ sessionId: 'b', event: 'stopped', body: { reason: 'pause', threadId: 20 } })

    expect(useAppStore.getState().debugSessionId).toBe('a')
    expect(useAppStore.getState().debugSessions.map((candidate) => candidate.sessionId)).toEqual(['a'])
  })
})
