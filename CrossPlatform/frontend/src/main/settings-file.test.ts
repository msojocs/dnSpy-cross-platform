import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PORTABLE_SETTINGS_FILE_NAME, SettingsFile, rendererEntries, resolveSettingsFile } from './settings-file'
import { parseFontconfigFamilies } from './system-fonts'
import { readThemeFiles, themeDirectories } from './theme-files'

describe('settings file', () => {
  it('takes the file --settings-file names, else a portable one beside the program, else none', () => {
    expect(resolveSettingsFile('/data/my.json', '/opt/dnspy', () => true)).toBe('/data/my.json')
    expect(resolveSettingsFile(undefined, '/opt/dnspy', (file) => file === path.join('/opt/dnspy', PORTABLE_SETTINGS_FILE_NAME))).toBe(path.join('/opt/dnspy', PORTABLE_SETTINGS_FILE_NAME))
    expect(resolveSettingsFile(undefined, '/opt/dnspy', () => false)).toBeUndefined()
  })

  it('keeps each part of the settings in a section of one document, written at once', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dnspy-settings-')), 'sub', 'settings.json')
    const settings = new SettingsFile(file)
    expect(settings.get('renderer')).toBeUndefined()
    settings.set('renderer', { 'dnspy.language': 'de' })
    settings.set('appSettings', { allowMoreThanOneInstance: false })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    expect(written).toEqual({ renderer: { 'dnspy.language': 'de' }, appSettings: { allowMoreThanOneInstance: false } })
    expect(new SettingsFile(file).get('renderer')).toEqual({ 'dnspy.language': 'de' })
  })

  it('starts empty from a file that is no settings document', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'dnspy-settings-')), 'settings.json')
    writeFileSync(file, '[1, 2]')
    expect(new SettingsFile(file).get('windowState')).toBeUndefined()
  })

  it('keeps only the renderer\'s own keys', () => {
    expect(rendererEntries({ 'dnspy.theme': 'dark', other: 'x', 'dnspy.count': 3 })).toEqual({ 'dnspy.theme': 'dark' })
  })
})

describe('theme files', () => {
  it('reads the Themes directory beside the program, then the user\'s, each once', () => {
    expect(themeDirectories('/opt/dnspy', '/home/u/.config/dnSpy')).toEqual([path.join('/opt/dnspy', 'Themes'), path.join('/home/u/.config/dnSpy', 'Themes')])
    expect(themeDirectories('/opt/dnspy', '/opt/dnspy')).toEqual([path.join('/opt/dnspy', 'Themes')])
  })

  it('lists the .dntheme files at the top of each directory and skips one that is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dnspy-themes-'))
    mkdirSync(path.join(root, 'Themes'))
    writeFileSync(path.join(root, 'Themes', 'b.dntheme'), '<theme/>')
    writeFileSync(path.join(root, 'Themes', 'a.DNTHEME'), '<theme a=""/>')
    writeFileSync(path.join(root, 'Themes', 'notes.txt'), 'x')
    const files = readThemeFiles([path.join(root, 'Themes'), path.join(root, 'missing')])
    expect(files.map((file) => path.basename(file.path))).toEqual(['a.DNTHEME', 'b.dntheme'])
    expect(files[1].text).toBe('<theme/>')
  })
})

describe('system fonts', () => {
  it('reads each family fontconfig lists by its first name, once', () => {
    expect(parseFontconfigFamilies('DejaVu Sans Mono,DejaVu Sans Mono Book\nNoto Sans CJK SC,Noto Sans CJK SC Regular\nDejaVu Sans Mono\n\n')).toEqual(['DejaVu Sans Mono', 'Noto Sans CJK SC'])
  })
})
