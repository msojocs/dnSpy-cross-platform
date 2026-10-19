/**
 * Reads and writes the payload of a serialized `System.Windows.Forms.ImageListStreamer` — the byte[] kept in its
 * "Data" member — without WinForms, so a resource WPF dnSpy built with a real `ImageList` can be shown and edited
 * here, and one built here loads in WinForms.
 *
 * The layers, outermost first:
 *  1. WinForms' compression (`ImageListStreamer.Compress`): "MSFt" then `RunLengthEncoder` pairs of (count, byte).
 *     Data without the signature is taken as already uncompressed, the way `Decompress` does.
 *  2. What comctl32's `ImageList_Write` (WinForms asks `ImageList_WriteEx(ILP_DOWNLEVEL)`) puts in the stream: a
 *     28-byte `ILHEAD`, the image bitmap as a BMP file and, with `ILC_MASK`, a 1bpp mask bitmap as a BMP file.
 *  3. Both bitmaps are a grid of `cx` x `cy` tiles, four to a row (Wine's `TILE_COUNT`, `imagelist_point_from_index`),
 *     stored as bottom-up DIBs with 4-byte aligned rows. A mask bit of 1 means "transparent".
 *
 * Checked against dotnet/winforms (`ImageListStreamer.cs`, `RunLengthEncoder.cs`, `ImageList.cs`) and Wine's
 * `dlls/comctl32/imagelist.c`, and against the sample in WinForms' `ImageListStreamerTests`.
 */

export type ImageListColorDepth = 4 | 8 | 16 | 24 | 32

/** One image: straight (non-premultiplied) RGBA, row-major, top-down. */
export interface ImageListImage {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface ImageListData {
  colorDepth: ImageListColorDepth
  /** Image size, 1..256. */
  width: number
  height: number
  /** WinForms' TransparentColor as 0xAARRGGBB; 0x00FFFFFF-ish "Transparent" (alpha 0) means none */
  transparentColor: number
  /** Each exactly width x height. */
  images: ImageListImage[]
}

const SIGNATURE = [0x4D, 0x53, 0x46, 0x74] // "MSFt"
const IL_MAGIC = 0x4C49 // 'I', 'L'
const IL_VERSION = 0x101
const ILHEAD_SIZE = 28
const ILC_MASK = 0x1
const CLR_NONE = 0xFFFFFFFF
const TILE_COUNT = 4
const BITMAPFILEHEADER_SIZE = 14
const BITMAPINFOHEADER_SIZE = 40
const BI_RGB = 0
/** WinForms creates its list with `InitialCapacity` 4 and `GrowBy` 4. */
const GROW_BY = 4

// ---------------------------------------------------------------------------------------------------------------
// WinForms' run-length layer

/** WinForms' `ImageListStreamer.Compress`: "MSFt", then (count, byte) pairs with runs capped at 255. */
export function compressImageListStreamerBytes(input: Uint8Array): Uint8Array {
  const out: number[] = [...SIGNATURE]
  let i = 0
  while (i < input.length) {
    const value = input[i]
    let run = 1
    while (i + run < input.length && input[i + run] === value) run++
    i += run
    while (run > 0) {
      out.push(Math.min(run, 0xFF), value)
      run -= 0xFF
    }
  }
  return Uint8Array.from(out)
}

/** WinForms' `ImageListStreamer.Decompress`; input without the "MSFt" signature is returned as it is. */
export function decompressImageListStreamerBytes(input: Uint8Array): Uint8Array {
  if (!hasSignature(input)) return input
  const pairs = input.subarray(SIGNATURE.length)
  if (pairs.length % 2 !== 0) throw new Error('ImageListStreamer data is truncated: the run-length pairs end on a count.')
  let length = 0
  for (let i = 0; i < pairs.length; i += 2) length += pairs[i]
  const out = new Uint8Array(length)
  let pos = 0
  for (let i = 0; i < pairs.length; i += 2) {
    out.fill(pairs[i + 1], pos, pos + pairs[i])
    pos += pairs[i]
  }
  return out
}

function hasSignature(data: Uint8Array): boolean {
  return data.length >= SIGNATURE.length && SIGNATURE.every((b, i) => data[i] === b)
}

// ---------------------------------------------------------------------------------------------------------------
// Palettes

type Rgb = [number, number, number]

/**
 * The palette written for 4-bit lists: the 16 VGA colours in the Windows default order. A 4bpp list on Windows
 * starts from the same colours, so pixels drawn from them survive exactly; others go to the nearest one.
 */
const PALETTE_4: Rgb[] = [
  [0x00, 0x00, 0x00], [0x80, 0x00, 0x00], [0x00, 0x80, 0x00], [0x80, 0x80, 0x00],
  [0x00, 0x00, 0x80], [0x80, 0x00, 0x80], [0x00, 0x80, 0x80], [0xC0, 0xC0, 0xC0],
  [0x80, 0x80, 0x80], [0xFF, 0x00, 0x00], [0x00, 0xFF, 0x00], [0xFF, 0xFF, 0x00],
  [0x00, 0x00, 0xFF], [0xFF, 0x00, 0xFF], [0x00, 0xFF, 0xFF], [0xFF, 0xFF, 0xFF],
]

/**
 * The palette written for 8-bit lists: a 6x6x6 colour cube (levels 0, 0x33, ..., 0xFF — the web-safe colours
 * Windows' own halftone palette is built around) followed by 40 evenly spaced greys. Windows writes whatever
 * palette its DIB section had; any palette reads back correctly, this one just quantizes evenly.
 */
const PALETTE_8: Rgb[] = (() => {
  const palette: Rgb[] = []
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) palette.push([r * 0x33, g * 0x33, b * 0x33])
    }
  }
  for (let i = 0; i < 40; i++) {
    const v = Math.round(i * 255 / 39)
    palette.push([v, v, v])
  }
  return palette
})()

function nearestIndex(palette: Rgb[], cache: Map<number, number>, r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i]
    const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  cache.set(key, best)
  return best
}

// ---------------------------------------------------------------------------------------------------------------
// Decoding

interface Dib {
  width: number
  height: number
  bitCount: number
  topDown: boolean
  palette: Rgb[]
  bits: Uint8Array
  stride: number
}

function dibStride(width: number, bitCount: number): number {
  return ((width * bitCount + 31) >> 5) * 4
}

/** Wine's `read_bitmap`: BITMAPFILEHEADER, BITMAPINFOHEADER, a full palette for <= 8bpp, then the bits. */
function readDib(view: DataView, offset: number, what: string): { dib: Dib, end: number } {
  const need = (count: number): void => {
    if (offset + count > view.byteLength) throw new Error(`ImageListStreamer data is truncated inside the ${what} bitmap.`)
  }
  need(BITMAPFILEHEADER_SIZE + BITMAPINFOHEADER_SIZE)
  if (view.getUint16(offset, true) !== 0x4D42) throw new Error(`The ${what} bitmap of the ImageListStreamer data has no "BM" header.`)
  offset += BITMAPFILEHEADER_SIZE
  const headerSize = view.getUint32(offset, true)
  if (headerSize !== BITMAPINFOHEADER_SIZE) throw new Error(`The ${what} bitmap has an unsupported header size ${headerSize}.`)
  const width = view.getInt32(offset + 4, true)
  const rawHeight = view.getInt32(offset + 8, true)
  const planes = view.getUint16(offset + 12, true)
  const bitCount = view.getUint16(offset + 14, true) * Math.max(planes, 1)
  const compression = view.getUint32(offset + 16, true)
  offset += BITMAPINFOHEADER_SIZE
  if (width <= 0 || rawHeight === 0) throw new Error(`The ${what} bitmap has an invalid size ${width}x${rawHeight}.`)
  if (![1, 4, 8, 16, 24, 32].includes(bitCount)) throw new Error(`The ${what} bitmap has an unsupported bit count ${bitCount}.`)
  if (compression !== BI_RGB) throw new Error(`The ${what} bitmap uses compression ${compression}; only BI_RGB is supported.`)
  const palette: Rgb[] = []
  if (bitCount <= 8) {
    const entries = 1 << bitCount
    need(entries * 4)
    for (let i = 0; i < entries; i++) {
      const p = offset + i * 4
      palette.push([view.getUint8(p + 2), view.getUint8(p + 1), view.getUint8(p)])
    }
    offset += entries * 4
  }
  const height = Math.abs(rawHeight)
  const stride = dibStride(width, bitCount)
  need(stride * height)
  const bits = new Uint8Array(view.buffer, view.byteOffset + offset, stride * height)
  return { dib: { width, height, bitCount, topDown: rawHeight < 0, palette, bits, stride }, end: offset + stride * height }
}

function rowOffset(dib: Dib, y: number): number {
  return (dib.topDown ? y : dib.height - 1 - y) * dib.stride
}

/** The pixel at (x, y), counted top-down, as [r, g, b, a] (a is only meaningful for 32bpp). */
function readPixel(dib: Dib, x: number, y: number, out: number[]): void {
  const row = rowOffset(dib, y)
  const bits = dib.bits
  switch (dib.bitCount) {
    case 1: case 4: case 8: {
      const bit = x * dib.bitCount
      const byte = bits[row + (bit >> 3)]
      const index = (byte >> (8 - dib.bitCount - (bit & 7))) & ((1 << dib.bitCount) - 1)
      const [r, g, b] = dib.palette[index]
      out[0] = r; out[1] = g; out[2] = b; out[3] = 0
      return
    }
    case 16: {
      const v = bits[row + x * 2] | (bits[row + x * 2 + 1] << 8)
      const expand = (c: number): number => (c << 3) | (c >> 2)
      out[0] = expand((v >> 10) & 0x1F); out[1] = expand((v >> 5) & 0x1F); out[2] = expand(v & 0x1F); out[3] = 0
      return
    }
    case 24: {
      const p = row + x * 3
      out[0] = bits[p + 2]; out[1] = bits[p + 1]; out[2] = bits[p]; out[3] = 0
      return
    }
    default: {
      const p = row + x * 4
      out[0] = bits[p + 2]; out[1] = bits[p + 1]; out[2] = bits[p]; out[3] = bits[p + 3]
    }
  }
}

function maskBit(mask: Dib, x: number, y: number): boolean {
  return ((mask.bits[rowOffset(mask, y) + (x >> 3)] << (x & 7)) & 0x80) !== 0
}

function colorDepthOf(bitCount: number): ImageListColorDepth {
  // A 1bpp list is not something WinForms can describe; it reads closest as 4-bit.
  return bitCount === 1 ? 4 : bitCount as ImageListColorDepth
}

/**
 * Decodes a "Data" byte[] (compressed or not). Per image, 32bpp pixels keep their alpha channel when any of them
 * has a non-zero alpha (comctl32's `ILIF_ALPHA` test in `add_dib_bits`); otherwise the mask decides — a set bit
 * becomes a transparent pixel, which is returned as 0,0,0,0 just as comctl32 clears it. The TransparentColor
 * WinForms applied while adding is baked into the mask, so it is only reported when the list has a background
 * colour; otherwise it is 0 (none).
 */
export function decodeImageListStreamerData(data: Uint8Array): ImageListData {
  const bytes = decompressImageListStreamerBytes(data)
  if (bytes.length < ILHEAD_SIZE) throw new Error('ImageListStreamer data is too short to hold an image list header.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0, true) !== IL_MAGIC) throw new Error('ImageListStreamer data does not start with an image list ("IL") header.')
  const version = view.getUint16(2, true)
  if (version !== IL_VERSION) throw new Error(`Unsupported image list version 0x${version.toString(16)}; only 0x101 is supported.`)
  const count = view.getUint16(4, true)
  const cx = view.getUint16(10, true)
  const cy = view.getUint16(12, true)
  const bkColor = view.getUint32(14, true)
  const flags = view.getUint16(18, true)
  if (cx === 0 || cy === 0) throw new Error(`The image list has an invalid image size ${cx}x${cy}.`)

  const { dib: image, end } = readDib(view, ILHEAD_SIZE, 'image')
  const mask = (flags & ILC_MASK) !== 0 ? readDib(view, end, 'mask').dib : null
  if (mask && mask.bitCount !== 1) throw new Error(`The mask bitmap has ${mask.bitCount} bits per pixel instead of 1.`)

  // comctl32 v6 lays images four to a row; an older single-strip layout is just a wider row.
  const columns = Math.floor(image.width / cx)
  if (count > 0 && columns === 0) throw new Error(`The image bitmap (${image.width} wide) is narrower than one ${cx}-pixel image.`)
  const rows = count === 0 ? 0 : Math.ceil(count / columns)
  if (rows * cy > image.height) throw new Error(`The image bitmap is too small for ${count} images of ${cx}x${cy}.`)
  if (mask && count > 0 && (mask.width < columns * cx || mask.height < rows * cy)) {
    throw new Error(`The mask bitmap is too small for ${count} images of ${cx}x${cy}.`)
  }

  const images: ImageListImage[] = []
  const pixel = [0, 0, 0, 0]
  for (let n = 0; n < count; n++) {
    const left = (n % columns) * cx
    const top = Math.floor(n / columns) * cy
    const rgba = new Uint8ClampedArray(cx * cy * 4)
    let hasAlpha = false
    if (image.bitCount === 32) {
      for (let y = 0; y < cy && !hasAlpha; y++) {
        for (let x = 0; x < cx; x++) {
          if (image.bits[rowOffset(image, top + y) + (left + x) * 4 + 3] !== 0) { hasAlpha = true; break }
        }
      }
    }
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        const o = (y * cx + x) * 4
        if (!hasAlpha && mask && maskBit(mask, left + x, top + y)) continue
        readPixel(image, left + x, top + y, pixel)
        rgba[o] = pixel[0]
        rgba[o + 1] = pixel[1]
        rgba[o + 2] = pixel[2]
        rgba[o + 3] = hasAlpha ? pixel[3] : 0xFF
      }
    }
    images.push({ width: cx, height: cy, rgba })
  }

  // COLORREF is 0x00BBGGRR.
  const transparentColor = bkColor === CLR_NONE
    ? 0
    : (0xFF000000 | ((bkColor & 0xFF) << 16) | (bkColor & 0xFF00) | ((bkColor >> 16) & 0xFF)) >>> 0
  return { colorDepth: colorDepthOf(image.bitCount), width: cx, height: cy, transparentColor, images }
}

// ---------------------------------------------------------------------------------------------------------------
// Encoding

function writeDibFile(out: DataView, offset: number, width: number, height: number, bitCount: number,
  palette: Rgb[], bits: Uint8Array): number {
  const paletteSize = bitCount <= 8 ? (1 << bitCount) * 4 : 0
  const offBits = BITMAPFILEHEADER_SIZE + BITMAPINFOHEADER_SIZE + paletteSize
  out.setUint16(offset, 0x4D42, true)
  // Both comctl32 and Wine put offBits (not the file size) in bfSize; copied so the bytes match WinForms'.
  out.setUint32(offset + 2, offBits, true)
  out.setUint32(offset + 10, offBits, true)
  let p = offset + BITMAPFILEHEADER_SIZE
  out.setUint32(p, BITMAPINFOHEADER_SIZE, true)
  out.setInt32(p + 4, width, true)
  out.setInt32(p + 8, height, true)
  out.setUint16(p + 12, 1, true)
  out.setUint16(p + 14, bitCount, true)
  out.setUint32(p + 16, BI_RGB, true)
  out.setUint32(p + 20, bits.length, true)
  p += BITMAPINFOHEADER_SIZE
  for (let i = 0; i < paletteSize / 4; i++) {
    const [r, g, b] = palette[i] ?? [0, 0, 0]
    out.setUint8(p + i * 4, b)
    out.setUint8(p + i * 4 + 1, g)
    out.setUint8(p + i * 4 + 2, r)
  }
  p += paletteSize
  new Uint8Array(out.buffer, out.byteOffset + p, bits.length).set(bits)
  return p + bits.length
}

function dibFileSize(bitCount: number, imageSize: number): number {
  return BITMAPFILEHEADER_SIZE + BITMAPINFOHEADER_SIZE + (bitCount <= 8 ? (1 << bitCount) * 4 : 0) + imageSize
}

function checkList(list: ImageListData): void {
  const { width, height, images } = list
  if (![4, 8, 16, 24, 32].includes(list.colorDepth)) throw new Error(`Unsupported image list colour depth ${list.colorDepth}.`)
  for (const [name, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 256) throw new Error(`The image list ${name} must be 1..256, not ${v}.`)
  }
  if (images.length > 0xFFFF) throw new Error(`An image list holds at most 65535 images, not ${images.length}.`)
  images.forEach((image, i) => {
    if (image.width !== width || image.height !== height || image.rgba.length !== width * height * 4) {
      throw new Error(`Image ${i} is ${image.width}x${image.height}, but the list holds ${width}x${height} images.`)
    }
  })
}

/**
 * Builds the "Data" byte[] WinForms would store for this list: an `ImageList_Write` stream (ILC_MASK plus the
 * colour flag, background CLR_NONE as WinForms sets it, a 4-wide tile grid) compressed with "MSFt" RLE.
 *
 * Like `ImageList.CreateBitmap`, a TransparentColor with non-zero alpha first makes matching pixels transparent.
 * A pixel is then masked out when its alpha is 0 (as `ControlPaint.CreateHBitmapTransparencyMask` decides), and
 * written as black, as comctl32 does when it adds a masked image. 32-bit lists keep the straight alpha channel;
 * lower depths drop it, 16-bit is 5-5-5 and 4/8-bit are quantized to the fixed palettes above.
 */
export function encodeImageListStreamerData(list: ImageListData): Uint8Array {
  checkList(list)
  const { colorDepth, width: cx, height: cy, images } = list
  const count = images.length
  const bitmapWidth = cx * TILE_COUNT
  // Windows writes only the rows the images use (its sample has cMaxImage 8 but one row), at least one.
  const bitmapHeight = Math.max(1, Math.ceil(count / TILE_COUNT)) * cy
  const stride = dibStride(bitmapWidth, colorDepth)
  const maskStride = dibStride(bitmapWidth, 1)
  const bits = new Uint8Array(stride * bitmapHeight)
  const maskBits = new Uint8Array(maskStride * bitmapHeight)
  const palette = colorDepth === 4 ? PALETTE_4 : colorDepth === 8 ? PALETTE_8 : []
  const cache = new Map<number, number>()
  const transparent = list.transparentColor >>> 0
  const useTransparent = (transparent >>> 24) !== 0
  const tr = (transparent >> 16) & 0xFF
  const tg = (transparent >> 8) & 0xFF
  const tb = transparent & 0xFF

  images.forEach((image, n) => {
    const left = (n % TILE_COUNT) * cx
    const top = Math.floor(n / TILE_COUNT) * cy
    for (let y = 0; y < cy; y++) {
      const by = top + y
      const row = (bitmapHeight - 1 - by) * stride
      const maskRow = (bitmapHeight - 1 - by) * maskStride
      for (let x = 0; x < cx; x++) {
        const bx = left + x
        const o = (y * cx + x) * 4
        const r = image.rgba[o]
        const g = image.rgba[o + 1]
        const b = image.rgba[o + 2]
        let a = image.rgba[o + 3]
        if (useTransparent && a !== 0 && r === tr && g === tg && b === tb) a = 0
        if (a === 0) {
          maskBits[maskRow + (bx >> 3)] |= 0x80 >> (bx & 7)
          continue // the colour bits stay 0 (black, or palette index 0 = black)
        }
        switch (colorDepth) {
          case 4: {
            const index = nearestIndex(palette, cache, r, g, b)
            bits[row + (bx >> 1)] |= (bx & 1) === 0 ? index << 4 : index
            break
          }
          case 8:
            bits[row + bx] = nearestIndex(palette, cache, r, g, b)
            break
          case 16: {
            const v = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
            bits[row + bx * 2] = v & 0xFF
            bits[row + bx * 2 + 1] = v >> 8
            break
          }
          case 24:
            bits[row + bx * 3] = b
            bits[row + bx * 3 + 1] = g
            bits[row + bx * 3 + 2] = r
            break
          default:
            bits[row + bx * 4] = b
            bits[row + bx * 4 + 1] = g
            bits[row + bx * 4 + 2] = r
            bits[row + bx * 4 + 3] = a
        }
      }
    }
  })

  const total = ILHEAD_SIZE + dibFileSize(colorDepth, bits.length) + dibFileSize(1, maskBits.length)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, IL_MAGIC, true)
  view.setUint16(2, IL_VERSION, true)
  view.setUint16(4, count, true)
  // cMaxImage: the capacity WinForms' list would have grown to (initial 4, grow 4); it only has to be >= cCurImage.
  view.setUint16(6, Math.max(GROW_BY, Math.ceil(count / GROW_BY) * GROW_BY), true)
  view.setUint16(8, GROW_BY, true)
  view.setUint16(10, cx, true)
  view.setUint16(12, cy, true)
  view.setUint32(14, CLR_NONE, true)
  view.setUint16(18, ILC_MASK | colorDepth, true) // ILC_COLOR4..ILC_COLOR32 equal the bit count
  for (let i = 0; i < 4; i++) view.setInt16(20 + i * 2, -1, true) // no overlay images
  const maskOffset = writeDibFile(view, ILHEAD_SIZE, bitmapWidth, bitmapHeight, colorDepth, palette, bits)
  writeDibFile(view, maskOffset, bitmapWidth, bitmapHeight, 1, [[0, 0, 0], [0xFF, 0xFF, 0xFF]], maskBits)
  return compressImageListStreamerBytes(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Resizing

/**
 * Resizes an image the way WinForms does when an added image is not the list's size (`new Bitmap(source, size)`,
 * GDI+'s default bilinear filter). Interpolates premultiplied colour so transparent pixels do not bleed into edges.
 */
export function scaleImage(image: ImageListImage, width: number, height: number): ImageListImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Cannot scale an image to ${width}x${height}.`)
  }
  const { width: sw, height: sh, rgba: src } = image
  const rgba = new Uint8ClampedArray(width * height * 4)
  if (sw === width && sh === height) {
    rgba.set(src)
    return { width, height, rgba }
  }
  const sample = (x: number, y: number, c: number): number => {
    const o = (y * sw + x) * 4
    return c === 3 ? src[o + 3] : src[o + c] * src[o + 3] / 255
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sh / height - 0.5, 0), sh - 1)
    const y0 = Math.floor(fy)
    const y1 = Math.min(y0 + 1, sh - 1)
    const wy = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sw / width - 0.5, 0), sw - 1)
      const x0 = Math.floor(fx)
      const x1 = Math.min(x0 + 1, sw - 1)
      const wx = fx - x0
      const value = [0, 0, 0, 0]
      for (let c = 0; c < 4; c++) {
        const top = sample(x0, y0, c) * (1 - wx) + sample(x1, y0, c) * wx
        const bottom = sample(x0, y1, c) * (1 - wx) + sample(x1, y1, c) * wx
        value[c] = top * (1 - wy) + bottom * wy
      }
      const o = (y * width + x) * 4
      const a = value[3]
      rgba[o + 3] = a
      if (a > 0) {
        rgba[o] = value[0] * 255 / a
        rgba[o + 1] = value[1] * 255 / a
        rgba[o + 2] = value[2] * 255 / a
      }
    }
  }
  return { width, height, rgba }
}
