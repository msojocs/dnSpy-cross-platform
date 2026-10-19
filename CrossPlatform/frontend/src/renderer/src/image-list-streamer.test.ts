import { describe, expect, it } from 'vitest'
import {
  compressImageListStreamerBytes,
  decodeImageListStreamerData,
  decompressImageListStreamerBytes,
  encodeImageListStreamerData,
  scaleImage,
  type ImageListColorDepth,
  type ImageListData,
  type ImageListImage,
} from './image-list-streamer'

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): ImageListImage {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4)
  }
  return { width, height, rgba }
}

function list(colorDepth: ImageListColorDepth, images: ImageListImage[], transparentColor = 0x00FFFFFF): ImageListData {
  return { colorDepth, width: images[0]?.width ?? 16, height: images[0]?.height ?? 16, transparentColor, images }
}

function base64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0))
}

/** The uncompressed `ImageList_Write` stream inside encoded data. */
function rawOf(list: ImageListData): DataView {
  const raw = decompressImageListStreamerBytes(encodeImageListStreamerData(list))
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
}

const ascii = (text: string): number[] => [...text].map(c => c.charCodeAt(0))

describe('the MSFt run-length layer', () => {
  it('writes WinForms\' (count, byte) pairs after the signature', () => {
    const bytes = Uint8Array.from([7, 7, 7, 1, 2, 2])
    expect([...compressImageListStreamerBytes(bytes)]).toEqual([...ascii('MSFt'), 3, 7, 1, 1, 2, 2])
  })

  it('splits runs longer than 255 and round-trips them', () => {
    const bytes = new Uint8Array(600).fill(0xAB)
    bytes[599] = 0
    const compressed = compressImageListStreamerBytes(bytes)
    expect([...compressed.subarray(4)]).toEqual([255, 0xAB, 255, 0xAB, 89, 0xAB, 1, 0])
    expect(decompressImageListStreamerBytes(compressed)).toEqual(bytes)
  })

  it('round-trips literal bytes and an empty input', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xFF)
    expect(decompressImageListStreamerBytes(compressImageListStreamerBytes(bytes))).toEqual(bytes)
    expect([...compressImageListStreamerBytes(new Uint8Array())]).toEqual(ascii('MSFt'))
    expect(decompressImageListStreamerBytes(Uint8Array.from(ascii('MSFt')))).toEqual(new Uint8Array())
  })

  it('passes data without the signature through, and rejects a dangling count', () => {
    const plain = Uint8Array.from([1, 2, 3])
    expect(decompressImageListStreamerBytes(plain)).toBe(plain)
    expect(() => decompressImageListStreamerBytes(Uint8Array.from([...ascii('MSFt'), 3]))).toThrow(/truncated/)
  })
})

describe('encoding', () => {
  it('writes an ILHEAD the way WinForms\' list would', () => {
    const view = rawOf(list(32, [image(16, 16, () => [1, 2, 3, 255])]))
    expect(view.getUint16(0, true)).toBe(0x4C49)
    expect(view.getUint16(2, true)).toBe(0x101)
    expect(view.getUint16(4, true)).toBe(1) // cCurImage
    expect(view.getUint16(6, true)).toBeGreaterThanOrEqual(1) // cMaxImage
    expect(view.getUint16(10, true)).toBe(16)
    expect(view.getUint16(12, true)).toBe(16)
    expect(view.getUint32(14, true)).toBe(0xFFFFFFFF) // CLR_NONE
    expect(view.getUint16(18, true)).toBe(0x21) // ILC_MASK | ILC_COLOR32
    expect(view.getInt16(20, true)).toBe(-1)
    expect(view.getUint16(28, true)).toBe(0x4D42) // "BM"
  })

  it('lays five images out four to a row, two rows, with a matching mask', () => {
    const images = Array.from({ length: 5 }, (_, n) => image(10, 6, () => [n * 40, 0, 0, 255]))
    const view = rawOf(list(24, images))
    const bmp = 28 + 14
    expect(view.getInt32(bmp + 4, true)).toBe(40) // 4 x 10
    expect(view.getInt32(bmp + 8, true)).toBe(12) // 2 rows x 6
    expect(view.getUint16(bmp + 14, true)).toBe(24)
    const mask = 28 + 14 + 40 + 40 * 3 * 12 // 24bpp rows of 120 bytes are already aligned
    expect(view.getUint16(mask, true)).toBe(0x4D42)
    expect(view.getInt32(mask + 14 + 4, true)).toBe(40)
    expect(view.getInt32(mask + 14 + 8, true)).toBe(12)
    expect(view.getUint16(mask + 14 + 14, true)).toBe(1)

    const decoded = decodeImageListStreamerData(encodeImageListStreamerData(list(24, images)))
    expect(decoded.images.map(i => i.rgba[0])).toEqual([0, 40, 80, 120, 160])
  })

  it('rejects images that are not the list\'s size', () => {
    const data = list(32, [image(16, 16, () => [0, 0, 0, 255])])
    data.width = 8
    expect(() => encodeImageListStreamerData(data)).toThrow(/16x16/)
    expect(() => encodeImageListStreamerData({ ...list(32, []), width: 0 })).toThrow(/1\.\.256/)
  })
})

describe('round trips per colour depth', () => {
  // A diagonal gradient with a transparent corner and a half-transparent pixel.
  const source = image(16, 16, (x, y) => {
    if (x === 0 && y === 0) return [0, 0, 0, 0]
    if (x === 1 && y === 0) return [200, 100, 50, 128]
    return [x * 16, y * 16, (x + y) * 8, 255]
  })

  it('keeps 32-bit pixels exactly, alpha included', () => {
    const decoded = decodeImageListStreamerData(encodeImageListStreamerData(list(32, [source])))
    expect(decoded.colorDepth).toBe(32)
    expect(decoded.images[0].rgba).toEqual(source.rgba)
  })

  it('keeps 24-bit colours exactly and turns alpha into the mask', () => {
    const decoded = decodeImageListStreamerData(encodeImageListStreamerData(list(24, [source])))
    const rgba = decoded.images[0].rgba
    expect(decoded.colorDepth).toBe(24)
    expect([...rgba.subarray(0, 8)]).toEqual([0, 0, 0, 0, 200, 100, 50, 255])
    expect([...rgba.subarray(16 * 4 * 5 + 12, 16 * 4 * 5 + 16)]).toEqual([48, 80, 64, 255])
  })

  it('keeps 16-bit colours to 5 bits per channel', () => {
    const decoded = decodeImageListStreamerData(encodeImageListStreamerData(list(16, [source])))
    const a = source.rgba
    const b = decoded.images[0].rgba
    expect(decoded.colorDepth).toBe(16)
    for (let i = 4; i < a.length; i++) expect(Math.abs(a[i] - b[i]), `byte ${i}`).toBeLessThanOrEqual(i % 4 === 3 ? 127 : 7)
  })

  it('quantizes 8-bit and 4-bit lists to their palettes', () => {
    const colours = image(4, 2, x => [[0xFF, 0, 0, 255], [0, 0x33, 0x66, 255], [0x80, 0x80, 0x80, 255], [0, 0, 0, 0]][x] as [number, number, number, number])
    const eight = decodeImageListStreamerData(encodeImageListStreamerData(list(8, [colours]))).images[0].rgba
    expect([...eight.subarray(0, 16)]).toEqual([0xFF, 0, 0, 255, 0, 0x33, 0x66, 255, 0x83, 0x83, 0x83, 255, 0, 0, 0, 0])
    const four = decodeImageListStreamerData(encodeImageListStreamerData(list(4, [colours])))
    expect(four.colorDepth).toBe(4)
    expect([...four.images[0].rgba.subarray(0, 16)]).toEqual([0xFF, 0, 0, 255, 0, 0, 0x80, 255, 0x80, 0x80, 0x80, 255, 0, 0, 0, 0])
  })

  it('applies a TransparentColor through the mask', () => {
    const magenta = image(2, 1, x => (x === 0 ? [255, 0, 255, 255] : [1, 2, 3, 255]))
    for (const depth of [4, 8, 16, 24, 32] as const) {
      const rgba = decodeImageListStreamerData(encodeImageListStreamerData(list(depth, [magenta], 0xFFFF00FF))).images[0].rgba
      expect(rgba[3], `depth ${depth}`).toBe(0)
      expect(rgba[7], `depth ${depth}`).toBe(255)
    }
    // A transparent TransparentColor (WinForms' default) changes nothing.
    const kept = decodeImageListStreamerData(encodeImageListStreamerData(list(24, [magenta], 0x00FF00FF))).images[0].rgba
    expect(kept[3]).toBe(255)
  })
})

describe('decoding', () => {
  it('uses the mask for 32-bit images that carry no alpha', () => {
    const data = list(32, [image(4, 1, x => [10, 20, 30, x === 2 ? 0 : 255])])
    const raw = decompressImageListStreamerBytes(encodeImageListStreamerData(data))
    // Clear the alpha bytes, as a list built from opaque GDI bitmaps would have them.
    const pixels = 28 + 14 + 40
    for (let i = pixels + 3; i < pixels + 16 * 4; i += 4) raw[i] = 0
    const rgba = decodeImageListStreamerData(raw).images[0].rgba
    expect([...rgba.subarray(0, 16)]).toEqual([10, 20, 30, 255, 10, 20, 30, 255, 0, 0, 0, 0, 10, 20, 30, 255])
  })

  it('reports the background colour as the transparent colour', () => {
    const raw = decompressImageListStreamerBytes(encodeImageListStreamerData(list(24, [image(2, 2, () => [0, 0, 0, 255])])))
    new DataView(raw.buffer).setUint32(14, 0x00332211, true) // COLORREF 0x00BBGGRR
    expect(decodeImageListStreamerData(raw).transparentColor).toBe(0xFF112233)
    expect(decodeImageListStreamerData(encodeImageListStreamerData(list(24, [image(2, 2, () => [0, 0, 0, 255])]))).transparentColor).toBe(0)
  })

  it('rejects garbage with a clear message', () => {
    expect(() => decodeImageListStreamerData(new Uint8Array())).toThrow(/too short/)
    expect(() => decodeImageListStreamerData(new Uint8Array(64).fill(0x41))).toThrow(/"IL"/)
    expect(() => decodeImageListStreamerData(Uint8Array.from([...ascii('MSFt'), 1]))).toThrow(/truncated/)
    const raw = decompressImageListStreamerBytes(encodeImageListStreamerData(list(24, [image(2, 2, () => [0, 0, 0, 255])])))
    expect(() => decodeImageListStreamerData(raw.subarray(0, raw.length - 10))).toThrow(/truncated inside the mask/)
    const badVersion = raw.slice()
    badVersion[3] = 0x06
    expect(() => decodeImageListStreamerData(badVersion)).toThrow(/version 0x601/)
    const badBmp = raw.slice()
    badBmp[28] = 0
    expect(() => decodeImageListStreamerData(badBmp)).toThrow(/"BM"/)
  })

  // The "Data" byte[] of the BinaryFormatter-serialized ImageListStreamer in dotnet/winforms'
  // ImageListStreamerTests (ClassicBfImageListStreamer): one blank 16x16 image in an 8-bit list.
  const winFormsSample =
    'TVNGdAFJAUwDAQEAAQgBAAEIAQABEAEAARABAAT/AQkBAAj/AUIBTQE2AQQGAAE2AQQCAAEoAwABQAMAARADAAEBAQABCAYAAQQYAAGAAgAB' +
    'gAMAAoABAAGAAwABgAEAAYABAAKAAgADwAEAAcAB3AHAAQAB8AHKAaYBAAEzBQABMwEAATMBAAEzAQACMwIAAxYBAAMcAQADIgEAAykBAANV' +
    'AQADTQEAA0IBAAM5AQABgAF8Af8BAAJQAf8BAAGTAQAB1gEAAf8B7AHMAQABxgHWAe8BAAHWAucBAAGQAakBrQIAAf8BMwMAAWYDAAGZAwAB' +
    'zAIAATMDAAIzAgABMwFmAgABMwGZAgABMwHMAgABMwH/AgABZgMAAWYBMwIAAmYCAAFmAZkCAAFmAcwCAAFmAf8CAAGZAwABmQEzAgABmQFm' +
    'AgACmQIAAZkBzAIAAZkB/wIAAcwDAAHMATMCAAHMAWYCAAHMAZkCAALMAgABzAH/AgAB/wFmAgAB/wGZAgAB/wHMAQABMwH/AgAB/wEAATMB' +
    'AAEzAQABZgEAATMBAAGZAQABMwEAAcwBAAEzAQAB/wEAAf8BMwIAAzMBAAIzAWYBAAIzAZkBAAIzAcwBAAIzAf8BAAEzAWYCAAEzAWYBMwEA' +
    'ATMCZgEAATMBZgGZAQABMwFmAcwBAAEzAWYB/wEAATMBmQIAATMBmQEzAQABMwGZAWYBAAEzApkBAAEzAZkBzAEAATMBmQH/AQABMwHMAgAB' +
    'MwHMATMBAAEzAcwBZgEAATMBzAGZAQABMwLMAQABMwHMAf8BAAEzAf8BMwEAATMB/wFmAQABMwH/AZkBAAEzAf8BzAEAATMC/wEAAWYDAAFm' +
    'AQABMwEAAWYBAAFmAQABZgEAAZkBAAFmAQABzAEAAWYBAAH/AQABZgEzAgABZgIzAQABZgEzAWYBAAFmATMBmQEAAWYBMwHMAQABZgEzAf8B' +
    'AAJmAgACZgEzAQADZgEAAmYBmQEAAmYBzAEAAWYBmQIAAWYBmQEzAQABZgGZAWYBAAFmApkBAAFmAZkBzAEAAWYBmQH/AQABZgHMAgABZgHM' +
    'ATMBAAFmAcwBmQEAAWYCzAEAAWYBzAH/AQABZgH/AgABZgH/ATMBAAFmAf8BmQEAAWYB/wHMAQABzAEAAf8BAAH/AQABzAEAApkCAAGZATMB' +
    'mQEAAZkBAAGZAQABmQEAAcwBAAGZAwABmQIzAQABmQEAAWYBAAGZATMBzAEAAZkBAAH/AQABmQFmAgABmQFmATMBAAGZATMBZgEAAZkBZgGZ' +
    'AQABmQFmAcwBAAGZATMB/wEAApkBMwEAApkBZgEAA5kBAAKZAcwBAAKZAf8BAAGZAcwCAAGZAcwBMwEAAWYBzAFmAQABmQHMAZkBAAGZAswB' +
    'AAGZAcwB/wEAAZkB/wIAAZkB/wEzAQABmQHMAWYBAAGZAf8BmQEAAZkB/wHMAQABmQL/AQABzAMAAZkBAAEzAQABzAEAAWYBAAHMAQABmQEA' +
    'AcwBAAHMAQABmQEzAgABzAIzAQABzAEzAWYBAAHMATMBmQEAAcwBMwHMAQABzAEzAf8BAAHMAWYCAAHMAWYBMwEAAZkCZgEAAcwBZgGZAQAB' +
    'zAFmAcwBAAGZAWYB/wEAAcwBmQIAAcwBmQEzAQABzAGZAWYBAAHMApkBAAHMAZkBzAEAAcwBmQH/AQACzAIAAswBMwEAAswBZgEAAswBmQEA' +
    'A8wBAALMAf8BAAHMAf8CAAHMAf8BMwEAAZkB/wFmAQABzAH/AZkBAAHMAf8BzAEAAcwC/wEAAcwBAAEzAQAB/wEAAWYBAAH/AQABmQEAAcwB' +
    'MwIAAf8CMwEAAf8BMwFmAQAB/wEzAZkBAAH/ATMBzAEAAf8BMwH/AQAB/wFmAgAB/wFmATMBAAHMAmYBAAH/AWYBmQEAAf8BZgHMAQABzAFm' +
    'Af8BAAH/AZkCAAH/AZkBMwEAAf8BmQFmAQAB/wKZAQAB/wGZAcwBAAH/AZkB/wEAAf8BzAIAAf8BzAEzAQAB/wHMAWYBAAH/AcwBmQEAAf8C' +
    'zAEAAf8BzAH/AQAC/wEzAQABzAH/AWYBAAL/AZkBAAL/AcwBAAJmAf8BAAFmAf8BZgEAAWYC/wEAAf8CZgEAAf8BZgH/AQAC/wFmAQABIQEA' +
    'AaUBAANfAQADdwEAA4YBAAOWAQADywEAA7IBAAPXAQAD3QEAA+MBAAPqAQAD8QEAA/gBAAHwAfsB/wEAAaQCoAEAA4ADAAH/AgAB/wMAAv8B' +
    'AAH/AwAB/wEAAf8BAAL/AgAD//8A/wD/AP8ABQABQgFNAT4HAAE+AwABKAMAAUADAAEQAwABAQEAAQEFAAGAFwAD/wEAAv8GAAL/BgAC/wYA' +
    'Av8GAAL/BgAC/wYAAv8GAAL/BgAC/wYAAv8GAAL/BgAC/wYAAv8GAAL/BgAC/wYAAv8GAA=='

  it('reads a list WinForms wrote, and compresses it back to the same bytes', () => {
    const data = base64(winFormsSample)
    const decoded = decodeImageListStreamerData(data)
    expect(decoded).toMatchObject({ colorDepth: 8, width: 16, height: 16, transparentColor: 0 })
    expect(decoded.images).toHaveLength(1)
    expect(decoded.images[0].rgba.every(v => v === 0)).toBe(true)
    expect(compressImageListStreamerBytes(decompressImageListStreamerBytes(data))).toEqual(data)
  })
})

describe('scaleImage', () => {
  it('resizes to the requested size', () => {
    const scaled = scaleImage(image(32, 8, () => [10, 20, 30, 255]), 16, 16)
    expect(scaled.width).toBe(16)
    expect(scaled.height).toBe(16)
    expect(scaled.rgba.length).toBe(16 * 16 * 4)
    expect([...scaled.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255])
  })

  it('copies a same-size image and does not bleed transparent colour into edges', () => {
    const half = image(2, 1, x => (x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]))
    const same = scaleImage(half, 2, 1)
    expect(same.rgba).toEqual(half.rgba)
    expect(same.rgba).not.toBe(half.rgba)
    const wide = scaleImage(half, 4, 1)
    expect(wide.rgba[4 + 2]).toBe(0) // the second pixel is partly transparent red, not purple
    expect(wide.rgba[4]).toBe(255)
    expect(() => scaleImage(half, 0, 1)).toThrow()
  })
})
