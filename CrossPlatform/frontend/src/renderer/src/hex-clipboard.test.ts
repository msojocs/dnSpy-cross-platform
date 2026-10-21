import { describe, expect, it, vi } from 'vitest'
import { buildHexClipboardText, HEX_COPY_TOO_MUCH_DATA, HEX_HTML_COPY_LIMIT, HEX_TEXT_COPY_LIMIT } from './hex-clipboard'
import { HexLineFormatter, lineTextWithin, type HexLineFormatterOptions } from './hex-line'
import { CHUNK_SIZE, PAGE_SIZE, type HexChunkReader } from './hex-view-data'

const formatter = (options: Partial<HexLineFormatterOptions> = {}): HexLineFormatter => new HexLineFormatter({
  charsPerLine: 100,
  bytesPerLine: 16,
  groupSizeInBytes: 8,
  showOffset: true,
  showValues: true,
  showAscii: true,
  offsetFormat: 'hex',
  startPosition: 0,
  endPosition: 64,
  basePosition: 0,
  useRelativePositions: false,
  offsetLowerCaseHex: false,
  valuesLowerCaseHex: false,
  offsetBitSize: 0,
  valuesFormat: 'hexByte',
  ...options,
})
const byteAt = (position: number): number => 0x30 + position % 64
const reader = vi.fn<HexChunkReader>(async (offset, count) => ({ bytes: Uint8Array.from({ length: count }, (_, index) => byteAt(offset + index)) }))
const options = (format = formatter()) => ({ formatter: format, reader, caretPosition: 0, fontFamily: 'Consolas', fontSize: 13, colorize: true })

describe('hex Copy Text', () => {
  it('copies the current line without a plain newline, but with the HTML trailing break', async () => {
    const format = formatter()
    const result = await buildHexClipboardText({ ...options(format), caretPosition: 18 })
    expect(result.text).toBe(format.getLine(18, byteAt).text)
    expect(result.text.endsWith('\n')).toBe(false)
    expect(result.html).toContain('<br/></div>')
  })

  it('keeps the selected cells and blanks the others, including reverse selections', async () => {
    const format = formatter()
    const result = await buildHexClipboardText({ ...options(format), selection: { start: 20, end: 3 } })
    const expected = [format.getLine(3, byteAt), format.getLine(19, byteAt)]
      .map((line) => `${lineTextWithin(line, 3, 20)}\n`).join('')
    expect(result.text).toBe(expected)
    expect(result.html?.match(/<br\/>/g)).toHaveLength(2)
  })

  it('retains multi-byte value cell padding and hidden columns', async () => {
    const format = formatter({ valuesFormat: 'hexUInt32', showOffset: false, showAscii: false })
    const result = await buildHexClipboardText({ ...options(format), selection: { start: 4, end: 8 } })
    expect(result.text).toBe(`${lineTextWithin(format.getLine(0, byteAt), 4, 8)}\n`)
  })

  it('copies inaccessible pages as question marks while keeping readable question marks in the ASCII colour', async () => {
    const format = formatter({ endPosition: PAGE_SIZE + 16 })
    const read = vi.fn<HexChunkReader>(async (_offset, count) => ({ bytes: new Uint8Array(count).fill(0x3F), readable: [true, false] }))
    const colors = { ascii: '#111111', error: '#ff0000' }
    const readable = await buildHexClipboardText({ ...options(format), reader: read, colors })
    expect(readable.text).toContain('3F 3F')
    expect(readable.html).toContain('color:#111111;">????????????????</span>')
    expect(readable.html).not.toContain('#ff0000')
    const unreadable = await buildHexClipboardText({ ...options(format), reader: read, caretPosition: PAGE_SIZE, colors })
    expect(unreadable.text).toContain('?? ??')
    expect(unreadable.text).not.toContain('00 00')
    expect(unreadable.html).toContain('color:#ff0000;')
  })

  it('reads a large selection in bounded chunks, not once per line', async () => {
    const length = CHUNK_SIZE * 2 + 13
    const format = formatter({ endPosition: length })
    const read = vi.fn<HexChunkReader>(async (_offset, count) => ({ bytes: new Uint8Array(count) }))
    await buildHexClipboardText({ ...options(format), reader: read, selection: { start: 3, end: length } })
    expect(read.mock.calls).toEqual([[0, CHUNK_SIZE], [CHUNK_SIZE, CHUNK_SIZE], [CHUNK_SIZE * 2, 13]])
  })

  it('allows the HTML limit and omits only HTML above it', async () => {
    const format = formatter({ endPosition: HEX_HTML_COPY_LIMIT + 1, bytesPerLine: 1024, showValues: false, showAscii: false })
    const read: HexChunkReader = async (_offset, count) => ({ bytes: new Uint8Array(count) })
    const equal = await buildHexClipboardText({ ...options(format), reader: read, selection: { start: 0, end: HEX_HTML_COPY_LIMIT } })
    expect(equal.html).toBeDefined()
    const above = await buildHexClipboardText({ ...options(format), reader: read, selection: { start: 0, end: HEX_HTML_COPY_LIMIT + 1 } })
    expect(above.html).toBeUndefined()
    expect(above.text).not.toBe(HEX_COPY_TOO_MUCH_DATA)
  })

  it('allows the text limit and rejects larger selections without reading', async () => {
    const format = formatter({ endPosition: HEX_TEXT_COPY_LIMIT + 1, bytesPerLine: 1024, showValues: false, showAscii: false })
    const read = vi.fn<HexChunkReader>(async (_offset, count) => ({ bytes: new Uint8Array(count) }))
    const equal = await buildHexClipboardText({ ...options(format), reader: read, selection: { start: 0, end: HEX_TEXT_COPY_LIMIT } })
    expect(equal.text).not.toBe(HEX_COPY_TOO_MUCH_DATA)
    read.mockClear()
    const above = await buildHexClipboardText({ ...options(format), reader: read, selection: { start: 0, end: HEX_TEXT_COPY_LIMIT + 1 } })
    expect(above).toEqual({ text: HEX_COPY_TOO_MUCH_DATA })
    expect(read).not.toHaveBeenCalled()
  })

  it('snapshots formatting and colours before the first async read', async () => {
    const format = formatter()
    const colors = { byte0: '#123456' }
    const read: HexChunkReader = async (_offset, count) => {
      format.options.valuesLowerCaseHex = true
      colors.byte0 = '#ffffff'
      return { bytes: new Uint8Array(count).fill(0xAF) }
    }
    const result = await buildHexClipboardText({ ...options(format), reader: read, colors })
    expect(result.text).toContain('AF AF')
    expect(result.html).toContain('color:#123456;')
    expect(result.html).not.toContain('#ffffff')
  })
})
