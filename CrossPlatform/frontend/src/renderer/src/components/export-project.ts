import type { DecompilerLanguage, DecompilerSettings, ProjectVersion, TreeNode } from '../../../shared/protocol'
import { projectVersions } from '../../../shared/protocol'
import type { AppOptions } from './app-options'

/**
 * The roots that hold a managed module — an assembly, or a net module opened on its own. Every row under one of them
 * resolves to that root's modules, the way dnSpy's GetAssemblyNode()/GetModuleNode() walk up from any row.
 */
const EXPORTABLE_ROOT_KINDS = new Set(['assembly', 'module'])

/** The roots of files that are no managed module, and the rows only they have: nothing in them can be exported. */
const UNEXPORTABLE_KINDS = new Set(['pedocument', 'elfdocument', 'unknowndocument', 'elf', 'elfstructure'])

/**
 * dnSpy's ExportProjectCommand.IsEnabled: GetModules() finds a module in the tree's selection. A row is followed up to
 * its root; a row whose ancestors are not known (one put in the selection without the tree having listed it) counts
 * by its own kind, which is what is left to go by.
 */
export const canExportToProject = (selection: readonly TreeNode[], parents: Readonly<Record<string, string>>, roots: readonly TreeNode[]): boolean =>
  selection.some((node) => {
    let id = node.id
    const seen = new Set<string>()
    while (parents[id] !== undefined && !seen.has(id)) {
      seen.add(id)
      id = parents[id]
    }
    const root = roots.find((candidate) => candidate.id === id)
    if (root)
      return EXPORTABLE_ROOT_KINDS.has(root.kind)
    return !UNEXPORTABLE_KINDS.has(node.kind)
  })

/** The languages dnSpy's dialog lists: the decompilers that have a ProjectFileExtension, in its order. */
export const exportLanguages: { value: Extract<DecompilerLanguage, 'cSharp' | 'visualBasic'>; label: string }[] = [
  { value: 'cSharp', label: 'C#' },
  { value: 'visualBasic', label: 'Visual Basic' },
]

/** ExportProjectCommand.Execute: the current language when it can export, otherwise the first one that can. */
export const initialExportLanguage = (language: DecompilerLanguage): Extract<DecompilerLanguage, 'cSharp' | 'visualBasic'> =>
  language === 'visualBasic' ? 'visualBasic' : 'cSharp'

/**
 * dnSpy's ExportToProjectSettings, which keeps the project version of the last export that ran to the end. The port
 * keeps the destination folder as well, so the dialog does not open on an empty folder every time.
 */
export interface ExportToProjectSettings {
  projectVersion: ProjectVersion
  directory?: string
}

const settingsStorageKey = 'dnspy.exportToProject.v1'

export const loadExportToProjectSettings = (): ExportToProjectSettings => {
  try {
    const stored = JSON.parse(localStorage.getItem(settingsStorageKey) ?? 'null') as Partial<ExportToProjectSettings> | null
    return {
      projectVersion: projectVersions.includes(stored?.projectVersion as ProjectVersion) ? stored!.projectVersion! : 'VS2010',
      directory: typeof stored?.directory === 'string' && stored.directory.length > 0 ? stored.directory : undefined,
    }
  } catch {
    return { projectVersion: 'VS2010' }
  }
}

export const saveExportToProjectSettings = (settings: ExportToProjectSettings): void => {
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings))
  } catch {
    // Storage that cannot be written to only costs the next dialog its defaults.
  }
}

const HEX = '[0-9a-f]'
const GUID_D = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`
/** The forms .NET's Guid.TryParse reads, which NullableGuidVM goes by: N, D, B and P. */
const GUID_FORMS = new RegExp(`^(?:${HEX}{32}|${GUID_D}|\\{${GUID_D}\\}|\\(${GUID_D}\\))$`, 'i')

/** NullableGuidVM: an empty box is no guid (every project gets a new one), anything else has to read as one. */
export const isValidProjectGuid = (text: string): boolean => text.trim().length === 0 || GUID_FORMS.test(text.trim())

/** The error log's cap — ExportToProjectVM.AddError stops at 8 KiB and marks the cut with "[...]". */
const MAX_ERROR_LOG = 8 * 1024

/** ExportToProjectVM.AddError: the message and a line break, until the log is full. */
export const appendErrorLog = (log: string, message: string): string => {
  if (log.length >= MAX_ERROR_LOG)
    return log
  const next = `${log}${message}\n`
  return next.length > MAX_ERROR_LOG ? `${next.slice(0, MAX_ERROR_LOG)}[...]` : next
}

/**
 * The decompiler settings an export runs with: the C# options the document views send with a decompile request, so a
 * project reads like the code the user has been looking at.
 */
export const decompilerSettingsFromOptions = (options: AppOptions): DecompilerSettings => ({
  cSharp: { ...options.decompiler.cSharp },
  il: { ...options.decompiler.il },
  baml: {
    newLineOnAttributes: options.baml.newLineOnAttributes,
    useTabs: options.baml.useTabs,
    // A project's .xaml files are always the XAML: dnSpy's export never writes BAML records.
    disassembleBaml: false,
  },
  decompileFullType: options.environmentGeneral.decompileFullType,
  useMemoryMappedIO: options.environmentGeneral.useMemoryMappedIO,
})
