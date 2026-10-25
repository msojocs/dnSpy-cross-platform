import type { ModuleBreakpoint } from './app-store'

/** BreakpointsSerializer's settings section GUID: the section an export file's rows live under. */
export const MODULE_BREAKPOINTS_SETTINGS_GUID = 'A7C5956E-593B-4B04-A237-F837CF17E44E'

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * dnSpy's module-breakpoint export, as XmlSettingsWriter writes it: a `settings` root, the serializer's
 * section, and one `Breakpoint` section per row. `IsEnabled` is the attribute the loader requires.
 */
export const moduleBreakpointsXml = (rows: readonly ModuleBreakpoint[]): string => {
  const breakpoints = [...rows].sort((a, b) => a.id.localeCompare(b.id)).map((row) => {
    const attributes = [`IsEnabled="${row.enabled ? 'true' : 'false'}"`]
    const optional: [string, string | number | boolean | undefined][] = [
      ['ModuleName', row.moduleName || undefined],
      ['IsDynamic', row.isDynamic],
      ['IsInMemory', row.isInMemory],
      ['IsLoaded', row.isLoaded],
      ['Order', row.order],
      ['AppDomainName', row.appDomainName || undefined],
      ['ProcessName', row.processName || undefined],
    ]
    for (const [name, value] of optional) {
      if (value !== undefined)
        attributes.push(`${name}="${escapeAttribute(typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value))}"`)
    }
    return `    <section _="Breakpoint" ${attributes.join(' ')} />`
  })
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<settings>',
    `  <section _="${MODULE_BREAKPOINTS_SETTINGS_GUID}">`,
    ...breakpoints,
    '  </section>',
    '</settings>',
    '',
  ].join('\n')
}

const boolAttribute = (element: Element, name: string): boolean | undefined => {
  const value = element.getAttribute(name)
  return value === 'true' ? true : value === 'false' ? false : undefined
}

/**
 * The rows of a file `moduleBreakpointsXml` wrote, or a file dnSpy's Export writes. A section that is not
 * under the serializer's GUID is ignored, and so is a row without the IsEnabled attribute its loader needs.
 */
export const parseModuleBreakpointsXml = (text: string): Omit<ModuleBreakpoint, 'id'>[] | undefined => {
  let document: Document
  try {
    document = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    return undefined
  }
  if (document.getElementsByTagName('parsererror').length > 0)
    return undefined
  const root = [...document.getElementsByTagName('section')].find((section) => section.getAttribute('_') === MODULE_BREAKPOINTS_SETTINGS_GUID)
  if (!root)
    return undefined
  const rows: Omit<ModuleBreakpoint, 'id'>[] = []
  for (const element of [...root.children]) {
    if (element.tagName !== 'section' || element.getAttribute('_') !== 'Breakpoint')
      continue
    const enabled = boolAttribute(element, 'IsEnabled')
    if (enabled === undefined)
      continue
    const order = element.getAttribute('Order')
    rows.push({
      enabled,
      moduleName: element.getAttribute('ModuleName') ?? '',
      isDynamic: boolAttribute(element, 'IsDynamic'),
      isInMemory: boolAttribute(element, 'IsInMemory'),
      isLoaded: boolAttribute(element, 'IsLoaded'),
      order: order !== null && /^-?\d+$/.test(order) ? Number(order) : undefined,
      appDomainName: element.getAttribute('AppDomainName') || undefined,
      processName: element.getAttribute('ProcessName') || undefined,
    })
  }
  return rows
}
