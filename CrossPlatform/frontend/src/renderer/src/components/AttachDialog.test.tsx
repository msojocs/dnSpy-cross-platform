import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugProcess } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { AttachDialog, sortAttachableProcesses } from './AttachDialog'

const processes: DebugProcess[] = [
  { processId: 300, name: 'worker', title: '', runtimeName: 'CoreCLR 10.0.0', architecture: 'x64', executablePath: '/usr/bin/dotnet', commandLine: 'dotnet worker.dll --port 80' },
  { processId: 20, name: 'App', title: '', runtimeName: 'CoreCLR 9.0.4', architecture: 'ARM64', executablePath: '/opt/app/App', commandLine: '/opt/app/App' },
  { processId: 4000, name: 'debugged', title: '', runtimeName: 'CoreCLR 10.0.0', architecture: 'x64', executablePath: '/opt/debugged', commandLine: '/opt/debugged' },
]

const attachDebug = vi.fn(async () => undefined)

beforeEach(() => {
  attachDebug.mockClear()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, listDebugProcesses: vi.fn(async () => processes), showMessage: vi.fn(async () => undefined) },
  })
  useAppStore.setState({
    attachDebug,
    debugProcess: undefined,
    debugSessions: [{ sessionId: 's', state: 'running', modules: [], threads: [], shouldDetach: true, process: { id: 4000, name: 'debugged', state: 'Running', debugging: 'CoreCLR', architecture: 'x64', ownsDebuggee: false } }],
  })
})

afterEach(() => cleanup())

const names = (): string[] => screen.getAllByRole('row').slice(1).map((row) => row.querySelector('span')?.textContent ?? '')

describe('AttachDialog', () => {
  it('lists the processes in dnSpy\'s columns, without the ones being debugged already', async () => {
    render(<AttachDialog onClose={() => undefined} />)
    await waitFor(() => expect(names()).toEqual(['App', 'worker']))
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Process', 'ID', 'Title', 'Type', 'Architecture', 'Filename', 'Command Line'])
    const row = screen.getAllByRole('row')[2]
    expect(within(row).getByText('CoreCLR 10.0.0')).toBeVisible()
    expect(within(row).getByText('dotnet worker.dll --port 80')).toBeVisible()
    // With nothing picked, the first process is.
    await waitFor(() => expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-selected', 'true'))
  })

  it('searches the columns the options name and sorts by a column on a header click', async () => {
    render(<AttachDialog onClose={() => undefined} />)
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search for a process' }), { target: { value: '-a arm64' } })
    expect(names()).toEqual(['App'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search for a process' }), { target: { value: '' } })
    const id = screen.getByRole('columnheader', { name: 'ID' })
    fireEvent.click(id)
    fireEvent.click(id)
    expect(names()).toEqual(['worker', 'App'])
  })

  it('attaches to every process picked', async () => {
    const onClose = vi.fn()
    render(<AttachDialog onClose={onClose} />)
    await waitFor(() => expect(names()).toHaveLength(2))
    const [, first, second] = screen.getAllByRole('row')
    fireEvent.mouseDown(first)
    fireEvent.mouseDown(second, { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    await waitFor(() => expect(attachDebug).toHaveBeenCalledTimes(2))
    expect(attachDebug).toHaveBeenNthCalledWith(1, 20)
    expect(attachDebug).toHaveBeenNthCalledWith(2, 300)
    expect(onClose).toHaveBeenCalled()
  })
})

describe('sortAttachableProcesses', () => {
  it('orders by name, then id, unless a column is sorted on', () => {
    expect(sortAttachableProcesses(processes).map((process) => process.processId)).toEqual([20, 4000, 300])
    expect(sortAttachableProcesses(processes, { column: 'type', descending: false }).map((process) => process.processId)).toEqual([4000, 300, 20])
  })
})
