// Gives the port every user interface language dnSpy ships, out of dnSpy's own translations: the
// *.Resources.<culture>.resx files beside each *.Resources.resx under dnSpy/ and Extensions/. The port writes
// its strings in English and translates them by that text, so a port string is found in the resx files by its
// English value, and the translation dnSpy gives that resource is the port's for the language.
//
// The English strings are the keys of the hand-kept Simplified Chinese table, locales/zh-CN.ts, which quotes
// dnSpy's zh-CN resx: when several resources share an English text, the one whose Chinese is the table's is
// the one taken, so a string means in every language what it means in Chinese. Simplified Chinese itself is
// not written here — the table is its own.
//
// Strings are compared the way they read on screen: dnSpy's menu mnemonics are dropped (`_File` is "File",
// `__` is an underscore, and the Chinese `文件(_F)` drops the parenthesised letter), and a format item `{0}`
// stands for whichever of the port's named placeholders sits in its place, so "Opened {0} module(s)." is the
// port's "Opened {count} module(s)." and the translation's `{0}` becomes `{count}`. A resource a culture's resx
// leaves untranslated — missing, empty, or a copy of the English — is left out, and the port shows English for
// it, the way .NET falls back to the neutral resource.
//
// The main process's native dialog strings, main/native-messages.ts, are looked up the same way into
// main/native-messages.generated.ts.
//
// The output is checked in, so a build does not need the WPF tree; run this again when a string is added to
// locales/zh-CN.ts or main/native-messages.ts, or the resx files change: node scripts/generate-locales.mjs
// (--verbose lists the strings no resource was found for; --check only reports whether the output is current,
// which is what locales.test.ts runs)
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '../..')
const localesDirectory = resolve(scriptDirectory, '../frontend/src/renderer/src/locales')
const outputPath = resolve(scriptDirectory, '../frontend/src/renderer/src/locales.generated.ts')
const nativeMessagesPath = resolve(scriptDirectory, '../frontend/src/main/native-messages.ts')
const nativeOutputPath = resolve(scriptDirectory, '../frontend/src/main/native-messages.generated.ts')
const verbose = process.argv.includes('--verbose')
// --check writes nothing and fails when a generated file is not what this would write.
const check = process.argv.includes('--check')
const stale = []

// The cultures written out. Simplified Chinese is kept by hand and English is the keys themselves.
const cultures = ['cs', 'de', 'es-ES', 'fa', 'fr', 'hu', 'it', 'pt-BR', 'pt-PT', 'ru', 'tr', 'uk', 'vi']

/** Every file under the directory whose name passes the test, passing over build output. */
const findFiles = (directory, test, found = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'bin' && entry.name !== 'obj' && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
        findFiles(join(directory, entry.name), test, found)
    }
    else if (test(entry.name)) {
      found.push(join(directory, entry.name))
    }
  }
  return found
}

const decodeXml = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  if (entity[0] === '#')
    return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10))
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()]
})

/** A resx file's string resources by name. Resources of another type — images, file references — are not strings. */
const readResx = (path) => {
  const source = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '')
  const resources = new Map()
  for (const match of source.matchAll(/<data\s+([^>]*?)(\/>|>([\s\S]*?)<\/data>)/g)) {
    const attributes = match[1]
    if (/\b(type|mimetype)\s*=/.test(attributes))
      continue
    const name = attributes.match(/\bname\s*=\s*"([^"]*)"/)?.[1]
    const value = match[3]?.match(/<value>([\s\S]*?)<\/value>|<value\s*\/>/)
    if (name === undefined || !value)
      continue
    resources.set(decodeXml(name), decodeXml(value[1] ?? '').replace(/\r\n?/g, '\n'))
  }
  return resources
}

/** What a menu header reads once WPF has turned its mnemonic into an underline. */
const stripMnemonics = (text) => text.replace(/\s*\(_[^)]\)/g, '').replace(/__|_(?=.)/gs, (marker) => (marker === '__' ? '_' : ''))

// `{0}`, `{1,8}`, `{0:X8}`: a .NET format item; `{{` and `}}` are a literal brace.
const formatItem = /\{\{|\}\}|\{(\d+)(?:,\s*-?\d+)?(?::[^{}]*)?\}/g

/** A resource's text with each format item replaced by a marker, and the item numbers in the order they appear. */
const splitFormat = (text) => {
  const items = []
  const shape = text.replace(formatItem, (whole, index) => {
    if (index === undefined)
      return whole[0]
    items.push(Number(index))
    return '\u0000'
  })
  return { shape, items }
}

/** A port string with each named placeholder replaced by a marker, and the names in the order they appear. */
const splitPlaceholders = (text) => {
  const names = []
  const shape = text.replace(/\{(\w+)\}/g, (_, name) => {
    names.push(name)
    return '\u0000'
  })
  return { shape, names }
}

/** Which of the port's names each format item stands for, or undefined when the two do not line up one to one. */
const mapItems = (items, names) => {
  if (items.length !== names.length)
    return undefined
  const byItem = new Map()
  const byName = new Map()
  for (let position = 0; position < items.length; position++) {
    const item = items[position]
    const name = names[position]
    if ((byItem.has(item) && byItem.get(item) !== name) || (byName.has(name) && byName.get(name) !== item))
      return undefined
    byItem.set(item, name)
    byName.set(name, item)
  }
  return byItem
}

/**
 * A translation in the port's form: the mnemonics dropped, the format items named. A translator may give a
 * mnemonic where the English has none, so they are dropped from every translation — unless the English matched
 * as written with an underscore in it, which then is a real one.
 */
const toPortText = (translation, english, stripped, byItem) => {
  const text = stripped || !english.includes('_') ? stripMnemonics(translation) : translation
  // A translation that names a format item the English does not have, leaves one out, or garbles one (the
  // Turkish "{0 n0}") would print wrong or throw in dnSpy's String.Format; it is passed over for the English.
  let unmapped = false
  const used = new Set()
  const result = text.trim().replace(formatItem, (whole, index) => {
    if (index === undefined)
      return whole[0]
    const name = byItem.get(Number(index))
    if (name === undefined)
      unmapped = true
    used.add(Number(index))
    return `{${name}}`
  })
  const stray = /[{}]/.test(text.replace(formatItem, ''))
  return unmapped || stray || used.size !== byItem.size ? undefined : result
}

// The Chinese a resource and the table give, compared once the mnemonic letters and the placeholders' names are out.
const normalizeChinese = (text) => stripMnemonics(text).replace(/\s*\([A-Z0-9]\)/g, '').replace(/\{[^{}]*\}/g, '{}').trim()

/**
 * The object literal a TypeScript file assigns to `const <name>`. The tables are written in plain literal
 * syntax — strings, comments, nothing computed — so the literal is cut out by its braces and evaluated.
 */
const readObjectLiteral = (path, name) => {
  const source = readFileSync(path, 'utf8')
  const declaration = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\{`).exec(source)
  if (!declaration)
    throw new Error(`${relative(repositoryRoot, path)} declares no ${name} table`)
  const start = declaration.index + declaration[0].length - 1
  let depth = 0
  for (let position = start; position < source.length; position++) {
    const character = source[position]
    if (character === '/' && source[position + 1] === '/')
      position = source.indexOf('\n', position)
    else if (character === '/' && source[position + 1] === '*')
      position = source.indexOf('*/', position) + 1
    else if (character === "'" || character === '"' || character === '`') {
      for (position++; source[position] !== character; position++)
        if (source[position] === '\\')
          position++
    }
    else if (character === '{')
      depth++
    else if (character === '}' && --depth === 0)
      return runInNewContext(`(${source.slice(start, position + 1)})`)
  }
  throw new Error(`The ${name} table in ${relative(repositoryRoot, path)} is not closed`)
}

// Every English resource with its translations: for each neutral resx, the siblings named after a culture.
const resources = []
const neutralFiles = findFiles(join(repositoryRoot, 'dnSpy'), (name) => name.endsWith('.Resources.resx'))
  .concat(findFiles(join(repositoryRoot, 'Extensions'), (name) => name.endsWith('.Resources.resx')))
  .sort((left, right) => left.localeCompare(right))
for (const neutralFile of neutralFiles) {
  const english = readResx(neutralFile)
  const localized = new Map()
  for (const culture of [...cultures, 'zh-CN']) {
    try {
      localized.set(culture, readResx(neutralFile.replace(/\.resx$/, `.${culture}.resx`)))
    }
    catch {
      localized.set(culture, new Map())
    }
  }
  for (const [name, value] of english) {
    const translations = {}
    for (const [culture, table] of localized)
      translations[culture] = table.get(name)
    resources.push({ file: relative(repositoryRoot, neutralFile), name, value, translations })
  }
}

// The resources by how their English reads: once as written, for strings that are no menu header and may
// hold a real underscore, and once with the mnemonics dropped.
// The second map reads them regardless of case, for the strings the port capitalises its own way ("Entry
// point" for dnSpy's "Entry Point", "ready" for "Ready"); a resource is only found that way when its Chinese
// is the table's, so the table vouches that the two are the same string.
const byShape = new Map()
const byLowerShape = new Map()
const index = (map, key, entry) => {
  const list = map.get(key)
  if (list)
    list.push(entry)
  else
    map.set(key, [entry])
}
for (const resource of resources) {
  const raw = splitFormat(resource.value.trim())
  const plain = splitFormat(stripMnemonics(resource.value).trim())
  for (const [form, stripped] of plain.shape === raw.shape ? [[raw, false]] : [[raw, false], [plain, true]]) {
    index(byShape, form.shape, { resource, stripped, items: form.items })
    index(byLowerShape, form.shape.toLowerCase(), { resource, stripped, items: form.items })
  }
}

/**
 * dnSpy's translations of a list of strings, each a key, its English and the Chinese the port gives it: per
 * culture, the keys there is a translation for. The strings no resource was found for are listed as well.
 */
const translateStrings = (strings) => {
  const tables = Object.fromEntries(cultures.map((culture) => [culture, {}]))
  const unmatched = []
  let caseMatched = 0
  for (const { key, english, chinese } of strings) {
    const { shape, names } = splitPlaceholders(english.trim())
    const wanted = normalizeChinese(chinese)
    const quotesChinese = (entry) => {
      const theirs = entry.resource.translations['zh-CN']
      return theirs !== undefined && normalizeChinese(theirs) === wanted
    }
    const withItems = (entries) => (entries ?? [])
      .map((entry) => ({ ...entry, byItem: mapItems(entry.items, names) }))
      .filter((entry) => entry.byItem !== undefined)
    let candidates = withItems(byShape.get(shape))
    if (candidates.length === 0) {
      candidates = withItems(byLowerShape.get(shape.toLowerCase())).filter(quotesChinese)
      if (candidates.length > 0)
        caseMatched++
    }
    if (candidates.length === 0) {
      unmatched.push(english)
      continue
    }
    // The resource the Chinese table quotes first; between equals, one matched as written before one whose
    // mnemonics had to be dropped, then the resx files in path order. A culture takes the first of them its
    // resx translates.
    candidates.sort((left, right) => Number(quotesChinese(right)) - Number(quotesChinese(left)) || Number(left.stripped) - Number(right.stripped))
    for (const culture of cultures) {
      for (const candidate of candidates) {
        const translation = candidate.resource.translations[culture]
        if (translation === undefined || !translation.trim() || translation.trim() === candidate.resource.value.trim())
          continue
        const text = toPortText(translation, candidate.resource.value, candidate.stripped, candidate.byItem)
        if (text === undefined || text === english)
          continue
        tables[culture][key] = text
        break
      }
    }
  }
  return { tables, unmatched, caseMatched, total: strings.length }
}

const writeTables = (path, header, declaration, tables) => {
  const lines = [...header, declaration]
  for (const culture of cultures) {
    lines.push(`  ${JSON.stringify(culture)}: {`)
    for (const [key, value] of Object.entries(tables[culture]))
      lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    lines.push('  },')
  }
  lines.push('}', '')
  const text = lines.join('\n')
  if (!check)
    writeFileSync(path, text)
  else if (!existsSync(path) || readFileSync(path, 'utf8') !== text)
    stale.push(relative(repositoryRoot, path))
}

const report = (title, result, path) => {
  console.log(`${title}: ${result.total} strings, ${result.total - result.unmatched.length} found in the resx files (${result.caseMatched} of them regardless of case).`)
  for (const culture of cultures)
    console.log(`  ${culture.padEnd(6)} ${String(Object.keys(result.tables[culture]).length).padStart(5)} translated`)
  if (verbose)
    for (const english of result.unmatched)
      console.log(`  no resource: ${JSON.stringify(english)}`)
  if (!check)
    console.log(`Wrote ${relative(repositoryRoot, path)}`)
}

console.log(`Read ${resources.length} resources from ${neutralFiles.length} resx files.`)

// The renderer's strings: the Chinese table's keys are the English.
const portTable = readObjectLiteral(join(localesDirectory, 'zh-CN.ts'), 'zhCN')
const portStrings = translateStrings(Object.entries(portTable).map(([english, chinese]) => ({ key: english, english, chinese })))
writeTables(outputPath, [
  '// Generated by scripts/generate-locales.mjs from dnSpy\'s *.Resources.<culture>.resx files. Do not edit.',
  '/* eslint-disable */',
  "import type { UiLocale } from '../../shared/protocol'",
  '',
  '/** dnSpy\'s translations of the port\'s English strings, by language. A string a language has no translation for is absent. */',
], 'export const generatedLocales: Readonly<Record<Exclude<UiLocale, \'en\' | \'zh-CN\'>, Readonly<Record<string, string>>>> = {', portStrings.tables)
report('The user interface', portStrings, outputPath)

// The main process's native dialogs: two tables by message name, one English and one Chinese.
const nativeEnglish = readObjectLiteral(nativeMessagesPath, 'en')
const nativeChinese = readObjectLiteral(nativeMessagesPath, 'zhCN')
const nativeStrings = translateStrings(Object.entries(nativeEnglish).map(([key, english]) => ({ key, english, chinese: nativeChinese[key] ?? '' })))
writeTables(nativeOutputPath, [
  '// Generated by scripts/generate-locales.mjs from dnSpy\'s *.Resources.<culture>.resx files. Do not edit.',
  '/* eslint-disable */',
  "import type { UiLocale } from '../shared/protocol'",
  "import type { NativeMessages } from './native-messages'",
  '',
  '/** dnSpy\'s translations of the native dialogs\' strings, by language. A string a language has no translation for is absent. */',
], 'export const generatedNativeMessages: Readonly<Record<Exclude<UiLocale, \'en\' | \'zh-CN\'>, Partial<NativeMessages>>> = {', nativeStrings.tables)
report('The native dialogs', nativeStrings, nativeOutputPath)

if (stale.length > 0) {
  console.error(`Out of date — run node scripts/generate-locales.mjs: ${stale.join(', ')}`)
  process.exitCode = 1
}
