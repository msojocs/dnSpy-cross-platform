import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { MemoryPane } from './DebugNativeWindows'

// The Disassembly tab next to it is Monaco, which jsdom cannot host.
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('../monaco', () => ({ monacoThemeName: () => 'vs' }))

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

// The debuggee's memory: the first 4 KiB page of every window is unmapped, the rest reads as its address's low byte.
const readDebugMemory = vi.fn(async (_session: string, address: string, count: number) => {
  const start = Number(BigInt(address))
  const bytes = Uint8Array.from({ length: count }, (_, index) => (start + index) & 0xFF)
  const pages = Math.ceil(count / 4096)
  return { address, data: toBase64(bytes), readable: Array.from({ length: pages }, (_, page) => page > 0), pageSize: 4096 }
})
const writeDebugMemory = vi.fn(async () => undefined)

beforeEach(() => {
  readDebugMemory.mockClear()
  writeDebugMemory.mockClear()
  Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, readDebugMemory, writeDebugMemory } })
  useAppStore.setState({ debugSessionId: 'session', debugState: 'stopped', debugSessions: [], debugGeneration: 1 })
})

afterEach(() => cleanup())

describe('MemoryPane', () => {
  it('is the hex editor over the process\'s memory, with unmapped pages shown as ??', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalledWith('session', '0x0', 64 * 1024))
    const firstLine = () => container.querySelector('.hex-line')?.textContent ?? ''
    await waitFor(() => expect(firstLine()).toContain('??'))
    // A 16 MiB window onto a 64-bit address space: the offset column is an address.
    expect(container.querySelector('.hex-offset')!.textContent).toMatch(/^0+$/)
  })

  it('moves its window along when the caret walks off the end of it', async () => {
    const { container } = render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    const view = container.querySelector<HTMLElement>('.hex-content')!
    readDebugMemory.mockClear()
    fireEvent.keyDown(view, { key: 'End', code: 'End', ctrlKey: true })
    fireEvent.keyDown(view, { key: 'ArrowDown', code: 'ArrowDown' })
    // The view reached the window's end, so the window moved on — 8 MiB in — and the caret went one line past
    // the old window's last byte.
    await waitFor(() => expect(readDebugMemory.mock.calls.some(([, address]) => BigInt(address) >= 0x800000n)).toBe(true))
    await waitFor(() => expect(container.querySelector('.hex-view')!.getAttribute('data-caret-offset')).toMatch(/0*100000F$/i))
  })

  it('says why there is nothing to show while the process runs', () => {
    useAppStore.setState({ debugState: 'running' })
    const { container } = render(<MemoryPane />)
    expect(container.textContent).toContain('Memory can only be read while the process is paused.')
  })

  it('reads the memory again on every stop', async () => {
    render(<MemoryPane />)
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
    readDebugMemory.mockClear()
    act(() => useAppStore.setState({ debugGeneration: 2 }))
    await waitFor(() => expect(readDebugMemory).toHaveBeenCalled())
  })
})
