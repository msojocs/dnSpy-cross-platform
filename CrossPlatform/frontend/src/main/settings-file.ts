import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * dnSpy's settings file (AppDirectories.SettingsFilename): `--settings-file` names one, and a dnSpy that finds
 * its settings beside the program keeps them there — the portable install — rather than in the user's profile.
 * The port keeps everything dnSpy keeps in that one file in one JSON document: the renderer's options, the
 * window's state, the few settings the main process reads before there is a window, and the dialog's last
 * directory, each a section of its own.
 */
export interface SettingsDocument {
  renderer?: Record<string, string>
  windowState?: unknown
  appSettings?: unknown
  dialogState?: unknown
}

export type SettingsSection = keyof SettingsDocument

/** The name of the portable settings file, which takes the place of dnSpy's dnSpy.xml beside the program. */
export const PORTABLE_SETTINGS_FILE_NAME = 'dnSpy.json'

/**
 * AppDirectories' static constructor: the file `--settings-file` names, else the portable file beside the
 * program if there is one, else none — the profile directory's files, as usual.
 */
export const resolveSettingsFile = (explicit: string | undefined, binDirectory: string, exists: (file: string) => boolean = existsSync): string | undefined => {
  if (explicit)
    return explicit
  const portable = path.join(binDirectory, PORTABLE_SETTINGS_FILE_NAME)
  return exists(portable) ? portable : undefined
}

export class SettingsFile {
  private document: SettingsDocument

  constructor(readonly filePath: string) {
    this.document = SettingsFile.read(filePath)
  }

  /** A file that is missing or is no settings document starts empty, the way dnSpy starts from defaults. */
  private static read(filePath: string): SettingsDocument {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as SettingsDocument : {}
    } catch {
      return {}
    }
  }

  get<K extends SettingsSection>(section: K): SettingsDocument[K] {
    return this.document[section]
  }

  /** Replaces a section and writes the file out at once, through a temporary file so a crash leaves the old one. */
  set<K extends SettingsSection>(section: K, value: SettingsDocument[K]): void {
    this.document = { ...this.document, [section]: value }
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.document, undefined, 2)}\n`, 'utf8')
      renameSync(temporary, this.filePath)
    } catch (error) {
      // dnSpy shows nothing either when its settings cannot be written; the run goes on with what it has.
      console.warn('[settings file] Could not save settings.', error)
    }
  }
}

/** The renderer's own options: every `dnspy.` key of its storage, which is all the port keeps there. */
export const rendererEntries = (entries: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => entry[0].startsWith('dnspy.') && typeof entry[1] === 'string'))
