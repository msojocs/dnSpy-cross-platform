import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HexPositionInfoResponse, HexToolTipInfoResponse } from '../../shared/protocol'
import { memoryStructures } from './memory-structures'

const base = 0x7FFF00000000
const toolTip: HexToolTipInfoResponse = {
  fields: [{ offset: base + 0x10, length: 2, kind: 'currentField' }, { offset: base - 8, length: 0x40, kind: 'structure' }],
  toolTip: { image: 'FieldPublic', sections: [[{ text: 'e_magic', color: 'instanceField' }]] },
}
const position: HexPositionInfoResponse = {
  file: { offset: base - 0x100, length: 0x4000000 },
  nestedFile: null,
  structure: { offset: base + 8, length: 0x40 },
  editField: { offset: base + 0x20, size: 2, value: '258', kind: 'flags', items: [{ name: 'Flag', mask: '256', value: '256', isFlag: true }] },
  rva: 0x1234,
  fileOffset: 0x234,
  fieldReference: { offset: base - 1, length: 4 },
  reference: { kind: 'method', nodeId: null, modulePath: '/tmp/test.dll', metadataToken: 0x06000001, ilOffset: 5 },
}
const getDebugMemoryToolTipInfo = vi.fn(async () => toolTip)
const getDebugMemoryPositionInfo = vi.fn(async () => position)
const resolveDebugMemoryPosition = vi.fn(async () => ({ offset: base - 1 }))
const goToDebugMemoryMetadata = vi.fn(async () => ({ range: { offset: base - 0x200, length: 16 } }))
const getDebugMemoryFileInfo = vi.fn(async () => ({ hasMetadata: true, hasPeHeaders: true }))

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, getDebugMemoryToolTipInfo, getDebugMemoryPositionInfo, resolveDebugMemoryPosition, goToDebugMemoryMetadata, getDebugMemoryFileInfo },
  })
})

describe('Memory structure coordinates', () => {
  it('converts addresses and spans, not RVA, file offsets, flag values or code references', async () => {
    const structures = memoryStructures('session', base, () => true)
    const info = await structures.positionInfo(0x10)
    expect(getDebugMemoryPositionInfo).toHaveBeenCalledWith('session', base + 0x10)
    expect(info).toEqual({
      ...position,
      file: { offset: -0x100, length: 0x4000000 },
      structure: { offset: 8, length: 0x40 },
      editField: { ...position.editField, offset: 0x20 },
      fieldReference: { offset: -1, length: 4 },
    })
    expect(info.reference).toBe(position.reference)
    const tooltipInfo = await structures.toolTipInfo(0x10)
    expect(getDebugMemoryToolTipInfo).toHaveBeenCalledWith('session', base + 0x10)
    expect(tooltipInfo.fields).toEqual([{ offset: 0x10, length: 2, kind: 'currentField' }, { offset: -8, length: 0x40, kind: 'structure' }])
    expect(tooltipInfo.toolTip).toBe(toolTip.toolTip)
  })

  it('keeps targets before the window and distinguishes the absent PE translation', async () => {
    const structures = memoryStructures('session', base, () => true)
    expect(await structures.resolvePosition(5, 'rva', 0x1000)).toBe(-1)
    expect(resolveDebugMemoryPosition).toHaveBeenCalledWith('session', base + 5, 'rva', 0x1000)
    resolveDebugMemoryPosition.mockResolvedValueOnce({ offset: -1 })
    expect(await structures.resolvePosition(5, 'file', 0)).toBeNaN()
    expect(await structures.goToMetadata(7, 'guid', 2)).toEqual({ offset: -0x200, length: 16 })
    expect(goToDebugMemoryMetadata).toHaveBeenCalledWith('session', base + 7, 'guid', 2)
    expect(await structures.fileInfo(9)).toEqual({ hasMetadata: true, hasPeHeaders: true })
    expect(getDebugMemoryFileInfo).toHaveBeenCalledWith('session', base + 9)
  })

  it('rejects answers from a previous process, window or stop', async () => {
    let current = true
    const structures = memoryStructures('session', base, () => current)
    const answer = structures.toolTipInfo(0)
    current = false
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
  })
})
