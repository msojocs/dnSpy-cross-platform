import { Actions, DockLocation, Model, TabSetNode } from 'flexlayout-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeStatement, DebugBreakpoint, DebugStackFrame, DecompilerLanguage, HexMethodTarget, HexTargetResponse, TreeNode } from '../../shared/protocol'
import { isNavigableSpan } from '../../shared/protocol'
import { bookmarkEntries, bookmarkLineInDocument, bookmarkMarkers, breakpointsFile, buildSession, bytesToHex, codeStatementAt, enableSessionPersistence, filterBookmarks, lineBreakpointEntries, lineBreakpointMarkers, loadSession, methodBreakpointName, orderedDocumentKeys, ownerTypeIdOf, parseBookmarkEntries, parseHexText, parseLineBreakpointEntries, statementIdentity, suggestCodeFilename, syncDockTabStrips, useAppStore } from './app-store'
import type { Bookmark, DocumentState, LineBreakpoint, SessionSource } from './app-store'
import { translate } from './localization'

describe('suggestCodeFilename', () => {
  it.each([
    ['Example', 'csharp', 'Example.cs'],
    ['Example', 'visual-basic', 'Example.vb'],
    ['Example', 'il', 'Example.il'],
    ['View.xaml', 'xml', 'View.xaml.xml'],
    ['Resource', 'plaintext', 'Resource.txt'],
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
    ...extra,
  })

  it('draws a bound breakpoint at the line the engine snapped it to', () => {
    const statements = [statement(5, 6, { ilOffset: 3 }), statement(7, 8, { ilOffset: 7 })]
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint()])).toEqual([
      { line: 7, enabled: true, state: 'bound', message: undefined, description: undefined },
    ])
  })

  it('draws a pending breakpoint at the line the user clicked', () => {
    const markers = lineBreakpointMarkers('method-1', [statement(7, 8, { ilOffset: 7 })], [
      breakpoint({ state: 'pending', modulePath: undefined, ilOffset: undefined }),
    ])
    expect(markers.map((marker) => marker.line)).toEqual([9])
  })

  it('draws nothing in a document that is not the breakpoint’s', () => {
    const statements = [statement(7, 8, { ilOffset: 7 })]
    // Bound to another module: the IL identity matches nothing here, and there is no requested line to fall back on.
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint({ identity: 'other|1|2' })])).toEqual([])
    // Not yet bound, and requested from a different node.
    expect(lineBreakpointMarkers('method-1', statements, [breakpoint({ nodeId: 'method-2', modulePath: undefined, ilOffset: undefined })])).toEqual([])
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
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ name: 'Ns.Type.A' }])

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
      { name: 'Ns.Type.A', settings: { condition: { kind: 'isTrue', expression: 'Code > 1' } } },
      { name: 'Ns.Type.C' },
    ])
  })

  it('enables and disables every breakpoint', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }, { name: 'Ns.Type.B', enabled: false }] })

    await useAppStore.getState().setAllFunctionBreakpointsEnabled(false)
    expect(useAppStore.getState().functionBreakpoints.every((breakpoint) => !breakpoint.enabled)).toBe(true)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [])

    await useAppStore.getState().setAllFunctionBreakpointsEnabled(true)
    expect(useAppStore.getState().functionBreakpoints.every((breakpoint) => breakpoint.enabled)).toBe(true)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ name: 'Ns.Type.A' }, { name: 'Ns.Type.B' }])
  })

  it('enables and disables a single breakpoint', async () => {
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }, { name: 'Ns.Type.B', enabled: false }] })

    await useAppStore.getState().setFunctionBreakpointEnabled('Ns.Type.B', true)
    expect(useAppStore.getState().functionBreakpoints).toEqual([
      { name: 'Ns.Type.A', enabled: true },
      { name: 'Ns.Type.B', enabled: true },
    ])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ name: 'Ns.Type.A' }, { name: 'Ns.Type.B' }])

    await useAppStore.getState().setFunctionBreakpointEnabled('Ns.Type.A', false)
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ name: 'Ns.Type.B' }])
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

describe('class breakpoints', () => {
  const setFunctionBreakpoints = vi.fn(async () => ({}))
  const getChildren = vi.fn()

  const typeNode: TreeNode = { id: 'n-type', kind: 'type', label: 'Console', hasChildren: true }
  const row = (description: string, kind: string): TreeNode => ({ id: `n-${description}`, kind, label: description, hasChildren: false, description })

  const install = (nodes: TreeNode[]): void => {
    getChildren.mockReset().mockImplementation(async () => ({ nodes }))
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getChildren, setFunctionBreakpoints },
    })
  }

  beforeEach(() => {
    setFunctionBreakpoints.mockClear()
    useAppStore.setState({ workspaceId: 'ws1', functionBreakpoints: [], debugSessionId: 'session', children: {}, output: [] })
  })

  it('breaks on every method of the type, and on no other kind of row it holds', async () => {
    install([
      row('System.Void Ns.Type::.ctor()', 'method'),
      row('System.Int32 Ns.Type::Get()', 'method'),
      row('Ns.Type+Kind', 'type'),
      row('System.Int32 _count', 'field'),
    ])

    await useAppStore.getState().addClassBreakpoint(typeNode)

    // The type's methods are not loaded until asked for, so the command reads them the way expanding the
    // row would, and the whole set goes to the adapter as one request.
    expect(getChildren).toHaveBeenCalledWith('ws1', 'n-type')
    expect(useAppStore.getState().functionBreakpoints).toEqual([
      { name: 'Ns.Type..ctor', enabled: true },
      { name: 'Ns.Type.Get', enabled: true },
    ])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ name: 'Ns.Type..ctor' }, { name: 'Ns.Type.Get' }])
    expect(useAppStore.getState().output.at(-1)).toContain(translate('Added {count} breakpoint(s) for {name}.', { count: 2, name: 'Console' }))
  })

  it('breaks on the accessors the tree nests under a property, as type.Methods holds them too', async () => {
    const property: TreeNode = { ...row('System.Int32 Ns.Type::Code', 'property'), hasChildren: true }
    const getter = row('System.Int32 Ns.Type::get_Code()', 'method')
    const setter = row('System.Void Ns.Type::set_Code(System.Int32)', 'method')
    const constructor = row('System.Void Ns.Type::.ctor()', 'method')
    getChildren.mockReset().mockImplementation(async (_workspaceId: string, nodeId: string) => ({
      nodes: nodeId === 'n-type' ? [property, constructor] : [getter, setter],
    }))
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, getChildren, setFunctionBreakpoints },
    })

    await useAppStore.getState().addClassBreakpoint(typeNode)

    // dnSpy walks `type.Methods`, which holds the getter and the setter as well as the constructor, so
    // the property's own row has to be read down to them.
    expect(useAppStore.getState().functionBreakpoints.map((breakpoint) => breakpoint.name)).toEqual([
      'Ns.Type..ctor',
      'Ns.Type.get_Code',
      'Ns.Type.set_Code',
    ])
  })

  it('leaves a breakpoint that is already there alone, and counts two overloads as the one name they share', async () => {
    install([
      row('System.Int32 Ns.Type::Get()', 'method'),
      row('System.Int32 Ns.Type::Get(System.Int32)', 'method'),
      row('System.Void Ns.Type::Put(System.Int32)', 'method'),
    ])
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.Put', enabled: false }] })

    await useAppStore.getState().addClassBreakpoint(typeNode)

    // A name that is already broken on keeps its own settings, and an overload pair cannot be told apart by
    // name — the engine binds the name to whichever of them it finds.
    expect(useAppStore.getState().functionBreakpoints).toEqual([
      { name: 'Ns.Type.Put', enabled: false },
      { name: 'Ns.Type.Get', enabled: true },
    ])
    expect(useAppStore.getState().output.at(-1)).toContain(translate('Added {count} breakpoint(s) for {name}.', { count: 1, name: 'Console' }))
  })

  it('says so when the type has no method left to break on', async () => {
    install([row('System.Void Ns.Type::Get()', 'method')])
    useAppStore.setState({ functionBreakpoints: [{ name: 'Ns.Type.Get', enabled: true }] })

    await useAppStore.getState().addClassBreakpoint(typeNode)

    expect(useAppStore.getState().functionBreakpoints).toEqual([{ name: 'Ns.Type.Get', enabled: true }])
    expect(setFunctionBreakpoints).not.toHaveBeenCalled()
    expect(useAppStore.getState().output.at(-1)).toContain(translate('{name} has no method left to break on.', { name: 'Console' }))
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
    evaluateScript.mockReset().mockResolvedValue({ entries: [{ kind: 'result', text: '2' }] })
    resetScript.mockReset().mockResolvedValue({ entries: [banner] })
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, evaluateScript, resetScript } })
    useAppStore.setState({ scriptEntries: [], scriptRunning: false, scriptHistory: [], scriptStarted: false })
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

    expect(useAppStore.getState().scriptEntries).toEqual([
      { kind: 'output', text: translate('Resetting execution engine.') },
      banner,
    ])
  })

  it('builds the session once, printing the banner and the help hint', async () => {
    await useAppStore.getState().startScript()
    await useAppStore.getState().startScript()

    expect(resetScript).toHaveBeenCalledOnce()
    const entries = useAppStore.getState().scriptEntries
    expect(entries[0]).toEqual(banner)
    expect(entries[entries.length - 1]).toEqual({ kind: 'help', text: translate('Type "#help" for more information.') })
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

  it('names a bookmark by the statement it landed on, not the line that was clicked', () => {
    // Line 8 is blank; the nearest statement is the one below it on line 9.
    useAppStore.getState().toggleBookmark('method-1', 8)

    const [created] = useAppStore.getState().bookmarks
    expect(created).toMatchObject({
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
    useAppStore.getState().toggleBookmark('method-1', 8)
    // The user now clicks the marker where it was drawn, not the blank line they started on.
    useAppStore.getState().toggleBookmark('method-1', 9)

    expect(useAppStore.getState().bookmarks).toEqual([])
    expect(useAppStore.getState().activeBookmarkId).toBeUndefined()
  })

  it('keeps a bookmark whose line has no statement, but only for this session', () => {
    useAppStore.setState({ documents: { 'method-1': doc(undefined) } })
    useAppStore.getState().toggleBookmark('method-1', 30)

    expect(useAppStore.getState().bookmarks[0]).toMatchObject({
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

    useAppStore.getState().toggleBookmarkEnabledAt('method-1', 8)
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
        bookmark({ id: 'b2', order: 2, line: 9, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
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
        bookmark({ id: 'b2', order: 2, line: 9, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
        bookmark({ id: 'b3', order: 3, line: 14, identity: statementIdentity('/app/DebugTarget.dll', 0x06000002, 11), enabled: false }),
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
        bookmark({ id: 'b2', order: 2, line: 9, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) }),
        bookmark({ id: 'b3', order: 3, line: 14, identity: statementIdentity('/app/DebugTarget.dll', 0x06000002, 11), labels: ['hot'] }),
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
    expect(useAppStore.getState().output.at(-1)).toContain(translate('Bookmark "{name}" is in a module that is not loaded.', { name: 'Loop head' }))
  })

  it('finds a restored bookmark by identity once its document is open', () => {
    const restored = bookmark({ id: 'b1', nodeId: '', line: 0, identity: statementIdentity('/app/DebugTarget.dll', 0x06000001, 7) })

    expect(bookmarkLineInDocument('method-1', statements, restored)).toBe(9)
    // A document whose IL map does not contain the identity gets no marker, even though its own
    // statements are perfectly good.
    expect(bookmarkLineInDocument('method-2', [statement(3, 3, { ilOffset: 2 })], restored)).toBeUndefined()
    // Nor does a document that has not been decompiled yet, since a restored bookmark has no line.
    expect(bookmarkLineInDocument('method-1', undefined, restored)).toBeUndefined()
  })

  it('falls back to the cached line for a session-only bookmark', () => {
    const sessionOnly = bookmark({ id: 'b1', nodeId: 'method-1', line: 30, identity: 'method-1|30' })

    expect(bookmarkLineInDocument('method-1', statements, sessionOnly)).toBe(30)
    expect(bookmarkLineInDocument('method-2', statements, sessionOnly)).toBeUndefined()
    expect(bookmarkMarkers('method-1', statements, [sessionOnly])).toEqual([{ line: 30, enabled: true, message: 'First' }])
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
    expect(useAppStore.getState().output.at(-1)).toContain(translate('Navigation failed: {message}', { message: '/app/Missing.dll' }))
  })

  it('reports a reference that could not be looked up at all', async () => {
    install({ findMember: vi.fn(async () => { throw new Error('the backend is gone') }) })

    await useAppStore.getState().openReferenceTarget({ start: 0, length: 9, kind: 'method', targetModulePath: consolePath, targetMetadataToken: 0x06000123 })

    expect(openNodeById).not.toHaveBeenCalled()
    expect(useAppStore.getState().output.at(-1)).toContain('the backend is gone')
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
    expect(useAppStore.getState().output.at(-1)).toContain(translate('Loaded {name} for the stopped location.', { name: 'System.Console.dll' }))
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
  const writeText = vi.fn(async () => undefined)
  const readText = vi.fn(async () => '')

  beforeEach(() => {
    for (const mock of [beginEdit, commitEdit, rollbackEdit, patchHex, resolveHexTarget, resolveHexStatement, readHex, getNode, getChildren, writeText, readText])
      mock.mockReset()
    beginEdit.mockResolvedValue({ transactionId: 't1', baseVersion: 1 })
    commitEdit.mockResolvedValue({ version: 2, stateId: 'state-2', changedNodeIds: ['m1'], canUndo: true, canRedo: false })
    rollbackEdit.mockResolvedValue(undefined)
    patchHex.mockResolvedValue({ queued: true })
    getNode.mockResolvedValue(methodNode)
    getChildren.mockResolvedValue({ nodes: [] })
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, beginEdit, commitEdit, rollbackEdit, patchHex, resolveHexTarget, resolveHexStatement, readHex, getNode, getChildren },
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

  it('writes a canned body over the method body and commits it as an edit', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })

    expect(await useAppStore.getState().hexWriteMethodBody('returnTrue')).toBe(true)

    // The offset is the body's, not the code's: dnSpy's templates carry the method header's byte.
    expect(patchHex).toHaveBeenCalledWith('w1', 't1', 'm1', 0x200, returnTrue)
    expect(commitEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState()).toMatchObject({ dirty: true, workspaceStateId: 'state-2', canUndo: true, busy: false })
    expect(useAppStore.getState().output.at(-1)).toContain('Updated method body bytes for Run().')
  })

  it('does nothing when the backend resolved no such template', async () => {
    // The backend spells "no such template" as null, so that is what the store is given here.
    useAppStore.setState({ hexTarget: methodTarget({ emptyBody: null }) })

    expect(await useAppStore.getState().hexWriteMethodBody('empty')).toBe(false)
    expect(beginEdit).not.toHaveBeenCalled()
  })

  it('rolls the transaction back and says so when the patch is rejected', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    patchHex.mockRejectedValue(new Error('The patch does not fit in the file.'))

    expect(await useAppStore.getState().hexWriteMethodBody('returnFalse')).toBe(false)

    expect(rollbackEdit).toHaveBeenCalledWith('w1', 't1')
    expect(useAppStore.getState().error).toBe('The patch does not fit in the file.')
    expect(useAppStore.getState().output.at(-1)).toContain('Hex edit failed: The patch does not fit in the file.')
  })

  it('copies the method body to the clipboard as hexadecimal text', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readHex.mockResolvedValue({ base64Data: base64([0x0a, 0x17, 0x2a]) })

    expect(await useAppStore.getState().hexCopyMethodBody()).toBe(true)

    expect(readHex).toHaveBeenCalledWith('w1', 'mod1', 0x200, 3)
    expect(writeText).toHaveBeenCalledWith('0A172A')
  })

  it('reports a copy that the backend refused', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readHex.mockRejectedValue(new Error('gone'))

    expect(await useAppStore.getState().hexCopyMethodBody()).toBe(false)
    expect(useAppStore.getState().output.at(-1)).toContain('Copy failed: gone')
  })

  it('pastes the clipboard over the method body', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readText.mockResolvedValue('0A162A')

    expect(await useAppStore.getState().hexPasteMethodBody()).toBe(true)

    expect(patchHex).toHaveBeenCalledWith('w1', 't1', 'm1', 0x200, returnFalse)
  })

  it('refuses a clipboard that is not hexadecimal bytes', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readText.mockResolvedValue('0A 16')

    expect(await useAppStore.getState().hexPasteMethodBody()).toBe(false)
    expect(useAppStore.getState().error).toBe('The clipboard does not hold hexadecimal bytes.')
    expect(useAppStore.getState().output.at(-1)).toContain('Paste failed: the clipboard does not hold hexadecimal bytes.')
    expect(beginEdit).not.toHaveBeenCalled()
  })

  it('refuses bytes that do not fit in the method body', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readText.mockResolvedValue('0A162A2A')

    expect(await useAppStore.getState().hexPasteMethodBody()).toBe(false)
    expect(useAppStore.getState().error).toBe('The pasted bytes do not fit in the method body.')
    expect(beginEdit).not.toHaveBeenCalled()
  })

  it('reports a clipboard that could not be read', async () => {
    useAppStore.setState({ hexTarget: methodTarget() })
    readText.mockRejectedValue(new Error('denied'))

    expect(await useAppStore.getState().hexPasteMethodBody()).toBe(false)
    expect(useAppStore.getState().output.at(-1)).toContain('Paste failed: denied')
  })

  it('bumps the navigation token so the same range can be asked for twice', () => {
    useAppStore.getState().showHexAt('mod1', 0x200, 3)
    const first = useAppStore.getState().hexNavigation

    useAppStore.getState().showHexAt('mod1', 0x200, 3)

    expect(useAppStore.getState().hexNavigation).toMatchObject({ moduleId: 'mod1', offset: 0x200, length: 3 })
    expect(useAppStore.getState().hexNavigation!.nonce).not.toBe(first!.nonce)
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
      recentWorkspaces: [],
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
    expect(useAppStore.getState().output.at(-1)).toContain('already open')
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
    }))

    expect(loadSession()).toEqual({
      version: 1,
      paths: ['/A.dll'],
      nodes: [{ key: 'k', expanded: true }],
      documents: [{ key: 'k', language: 'cSharp' }],
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
  const saveModule = vi.fn()
  const saveAllModules = vi.fn()
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
    documents: {},
    documentOrder: [],
    activeDocumentId: undefined,
    searchResults: [],
    assemblyListRevision: 0,
    output: [],
    dirty: false,
    workspaceStateId: undefined,
    savedStateId: undefined,
    canUndo: false,
    canRedo: false,
  })

  beforeEach(() => {
    saveModule.mockReset().mockResolvedValue({ path: '/A.dll', length: 10, sha256: 'aa' })
    saveAllModules.mockReset().mockResolvedValue({ saved: [{ path: '/A.dll', length: 10, sha256: 'aa' }] })
    reloadWorkspace.mockReset().mockResolvedValue({ workspaceId: 'w1', modules: [openedModule('n1', '/A.dll')], stateId: 's9' })
    sortAssemblies.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    getRoots.mockReset().mockResolvedValue({ nodes: [rootA, rootB] })
    Object.defineProperty(window, 'dnSpy', {
      configurable: true,
      value: { ...window.dnSpy, saveModule, saveAllModules, reloadWorkspace, sortAssemblies, getRoots },
    })
    reset()
  })

  it('saves the selected module back over its own file', async () => {
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll'), openedModule('n2', '/B.dll')],
      roots: [rootA, rootB],
      selectedNode: rootB,
      dirty: true,
      workspaceStateId: 's2',
      savedStateId: 's1',
    })

    await expect(useAppStore.getState().saveModule()).resolves.toBe(true)
    expect(saveModule).toHaveBeenCalledWith('w1', 'n2')
    expect(useAppStore.getState().dirty).toBe(false)
    expect(useAppStore.getState().savedStateId).toBe('s2')
  })

  it('saves every module the backend reports modified', async () => {
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll')],
      roots: [rootA],
      selectedNode: rootA,
      dirty: true,
      workspaceStateId: 's2',
      savedStateId: 's1',
    })

    await expect(useAppStore.getState().saveAllModules()).resolves.toBe(true)
    expect(saveAllModules).toHaveBeenCalledWith('w1')
    expect(useAppStore.getState().dirty).toBe(false)
    expect(useAppStore.getState().savedStateId).toBe('s2')
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
    saveModule.mockRejectedValue(new Error('disk full'))
    useAppStore.setState({
      workspaceId: 'w1',
      modules: [openedModule('n1', '/A.dll')],
      roots: [rootA],
      dirty: true,
      workspaceStateId: 's2',
      savedStateId: 's1',
    })

    await expect(useAppStore.getState().saveModule()).resolves.toBe(false)
    expect(useAppStore.getState().dirty).toBe(true)
    expect(useAppStore.getState().error).toBe('disk full')
  })
})
