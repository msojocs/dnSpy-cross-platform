import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The part of dnSpy's AppSettings the main process has to know before there is a renderer to ask: the
 * options that decide how the process itself starts. Everything else lives in the renderer's option store;
 * that store is the one that is written, and it hands these few down through `app:mainSettings` so this
 * file is only ever a copy of what the user last chose.
 */
export interface AppMainSettings {
  /** dnSpy's AppSettings.AllowMoreThanOneInstance: false lets a second dnSpy start instead of handing its
   * command line to the one already running. Read before the single instance lock is taken. */
  allowMoreThanOneInstance: boolean
}

export const defaultAppMainSettings: AppMainSettings = {
  allowMoreThanOneInstance: false,
}

/** Defaults for a file that is missing, unreadable or not what it should be: a fresh install starts with
 * dnSpy's own defaults rather than failing to start. */
export const loadAppMainSettings = (filePath: string): AppMainSettings => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AppMainSettings> | null
    if (typeof parsed !== 'object' || parsed === null)
      return defaultAppMainSettings
    return { allowMoreThanOneInstance: parsed.allowMoreThanOneInstance === true }
  } catch {
    return defaultAppMainSettings
  }
}

export const saveAppMainSettings = (filePath: string, settings: AppMainSettings): void => {
  try {
    writeFileSync(filePath, JSON.stringify(settings))
  } catch {
    // The option only takes effect on the next start, and a settings file that cannot be written must not
    // stand in the way of the run that is going on now.
  }
}
