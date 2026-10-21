/**
 * dnSpy's hex editor encoding (`HexViewOptions.TryGetEncoding`, the General page's `EncodingInfoVM`): every encoding
 * .NET lists, by code page, sorted by its display name. The list comes from the backend; until it has answered the
 * page offers the five the browser can encode by itself.
 */

export interface HexEncoding {
  codePage: number
  name: string
  displayName: string
}

/** UTF-8: `DefaultHexViewOptions.EncodingCodePageId`'s default. */
export const DEFAULT_HEX_CODE_PAGE = 65001

const BUILT_IN: HexEncoding[] = [
  { codePage: 20127, name: 'us-ascii', displayName: 'US-ASCII' },
  { codePage: 1200, name: 'utf-16', displayName: 'Unicode' },
  { codePage: 1201, name: 'utf-16BE', displayName: 'Unicode (Big-Endian)' },
  { codePage: 65001, name: 'utf-8', displayName: 'Unicode (UTF-8)' },
  { codePage: 28591, name: 'iso-8859-1', displayName: 'Western European (ISO)' },
]

/** The names the option held before it was a code page. */
const LEGACY: Record<string, number> = { utf8: 65001, utf16: 1200, utf16BE: 1201, ascii: 20127, latin1: 28591 }

/** The code page an option value names, an old name included; anything unreadable is UTF-8. */
export const hexCodePageOf = (value: string | number | undefined): number => {
  if (typeof value === 'string' && Object.hasOwn(LEGACY, value))
    return LEGACY[value]!
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_HEX_CODE_PAGE
}

let loaded: HexEncoding[] | undefined
let loading: Promise<HexEncoding[]> | undefined

/** The encodings .NET lists, asked for once. */
export const loadHexEncodings = (): Promise<HexEncoding[]> => {
  if (loaded)
    return Promise.resolve(loaded)
  loading ??= Promise.resolve().then(async () => {
    const response = await window.dnSpy.getEncodings()
    if (response.encodings.length === 0)
      throw new Error('No encodings returned')
    loaded = response.encodings
    return loaded
  }).catch(() => BUILT_IN).finally(() => { loading = undefined })
  return loading
}

/** The encodings known so far, for a list that cannot wait. */
export const hexEncodings = (): HexEncoding[] => loaded ?? BUILT_IN

/** GeneralAppSettingsPageBase selects UTF-8 if its saved code page is unavailable. Wait for the real list first. */
export const hexEncodingSelection = (value: string | number | undefined): number => {
  const codePage = hexCodePageOf(value)
  if (!loaded || loaded.some((encoding) => encoding.codePage === codePage))
    return codePage
  return loaded.find((encoding) => encoding.codePage === DEFAULT_HEX_CODE_PAGE)?.codePage ?? loaded[0]!.codePage
}

/** Text as bytes in a code page: the browser encodes UTF-8, UTF-16, ASCII and Latin-1, .NET every other one. */
export const encodeHexText = async (text: string, codePage: number): Promise<Uint8Array> => {
  switch (codePage) {
    case 65001:
      return new TextEncoder().encode(text)
    case 1200:
    case 1201: {
      const bytes = new Uint8Array(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i)
        // UnicodeEncoding replaces an unpaired UTF-16 surrogate instead of writing its raw code unit.
        if ((code >= 0xD800 && code <= 0xDBFF && !(text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF))
          || (code >= 0xDC00 && code <= 0xDFFF && !(text.charCodeAt(i - 1) >= 0xD800 && text.charCodeAt(i - 1) <= 0xDBFF)))
          code = 0xFFFD
        bytes[i * 2 + (codePage === 1201 ? 0 : 1)] = code >> 8
        bytes[i * 2 + (codePage === 1201 ? 1 : 0)] = code & 0xFF
      }
      return bytes
    }
    // .NET writes one '?' per UTF-16 code unit, including both halves of a surrogate pair.
    case 20127:
    case 28591: {
      const limit = codePage === 20127 ? 0x80 : 0x100
      const bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++)
        bytes[i] = text.charCodeAt(i) < limit ? text.charCodeAt(i) : 0x3F
      return bytes
    }
    default: {
      const response = await window.dnSpy.encodeText(codePage, text)
      return Uint8Array.from(atob(response.base64Data), (character) => character.charCodeAt(0))
    }
  }
}
