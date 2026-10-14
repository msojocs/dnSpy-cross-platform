import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../app-store'
import { LanguageProvider } from '../localization'
import { OutputPane } from './ToolWindows'

const renderPane = (): void => {
  render(<LanguageProvider initialLanguage="en"><OutputPane /></LanguageProvider>)
}

beforeEach(() => {
  useAppStore.setState({ output: ['first line', 'second line'] })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('OutputPane', () => {
  it('shows the lines the app has written', () => {
    renderPane()
    expect(screen.getByRole('log')).toHaveTextContent('first line')
    expect(screen.getByText('second line')).toBeVisible()
  })

  it('empties the window — dnSpy\'s Clear All', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Clear All' }))
    expect(useAppStore.getState().output).toEqual([])
    expect(screen.getByRole('log')).toBeEmptyDOMElement()
  })

  it('writes the log out as text, under the Output window\'s own title', async () => {
    const saveCode = vi.fn().mockResolvedValue('/tmp/output.txt')
    Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, saveCode } })
    renderPane()

    fireEvent.click(screen.getByRole('button', { name: 'Save As' }))
    await vi.waitFor(() => expect(saveCode).toHaveBeenCalledWith('output.txt', 'first line\nsecond line', 'Save Output As'))
  })

  it('has nothing to clear or save while the log is empty', () => {
    useAppStore.setState({ output: [] })
    renderPane()
    expect(screen.getByRole('button', { name: 'Clear All' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save As' })).toBeDisabled()
  })

  it('wraps the log when the toggle is on, and remembers that it was', () => {
    renderPane()
    const toggle = screen.getByRole('button', { name: 'Word Wrap' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('log').className).not.toContain('output-word-wrap')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('log').className).toContain('output-word-wrap')
    expect(localStorage.getItem('dnspy.output.wordWrap')).toBe('true')
  })
})
