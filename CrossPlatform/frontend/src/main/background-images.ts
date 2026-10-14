import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** What the Background Image window's settings point at: image files, and folders holding them. */
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff'])

/** dnSpy loads whatever it is pointed at into memory and keeps it there; the port hands each one over as a
 *  data URL, so there is a limit to how much of that is worth doing at once. */
const maxImages = 500
const maxImageBytes = 32 * 1024 * 1024

const contentTypeFor = (file: string): string => {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    case '.webp': return 'image/webp'
    case '.ico': return 'image/x-icon'
    default: return 'image/tiff'
  }
}

/**
 * The files the Background Image window's paths name, in the order they were listed: a file is taken as it
 * is, and a folder is read for the images directly inside it — which is what dnSpy's ImageSourceService does
 * with the folders in its own list. A path that is neither, or that cannot be read, is passed over.
 */
export const backgroundImageFiles = (paths: readonly string[]): string[] => {
  const files: string[] = []
  for (const entry of paths) {
    try {
      const stats = statSync(entry)
      if (stats.isFile()) {
        if (imageExtensions.has(path.extname(entry).toLowerCase()))
          files.push(entry)
        continue
      }
      if (!stats.isDirectory())
        continue
      for (const name of readdirSync(entry).sort()) {
        const candidate = path.join(entry, name)
        if (imageExtensions.has(path.extname(candidate).toLowerCase()) && statSync(candidate).isFile())
          files.push(candidate)
      }
    } catch {
      // A path that is gone, unreadable or a broken link names no image; the rest of the list still loads.
    }
    if (files.length >= maxImages)
      break
  }
  return files.slice(0, maxImages)
}

/** One image, read as the data URL the renderer's `<img>` can put up without reaching for the disk itself. */
export interface BackgroundImageData {
  name: string
  dataUrl: string
}

export const readBackgroundImages = (paths: readonly string[]): BackgroundImageData[] => {
  const images: BackgroundImageData[] = []
  for (const file of backgroundImageFiles(paths)) {
    try {
      if (statSync(file).size > maxImageBytes)
        continue
      const bytes = readFileSync(file)
      images.push({ name: path.basename(file), dataUrl: `data:${contentTypeFor(file)};base64,${bytes.toString('base64')}` })
    } catch {
      // Same as above: an image that cannot be read is one the window does without.
    }
  }
  return images
}
