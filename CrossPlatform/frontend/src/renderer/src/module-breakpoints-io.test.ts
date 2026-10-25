import { describe, expect, it } from 'vitest'
import { MODULE_BREAKPOINTS_SETTINGS_GUID, moduleBreakpointsXml, parseModuleBreakpointsXml } from './module-breakpoints-io'
import type { ModuleBreakpoint } from './app-store'

const row = (id: string, extra: Partial<ModuleBreakpoint> = {}): ModuleBreakpoint => ({
  id,
  enabled: true,
  moduleName: '',
  ...extra,
})

describe('the module breakpoint file', () => {
  it('writes the settings XML BreakpointsSerializer loads', () => {
    const xml = moduleBreakpointsXml([
      row('a', { moduleName: 'MyApp*', isDynamic: true, isInMemory: false, isLoaded: false, order: 3, processName: 'app', appDomainName: 'Default' }),
      row('b', { enabled: false, moduleName: '', isLoaded: undefined }),
    ])

    expect(xml).toContain(`<section _="${MODULE_BREAKPOINTS_SETTINGS_GUID}">`)
    expect(xml).toContain('<section _="Breakpoint" IsEnabled="true" ModuleName="MyApp*" IsDynamic="true" IsInMemory="false" IsLoaded="false" Order="3" AppDomainName="Default" ProcessName="app" />')
    // An empty module name and an unset Loaded are left out, as the serializer does.
    expect(xml).toContain('<section _="Breakpoint" IsEnabled="false" />')
  })

  it('reads what it writes back', () => {
    const rows = [row('a', { moduleName: 'MyApp*', isDynamic: true, order: 3, processName: 'app' }), row('b', { enabled: false, isLoaded: false })]

    expect(parseModuleBreakpointsXml(moduleBreakpointsXml(rows))).toEqual([
      { enabled: true, moduleName: 'MyApp*', isDynamic: true, isInMemory: undefined, isLoaded: undefined, order: 3, processName: 'app', appDomainName: undefined },
      { enabled: false, moduleName: '', isDynamic: undefined, isInMemory: undefined, isLoaded: false, order: undefined, processName: undefined, appDomainName: undefined },
    ])
  })

  it('ignores other settings sections and a file that is not XML', () => {
    expect(parseModuleBreakpointsXml('<settings><section _="not-the-serializer" /></settings>')).toBeUndefined()
    expect(parseModuleBreakpointsXml('not xml at all')).toBeUndefined()
    // A Breakpoint row without IsEnabled is not loadable, so the serializer drops it too.
    expect(parseModuleBreakpointsXml(`<settings><section _="${MODULE_BREAKPOINTS_SETTINGS_GUID}"><section _="Breakpoint" ModuleName="x" /></section></settings>`)).toEqual([])
  })
})
