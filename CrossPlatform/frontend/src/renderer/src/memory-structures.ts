import type { HexRange } from '../../shared/protocol'
import type { HexStructureSource } from './components/HexEditor'

/** The modules in a process use addresses; the hex view uses positions relative to its current window. */
export const memoryStructures = (sessionId: string, base: number, isCurrent: () => boolean): HexStructureSource => {
  const range = (value: HexRange | null): HexRange | null => value === null ? null : { ...value, offset: value.offset - base }
  const ask = async <T>(request: Promise<T>): Promise<T> => {
    const response = await request
    if (!isCurrent())
      throw new DOMException('The memory window has changed.', 'AbortError')
    return response
  }
  return {
    toolTipInfo: async (position) => {
      const info = await ask(window.dnSpy.getDebugMemoryToolTipInfo(sessionId, base + position))
      return { ...info, fields: info.fields.map((field) => ({ ...field, offset: field.offset - base })) }
    },
    positionInfo: async (position) => {
      const info = await ask(window.dnSpy.getDebugMemoryPositionInfo(sessionId, base + position))
      return {
        ...info,
        file: range(info.file),
        nestedFile: range(info.nestedFile),
        structure: range(info.structure),
        fieldReference: range(info.fieldReference),
        editField: info.editField === null ? null : { ...info.editField, offset: info.editField.offset - base },
      }
    },
    resolvePosition: async (caret, kind, value) => {
      const resolved = await ask(window.dnSpy.resolveDebugMemoryPosition(sessionId, base + caret, kind, value))
      // A position before this window can legitimately be -1; NaN alone means there is no PE translation.
      return resolved.offset < 0 ? Number.NaN : resolved.offset - base
    },
    goToMetadata: async (caret, kind, value) => range((await ask(window.dnSpy.goToDebugMemoryMetadata(sessionId, base + caret, kind, value))).range),
    fileInfo: (caret) => ask(window.dnSpy.getDebugMemoryFileInfo(sessionId, base + caret)),
  }
}
