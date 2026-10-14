import { describe, expect, it } from 'vitest'
import { formatAppTitle } from './app-info'

describe('formatAppTitle', () => {
  it('writes dnSpy\'s "name version (info, info)" title', () => {
    expect(formatAppTitle('dnSpy', '6.6.0', { bitness: '64-bit', runtime: '.NET' })).toBe('dnSpy 6.6.0 (64-bit, .NET)')
  })

  it('adds the administrator and debug infos after the framework, in dnSpy\'s order', () => {
    expect(formatAppTitle('dnSpy', '6.6.0', { bitness: '64-bit', runtime: '.NET', isDebugBuild: true, isAdministrator: true, administratorText: '管理员' }))
      .toBe('dnSpy 6.6.0 (64-bit, .NET, Debug Build, 管理员)')
  })

  it('says Administrator in English when no translation was handed over', () => {
    expect(formatAppTitle('dnSpy', '6.6.0', { bitness: '64-bit', isAdministrator: true })).toBe('dnSpy 6.6.0 (64-bit, Administrator)')
  })
})
