// Turns dnSpy's theme machinery into data the port's theme service reads: the colour tree of
// dnSpy/dnSpy/Themes/ColorInfos.cs — every ColorType, the colour it inherits from, its defaults and the WPF
// resource keys it fills — and the four .dntheme files dnSpy ships. A theme file only lists the colours it
// changes; the rest come from the tree, by inheritance or by default, exactly as dnSpy's Theme class reads it.
//
// The output is checked in, so a build does not need the WPF sources; run this again when the colour tree or
// the shipped themes change: node scripts/generate-themes.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const themesDirectory = resolve(scriptDirectory, '../../dnSpy/dnSpy/Themes')
const outputPath = resolve(scriptDirectory, '../frontend/src/renderer/src/themes.generated.ts')

/** The C# of ColorInfos.cs as tokens: identifiers, string literals, numbers and single punctuation characters. */
const tokenize = (source) => {
  const tokens = []
  let position = 0
  while (position < source.length) {
    const rest = source.slice(position)
    let match
    if ((match = /^\s+/.exec(rest)) || (match = /^\/\/[^\n]*/.exec(rest)) || (match = /^\/\*[\s\S]*?\*\//.exec(rest))) {
      position += match[0].length
      continue
    }
    if ((match = /^"((?:[^"\\]|\\.)*)"/.exec(rest)))
      tokens.push({ kind: 'string', value: JSON.parse(`"${match[1]}"`) })
    else if ((match = /^-?\d+(?:\.\d+)?/.exec(rest)))
      tokens.push({ kind: 'number', value: Number(match[0]) })
    else if ((match = /^[A-Za-z_][\w.]*/.exec(rest)))
      tokens.push({ kind: 'name', value: match[0] })
    else {
      match = [rest[0]]
      tokens.push({ kind: 'punct', value: rest[0] })
    }
    position += match[0].length
  }
  return tokens
}

const source = readFileSync(resolve(themesDirectory, 'ColorInfos.cs'), 'utf8')
const tokens = tokenize(source.slice(source.indexOf('RootColorInfos')))
let index = 0
const peek = () => tokens[index]
const next = () => tokens[index++]
const expect = (value) => {
  const token = next()
  if (token.value !== value) throw new Error(`Expected '${value}' but found '${token.value}' at token ${index - 1}`)
  return token
}

const infos = []

const parsePoint = () => {
  expect('new'); expect('Point'); expect('(')
  const x = next().value
  expect(',')
  const y = next().value
  expect(')')
  return [x, y]
}

/** One `new XxxColorInfo(ColorType.Name, ...) { ... }`, its children included; returns its index. */
const parseInfo = (parent) => {
  expect('new')
  const className = next().value
  expect('(')
  const name = next().value.replace(/^ColorType\./, '')
  const info = { name, kind: className.replace(/ColorInfo$/, '').toLowerCase() }
  if (parent !== undefined) info.parent = parent
  const id = infos.push(info) - 1
  if (className === 'LinearGradientColorInfo') {
    expect(',')
    const first = parsePoint()
    let start = [0, 0]
    let end = first
    if (peek().value === ',' && tokens[index + 1].value === 'new') {
      next()
      start = first
      end = parsePoint()
    }
    expect(',')
    next() // the description
    const offsets = []
    while (peek().value === ',') {
      next()
      offsets.push(next().value)
    }
    info.gradient = { start, end, offsets }
  } else {
    expect(',')
    next() // the description
  }
  expect(')')
  if (peek().value === '{') {
    next()
    while (peek().value !== '}') {
      const property = next().value
      expect('=')
      if (property === 'Children') {
        expect('new'); expect('ColorInfo'); expect('['); expect(']')
        parseList(id)
      } else {
        const value = next().value
        switch (property) {
          case 'DefaultForeground': info.fg = value; break
          case 'DefaultBackground': info.bg = value; break
          case 'DefaultColor3': info.c3 = value; break
          case 'DefaultColor4': info.c4 = value; break
          case 'ForegroundResourceKey': info.fgKey = value; break
          case 'BackgroundResourceKey': info.bgKey = value; break
          case 'ResourceKey': info.key = value; break
          case 'IsHorizontal': info.horizontal = value === 'true'; break
          default: throw new Error(`Unknown property ${property} of ${name}`)
        }
      }
      if (peek().value === ',') next()
    }
    expect('}')
  }
  return id
}

const parseList = (parent) => {
  expect('{')
  while (peek().value !== '}') {
    parseInfo(parent)
    if (peek().value === ',') next()
  }
  expect('}')
}

expect('RootColorInfos'); expect('='); expect('new'); expect('ColorInfo'); expect('['); expect(']')
parseList(undefined)

const names = new Set()
for (const info of infos) {
  if (names.has(info.name.toLowerCase())) throw new Error(`Duplicate colour ${info.name}`)
  names.add(info.name.toLowerCase())
}

const themeFiles = ['blue.dntheme', 'dark.dntheme', 'hc.dntheme', 'light.dntheme']
const themes = Object.fromEntries(themeFiles.map((file) => [file, readFileSync(resolve(themesDirectory, file), 'utf8').replace(/\r\n/g, '\n')]))

const lines = [
  '// Generated by scripts/generate-themes.mjs from dnSpy/dnSpy/Themes (ColorInfos.cs and the shipped .dntheme files). Do not edit.',
  '/* eslint-disable */',
  '',
  '/** One of dnSpy\'s colours (a ColorInfo): what kind of WPF brush it makes, the colour it inherits from, its',
  ' *  defaults, and the resource keys dnSpy\'s templates read it through. */',
  'export interface ColorInfoData {',
  '  name: string',
  '  kind: \'brush\' | \'color\' | \'drawingbrush\' | \'lineargradient\'',
  '  parent?: number',
  '  fg?: string',
  '  bg?: string',
  '  c3?: string',
  '  c4?: string',
  '  fgKey?: string',
  '  bgKey?: string',
  '  key?: string',
  '  horizontal?: boolean',
  '  gradient?: { start: [number, number]; end: [number, number]; offsets: number[] }',
  '}',
  '',
  '/** ColorInfos.RootColorInfos, flattened in the order dnSpy lists them; `parent` is an index into this list. */',
  'export const COLOR_INFOS: readonly ColorInfoData[] = [',
  ...infos.map((info) => `  ${JSON.stringify(info)},`),
  ']',
  '',
  '/** The themes dnSpy ships in its Themes directory, by file name. */',
  'export const BUILT_IN_THEMES: Readonly<Record<string, string>> = {',
  ...Object.entries(themes).map(([file, text]) => `  ${JSON.stringify(file)}: ${JSON.stringify(text)},`),
  '}',
  '',
]
writeFileSync(outputPath, lines.join('\n'))
console.log(`Wrote ${infos.length} colours and ${themeFiles.length} themes to ${outputPath}`)
