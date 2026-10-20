import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineBreakpoint } from '../app-store'
import { useAppStore } from '../app-store'
import { BreakpointsPane } from './DebugToolWindows'

const setFunctionBreakpoints = vi.fn(async () => ({}))
const setBreakpoints = vi.fn(async () => [])
const saveCode = vi.fn(async () => '/tmp/breakpoints.xml')
const readTextFile = vi.fn(async () => undefined as string | undefined)
const showMessage = vi.fn(async () => undefined)
const exportBreakpoints = vi.fn(async () => '<settings />')
const importBreakpoints = vi.fn()
const formatBookmarkLocations = vi.fn(async (_workspaceId: unknown, locations: { metadataToken: number; ilOffset?: number | null }[]) =>
  locations.map((location) => ({ resolved: true, parts: [{ text: `M${location.metadataToken.toString(16)} + 0x${(location.ilOffset ?? 0).toString(16).padStart(4, '0')}`, color: 'text' }] })))

/** A breakpoint as it comes back from storage: the workspace that issued its node id is gone. */
const restored = (extra: Partial<LineBreakpoint> = {}): LineBreakpoint => ({
  id: 'line1',
  nodeId: '',
  identity: '/app/DebugTarget.dll|100663297|7',
  requestedLine: 42,
  line: 42,
  endLine: 42,
  state: 'pending',
  enabled: true,
  description: 'System.Void Ns.Type::M()',
  modulePath: '/app/DebugTarget.dll',
  metadataToken: 0x06000001,
  sourceMethodToken: 0x06000001,
  ilOffset: 7,
  order: 1,
  ...extra,
})

beforeEach(() => {
  setFunctionBreakpoints.mockClear()
  setBreakpoints.mockClear()
  saveCode.mockClear()
  showMessage.mockClear()
  readTextFile.mockReset()
  importBreakpoints.mockReset()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, setFunctionBreakpoints, setBreakpoints, saveCode, readTextFile, showMessage, exportBreakpoints, importBreakpoints, formatBookmarkLocations },
  })
  useAppStore.setState({
    lineBreakpoints: [],
    functionBreakpoints: [{ name: 'Ns.Type.A', enabled: true }, { name: 'Ns.Type.B', enabled: false }],
    debugSessionId: 'session',
    debugState: 'inactive',
  })
})

afterEach(() => {
  cleanup()
})

const rowOf = (text: string): HTMLElement => {
  const row = screen.getByText(text).closest('[role="row"]')
  if (!(row instanceof HTMLElement))
    throw new Error(`No row for ${text}`)
  return row
}

describe('BreakpointsPane', () => {
  it('lists every breakpoint in dnSpy\'s seven columns', async () => {
    useAppStore.setState({ lineBreakpoints: [restored({ settings: { condition: { kind: 'isTrue', expression: 'x > 1' }, hitCount: { kind: 'multipleOf', count: 3 }, trace: { message: 'hi', continue: true }, labels: ['a', 'b'] } })] })
    render(<BreakpointsPane />)

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Name', 'Labels', 'Condition', 'Hit Count', 'Filter', 'When Hit', 'Module'])
    const row = rowOf(await screen.findByText('M6000001 + 0x0007').then((element) => element.textContent ?? ''))
    expect(within(row).getByText('a, b')).toBeVisible()
    expect(within(row).getByText("when 'x > 1' is true")).toBeVisible()
    expect(within(row).getByText('when hit count is a multiple of 3')).toBeVisible()
    expect(within(row).getByText('(none)')).toBeVisible()
    expect(within(row).getByText("Print message 'hi'")).toBeVisible()
    expect(within(row).getByText('DebugTarget.dll')).toBeVisible()
    // A tracepoint with a condition is drawn with the advanced tracepoint's image.
    expect(row.querySelector('.breakpoint-image-AdvancedTracepointEnabled')).not.toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Disable Ns.Type.A' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Enable Ns.Type.B' })).not.toBeChecked()
  })

  it('says how many hits there have been while a debugger runs', () => {
    useAppStore.setState({ debugState: 'running', lineBreakpoints: [restored({ hitCount: 2 })] })
    render(<BreakpointsPane />)
    expect(screen.getAllByText('break always (currently 2)').length).toBeGreaterThan(0)
  })

  it('re-enables a disabled breakpoint from its checkbox', () => {
    const { container } = render(<BreakpointsPane />)
    expect(container.querySelectorAll('.breakpoint-disabled')).toHaveLength(1)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Ns.Type.B' }))

    expect(useAppStore.getState().functionBreakpoints).toEqual([
      { name: 'Ns.Type.A', enabled: true },
      { name: 'Ns.Type.B', enabled: true },
    ])
    expect(setFunctionBreakpoints).toHaveBeenLastCalledWith('session', [{ id: 'fn:Ns.Type.A', name: 'Ns.Type.A' }, { id: 'fn:Ns.Type.B', name: 'Ns.Type.B' }])
    expect(container.querySelectorAll('.breakpoint-disabled')).toHaveLength(0)
  })

  it('filters on the columns the search options name, and says so when nothing matches', () => {
    useAppStore.setState({ lineBreakpoints: [restored({ settings: { labels: ['hot'] } })] })
    render(<BreakpointsPane />)
    const search = screen.getByRole('textbox', { name: 'Search for a breakpoint' })

    fireEvent.change(search, { target: { value: '-l hot' } })
    expect(screen.queryByText('Ns.Type.A')).toBeNull()
    expect(screen.getByText('hot')).toBeVisible()

    fireEvent.change(search, { target: { value: '-l! hot' } })
    expect(screen.getByText('Ns.Type.A')).toBeVisible()
    expect(screen.queryByText('hot')).toBeNull()

    fireEvent.change(search, { target: { value: 'nothing-like-it' } })
    expect(screen.getByText('No breakpoints match your search filter.')).toBeVisible()
  })

  it('sorts by a column on a header click, cycling back to the order they were added in', () => {
    render(<BreakpointsPane />)
    const names = (): string[] => screen.getAllByRole('row').slice(1).map((row) => row.querySelector('.breakpoint-name')?.textContent ?? '')
    const header = screen.getByRole('columnheader', { name: 'Name' })
    expect(names()).toEqual(['Ns.Type.A', 'Ns.Type.B'])
    fireEvent.click(header)
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(names()).toEqual(['Ns.Type.B', 'Ns.Type.A'])
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'none')
  })

  it('edits a breakpoint\'s labels in place', () => {
    render(<BreakpointsPane />)
    const row = rowOf('Ns.Type.A')
    fireEvent.doubleClick(row.querySelector('.breakpoint-labels-cell')!)
    const input = within(row).getByRole('textbox', { name: 'Labels' })
    fireEvent.change(input, { target: { value: 'one,  two ,' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useAppStore.getState().functionBreakpoints[0].settings?.labels).toEqual(['one', 'two'])
  })

  it('adds a breakpoint for the typed function name', () => {
    render(<BreakpointsPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Function breakpoint' }), { target: { value: 'Ns.Type.C' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add function breakpoint' }))

    expect(useAppStore.getState().functionBreakpoints.map((breakpoint) => breakpoint.name)).toEqual(['Ns.Type.A', 'Ns.Type.B', 'Ns.Type.C'])
  })

  it('exports the matching breakpoints as dnSpy\'s breakpoint file', async () => {
    useAppStore.setState({ lineBreakpoints: [restored({ settings: { filter: 'ThreadId == 1' } })] })
    render(<BreakpointsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Export all breakpoints matching the current search criteria' }))

    await waitFor(() => expect(saveCode).toHaveBeenCalledWith('breakpoints.xml', '<settings />'))
    expect(exportBreakpoints).toHaveBeenCalledWith(undefined, [{ modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 7, enabled: true, settings: { filter: 'ThreadId == 1' } }])
    expect(await screen.findByText('Exported breakpoints to /tmp/breakpoints.xml.')).toBeVisible()
  })

  it('imports dnSpy\'s breakpoint file and reports how many it added', async () => {
    readTextFile.mockResolvedValue('<settings />')
    importBreakpoints.mockResolvedValue({ breakpoints: [{ modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 7, enabled: true, settings: null, method: 'System.Void Ns.Type::M()' }], skipped: 1 })
    render(<BreakpointsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Import breakpoints from a file' }))

    expect(await screen.findByText('Imported 1 breakpoint(s); skipped 1 the file cannot place.')).toBeVisible()
    expect(useAppStore.getState().lineBreakpoints).toMatchObject([{ modulePath: '/app/DebugTarget.dll', metadataToken: 0x06000001, ilOffset: 7, description: 'System.Void Ns.Type::M()' }])
  })

  it('says so when the chosen file is not a breakpoint file', async () => {
    readTextFile.mockResolvedValue('{ not json')
    render(<BreakpointsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Import breakpoints from a file' }))

    await waitFor(() => expect(showMessage).toHaveBeenCalledWith('The breakpoint file could not be read.'))
  })
})
