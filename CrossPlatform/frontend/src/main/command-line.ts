import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppCommandLine } from '../shared/protocol'

/** What a command line asks of the app: dnSpy's AppCommandLineArgs, every field of it. */
export type CommandLine = AppCommandLine

/**
 * dnSpy's AppCommandLineArgs: every argument that is no option is a file to open, `--` ends the options, and
 * each option dnSpy knows is read the way it reads it — the ones that take a value swallow the argument after
 * them, so `--theme dark` is not taken for a file called "dark". Any other option, which includes the switches
 * Chromium and Electron read, is kept the way dnSpy keeps an extension's: `--name` or `--name:value`, looked up
 * later by name. A `file://` address, which a desktop's "Open With" may hand over, is read as the file it names.
 */
export const parseCommandLine = (args: readonly string[], cwd: string): CommandLine => {
  const result: CommandLine = {
    paths: [],
    singleInstance: true,
    activate: true,
    newTab: false,
    noLoadFiles: false,
    showStartupTime: false,
    userArgs: {},
  }
  let canParseOptions = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const next = args[index + 1] ?? ''
    if (!canParseOptions || !arg.startsWith('-')) {
      result.paths.push(fullPath(arg, cwd))
      continue
    }
    switch (arg) {
      case '--':
        canParseOptions = false
        break
      case '--settings-file':
        result.settingsFile = fullPath(next, cwd)
        index++
        break
      case '--multiple':
        result.singleInstance = false
        break
      case '--dont-activate':
      case '--no-activate':
        result.activate = false
        break
      case '-l':
      case '--language':
        result.language = next
        index++
        break
      case '--culture':
        result.culture = next
        index++
        break
      case '--select':
        result.selectMember = next
        index++
        break
      case '--new-tab':
        result.newTab = true
        break
      case '--search':
        result.searchText = next
        index++
        break
      case '--search-for':
        result.searchFor = next
        index++
        break
      case '--search-in':
        result.searchIn = next
        index++
        break
      case '--theme':
        result.theme = next
        index++
        break
      case '--dont-load-files':
      case '--no-load-files':
        result.noLoadFiles = true
        break
      case '--full-screen':
        result.fullScreen = true
        break
      case '--not-full-screen':
        result.fullScreen = false
        break
      case '--show-tool-window':
        result.showToolWindow = next
        index++
        break
      case '--hide-tool-window':
        result.hideToolWindow = next
        index++
        break
      case '--show-startup-time':
        result.showStartupTime = true
        break
      case '-p':
      case '--pid': {
        const pid = parseUInt32(next)
        if (pid !== undefined)
          result.debugAttachPid = pid
        index++
        break
      }
      case '-pn':
      case '--process-name':
        result.debugAttachProcess = next
        index++
        break
      // Just-in-time debugging hands the debugger an event handle and a JIT_DEBUG_INFO address, which only
      // mean something to the Windows debugger that registered dnSpy for it. Both still take their values.
      case '-e':
      case '--jdinfo':
        index++
        break
      case '--extension-directory':
        result.extensionDirectory = fullPath(next, cwd)
        index++
        break
      // The port's own spelling of a file to open, kept for the scripts and the guide that use it.
      case '--open':
        if (index + 1 < args.length)
          result.paths.push(fullPath(next, cwd))
        index++
        break
      default: {
        const separator = arg.indexOf(':')
        const name = separator < 0 ? arg : arg.slice(0, separator)
        const value = separator < 0 ? '' : arg.slice(separator + 1)
        if (!(name in result.userArgs))
          result.userArgs[name] = value
        break
      }
    }
  }
  return result
}

/** dnSpy's TryParseUInt32: decimal, a negative number read as its two's complement, or `0x`/`&H` hexadecimal. */
const parseUInt32 = (value: string): number | undefined => {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value)
    return parsed <= 0xFFFF_FFFF ? parsed : undefined
  }
  if (/^-\d+$/.test(value)) {
    const parsed = Number(value)
    return parsed >= -0x8000_0000 ? parsed >>> 0 : undefined
  }
  const hex = /^(?:0x|&h)([0-9a-f]{1,8})$/i.exec(value)
  return hex ? Number.parseInt(hex[1], 16) : undefined
}

const fullPath = (file: string, cwd: string): string => {
  if (file.startsWith('file://')) {
    try {
      return fileURLToPath(file)
    } catch {
      // Not an address that names a local file; read it as a path like any other.
    }
  }
  return path.resolve(cwd, file)
}

/**
 * The arguments that are the user's: Electron's own executable comes first, and a development or test run
 * (`electron .`) names the app's directory as its first argument that is no switch — which is not necessarily
 * the second one, since a launcher may put switches of its own in front of it.
 */
export const userArguments = (argv: readonly string[], defaultApp: boolean): string[] => {
  const args = argv.slice(1)
  if (!defaultApp)
    return args
  const appPath = args.findIndex((arg) => !arg.startsWith('-'))
  return appPath < 0 ? args : [...args.slice(0, appPath), ...args.slice(appPath + 1)]
}
