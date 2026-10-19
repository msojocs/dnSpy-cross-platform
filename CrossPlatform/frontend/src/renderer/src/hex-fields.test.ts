import { describe, expect, it } from 'vitest'
import type { HexField } from '../../shared/protocol'
import { bitFieldValue, encodeHexFieldText, formatHexFieldValue, formatHexOffset, hexFieldValue, isHexFieldError, withBitField } from './hex-fields'
import { contiguousRids, encodeColumnText, formatColumnValue, hasMetadataTables, parseClipboardBytes, pasteTarget } from './metadata-table'

const field = (kind: HexField['kind'], size: number, text: string): HexField => ({ name: 'Field', offset: 0x80, size, kind, value: 0, text })

describe('the PE and metadata field boxes', () => {
  it('write a value the way SimpleTypeConverter does when told not to use decimal', () => {
    expect(formatHexFieldValue(9n)).toBe('9')
    expect(formatHexFieldValue(10n)).toBe('0xA')
    expect(formatHexFieldValue(0x5A4Dn)).toBe('0x5A4D')
    expect(formatHexOffset(0x3C)).toBe('0x0000003C')
  })

  it('read decimal and hex text into the field\'s little-endian bytes, and say why other text is none', () => {
    expect(encodeHexFieldText(field('uint16', 2, ''), '0x5A4D')).toEqual(Uint8Array.of(0x4D, 0x5A))
    expect(encodeHexFieldText(field('uint32', 4, ''), '258')).toEqual(Uint8Array.of(2, 1, 0, 0))
    expect(encodeHexFieldText(field('int16', 2, ''), '-1')).toEqual(Uint8Array.of(0xFF, 0xFF))
    const tooBig = encodeHexFieldText(field('byte', 1, ''), '256')
    expect(isHexFieldError(tooBig) && tooBig.args).toEqual({ min: '0', max: '255', maxHex: 'FF' })
    expect(isHexFieldError(encodeHexFieldText(field('uint16', 2, ''), 'zz'))).toBe(true)
    // A string is the C# literal dnSpy writes it as, cut to the field and padded with zeros.
    expect(encodeHexFieldText(field('string', 8, ''), '".text\\0"')).toEqual(Uint8Array.of(0x2E, 0x74, 0x65, 0x78, 0x74, 0, 0, 0))
    expect(encodeHexFieldText(field('string', 4, ''), '"a\\u0042\\"x"')).toEqual(Uint8Array.of(0x61, 0x42, 0x22, 0x78))
    expect(encodeHexFieldText(field('string', 8, ''), '.text')).toEqual({ template: 'A string must be enclosed in double quotes (")' })
  })

  it('read and replace a flags field\'s bits, 64-bit masks included', () => {
    const mask = field('uint64', 8, '0x1F00000000000957')
    const value = hexFieldValue(mask)
    expect(value).toBe(0x1F00000000000957n)
    expect(bitFieldValue(value, { name: 'TypeDef', bit: 2, count: 1 })).toBe(1n)
    expect(bitFieldValue(value, { name: 'High', bit: 56, count: 5 })).toBe(0x1Fn)
    expect(withBitField(value, { name: 'TypeDef', bit: 2, count: 1 }, 0n)).toBe(0x1F00000000000953n)
    expect(withBitField(0n, { name: 'Machine', bit: 0, count: 16 }, 0x8664n)).toBe(0x8664n)
  })
})

describe('the metadata table document', () => {
  it('writes and reads a column as an unsigned number of its size', () => {
    expect(formatColumnValue(3)).toBe('3')
    expect(formatColumnValue(0x2001)).toBe('0x2001')
    expect(encodeColumnText({ name: 'Flags', offset: 0, size: 4 }, '0x100001')).toEqual(Uint8Array.of(1, 0, 0x10, 0))
    expect(encodeColumnText({ name: 'Name', offset: 4, size: 2 }, '0x10000')).toBe('Value must be between {min} and {max} (0x{maxHex}) inclusive')
  })

  it('reads the clipboard the way ClipboardUtils does and pastes whole rows that fit', () => {
    expect(parseClipboardBytes('0A?f')).toEqual(Uint8Array.of(0x0A, 0x0F))
    expect(parseClipboardBytes('0A 0B')).toBeUndefined()
    expect(parseClipboardBytes('ABC')).toBeUndefined()
    const row = { rid: 2, token: 0x02000002, offset: 0x400, values: [] }
    expect(pasteTarget(new Uint8Array(12), 6, row, 3)).toEqual({ offset: 0x400, records: 2 })
    expect(pasteTarget(new Uint8Array(18), 6, row, 3)).toBeUndefined()
    expect(pasteTarget(new Uint8Array(7), 6, row, 3)).toBeUndefined()
    expect(contiguousRids([4, 2, 3])).toBe(true)
    expect(contiguousRids([1, 3])).toBe(false)
  })

  it('looks for metadata only in a managed module read from a file', () => {
    const roots = [
      { id: 'a', label: 'A', kind: 'assembly', hasChildren: true },
      { id: 'n', label: 'native.dll', kind: 'pedocument', hasChildren: true },
      { id: 'm', label: 'New', kind: 'assembly', hasChildren: true },
    ]
    const state = { roots, parents: { t: 'ns', ns: 'mod', mod: 'a', pe: 'n' }, modules: [{ id: 'a', name: 'A', path: '/a.dll', hasPdb: false }, { id: 'm', name: 'New', path: '', hasPdb: false, inMemory: true }] }
    expect(hasMetadataTables(state, 't')).toBe(true)
    expect(hasMetadataTables(state, 'pe')).toBe(false)
    expect(hasMetadataTables(state, 'm')).toBe(false)
  })
})
