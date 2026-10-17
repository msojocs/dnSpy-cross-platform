import { useInsertionEffect } from 'react'
import { DS_IMAGES } from './ds-images.generated'
import { toHexColor } from './named-colors'

/**
 * dnSpy's images in the colours of the theme they are drawn on. dnSpy draws every image of its set over the
 * background it sits on through ThemedImageCreator, which moves each colour's luminosity the way Visual Studio
 * themes its images: on a dark background the dark outlines turn light while the coloured parts keep their hue.
 * The images here are vector drawings whose colours are all spelled out, so the same transform is run over
 * those colours — the picture comes out as dnSpy's own bitmap would.
 */

interface Hsl {
  hue: number
  saturation: number
  luminosity: number
}

type Rgb = [number, number, number]

/** ThemedImageCreator.HslColor.FromColor, including its truncation of the red hue. */
const toHsl = ([r, g, b]: Rgb): Hsl => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const range = max - min
  const high = max / 255
  const low = min / 255
  const hue = max === min ? 0
    : max === r ? Math.trunc(60 * (g - b) / range + 360) % 360
      : max === g ? 60 * (b - r) / range + 120
        : 60 * (r - g) / range + 240
  const luminosity = 0.5 * (high + low)
  const saturation = max === min ? 0 : luminosity <= 0.5 ? (high - low) / (2 * luminosity) : (high - low) / (2 - 2 * luminosity)
  return { hue, saturation, luminosity }
}

const modOne = (value: number): number => value < 0 ? value + 1 : value > 1 ? value - 1 : value

const component = (p: number, q: number, t: number): number =>
  t < 1 / 6 ? p + (q - p) * 6 * t
    : t < 0.5 ? q
      : t < 2 / 3 ? p + (q - p) * 6 * (2 / 3 - t)
        : p

/** ThemedImageCreator.HslColor.ToColor; a channel is cut to a byte the way C#'s cast cuts it. */
const toRgb = ({ hue, saturation, luminosity }: Hsl): Rgb => {
  const q = luminosity < 0.5 ? luminosity * (1 + saturation) : luminosity + saturation - luminosity * saturation
  const p = 2 * luminosity - q
  const t = hue / 360
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.trunc(value * 255)))
  return [channel(component(p, q, modOne(t + 1 / 3))), channel(component(p, q, t)), channel(component(p, q, modOne(t - 1 / 3)))]
}

const LIGHTEST = 0.96470588235294119

/** ThemedImageCreator.TransformLuminosity. */
const transformLuminosity = (hue: number, saturation: number, luminosity: number, background: number): number => {
  if (background < 0.5) {
    if (luminosity >= LIGHTEST)
      return background * (luminosity - 1) / -0.035294117647058809
    const grey = saturation < 0.2 ? 1 : saturation > 0.3 ? 0 : 1 - (saturation - 0.2) / 0.099999999999999978
    const weight = Math.max(Math.min(1, Math.abs(hue - 37) / 20), grey)
    const target = ((background - 1) * 0.66 / LIGHTEST + 1) * weight + 0.66 * (1 - weight)
    return luminosity < 0.66
      ? (target - 1) / 0.66 * luminosity + 1
      : (target - background) / -0.30470588235294116 * (luminosity - LIGHTEST) + background
  }
  return luminosity < LIGHTEST
    ? luminosity * background / LIGHTEST
    : (1 - background) * (luminosity - 1) / 0.035294117647058809 + 1
}

/** One colour of an image as ThemedImageCreator.CreateThemedBitmapSource writes the pixel it fills. */
export const themedColor = (color: Rgb, background: Rgb, highContrast: boolean): Rgb => {
  const backgroundHsl = toHsl(background)
  const { hue, saturation, luminosity } = toHsl(color)
  const distance = Math.abs(LIGHTEST - luminosity)
  const greyness = Math.max(0, 1 - saturation * 4)
  const fade = greyness * Math.max(0, 1 - distance * 4)
  let themedLuminosity = transformLuminosity(hue, saturation, luminosity, backgroundHsl.luminosity)
  const themedHue = hue * (1 - greyness) + backgroundHsl.hue * greyness
  const themedSaturation = saturation * (1 - fade) + backgroundHsl.saturation * fade
  if (highContrast) {
    const stretched = themedLuminosity <= 0.3 ? 0 : themedLuminosity >= 0.7 ? 1 : (themedLuminosity - 0.3) / 0.4
    themedLuminosity = stretched * (1 - themedSaturation) + themedLuminosity * themedSaturation
  }
  return toRgb({ hue: themedHue, saturation: themedSaturation, luminosity: themedLuminosity })
}

const parseHex = (hex: string): Rgb => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]

const toHex = (rgb: Rgb): string => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`

/** A CSS colour as the computed style writes it — "rgb(37, 40, 43)" — or as a hex triplet. */
export const parseCssColor = (value: string): Rgb | undefined => {
  // A colour name is the hex triplet it stands for; a transparent one is no background to draw over.
  const trimmed = toHexColor(value.trim()) ?? value.trim()
  if (/^#[0-9a-f]{6}$/i.test(trimmed))
    return parseHex(trimmed)
  const match = trimmed.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** The images dnSpy's tree knows by name. */
export const hasDsImage = (name: string | undefined): name is string => name !== undefined && Object.hasOwn(DS_IMAGES, name)

const imageUrls = new Map<string, string>()

/** The image as a data address for a background, ready for an <img>; cached per image, background and contrast. */
export const dsImageUrl = (name: string, background: Rgb, highContrast: boolean): string | undefined => {
  const svg = DS_IMAGES[name]
  if (svg === undefined)
    return undefined
  const key = `${name}|${background.join(',')}|${highContrast}`
  let url = imageUrls.get(key)
  if (url === undefined) {
    const themed = svg.replace(/fill="(#[0-9a-f]{6})"/gi, (_, hex: string) => `fill="${toHex(themedColor(parseHex(hex), background, highContrast))}"`)
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themed)}`
    imageUrls.set(key, url)
  }
  return url
}

/** What the images are drawn over: the surface the tree, the search results and the analyzer share. */
interface ImageBackground {
  color: Rgb
  highContrast: boolean
}

const WHITE: ImageBackground = { color: [255, 255, 255], highContrast: false }

const readBackground = (): ImageBackground => {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined')
    return WHITE
  const root = document.documentElement
  const color = parseCssColor(getComputedStyle(root).getPropertyValue('--surface')) ?? WHITE.color
  return { color, highContrast: root.dataset.themeKind === 'hc' }
}

/** The CSS class an image is drawn with. */
export const dsImageClass = (name: string): string => `dsi-${name}`

/**
 * The images are drawn by a stylesheet of their own — one rule per image in use, the image as its background —
 * which a theme switch rewrites in place. A row only names its image's class, so nothing on screen has to render
 * again when the theme changes: the browser repaints the rows with the new rules, and the windows that show
 * images are left alone in the middle of switching their own colours over.
 */
const usedImages = new Set<string>()
let sheet: HTMLStyleElement | undefined
let sheetBackground: ImageBackground | undefined

const imageRule = (name: string, background: ImageBackground): string =>
  `.${dsImageClass(name)}{background-image:url("${dsImageUrl(name, background.color, background.highContrast)}")}`

const rewriteSheet = (): void => {
  if (!sheet)
    return
  const background = readBackground()
  if (sheetBackground && background.color.join() === sheetBackground.color.join() && background.highContrast === sheetBackground.highContrast)
    return
  sheetBackground = background
  sheet.textContent = [...usedImages].map((name) => imageRule(name, background)).join('\n')
}

/** Puts an image's rule in the stylesheet, which is made — and the theme watched — the first time one is. */
export const ensureDsImage = (name: string): void => {
  if (usedImages.has(name) || !hasDsImage(name) || typeof document === 'undefined')
    return
  usedImages.add(name)
  if (!sheet) {
    sheet = document.createElement('style')
    sheet.dataset.dsImages = ''
    document.head.append(sheet)
    // The shell switches the theme by writing it on the root element, which is all there is to watch. The
    // rules are rewritten a task later rather than in the observer's own microtask: the code view's editor
    // switches its theme in the same breath, and work done before it has settled — restyling the page, or
    // rendering — leaves Monaco re-tokenizing the open document with no colours at all.
    if (typeof MutationObserver !== 'undefined')
      new MutationObserver(() => { setTimeout(rewriteSheet, 0) }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    sheetBackground = readBackground()
  }
  sheet.append(document.createTextNode(`${imageRule(name, sheetBackground!)}\n`))
}

/** The class an image is drawn with once its rule is in the stylesheet, or undefined for a name dnSpy has no
 *  image for. The rule goes in before the row is painted. */
export const useDsImageClass = (name: string | undefined): string | undefined => {
  const known = hasDsImage(name)
  useInsertionEffect(() => {
    if (known)
      ensureDsImage(name)
  }, [known, name])
  return known ? dsImageClass(name) : undefined
}
