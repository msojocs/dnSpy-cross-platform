import { afterEach, describe, expect, it, vi } from 'vitest'

const originalApi = window.dnSpy

const encodingApi = (api: Partial<typeof window.dnSpy>): void => {
  Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...originalApi, ...api } })
}

afterEach(() => {
  Object.defineProperty(window, 'dnSpy', { configurable: true, value: originalApi })
  vi.resetModules()
})

describe('hex encodings', () => {
  it('reads old names and code pages, rejecting invalid saved values', async () => {
    const { hexCodePageOf } = await import('./hex-encodings')
    for (const [value, codePage] of [['utf8', 65001], ['utf16', 1200], ['utf16BE', 1201], ['ascii', 20127], ['latin1', 28591], ['936', 936], [1252, 1252]] as const)
      expect(hexCodePageOf(value)).toBe(codePage)
    for (const value of ['nonsense', 'constructor', 'toString', '', '0', '-1', '65536', -1, 0, NaN, Infinity, 1.5, undefined])
      expect(hexCodePageOf(value)).toBe(65001)
  })

  it('encodes the browser’s own encodings itself and asks .NET for the rest', async () => {
    const { encodeHexText } = await import('./hex-encodings')
    expect(await encodeHexText('Aé', 28591)).toEqual(Uint8Array.of(0x41, 0xE9))
    expect(await encodeHexText('é', 20127)).toEqual(Uint8Array.of(0x3F))
    expect(await encodeHexText('A', 1201)).toEqual(Uint8Array.of(0, 0x41))
    const encodeText = vi.fn(async () => ({ base64Data: btoa('\xC4\xE3') }))
    encodingApi({ encodeText })
    expect(await encodeHexText('你', 936)).toEqual(Uint8Array.of(0xC4, 0xE3))
    expect(encodeText).toHaveBeenCalledWith(936, '你')
  })

  it('matches .NET replacement fallback for surrogate pairs and unpaired surrogates', async () => {
    const { encodeHexText } = await import('./hex-encodings')
    for (const codePage of [20127, 28591]) {
      expect(await encodeHexText('A😀𐀀\uD800Z\uDC00', codePage)).toEqual(Uint8Array.of(0x41, 0x3F, 0x3F, 0x3F, 0x3F, 0x3F, 0x5A, 0x3F))
    }
    expect(await encodeHexText('\uD800Z\uDC00', 1200)).toEqual(Uint8Array.of(0xFD, 0xFF, 0x5A, 0, 0xFD, 0xFF))
    expect(await encodeHexText('\uD800Z\uDC00', 1201)).toEqual(Uint8Array.of(0xFF, 0xFD, 0, 0x5A, 0xFF, 0xFD))
    expect(await encodeHexText('😀', 1200)).toEqual(Uint8Array.of(0x3D, 0xD8, 0, 0xDE))
    expect(Array.from(await encodeHexText('\uD800', 65001))).toEqual([0xEF, 0xBF, 0xBD])
  })

  it('shares a pending list request and preserves the backend’s culture-sorted complete list', async () => {
    const encodings = [
      { codePage: 936, name: 'gb2312', displayName: 'Chinese Simplified (GB2312)' },
      { codePage: 932, name: 'shift_jis', displayName: 'Japanese (Shift-JIS)' },
      { codePage: 65001, name: 'utf-8', displayName: 'Unicode (UTF-8)' },
      { codePage: 1252, name: 'windows-1252', displayName: 'Western European (Windows)' },
    ]
    const getEncodings = vi.fn(async () => ({ encodings }))
    encodingApi({ getEncodings })
    const { hexEncodings, loadHexEncodings, hexEncodingSelection } = await import('./hex-encodings')
    const first = loadHexEncodings()
    expect(loadHexEncodings()).toBe(first)
    expect(await first).toEqual(encodings)
    expect(hexEncodings()).toEqual(encodings)
    expect(await loadHexEncodings()).toEqual(encodings)
    expect(getEncodings).toHaveBeenCalledOnce()
    expect(hexEncodingSelection('936')).toBe(936)
    expect(hexEncodingSelection('12345')).toBe(65001)
  })

  it('can retry after a missing bridge, a rejected request or an empty response', async () => {
    const { loadHexEncodings, hexEncodingSelection } = await import('./hex-encodings')
    encodingApi({ getEncodings: undefined })
    expect(await loadHexEncodings()).toHaveLength(5)
    // A temporary fallback must not discard a real saved code page before the host answers.
    expect(hexEncodingSelection('936')).toBe(936)
    const encodings = [{ codePage: 65001, name: 'utf-8', displayName: 'Unicode (UTF-8)' }]
    const getEncodings = vi.fn()
      .mockRejectedValueOnce(new Error('Backend unavailable'))
      .mockResolvedValueOnce({ encodings: [] })
      .mockResolvedValueOnce({ encodings })
    encodingApi({ getEncodings })
    expect(await loadHexEncodings()).toHaveLength(5)
    expect(await loadHexEncodings()).toHaveLength(5)
    expect(await loadHexEncodings()).toEqual(encodings)
    expect(getEncodings).toHaveBeenCalledTimes(3)
  })

  it('propagates encoding errors to the editor without writing different bytes', async () => {
    const { encodeHexText } = await import('./hex-encodings')
    encodingApi({ encodeText: vi.fn().mockRejectedValue(new Error('Unknown code page')) })
    await expect(encodeHexText('text', 12345)).rejects.toThrow('Unknown code page')
  })
})
