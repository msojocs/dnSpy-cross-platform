import { describe, expect, it, vi } from 'vitest'
import { visibleHexMenuEntries, type HexMenuContext } from './hex-menu'

const context = (overrides: Partial<HexMenuContext> = {}): HexMenuContext => ({
  t: (message) => message,
  documentAvailable: true,
  onOpenHex: vi.fn(),
  onShowHexAt: vi.fn(),
  onHexWriteBody: vi.fn(),
  onHexCopyBody: vi.fn(),
  onHexPasteBody: vi.fn(),
  ...overrides,
})

describe('hex menu group', () => {
  it('shows an address reference under the caret instead of the document commands', () => {
    const onShowAddress = vi.fn()
    const address = { modulePath: '/A.dll', isRva: false, address: 0x200, length: 4 }
    const ctx = context({ addressReference: address, onShowAddress, hexStatement: { moduleId: 'm', range: { offset: 0, length: 1 } } })
    const entries = visibleHexMenuEntries(ctx)
    expect(entries.map((entry) => entry.label(ctx))).toEqual(['Show in Hex Editor'])
    entries[0].run(ctx)
    expect(onShowAddress).toHaveBeenCalledWith(address)
  })

  it('opens the document when the caret is on nothing the hex editor shows', () => {
    const ctx = context()
    expect(visibleHexMenuEntries(ctx).map((entry) => entry.label(ctx))).toEqual(['Open Hex Editor'])
  })
})
