import type { StringReference, StringReferenceKind } from '../../shared/protocol'

// What dnSpy's String References window does with its list (StringsControlVM): the filter the search box and
// the three options make, and the orders the column headers sort in.

/** dnSpy's StringReferencesSettings: the three switches under the window's Options expander. */
export interface StringReferencesSettings {
  caseSensitive: boolean
  regex: boolean
  /** Match on the string as a C# literal — escaped and quoted — rather than as it is. */
  matchFormatted: boolean
}

export type StringReferencesColumn = 'kind' | 'literal' | 'referrer' | 'module'

/** The columns in the order the window lays them out, with dnSpy's widths. */
export const STRING_REFERENCES_COLUMNS: readonly { column: StringReferencesColumn; label: string; width: number }[] = [
  { column: 'kind', label: 'Kind', width: 75 },
  { column: 'literal', label: 'Literal', width: 600 },
  { column: 'referrer', label: 'Referrer', width: 500 },
  { column: 'module', label: 'Module', width: 150 },
]

/** StringReferenceKindConverter. */
export const STRING_REFERENCE_KIND_LABELS: Record<StringReferenceKind, string> = {
  il: 'IL',
  constant: 'Constant',
  attribute: 'Attribute',
}

const KIND_ORDER: Record<StringReferenceKind, number> = { il: 0, constant: 1, attribute: 2 }

export interface StringReferencesSort {
  column: StringReferencesColumn
  descending: boolean
}

/** dnSpy's GridViewColumnSorter: a header sorts up, then down, then hands the list back its own order. */
export const nextStringReferencesSort = (current: StringReferencesSort | undefined, column: StringReferencesColumn): StringReferencesSort | undefined => {
  if (current?.column !== column)
    return { column, descending: false }
  return current.descending ? undefined : { column, descending: true }
}

export const referrerTextOf = (reference: StringReference): string => reference.referrerParts.map((part) => part.text).join('')

/** .NET's StringComparison.OrdinalIgnoreCase: the strings compared by their upper-cased UTF-16 code units. */
const compareOrdinalIgnoreCase = (a: string, b: string): number => {
  const x = a.toUpperCase()
  const y = b.toUpperCase()
  return x < y ? -1 : x > y ? 1 : 0
}

const compareOrdinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/**
 * StringReferenceComparer and its three columns. Every order starts with the kind — IL, then constants, then
 * attributes — except the literal and referrer orders, which compare their column first and fall back on it;
 * after the kind come the referrer's token and, for `ldstr`, the offset. The module order only tells IL rows
 * apart by their module, which is how dnSpy's ModuleComparer is written.
 */
export const compareStringReferences = (sort: StringReferencesSort | undefined) => {
  const sign = sort?.descending ? -1 : 1
  const byKindTokenOffset = (x: StringReference, y: StringReference, moduleFirst: boolean): number => {
    if (x.kind !== y.kind)
      return sign * (KIND_ORDER[x.kind] - KIND_ORDER[y.kind])
    if (moduleFirst && x.kind === 'il') {
      const modules = compareOrdinal(x.moduleName, y.moduleName)
      if (modules !== 0)
        return sign * modules
    }
    const tokens = (x.token >>> 0) - (y.token >>> 0)
    if (tokens !== 0 || x.kind !== 'il')
      return sign * Math.sign(tokens)
    return sign * ((x.ilOffset ?? 0) - (y.ilOffset ?? 0))
  }
  return (x: StringReference, y: StringReference): number => {
    switch (sort?.column) {
      case 'literal': {
        const result = compareOrdinalIgnoreCase(x.literal, y.literal)
        return result !== 0 ? sign * result : byKindTokenOffset(x, y, false)
      }
      case 'referrer': {
        const result = compareOrdinalIgnoreCase(referrerTextOf(x), referrerTextOf(y))
        return result !== 0 ? sign * result : byKindTokenOffset(x, y, false)
      }
      case 'module':
        return byKindTokenOffset(x, y, true)
      default:
        return byKindTokenOffset(x, y, false)
    }
  }
}

export const sortStringReferences = (references: readonly StringReference[], sort: StringReferencesSort | undefined): StringReference[] =>
  [...references].sort(compareStringReferences(sort))

/**
 * Answers whether a row is listed — or, when the options ask for a regular expression and the query is not one,
 * names the error instead; dnSpy then keeps the filter it had.
 */
export type StringReferencesFilter =
  | { matches(reference: StringReference): boolean; error?: undefined }
  | { matches?: undefined; error: string }

/**
 * StringsControlVM.ApplyFilter: a substring of the string, or a regular expression, matched with or without
 * case against the string as it is or as a C# literal. An empty query lists everything.
 */
export const stringReferencesFilter = (query: string, settings: StringReferencesSettings): StringReferencesFilter => {
  const text = (reference: StringReference): string => settings.matchFormatted ? reference.formattedLiteral : reference.literal
  if (settings.regex) {
    try {
      // No 'u' flag: .NET's syntax, which dnSpy's Regex reads, is closer to JavaScript's without it.
      const regex = new RegExp(query, settings.caseSensitive ? '' : 'i')
      return { matches: (reference) => regex.test(text(reference)) }
    } catch {
      return { error: 'Invalid regular expression pattern' }
    }
  }
  if (settings.caseSensitive)
    return { matches: (reference) => text(reference).includes(query) }
  const lowered = query.toLowerCase()
  return { matches: (reference) => text(reference).toLowerCase().includes(lowered) }
}
