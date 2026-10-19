import { create } from 'zustand'
import type { MetadataColumn, MetadataRow, OpenedModule, TreeNode } from '../../shared/protocol'

/**
 * The helpers behind dnSpy's metadata table document — MetadataTableVM's grid and the MDTableContextMenuCommands —
 * and the commands of the table that has the focus, which the Edit menu reads to show its metadata group.
 */

/** A column value as dnSpy's HexField boxes write it: a digit as itself, anything larger in hex. */
export const formatColumnValue = (value: number): string =>
  value <= 9 ? String(value) : `0x${value.toString(16).toUpperCase()}`

/** MetadataTableRecordVM.TokenString and OffsetString. */
export const formatToken = (token: number): string => `0x${token.toString(16).toUpperCase().padStart(8, '0')}`

/** The bytes a column cell's text stands for, or why it holds none: an unsigned number of the column's size. */
export const encodeColumnText = (column: MetadataColumn, text: string): Uint8Array | string => {
  const trimmed = text.trim().replaceAll('_', '')
  const hexadecimal = /^(0x|&h)/i.test(trimmed)
  const digits = hexadecimal ? trimmed.slice(2) : trimmed
  if (digits.length === 0 || !(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits))
    return 'The value is not a hexadecimal or decimal integer'
  const value = BigInt(hexadecimal ? `0x${digits}` : digits)
  const max = (1n << BigInt(column.size * 8)) - 1n
  if (value > max)
    return 'Value must be between {min} and {max} (0x{maxHex}) inclusive'
  const bytes = new Uint8Array(column.size)
  let rest = value
  for (let index = 0; index < column.size; index++) {
    bytes[index] = Number(rest & 0xFFn)
    rest >>= 8n
  }
  return bytes
}

/** ClipboardUtils.HexStringToByteArray: pairs of hex digits, a "?" reading as 0, and nothing else. */
export const parseClipboardBytes = (text: string): Uint8Array | undefined => {
  if (text.length === 0 || text.length % 2 !== 0)
    return undefined
  const bytes = new Uint8Array(text.length / 2)
  for (let index = 0; index < text.length; index += 2) {
    const digit = (character: string): number => character === '?' ? 0 : /^[0-9a-f]$/i.test(character) ? parseInt(character, 16) : -1
    const high = digit(text[index])
    const low = digit(text[index + 1])
    if (high < 0 || low < 0)
      return undefined
    bytes[index / 2] = (high << 4) | low
  }
  return bytes
}

/** ClipboardUtils.ToHexString. */
export const bytesAsHex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('')

/** MDTableContext.ContiguousRecords: the selected rows follow one another with no gap. */
export const contiguousRids = (rids: readonly number[]): boolean => {
  const sorted = [...rids].sort((a, b) => a - b)
  return sorted.every((rid, index) => index === 0 || rid === sorted[index - 1] + 1)
}

/**
 * Where pasted bytes go, as PasteMDTableCommand.GetPasteData decides: whole rows, starting at the first selected
 * row, that fit inside the table. Nothing when they do not.
 */
export const pasteTarget = (data: Uint8Array, rowSize: number, firstRow: MetadataRow | undefined, rows: number): { offset: number; records: number } | undefined => {
  if (!firstRow || data.length === 0 || data.length % rowSize !== 0)
    return undefined
  const records = data.length / rowSize
  return firstRow.rid - 1 + records > rows ? undefined : { offset: firstRow.offset, records }
}

/** The commands of the metadata table document with the focus, as the Edit menu runs them. */
export interface MetadataTableCommands {
  canSort: boolean
  canSortSelection: boolean
  hasSelection: boolean
  canShowInHex: boolean
  sortTable(): void
  sortSelection(): void
  goToRid(): void
  showInHex(): void
  copyAsText(): void
  copy(): void
  paste(): void
}

interface MetadataTableCommandsState {
  /** The table view that was last focused, while it is still on screen. */
  active?: { viewId: string; commands: MetadataTableCommands }
}

export const useMetadataTableCommands = create<MetadataTableCommandsState>(() => ({}))

/**
 * Whether a row of the tree is in a document Go to MD Table Row can look in — dnSpy's HasPENode: a managed module
 * read from a file, whose PE tree holds the metadata tables. A document Create Assembly made has no file yet, and a
 * native or unknown file has no metadata.
 */
export const hasMetadataTables = (
  state: { roots: TreeNode[]; parents: Record<string, string>; modules: OpenedModule[] },
  nodeId: string,
): boolean => {
  let rootId = nodeId
  for (let parent = state.parents[rootId]; parent !== undefined; parent = state.parents[rootId])
    rootId = parent
  const root = state.roots.find((candidate) => candidate.id === rootId)
  if (!root || (root.kind !== 'assembly' && root.kind !== 'module'))
    return false
  return state.modules.find((module) => module.id === root.id)?.inMemory !== true
}
