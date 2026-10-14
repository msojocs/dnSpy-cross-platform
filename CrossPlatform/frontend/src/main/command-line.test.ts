import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCommandLine, userArguments } from './command-line'

const cwd = path.resolve('/work')

describe('parseCommandLine', () => {
  it('opens every argument that is no option, made absolute against the start directory', () => {
    expect(parseCommandLine(['a.dll', '/abs/b.exe'], cwd)).toEqual({
      paths: [path.resolve(cwd, 'a.dll'), path.resolve('/abs/b.exe')],
      singleInstance: true,
      activate: true,
      newTab: false,
      noLoadFiles: false,
      showStartupTime: false,
      userArgs: {},
    })
  })

  it('reads --select, both spellings of --no-load-files and the port\'s own --open', () => {
    const parsed = parseCommandLine(['--select', 'T:Ns.Type', '--dont-load-files', '--open', 'c.dll', 'd.dll'], cwd)
    expect(parsed.selectMember).toBe('T:Ns.Type')
    expect(parsed.noLoadFiles).toBe(true)
    expect(parsed.paths).toEqual([path.resolve(cwd, 'c.dll'), path.resolve(cwd, 'd.dll')])
    expect(parseCommandLine(['--no-load-files'], cwd).noLoadFiles).toBe(true)
  })

  it('reads every option dnSpy knows, with the value of the ones that take one', () => {
    const parsed = parseCommandLine([
      '--theme', 'dark', '-l', 'C#', '--culture', 'de', '--multiple', '--dont-activate', '--new-tab',
      '--search', 'Foo', '--search-for', 'method', '--search-in', 'all', '--full-screen',
      '--show-tool-window', 'a!left,b', '--hide-tool-window', 'c', '--show-startup-time', '-pn', 'app',
      '--settings-file', 'cfg', '--extension-directory', 'ext', '-e', '12', '--jdinfo', 'ABC', 'e.dll',
    ], cwd)
    expect(parsed).toMatchObject({
      paths: [path.resolve(cwd, 'e.dll')],
      theme: 'dark',
      language: 'C#',
      culture: 'de',
      singleInstance: false,
      activate: false,
      newTab: true,
      searchText: 'Foo',
      searchFor: 'method',
      searchIn: 'all',
      fullScreen: true,
      showToolWindow: 'a!left,b',
      hideToolWindow: 'c',
      showStartupTime: true,
      debugAttachProcess: 'app',
      settingsFile: path.resolve(cwd, 'cfg'),
      extensionDirectory: path.resolve(cwd, 'ext'),
    })
    expect(parseCommandLine(['--not-full-screen'], cwd).fullScreen).toBe(false)
  })

  it('reads a process id the way dnSpy does: decimal, negative or hexadecimal', () => {
    expect(parseCommandLine(['-p', '1234'], cwd).debugAttachPid).toBe(1234)
    expect(parseCommandLine(['--pid', '0x10'], cwd).debugAttachPid).toBe(16)
    expect(parseCommandLine(['--pid', '&H1f'], cwd).debugAttachPid).toBe(31)
    expect(parseCommandLine(['--pid', '-1'], cwd).debugAttachPid).toBe(0xFFFF_FFFF)
    const unparsed = parseCommandLine(['--pid', 'abc', 'x.dll'], cwd)
    expect(unparsed.debugAttachPid).toBeUndefined()
    expect(unparsed.paths).toEqual([path.resolve(cwd, 'x.dll')])
  })

  it('keeps every other option by name, the way dnSpy keeps an extension\'s', () => {
    // The switches Chromium and Electron read land here too, and name no file.
    const parsed = parseCommandLine(['--settings:{GUID}', '--no-sandbox', '--user-data-dir=/tmp/x', '--settings:other', 'e.dll'], cwd)
    expect(parsed.paths).toEqual([path.resolve(cwd, 'e.dll')])
    expect(parsed.userArgs).toEqual({ '--settings': '{GUID}', '--no-sandbox': '', '--user-data-dir=/tmp/x': '' })
  })

  it('reads everything after -- as a file, even what looks like an option', () => {
    expect(parseCommandLine(['--', '--weird.dll'], cwd).paths).toEqual([path.resolve(cwd, '--weird.dll')])
  })

  it('reads a file:// address as the file it names', () => {
    expect(parseCommandLine(['file:///tmp/My%20Lib.dll'], cwd).paths).toEqual([path.resolve('/tmp/My Lib.dll')])
  })
})

describe('userArguments', () => {
  it('drops the executable, and in a development run the app directory', () => {
    expect(userArguments(['/usr/bin/dnspy', 'a.dll'], false)).toEqual(['a.dll'])
    expect(userArguments(['electron', '.', 'a.dll'], true)).toEqual(['a.dll'])
    // A launcher may put switches of its own in front of the app directory.
    expect(userArguments(['electron', '--inspect=0', '--remote-debugging-port=0', '.', '--no-sandbox', 'a.dll'], true))
      .toEqual(['--inspect=0', '--remote-debugging-port=0', '--no-sandbox', 'a.dll'])
  })
})
