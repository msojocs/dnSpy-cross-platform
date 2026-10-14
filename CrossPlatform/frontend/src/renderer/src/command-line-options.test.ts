import { describe, expect, it } from 'vitest'
import { parseToolWindowInfos, parseToolWindowLocation, resolveDecompilerLanguage, resolveSearchLocation, resolveSearchType, resolveThemeName, toolWindowIdForGuid } from './command-line-options'

describe('resolveThemeName', () => {
  it('reads a theme by the name dnSpy gives it in its .dntheme file', () => {
    expect(resolveThemeName('dark')).toBe('dark')
    expect(resolveThemeName('  hc  ')).toBe('hc')
  })

  it('takes the name exactly as dnSpy does, which is case-sensitively', () => {
    expect(resolveThemeName('Blue')).toBeUndefined()
  })

  it('reads a theme by GUID, with or without the braces, either case', () => {
    expect(resolveThemeName('64EFBB2C-0ACA-467C-8389-9FA350376F3F')).toBe('dark')
    expect(resolveThemeName('{61aa341e-281d-4154-985f-c81e9269034b}')).toBe('blue')
    expect(resolveThemeName('B3D71E74-C353-4206-9AD1-05847BE95CBE')).toBe('light')
    expect(resolveThemeName('D0EA082A-BF0D-439F-B396-547C29D97E37')).toBe('hc')
  })

  it('has no theme for a name it does not know, or for nothing at all', () => {
    expect(resolveThemeName('purple')).toBeUndefined()
    expect(resolveThemeName(undefined)).toBeUndefined()
    expect(resolveThemeName('')).toBeUndefined()
  })
})

describe('parseToolWindowLocation', () => {
  it('reads every spelling dnSpy accepts', () => {
    expect(parseToolWindowLocation('l')).toBe('left')
    expect(parseToolWindowLocation('left')).toBe('left')
    expect(parseToolWindowLocation(' r ')).toBe('right')
    expect(parseToolWindowLocation('bottom')).toBe('bottom')
    expect(parseToolWindowLocation('d')).toBe('default-horizontal')
    expect(parseToolWindowLocation('default-vertical')).toBe('default-vertical')
  })

  it('has no location for anything else', () => {
    expect(parseToolWindowLocation('middle')).toBeUndefined()
  })
})

describe('parseToolWindowInfos', () => {
  it('reads a list of GUIDs, each with a location or without one', () => {
    expect(parseToolWindowInfos('8E359BE0-C8CD-4CA7-B228-8C836219AF85!left,90A45E97-727E-4F31-8692-06E19218D99A'))
      .toEqual([
        { guid: '8e359be0-c8cd-4ca7-b228-8c836219af85', location: 'left' },
        { guid: '90a45e97-727e-4f31-8692-06e19218d99a' },
      ])
  })

  it('passes over an entry that names no window, and keeps the rest', () => {
    expect(parseToolWindowInfos('not-a-guid,90A45E97-727E-4F31-8692-06E19218D99A!b')).toEqual([
      { guid: '90a45e97-727e-4f31-8692-06e19218d99a', location: 'bottom' },
    ])
  })

  it('keeps a window whose location it does not know, with no location of its own', () => {
    // dnSpy fails an assert there but still shows the window; nothing is dropped over an unknown location.
    expect(parseToolWindowInfos('90A45E97-727E-4F31-8692-06E19218D99A!middle'))
      .toEqual([{ guid: '90a45e97-727e-4f31-8692-06e19218d99a' }])
  })

  it('is empty for no argument at all', () => {
    expect(parseToolWindowInfos(undefined)).toEqual([])
    expect(parseToolWindowInfos('')).toEqual([])
  })
})

describe('toolWindowIdForGuid', () => {
  it('names the windows this port has, whichever case the GUID came in', () => {
    expect(toolWindowIdForGuid('5495EE9F-1EF2-45F3-A320-22A89BFDF731')).toBe('explorer')
    expect(toolWindowIdForGuid('90a45e97-727e-4f31-8692-06e19218d99a')).toBe('output')
    expect(toolWindowIdForGuid('8e359be0-c8cd-4ca7-b228-8c836219af85')).toBe('search')
    expect(toolWindowIdForGuid('0e53b79d-ec30-44b6-86a3-dffce364eb4a')).toBe('callstack')
  })

  it('has no id for a window this port does not have', () => {
    expect(toolWindowIdForGuid('c0d88168-7750-4b15-ae72-215bfe214da5')).toBeUndefined()
  })
})

describe('resolveDecompilerLanguage', () => {
  it('reads a decompiler by the name dnSpy shows for it', () => {
    expect(resolveDecompilerLanguage('C#')).toBe('cSharp')
    expect(resolveDecompilerLanguage('c#')).toBe('cSharp')
    expect(resolveDecompilerLanguage('IL')).toBe('il')
    expect(resolveDecompilerLanguage('Visual Basic')).toBe('visualBasic')
    expect(resolveDecompilerLanguage('IL with C#')).toBe('ilWithCSharp')
  })

  it('reads one by GUID as well', () => {
    expect(resolveDecompilerLanguage('F5A318D4-4B2A-48D2-AE33-F4D2B1EFF4B0')).toBe('cSharp')
    expect(resolveDecompilerLanguage('{B6849618-8239-4FBB-8DFF-D45EB023C193}')).toBe('visualBasic')
    expect(resolveDecompilerLanguage('9EF276FD-3293-42A4-B48A-1D6A69086B3D')).toBe('il')
  })

  it('has no language for a name it does not know', () => {
    expect(resolveDecompilerLanguage('F#')).toBeUndefined()
    expect(resolveDecompilerLanguage(undefined)).toBeUndefined()
  })
})

describe('resolveSearchLocation', () => {
  it('reads the names dnSpy\'s search window takes, long and short', () => {
    expect(resolveSearchLocation('all')).toBe('allFiles')
    expect(resolveSearchLocation('a')).toBe('allFiles')
    expect(resolveSearchLocation('selected-files')).toBe('selectedFiles')
    expect(resolveSearchLocation('same-folder')).toBe('allFilesInSameDir')
    expect(resolveSearchLocation('selected-type')).toBe('selectedType')
  })

  it('has no location for a name it does not know', () => {
    expect(resolveSearchLocation('everywhere')).toBeUndefined()
    expect(resolveSearchLocation(undefined)).toBeUndefined()
  })
})

describe('resolveSearchType', () => {
  it('reads the names dnSpy\'s search window takes, long and short', () => {
    expect(resolveSearchType('m')).toBe('method')
    expect(resolveSearchType('method')).toBe('method')
    expect(resolveSearchType('prop')).toBe('property')
    expect(resolveSearchType('param-local')).toBe('parameterLocal')
    expect(resolveSearchType('asm-ref')).toBe('assemblyRef')
    expect(resolveSearchType('non-generic')).toBe('nonGenericType')
    expect(resolveSearchType('const')).toBe('literal')
    expect(resolveSearchType('any')).toBe('any')
  })

  it('has no type for a name it does not know', () => {
    expect(resolveSearchType('lambda')).toBeUndefined()
    expect(resolveSearchType(undefined)).toBeUndefined()
  })
})
