import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutDialog } from './AboutDialog'

beforeEach(() => {
  // The version is the main process's to know: it is what the package was built as, not something the
  // renderer has a copy of.
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, getStartupOptions: async () => ({ version: '6.6.0' }) },
  })
})

afterEach(cleanup)

describe('AboutDialog', () => {
  it('renders product and license information, with the version the package was built as', async () => {
    render(<AboutDialog onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'About dnSpy' })).toBeVisible()
    expect(await screen.findByText('dnSpy 6.6.0 (.NET)')).toBeVisible()
    expect(screen.getByText('Version 6.6.0')).toBeVisible()
    expect(screen.getByText('Cross-platform .NET assembly browser, decompiler, editor and debugger.')).toBeVisible()
    expect(screen.getByText('Licensed under GNU GPL v3.0 only.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close About' })).toHaveFocus()
  })

  it('folds the credits and the third-party notices away until they are asked for', async () => {
    render(<AboutDialog onClose={vi.fn()} />)

    expect(screen.queryByText(/dnSpy credits:/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Credits' }))
    expect(screen.getByText(/dnSpy credits:/)).toBeVisible()

    // One text is open at a time: the notices take the place of the credits rather than joining them.
    fireEvent.click(screen.getByRole('button', { name: 'Third-Party Notices' }))
    expect(screen.queryByText(/dnSpy credits:/)).not.toBeInTheDocument()
    expect(screen.getByText(/dnSpy is distributed under GPL-3.0-only/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Third-Party Notices' }))
    expect(screen.queryByText(/dnSpy is distributed under GPL-3.0-only/)).not.toBeInTheDocument()
  })

  it('closes from the button and Escape key', () => {
    const onClose = vi.fn()
    render(<AboutDialog onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
