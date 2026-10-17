import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { LanguageProvider } from '../localization'
import { loadAppOptions, saveAppOptions } from './app-options'
import { OutputPane, outputText } from './ToolWindows'

const renderPane = (): void => {
  render(<LanguageProvider initialLanguage="en"><OutputPane /></LanguageProvider>)
}

const setGeneral = (change: Partial<ReturnType<typeof loadAppOptions>['output']['general']>): void => {
  const options = loadAppOptions()
  saveAppOptions({ ...options, output: { ...options.output, general: { ...options.output.general, ...change } } })
}

beforeEach(() => {
  useAppStore.setState({
    output: [{ timestamp: '10:00:00.000', text: 'first line' }, { text: 'second line' }],
    debugOutput: [{ text: 'program output' }],
    outputPane: 'dnSpy',
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('OutputPane', () => {
  it('shows the selected pane\'s lines with their timestamps', () => {
    renderPane()
    expect(screen.getByRole('log')).toHaveTextContent('10:00:00.000 first line')
    expect(screen.getByText('second line')).toBeVisible()
    expect(screen.queryByText('program output')).toBeNull()
  })

  it('switches panes from "Show output from" and with Ctrl+1', () => {
    renderPane()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'debug' } })
    expect(screen.getByText('program output')).toBeVisible()
    fireEvent.keyDown(screen.getByRole('log'), { key: '2', ctrlKey: true })
    expect(useAppStore.getState().outputPane).toBe('dnSpy')
    fireEvent.keyDown(screen.getByRole('log'), { key: '1', ctrlKey: true })
    expect(useAppStore.getState().outputPane).toBe('debug')
  })

  it('empties the selected pane only — dnSpy\'s Clear All, also on Ctrl+L', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }))
    expect(useAppStore.getState().output).toEqual([])
    expect(useAppStore.getState().debugOutput).toHaveLength(1)
    act(() => useAppStore.getState().selectOutputPane('debug'))
    fireEvent.keyDown(screen.getByRole('log'), { key: 'l', ctrlKey: true })
    expect(useAppStore.getState().debugOutput).toEqual([])
  })

  it('writes the pane out as text under the name Visual Studio gives it', async () => {
    const saveCode = vi.fn().mockResolvedValue('/tmp/output.txt')
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, saveCode } })
    renderPane()

    fireEvent.click(screen.getByRole('button', { name: 'Save As' }))
    await vi.waitFor(() => expect(saveCode).toHaveBeenCalledWith('Output-dnSpy.txt', '10:00:00.000 first line\nsecond line', 'Save Output As'))
  })

  it('keeps Clear All and Save available for an empty pane, as dnSpy does', () => {
    useAppStore.setState({ output: [] })
    renderPane()
    expect(screen.getByRole('button', { name: 'Clear All' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save As' })).toBeEnabled()
  })

  it('wraps the log as dnSpy does by default, and the toggle keeps its state in the Output options', () => {
    renderPane()
    const toggle = screen.getByRole('button', { name: 'Word Wrap' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('log').className).toContain('output-word-wrap')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Word Wrap' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('log').className).not.toContain('output-word-wrap')
    expect(loadAppOptions().output.general.wordWrap).toBe(false)
  })

  it('numbers the lines while the Output options ask for it, which they do by default', () => {
    renderPane()
    expect(screen.getByRole('log').querySelectorAll('.output-line-number')).toHaveLength(2)
    act(() => setGeneral({ showLineNumbers: false }))
    expect(screen.getByRole('log').className).not.toContain('output-line-numbers')
    expect(screen.getByRole('log').querySelectorAll('.output-line-number')).toHaveLength(0)
  })
})

describe('appendOutput', () => {
  it('stamps each line of a message with the time in the Output options\' format', () => {
    useAppStore.setState({ output: [] })
    setGeneral({ showTimestamps: true, timestampDateTimeFormat: '"T"HH' })
    useAppStore.getState().appendOutput('one\ntwo')
    const lines = useAppStore.getState().output
    expect(lines.map((line) => line.text)).toEqual(['one', 'two'])
    expect(lines[0].timestamp).toMatch(/^T\d\d$/)
    expect(outputText(lines)).toMatch(/^T\d\d one\nT\d\d two$/)
  })

  it('writes lines without a timestamp while timestamps are off, and to the pane it is given', () => {
    useAppStore.setState({ output: [], debugOutput: [] })
    setGeneral({ showTimestamps: false })
    useAppStore.getState().appendOutput('from the debugger', 'debug')
    expect(useAppStore.getState().debugOutput).toEqual([{ text: 'from the debugger' }])
    expect(useAppStore.getState().output).toEqual([])
  })
})
