import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveModuleOptions } from '../../../shared/protocol'
import { SaveModuleOptionsDialog, defaultSaveModuleOptions } from './SaveModuleOptionsDialog'

afterEach(cleanup)

describe('SaveModuleOptionsDialog', () => {
  it('opens with dnlib\'s own defaults and reports what the user changes', () => {
    const onAccept = vi.fn()
    render(<SaveModuleOptionsDialog onAccept={onAccept} onClose={() => undefined} />)

    expect(screen.getByLabelText('Keep Win32 resources')).toBeChecked()
    expect(screen.getByLabelText('Preserve RIDs')).not.toBeChecked()
    expect(screen.getByLabelText('Keep extra PE data')).toBeChecked()
    expect(screen.getByLabelText('Module type')).toHaveValue('')

    fireEvent.click(screen.getByLabelText('Preserve RIDs'))
    fireEvent.click(screen.getByLabelText('Share method bodies'))
    fireEvent.change(screen.getByLabelText('Module type'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    const written = onAccept.mock.calls[0][0] as SaveModuleOptions
    expect(written.preserveRids).toBe(true)
    expect(written.shareMethodBodies).toBe(true)
    expect(written.moduleKind).toBe(2)
  })

  it('puts every option back to the defaults on Reset', () => {
    render(<SaveModuleOptionsDialog initial={{ ...defaultSaveModuleOptions(), preserveRids: true, writePdb: true }} onAccept={() => undefined} onClose={() => undefined} />)
    expect(screen.getByLabelText('Preserve RIDs')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.getByLabelText('Preserve RIDs')).not.toBeChecked()
    expect(screen.getByLabelText('Write PDB')).not.toBeChecked()
  })
})
