import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** What a command line asks of the tree. */
export interface CommandLine {
  /** The files to open, made absolute against the directory the process was started in. */
  paths: string[]
  /** `--select`: a token or an XML documentation id to follow in the files once they are open. */
  selectMember?: string
  /** `--no-load-files` (dnSpy's `--dont-load-files`): leave the last session's files where they are. */
  noLoadFiles: boolean
}

// The options of dnSpy's AppCommandLineArgs that take the argument after them. This port reads only the tree's
// own, but every one of them still swallows its value, so `--theme dark` is not taken for a file called "dark".
const OPTIONS_WITH_A_VALUE = new Set([
  '--settings-file', '-l', '--language', '--culture', '--select', '--search', '--search-for', '--search-in',
  '--theme', '--show-tool-window', '--hide-tool-window', '-p', '--pid', '-e', '--jdinfo', '-pn', '--process-name',
  '--extension-directory',
  // The port's own spelling of a file to open, kept for the scripts and the guide that use it.
  '--open',
])

/**
 * dnSpy's AppCommandLineArgs, the part that concerns the tree: every argument that is no option is a file to
 * open, `--` ends the options, `--select` names the member to show and `--no-load-files` skips the last
 * session. Any other option — dnSpy's own, or one Chromium and Electron read — is passed over, and so is the
 * value of one that takes a value. A `file://` address, which a desktop's "Open With" may hand over, is read as
 * the file it names.
 */
export const parseCommandLine = (args: readonly string[], cwd: string): CommandLine => {
  const result: CommandLine = { paths: [], noLoadFiles: false }
  let canParseOptions = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (canParseOptions && arg.startsWith('-')) {
      if (arg === '--') {
        canParseOptions = false
        continue
      }
      if (arg === '--dont-load-files' || arg === '--no-load-files') {
        result.noLoadFiles = true
        continue
      }
      if (!OPTIONS_WITH_A_VALUE.has(arg))
        continue
      const value = args[index + 1]
      index++
      if (value === undefined)
        continue
      if (arg === '--select')
        result.selectMember = value
      else if (arg === '--open')
        result.paths.push(fullPath(value, cwd))
      continue
    }
    result.paths.push(fullPath(arg, cwd))
  }
  return result
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
