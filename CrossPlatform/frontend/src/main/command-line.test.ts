import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCommandLine, userArguments } from './command-line'

const cwd = path.resolve('/work')

describe('parseCommandLine', () => {
  it('opens every argument that is no option, made absolute against the start directory', () => {
    expect(parseCommandLine(['a.dll', '/abs/b.exe'], cwd)).toEqual({ paths: [path.resolve(cwd, 'a.dll'), path.resolve('/abs/b.exe')], noLoadFiles: false })
  })

  it('reads --select, both spellings of --no-load-files and the port\'s own --open', () => {
    const parsed = parseCommandLine(['--select', 'T:Ns.Type', '--dont-load-files', '--open', 'c.dll', 'd.dll'], cwd)
    expect(parsed.selectMember).toBe('T:Ns.Type')
    expect(parsed.noLoadFiles).toBe(true)
    expect(parsed.paths).toEqual([path.resolve(cwd, 'c.dll'), path.resolve(cwd, 'd.dll')])
    expect(parseCommandLine(['--no-load-files'], cwd).noLoadFiles).toBe(true)
  })

  it('passes over the options it does not read, with the value of one that takes a value', () => {
    // dnSpy's own options, and the switches Chromium and Electron read, name no file.
    expect(parseCommandLine(['--theme', 'dark', '-l', 'C#', '--no-sandbox', '--user-data-dir=/tmp/x', '--multiple', 'e.dll'], cwd).paths)
      .toEqual([path.resolve(cwd, 'e.dll')])
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
