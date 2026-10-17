import { execFile } from 'node:child_process'

/**
 * WPF's Fonts.SystemFontFamilies, for a renderer that cannot list the local fonts itself: fontconfig's list of
 * families where there is one (Linux, and macOS with it installed). Each line fontconfig writes may name a family
 * in several languages, comma separated; the first is the one it is known by.
 */
export const listSystemFonts = (): Promise<string[]> => new Promise((resolve) => {
  execFile('fc-list', ['--format', '%{family}\\n'], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    if (error) {
      resolve([])
      return
    }
    resolve(parseFontconfigFamilies(stdout))
  })
})

export const parseFontconfigFamilies = (output: string): string[] =>
  [...new Set(output.split('\n').map((line) => line.split(',')[0].replace(/\\-/g, '-').trim()).filter(Boolean))]
