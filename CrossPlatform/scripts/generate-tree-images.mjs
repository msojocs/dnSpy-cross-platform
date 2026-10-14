// Turns dnSpy's own tree images — the XAML drawings of dnSpy/dnSpy.Images, from the Visual Studio Image
// Library — into the SVG the Assembly Explorer draws, so every row wears the very image its WPF counterpart
// does: "ClassPublic", "MethodPrivate", "EnumerationItemProtected" and the rest of the DsImages set, the access
// they show included. The images are drawn on a 16×16 canvas out of filled geometries only; a drawing is a
// nest of groups, each of which may be faded, and every geometry is filled with a brush of the file's own.
//
// The output is checked in, so a build does not need the dnSpy.Images submodule; run this again when the
// images change: node scripts/generate-tree-images.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const imagesDirectory = resolve(scriptDirectory, '../../dnSpy/dnSpy.Images/Images')
const outputPath = resolve(scriptDirectory, '../frontend/src/renderer/src/ds-images.generated.ts')

/** A small reader for the XAML these files are written in: elements, attributes and text, nothing else. */
const parseXml = (source) => {
  let position = 0
  const skipMisc = () => {
    for (;;) {
      while (position < source.length && /\s/.test(source[position])) position++
      if (source.startsWith('<?', position)) position = source.indexOf('?>', position) + 2
      else if (source.startsWith('<!--', position)) position = source.indexOf('-->', position) + 3
      else return
    }
  }
  const readElement = () => {
    skipMisc()
    if (source[position] !== '<') throw new Error(`Expected an element at ${position}`)
    const tagEnd = source.indexOf('>', position)
    const header = source.slice(position + 1, tagEnd)
    position = tagEnd + 1
    const selfClosing = header.endsWith('/')
    const body = selfClosing ? header.slice(0, -1) : header
    const name = body.match(/^\s*([^\s/>]+)/)[1]
    const attributes = {}
    for (const match of body.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attributes[match[1]] = match[2]
    const element = { name, attributes, children: [], text: '' }
    if (selfClosing) return element
    for (;;) {
      const next = source.indexOf('<', position)
      element.text += source.slice(position, next)
      position = next
      if (source.startsWith('<!--', position)) {
        position = source.indexOf('-->', position) + 3
        continue
      }
      if (source.startsWith('</', position)) {
        position = source.indexOf('>', position) + 1
        element.text = element.text.trim()
        return element
      }
      element.children.push(readElement())
    }
  }
  return readElement()
}

const walk = (element, visit) => {
  visit(element)
  for (const child of element.children) walk(child, visit)
}

const resourceKey = (value) => value?.match(/^\{(?:Dynamic|Static)Resource\s+([^}\s]+)\s*\}$/)?.[1]

const number = (value) => Number.parseFloat(value).toString()

/** One image: its brushes and numbers by key, and its drawing groups turned into SVG groups. */
const convert = (source) => {
  const root = parseXml(source)
  const brushes = new Map()
  const doubles = new Map()
  walk(root, (element) => {
    const key = element.attributes['x:Key']
    if (key === undefined) return
    if (element.name === 'SolidColorBrush')
      brushes.set(key, { color: element.attributes.Color, opacity: element.attributes.Opacity === undefined ? 1 : Number(element.attributes.Opacity) })
    else if (element.name === 'System:Double')
      doubles.set(key, Number(element.text))
  })
  const opacityOf = (value) => {
    if (value === undefined) return 1
    const key = resourceKey(value)
    return key === undefined ? Number(value) : doubles.get(key) ?? 1
  }
  const draw = (element) => {
    if (element.name === 'GeometryDrawing') {
      const key = resourceKey(element.attributes.Brush)
      const brush = key === undefined ? { color: element.attributes.Brush, opacity: 1 } : brushes.get(key)
      // The transparent "canvas" every image starts with is no part of the picture.
      if (!brush?.color || brush.opacity === 0) return ''
      let geometry = element.attributes.Geometry.trim()
      // WPF's path markup fills even-odd unless it opens with F1; F0 says even-odd outright.
      let fillRule = 'evenodd'
      const prefix = geometry.match(/^F([01])\s*/)
      if (prefix) {
        fillRule = prefix[1] === '1' ? 'nonzero' : 'evenodd'
        geometry = geometry.slice(prefix[0].length)
      }
      const opacity = brush.opacity === 1 ? '' : ` fill-opacity="${number(brush.opacity)}"`
      return `<path fill="${brush.color.toLowerCase()}"${opacity} fill-rule="${fillRule}" d="${geometry.replace(/\s+/g, ' ')}"/>`
    }
    if (element.name === 'DrawingGroup') {
      const content = element.children.map(draw).join('')
      if (!content) return ''
      const opacity = opacityOf(element.attributes.Opacity)
      return opacity === 1 ? content : `<g opacity="${number(opacity)}">${content}</g>`
    }
    return element.children.map(draw).join('')
  }
  const drawing = []
  walk(root, (element) => {
    if (element.name === 'DrawingBrush.Drawing') drawing.push(...element.children)
  })
  if (drawing.length === 0) throw new Error('No drawing in the image.')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${drawing.map(draw).join('')}</svg>`
}

const images = {}
for (const file of readdirSync(imagesDirectory).filter((name) => name.endsWith('.xaml')).sort()) {
  const name = basename(file, '.xaml')
  try {
    images[name] = convert(readFileSync(resolve(imagesDirectory, file), 'utf8'))
  } catch (error) {
    throw new Error(`${file}: ${error.message}`)
  }
}

const lines = [
  '// Generated by scripts/generate-tree-images.mjs from dnSpy/dnSpy.Images (Visual Studio Image Library). Do not edit.',
  '/* eslint-disable */',
  '',
  '/** dnSpy\'s image set by name, each a 16×16 SVG in the colours of the light theme. */',
  'export const DS_IMAGES: Readonly<Record<string, string>> = {',
  ...Object.entries(images).map(([name, svg]) => `  ${JSON.stringify(name)}: ${JSON.stringify(svg)},`),
  '}',
  '',
]
writeFileSync(outputPath, lines.join('\n'))
console.log(`Wrote ${Object.keys(images).length} images to ${outputPath}`)
