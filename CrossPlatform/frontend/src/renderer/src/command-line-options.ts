import type { DecompilerLanguage, SearchLocation, SearchType } from '../../shared/protocol'
import { findTheme, themeKey } from './theme-service'

/** `--theme`: a theme's GUID — read either case and with or without the braces — or its name, dnSpy's `name`
 * attribute rather than its menu name, compared exactly as AppCommandLineArgsHandler compares it. Any theme the
 * theme service loaded will do, the user's own included; what comes back is the key the options keep it under. */
export const resolveThemeName = (value: string | undefined): string | undefined => {
  const theme = findTheme(value?.trim())
  return theme ? themeKey(theme) : undefined
}

/** dnSpy's AppToolWindowLocation, the four edges plus the two the window remembers for itself. */
export type ToolWindowLocation = 'left' | 'right' | 'top' | 'bottom' | 'default-horizontal' | 'default-vertical'

/** One entry of `--show-tool-window` or `--hide-tool-window`: a window, and where it is to be put. */
export interface ToolWindowInfo {
  guid: string
  location?: ToolWindowLocation
}

/** dnSpy's AppCommandLineArgsHandler.GetLocation: the short and long spelling of every location. */
export const parseToolWindowLocation = (value: string): ToolWindowLocation | undefined => {
  switch (value.trim()) {
    case 'l': case 'left': return 'left'
    case 'r': case 'right': return 'right'
    case 't': case 'top': return 'top'
    case 'b': case 'bottom': return 'bottom'
    case 'd': case 'default': case 'dh': case 'default-horiz': case 'default-horizontal': return 'default-horizontal'
    case 'dv': case 'default-vert': case 'default-vertical': return 'default-vertical'
    default: return undefined
  }
}

/**
 * dnSpy's AppCommandLineArgsHandler.GetToolWindowInfos: a comma-separated list of tool window GUIDs, each
 * optionally followed by `!` and a location. An entry whose GUID does not parse is passed over, as it is
 * there, and so is a location that is not one of the six.
 */
export const parseToolWindowInfos = (arg: string | undefined): ToolWindowInfo[] => {
  if (!arg)
    return []
  const infos: ToolWindowInfo[] = []
  for (const entry of arg.split(',')) {
    const [guid, location] = entry.split('!', 2)
    const trimmed = guid.trim()
    if (!/^\{?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?$/i.test(trimmed))
      continue
    const info: ToolWindowInfo = { guid: trimmed.replace(/^\{|\}$/g, '').toLowerCase() }
    if (location !== undefined) {
      const parsed = parseToolWindowLocation(location)
      if (parsed)
        info.location = parsed
    }
    infos.push(info)
  }
  return infos
}

/**
 * dnSpy's tool window GUIDs — each content provider's THE_GUID — against the ids this port names the same
 * windows by. A command line written for dnSpy names a window by GUID, and a Memory window's GUID carries
 * the window's number in it, so only the first one is listed.
 */
const toolWindowIdByGuid: Record<string, string> = {
  '5495ee9f-1ef2-45f3-a320-22a89bfdf731': 'explorer',
  '90a45e97-727e-4f31-8692-06e19218d99a': 'output',
  'ffd1f456-dc69-46d7-8c96-858b36c57bc3': 'csharp-interactive',
  '8e359be0-c8cd-4ca7-b228-8c836219af85': 'search',
  '5827d693-a5df-4d65-b1f8-acf249508a96': 'analysis',
  'd799829f-cae3-4f8f-ad81-1732abc50636': 'locals',
  '82575354-ab18-408b-846b-aa585b7b2b4a': 'exception-settings',
  'a05af486-59a0-4a2f-ab61-fc25151426c3': 'watch',
  '0e53b79d-ec30-44b6-86a3-dffce364eb4a': 'callstack',
  'e5745d58-4dcb-4d92-b786-4e1635c86eed': 'breakpoints',
  'a13ffead-9f74-4456-9204-034edbde3244': 'bookmarks',
  '3c01719c-b6b5-4261-9cd4-3edce1032e5c': 'threads',
  '8c95eb2e-25f4-4d2f-a00d-a303754990df': 'modules',
  '9d7d28f0-f031-4439-99bf-f7b747fa4b19': 'module-breakpoints',
  '6e0232ec-3d88-4087-a571-cc1184d86645': 'autos',
  'f46a6b46-4da1-46bc-a279-2e2292069be9': 'static-fields',
  'f1efb8be-8941-4be4-acc4-aca8809394bb': 'processes',
  '30ad8a10-5c72-47ff-a30d-9e2fbe2852b4': 'memory',
}

/** The id this port gives the window a command line names, or undefined for a window it has no counterpart
 * of (a Visual Basic Interactive window, a second Memory window, an absent debugger pane). */
export const toolWindowIdForGuid = (guid: string): string | undefined => toolWindowIdByGuid[guid.toLowerCase()]

/** dnSpy's decompiler GUIDs, from DecompilerConstants. `-l` takes a GUID or a name, so both are read. */
const decompilerLanguageByGuid: Record<string, DecompilerLanguage> = {
  'f5a318d4-4b2a-48d2-ae33-f4d2b1eff4b0': 'cSharp',
  'b6849618-8239-4fbb-8dff-d45eb023c193': 'visualBasic',
  '9ef276fd-3293-42a4-b48a-1d6a69086b3d': 'il',
  'a4f35508-691f-4bd0-b74d-d5d5d1d0e8e6': 'il',
  'ca52a515-12ae-4182-bc88-81ed037c3d32': 'ilWithCSharp',
}

/** `-l`/`--language`: dnSpy's App.GetDecompiler, which looks the name up in the unique names first and the
 * generic ones after — "C#", "Visual Basic", "IL" and "IL with C#" are the ones that name a decompiler. */
export const resolveDecompilerLanguage = (value: string | undefined): DecompilerLanguage | undefined => {
  if (!value)
    return undefined
  const guid = decompilerLanguageByGuid[value.trim().replace(/^\{|\}$/g, '').toLowerCase()]
  if (guid)
    return guid
  switch (value.trim().toLowerCase()) {
    case 'c#': return 'cSharp'
    case 'visual basic': return 'visualBasic'
    case 'il': return 'il'
    case 'il with c#': return 'ilWithCSharp'
    default: return undefined
  }
}

/** The names dnSpy's search window takes on the command line, from its own AppCommandLineArgsHandler. */
const searchLocationNames: Record<string, SearchLocation> = {
  a: 'allFiles', all: 'allFiles', 'all-files': 'allFiles',
  sel: 'selectedFiles', selected: 'selectedFiles', 'selected-files': 'selectedFiles',
  dir: 'allFilesInSameDir', folder: 'allFilesInSameDir', 'same-dir': 'allFilesInSameDir', 'same-folder': 'allFilesInSameDir',
  t: 'selectedType', type: 'selectedType', 'sel-type': 'selectedType', 'selected-type': 'selectedType',
}

/** `--search-in`: which files the search looks through. */
export const resolveSearchLocation = (value: string | undefined): SearchLocation | undefined =>
  value ? searchLocationNames[value] : undefined

const searchTypeNames: Record<string, SearchType> = {
  asm: 'assembly', assembly: 'assembly',
  mod: 'module', module: 'module',
  ns: 'namespace', namespace: 'namespace',
  t: 'type', type: 'type',
  f: 'field', field: 'field',
  m: 'method', method: 'method',
  p: 'property', prop: 'property', property: 'property',
  e: 'event', evt: 'event', event: 'event',
  pm: 'parameter', param: 'parameter',
  loc: 'local', local: 'local',
  pl: 'parameterLocal', pmloc: 'parameterLocal', 'pm-loc': 'parameterLocal', paramlocal: 'parameterLocal', 'param-local': 'parameterLocal',
  ar: 'assemblyRef', asmref: 'assemblyRef', 'asm-ref': 'assemblyRef', 'assembly-ref': 'assemblyRef',
  mr: 'moduleRef', modref: 'moduleRef', 'mod-ref': 'moduleRef', 'module-ref': 'moduleRef',
  r: 'resource', res: 'resource', rsrc: 'resource', resource: 'resource',
  generic: 'genericType',
  'non-generic': 'nonGenericType',
  enum: 'enum',
  if: 'interface', iface: 'interface', interface: 'interface',
  cl: 'class', class: 'class',
  st: 'struct', struct: 'struct',
  del: 'delegate', delegate: 'delegate',
  member: 'member',
  any: 'any',
  lit: 'literal', literal: 'literal', const: 'literal', constant: 'literal',
}

/** `--search-for`: which kind of thing the search looks for. */
export const resolveSearchType = (value: string | undefined): SearchType | undefined =>
  value ? searchTypeNames[value] : undefined
