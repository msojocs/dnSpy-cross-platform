import type { ImageListImage } from './image-list-streamer'

export const bytesFromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.charCodeAt(0))

export const base64FromBytes = (data: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < data.length; index += 0x8000)
    binary += String.fromCharCode(...data.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * The names WinForms' ColorConverter writes and reads for the colours a transparent colour is usually picked from —
 * System.Drawing's KnownColor values. Any other colour is written as its components.
 */
const KNOWN_COLORS: Record<string, number> = {
  Transparent: 0x00FFFFFF,
  Black: 0xFF000000,
  White: 0xFFFFFFFF,
  Red: 0xFFFF0000,
  Lime: 0xFF00FF00,
  Blue: 0xFF0000FF,
  Yellow: 0xFFFFFF00,
  Cyan: 0xFF00FFFF,
  Aqua: 0xFF00FFFF,
  Magenta: 0xFFFF00FF,
  Fuchsia: 0xFFFF00FF,
  Green: 0xFF008000,
  Maroon: 0xFF800000,
  Navy: 0xFF000080,
  Olive: 0xFF808000,
  Purple: 0xFF800080,
  Teal: 0xFF008080,
  Gray: 0xFF808080,
  Silver: 0xFFC0C0C0,
  Orange: 0xFFFFA500,
}

/** ColorConverter.ConvertToString: a known colour's name, else "r, g, b" — with the alpha first when it is not 255. */
export const formatColor = (argb: number): string => {
  const value = argb >>> 0
  const name = Object.keys(KNOWN_COLORS).find((key) => KNOWN_COLORS[key] === value)
  if (name)
    return name
  const a = value >>> 24
  const components = [(value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF]
  return (a === 255 ? components : [a, ...components]).join(', ')
}

/**
 * ColorConverter.ConvertFromString: a colour's name, "r, g, b", "a, r, g, b", or a number ("#RRGGBB" is opaque,
 * "#AARRGGBB" and "0x…" are taken as they are). An empty string is Color.Empty, which makes nothing transparent.
 * Anything else is no colour at all.
 */
export const parseColor = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!trimmed)
    return 0
  const named = Object.keys(KNOWN_COLORS).find((key) => key.toLowerCase() === trimmed.toLowerCase())
  if (named)
    return KNOWN_COLORS[named]
  const hex = /^(?:#|0x|&h)([0-9a-f]{1,8})$/i.exec(trimmed)
  if (hex) {
    const value = parseInt(hex[1], 16)
    return (trimmed.startsWith('#') && hex[1].length <= 6 ? 0xFF000000 | value : value) >>> 0
  }
  const parts = trimmed.split(',').map((part) => part.trim())
  if ((parts.length !== 3 && parts.length !== 4) || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined
  const [a, r, g, b] = (parts.length === 3 ? [255, ...parts.map(Number)] : parts.map(Number))
  return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
}

/**
 * Reads an image file the way WPF's BitmapImage does for dnSpy's image list: whatever the browser can decode — PNG,
 * GIF, BMP, JPEG and ICO all are — as straight RGBA at its own size.
 */
export const decodeImageFile = async (data: Uint8Array): Promise<ImageListImage> => {
  const bitmap = await createImageBitmap(new Blob([data as BlobPart]))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context)
      throw new Error('The image could not be drawn.')
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { width: bitmap.width, height: bitmap.height, rgba: new Uint8ClampedArray(pixels.data) }
  }
  finally {
    bitmap.close()
  }
}

/** An image as a data URL the list can show, or nothing where there is no canvas to draw it with. */
export const imageDataUrl = (image: ImageListImage): string | undefined => {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  let context: CanvasRenderingContext2D | null = null
  try {
    context = canvas.getContext('2d')
  }
  catch {
    return undefined
  }
  if (!context)
    return undefined
  context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0)
  return canvas.toDataURL()
}
