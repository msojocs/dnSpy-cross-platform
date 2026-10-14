import { describe, expect, it } from 'vitest'
import { resourceFileName, resourceFileSegments } from './resource-files'

describe('resource file names', () => {
  it('saves one resource under the part of its name after the last directory', () => {
    expect(resourceFileName('themes/generic.xaml')).toBe('generic.xaml')
    expect(resourceFileName('a\\b:c?.txt')).toBe('b_c_.txt')
    expect(resourceFileName('')).toBe('resource.bin')
  })

  it('keeps the directories of a name only for the "use sub dirs" variant', () => {
    expect(resourceFileSegments('themes/generic.xaml', false)).toEqual(['generic.xaml'])
    expect(resourceFileSegments('themes/generic.xaml', true)).toEqual(['themes', 'generic.xaml'])
    expect(resourceFileSegments('images\\icons/app.png', true)).toEqual(['images', 'icons', 'app.png'])
  })

  it('never lets a name climb out of the folder the user picked', () => {
    expect(resourceFileSegments('../../etc/passwd', true)).toEqual(['__', '__', 'etc', 'passwd'])
    expect(resourceFileSegments('/abs/./x', true)).toEqual(['abs', '_', 'x'])
  })
})
