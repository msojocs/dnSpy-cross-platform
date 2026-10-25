import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugSessionEntry } from '../app-store'
import { useAppStore } from '../app-store'
import { ModulesPane, ProcessesPane, ThreadsPane } from './DebugToolWindows'

const process = (id: number, name: string) => ({ id, name, path: `/app/${name}`, state: 'Running' as const, debugging: 'CoreCLR', architecture: 'x64', ownsDebuggee: true })
const entry = (sessionId: string, state: DebugSessionEntry['state'], extra: Partial<DebugSessionEntry> = {}): DebugSessionEntry =>
  ({ sessionId, state, modules: [], threads: [], shouldDetach: false, ...extra })

const setCurrentDebugSession = vi.fn(async () => undefined)
const continueDebugProcess = vi.fn(async () => undefined)

beforeEach(() => {
  setCurrentDebugSession.mockClear()
  continueDebugProcess.mockClear()
  useAppStore.setState({
    debugSessionId: 'a',
    debugState: 'stopped',
    debugProcess: process(10, 'first'),
    debugThreads: [{ id: 1, name: 'Main Thread', processId: 10, processName: 'first' }],
    debugModules: [{ id: 1, name: 'first.dll', path: '/app/first.dll', processId: 10 }],
    selectedDebugThreadId: 1,
    debugSessions: [
      entry('a', 'stopped', { process: process(10, 'first') }),
      entry('b', 'stopped', {
        process: process(20, 'second'),
        threads: [{ id: 2, name: 'Worker', processId: 20, processName: 'second' }],
        modules: [{ id: 1, name: 'second.dll', path: '/app/second.dll', processId: 20 }],
        threadId: 2,
      }),
    ],
    setCurrentDebugSession,
    continueDebugProcess,
  })
})

afterEach(() => cleanup())

const rowOf = (grid: HTMLElement, text: string): HTMLElement =>
  within(grid).getAllByRole('row').find((row) => row.textContent?.includes(text)) ?? (() => { throw new Error(`No row for ${text}`) })()

describe('the windows of several processes', () => {
  it('lists every process in Processes, marks the current one, and switches to another on a double click', () => {
    render(<ProcessesPane />)
    const grid = screen.getByRole('grid', { name: 'Processes' })
    expect(within(grid).getAllByRole('row')).toHaveLength(2)
    expect(rowOf(grid, 'first').className).toContain('process-current')
    expect(rowOf(grid, 'second').className).not.toContain('process-current')

    fireEvent.doubleClick(rowOf(grid, 'second'))
    expect(setCurrentDebugSession).toHaveBeenCalledWith('b')
  })

  it('runs a process from its row and keeps its Detach When Debugging Stopped', () => {
    render(<ProcessesPane />)
    const grid = screen.getByRole('grid', { name: 'Processes' })
    fireEvent.contextMenu(rowOf(grid, 'second'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Continue Process/ }))
    expect(continueDebugProcess).toHaveBeenCalledWith('b')

    fireEvent.contextMenu(rowOf(grid, 'second'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Detach When Debugging Stopped/ }))
    expect(useAppStore.getState().debugSessions.find((candidate) => candidate.sessionId === 'b')?.shouldDetach).toBe(true)
  })

  it('lists the threads and modules of every process, and narrows them to one with the Process combo', () => {
    render(<ThreadsPane />)
    const threads = screen.getByRole('grid', { name: 'Threads' })
    expect(within(threads).getAllByRole('row').map((row) => row.textContent)).toEqual([expect.stringContaining('Main Thread'), expect.stringContaining('Worker')])
    fireEvent.change(screen.getByRole('combobox', { name: 'Process' }), { target: { value: 'b' } })
    expect(within(threads).getAllByRole('row')).toHaveLength(1)
    cleanup()

    render(<ModulesPane />)
    const modules = screen.getByRole('grid', { name: 'Modules' })
    expect(within(modules).getAllByRole('row').map((row) => row.textContent)).toEqual([expect.stringContaining('first.dll'), expect.stringContaining('second.dll')])
  })

  it('filters the threads with the search box and sorts them from a column header', () => {
    render(<ThreadsPane />)
    const threads = screen.getByRole('grid', { name: 'Threads' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'Worker' } })
    expect(within(threads).getAllByRole('row').map((row) => row.textContent)).toEqual([expect.stringContaining('Worker')])

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: '' } })
    const nameHeader = within(threads).getByRole('columnheader', { name: 'Name' })
    // GridViewColumnSorter: ascending, then descending, then the list's own order.
    fireEvent.click(nameHeader)
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(nameHeader)
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
    expect(within(threads).getAllByRole('row')[0].textContent).toContain('Worker')
    fireEvent.click(nameHeader)
    expect(nameHeader).toHaveAttribute('aria-sort', 'none')
  })

  it('selects every row with Ctrl+A, as the WPF lists do', () => {
    render(<ThreadsPane />)
    const threads = screen.getByRole('grid', { name: 'Threads' })
    fireEvent.keyDown(threads, { key: 'a', ctrlKey: true })
    expect(within(threads).getAllByRole('row').every((row) => row.getAttribute('aria-selected') === 'true')).toBe(true)

    // A right click inside the selection keeps it, so a command reaches both threads.
    fireEvent.contextMenu(within(threads).getAllByRole('row')[0])
    expect(screen.getByRole('menuitem', { name: /Copy/ })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('runs the selected processes from the Processes window toolbar', () => {
    render(<ProcessesPane />)
    const grid = screen.getByRole('grid', { name: 'Processes' })
    fireEvent.mouseDown(rowOf(grid, 'second'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue Process' }))
    expect(continueDebugProcess).toHaveBeenCalledWith('b')
  })
})
