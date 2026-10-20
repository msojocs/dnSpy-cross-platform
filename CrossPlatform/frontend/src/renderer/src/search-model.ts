import type { CodeStatement, SearchLocation, SearchResult, SearchType, TextSpan } from '../../shared/protocol'
import { findReferenceCaret } from './analyzer-model'

/** One entry of the "Search For" box, in the order SearchControlVM lists them, with the image dnSpy gives it
 * and the letter Ctrl picks it with, which its tooltip names. */
export interface SearchTypeEntry {
  type: SearchType
  label: string
  icon: string
  key?: string
}

export const SEARCH_TYPES: readonly SearchTypeEntry[] = [
  { type: 'assembly', label: 'Assembly', icon: 'Assembly' },
  { type: 'module', label: 'Module', icon: 'ModulePublic' },
  { type: 'namespace', label: 'Namespace', icon: 'Namespace' },
  { type: 'type', label: 'Type', icon: 'ClassPublic', key: 't' },
  { type: 'field', label: 'Field', icon: 'FieldPublic', key: 'f' },
  { type: 'method', label: 'Method', icon: 'MethodPublic', key: 'm' },
  { type: 'property', label: 'Property', icon: 'Property', key: 'p' },
  { type: 'event', label: 'Event', icon: 'EventPublic', key: 'e' },
  { type: 'parameter', label: 'Parameter', icon: 'Parameter', key: 'j' },
  { type: 'local', label: 'Local', icon: 'LocalVariable', key: 'i' },
  { type: 'parameterLocal', label: 'Parameter/Local', icon: 'LocalVariable', key: 'n' },
  { type: 'assemblyRef', label: 'AssemblyRef', icon: 'Reference' },
  { type: 'moduleRef', label: 'ModuleRef', icon: 'Reference' },
  { type: 'resource', label: 'Resource', icon: 'Dialog', key: 'r' },
  { type: 'genericType', label: 'Generic Type', icon: 'Template' },
  { type: 'nonGenericType', label: 'Non-Generic Type', icon: 'ClassPublic' },
  { type: 'enum', label: 'Enum', icon: 'EnumerationPublic' },
  { type: 'interface', label: 'Interface', icon: 'InterfacePublic' },
  { type: 'class', label: 'Class', icon: 'ClassPublic' },
  { type: 'struct', label: 'Struct', icon: 'StructurePublic' },
  { type: 'delegate', label: 'Delegate', icon: 'DelegatePublic' },
  { type: 'member', label: 'Member', icon: 'Property', key: 'u' },
  { type: 'any', label: 'All of the Above', icon: 'ClassPublic', key: 'b' },
  { type: 'literal', label: 'Number/String', icon: 'ConstantPublic', key: 'l' },
]

/** The location box, and the letter Ctrl picks each entry with. */
export const SEARCH_LOCATIONS: readonly { location: SearchLocation; label: string; key: string }[] = [
  { location: 'allFiles', label: 'All Files', key: 'g' },
  { location: 'selectedFiles', label: 'Selected Files', key: 's' },
  { location: 'allFilesInSameDir', label: 'Files in Same Folder', key: 'd' },
  { location: 'selectedType', label: 'Selected Type', key: 'q' },
]

/** dnSpy's limit: the search stops at the first result past it. */
export const MAX_SEARCH_RESULTS = 10_000

// dnSpy sorts its list with StringComparer.CurrentCultureIgnoreCase on what a result's name reads.
const collator = new Intl.Collator(undefined, { sensitivity: 'accent' })

/** The positions of the results in the order dnSpy's list shows them: by name, the culture's way and ignoring
 * case; two of one name keep the order they were found in. */
export const searchResultOrder = (results: readonly SearchResult[]): number[] =>
  results.map((_, index) => index).sort((left, right) => collator.compare(results[left].name, results[right].name) || left - right)

/** The results in the order dnSpy's list shows them. */
export const sortSearchResults = (results: readonly SearchResult[]): SearchResult[] =>
  searchResultOrder(results).map((index) => results[index])

interface DecompiledMethod {
  text: string
  spans: TextSpan[]
  codeStatements?: CodeStatement[]
}

/**
 * Where following a match in a method body puts the caret (SearchService.GoTo): at the start of the
 * statement the instruction it was found at belongs to — in IL, whose statements are the instructions, at the
 * instruction itself. Nothing when the document has no statement for it — a document whose language carries no
 * statement map (Visual Basic recovers one from the conversion, so it follows like C#).
 */
export const findSearchResultCaret = (document: DecompiledMethod, methodToken: number, ilOffset: number): { line: number; column: number } | undefined => {
  const modulePath = document.codeStatements?.find((statement) => statement.metadataToken === methodToken)?.modulePath
  if (!modulePath)
    return undefined
  // With nothing to look for in the statement, the analyzer's caret is the statement's start.
  return findReferenceCaret(document, { methodNodeId: '', modulePath, methodToken, ilOffset, targets: [] })
}
