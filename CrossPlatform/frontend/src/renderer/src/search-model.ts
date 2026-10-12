import type { CodeStatement, SearchLocation, SearchResult, SearchType, TextSpan } from '../../shared/protocol'
import { findReferenceCaret } from './analyzer-model'

/** One entry of the "Search For" box, in the order SearchControlVM lists them, with the image it wears and
 * the letter Ctrl picks it with. */
export interface SearchTypeEntry {
  type: SearchType
  label: string
  icon: string
  key?: string
}

export const SEARCH_TYPES: readonly SearchTypeEntry[] = [
  { type: 'assembly', label: 'Assembly', icon: 'assembly' },
  { type: 'module', label: 'Module', icon: 'module' },
  { type: 'namespace', label: 'Namespace', icon: 'namespace' },
  { type: 'type', label: 'Type', icon: 'class', key: 't' },
  { type: 'field', label: 'Field', icon: 'field', key: 'f' },
  { type: 'method', label: 'Method', icon: 'method', key: 'm' },
  { type: 'property', label: 'Property', icon: 'property', key: 'p' },
  { type: 'event', label: 'Event', icon: 'event', key: 'e' },
  { type: 'parameter', label: 'Parameter', icon: 'parameter', key: 'j' },
  { type: 'local', label: 'Local', icon: 'local', key: 'i' },
  { type: 'parameterLocal', label: 'Parameter/Local', icon: 'local', key: 'n' },
  { type: 'assemblyRef', label: 'AssemblyRef', icon: 'reference' },
  { type: 'moduleRef', label: 'ModuleRef', icon: 'reference' },
  { type: 'resource', label: 'Resource', icon: 'resource', key: 'r' },
  { type: 'genericType', label: 'Generic Type', icon: 'class' },
  { type: 'nonGenericType', label: 'Non-Generic Type', icon: 'class' },
  { type: 'enum', label: 'Enum', icon: 'enum' },
  { type: 'interface', label: 'Interface', icon: 'interface' },
  { type: 'class', label: 'Class', icon: 'class' },
  { type: 'struct', label: 'Struct', icon: 'class' },
  { type: 'delegate', label: 'Delegate', icon: 'class' },
  { type: 'member', label: 'Member', icon: 'property', key: 'u' },
  { type: 'any', label: 'All of the Above', icon: 'class', key: 'b' },
  { type: 'literal', label: 'Number/String', icon: 'literal', key: 'l' },
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

/** The results in the order dnSpy's list shows them: by name, the culture's way and ignoring case; two of
 * one name keep the order they were found in. */
export const sortSearchResults = (results: readonly SearchResult[]): SearchResult[] =>
  [...results].sort((left, right) => collator.compare(left.name, right.name))

interface DecompiledMethod {
  text: string
  spans: TextSpan[]
  codeStatements?: CodeStatement[]
}

/**
 * Where following a match in a method body puts the caret (SearchService.GoTo): at the start of the
 * statement the instruction it was found at belongs to. Nothing when the document has no statement for it
 * — a view such as IL, which carries no statement map.
 */
export const findSearchResultCaret = (document: DecompiledMethod, methodToken: number, ilOffset: number): { line: number; column: number } | undefined => {
  const modulePath = document.codeStatements?.find((statement) => statement.metadataToken === methodToken)?.modulePath
  if (!modulePath)
    return undefined
  // With nothing to look for in the statement, the analyzer's caret is the statement's start.
  return findReferenceCaret(document, { methodNodeId: '', modulePath, methodToken, ilOffset, targets: [] })
}
