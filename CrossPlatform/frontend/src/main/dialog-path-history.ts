import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface DialogPathSettings {
  lastOpenDirectory?: string
}

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

/** Where the directory is kept when it is not a file of its own: a section of the settings file. */
export interface DialogPathStorage {
  read(): unknown
  write(settings: DialogPathSettings): void
}

export class DialogPathHistory {
  private lastOpenDirectory: string | undefined

  constructor(private readonly settingsPath: string, private readonly storage?: DialogPathStorage) {}

  get openDirectory(): string | undefined {
    return this.lastOpenDirectory
  }

  async load(): Promise<void> {
    try {
      const settings = (this.storage ? this.storage.read() ?? {} : JSON.parse(await readFile(this.settingsPath, 'utf8'))) as DialogPathSettings
      if (typeof settings.lastOpenDirectory !== 'string' || !path.isAbsolute(settings.lastOpenDirectory))
        return
      if ((await stat(settings.lastOpenDirectory)).isDirectory())
        this.lastOpenDirectory = settings.lastOpenDirectory
    } catch (error) {
      if (!isMissingFileError(error))
        console.warn('[dialog path history] Could not load settings.', error)
    }
  }

  async rememberOpenedFile(filePath: string): Promise<void> {
    if (!path.isAbsolute(filePath))
      return

    this.lastOpenDirectory = path.dirname(filePath)
    const settings: DialogPathSettings = { lastOpenDirectory: this.lastOpenDirectory }
    if (this.storage) {
      this.storage.write(settings)
      return
    }
    const temporaryPath = `${this.settingsPath}.tmp`
    try {
      await mkdir(path.dirname(this.settingsPath), { recursive: true })
      await writeFile(temporaryPath, `${JSON.stringify(settings, undefined, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.settingsPath)
    } catch (error) {
      console.warn('[dialog path history] Could not save settings.', error)
    }
  }
}
