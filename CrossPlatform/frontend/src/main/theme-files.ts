import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ThemeFile } from '../shared/protocol'

/**
 * dnSpy's AppDirectories.GetDirectories("Themes"): the Themes directory beside the program, then the one in the
 * user's data directory when that is a different place. dnSpy reads every `*.dntheme` file at the top of each,
 * and skips a directory it cannot list; the four themes it ships are built into this port, so these are only
 * the user's own.
 */
export const themeDirectories = (binDirectory: string, dataDirectory: string): string[] => {
  const directories = [path.join(binDirectory, 'Themes')]
  if (path.resolve(binDirectory).toLowerCase() !== path.resolve(dataDirectory).toLowerCase())
    directories.push(path.join(dataDirectory, 'Themes'))
  return directories
}

export const readThemeFiles = (directories: readonly string[]): ThemeFile[] => {
  const files: ThemeFile[] = []
  for (const directory of directories) {
    let names: string[]
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dntheme'))
        .map((entry) => entry.name)
        .sort()
    } catch {
      continue
    }
    for (const name of names) {
      const filePath = path.join(directory, name)
      try {
        files.push({ path: filePath, text: readFileSync(filePath, 'utf8') })
      } catch {
        // dnSpy's Load(filename) gives up on a file it cannot read and goes on with the next.
      }
    }
  }
  return files
}
