/**
 * dnSpy's tool window search (SearchMatcher and SearchColumnCommandParser): the search box of the Breakpoints, Attach
 * to Process and other list windows. A word must be found in some column; `-x text` must be found in the column
 * whose short option is `x`, and `-x! text` must not. A word in double quotes keeps its spaces, a backslash takes the
 * character after it as it is, and a word that starts with either is always text. Matching ignores case.
 */
export interface SearchColumn {
  id: string
  shortOption: string
  name: string
}

interface SearchCommand {
  column?: string
  text: string
  negate: boolean
}

const nextWord = (text: string, start: number): { word: string; isText: boolean; end: number } | undefined => {
  let position = start
  while (position < text.length && /\s/.test(text[position]))
    position++
  if (position === text.length)
    return undefined
  const first = text[position]
  const needEndQuote = first === '"'
  const isText = needEndQuote || first === '\\'
  if (needEndQuote)
    position++
  let word = ''
  while (position < text.length) {
    let character = text[position++]
    if (needEndQuote) {
      if (character === '"')
        break
    } else if (/\s/.test(character)) {
      break
    }
    if (character === '\\' && position < text.length)
      character = text[position++]
    word += character
  }
  return { word, isText, end: position }
}

const columnOption = (word: string, columns: readonly SearchColumn[]): { column: SearchColumn; negate: boolean } | undefined => {
  if (!word.startsWith('-'))
    return undefined
  const negate = word.endsWith('!')
  const name = word.slice(1, negate ? -1 : undefined)
  const column = columns.find((candidate) => candidate.shortOption === name)
  return column ? { column, negate } : undefined
}

/** SearchColumnCommandParser.GetSearchCommands. */
export const parseSearchCommands = (searchText: string, columns: readonly SearchColumn[]): SearchCommand[] => {
  const tokens: ({ kind: 'text'; text: string } | { kind: 'command'; column: string; negate: boolean })[] = []
  for (let word = nextWord(searchText, 0); word; word = nextWord(searchText, word.end)) {
    const option = word.isText ? undefined : columnOption(word.word, columns)
    tokens.push(option ? { kind: 'command', column: option.column.id, negate: option.negate } : { kind: 'text', text: word.word })
  }
  const commands: SearchCommand[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.kind === 'text') {
      commands.push({ text: token.text, negate: false })
      continue
    }
    const next = tokens[++index]
    if (next)
      commands.push({ column: token.column, text: next.kind === 'text' ? next.text : next.column, negate: token.negate })
  }
  return commands
}

const contains = (text: string, search: string): boolean => text.toLocaleLowerCase().includes(search.toLocaleLowerCase())

/** A search over a list's columns, answering whether a row's column texts match all of it. */
export class SearchMatcher {
  private commands: SearchCommand[] = []

  constructor(private readonly columns: readonly SearchColumn[]) {}

  setSearchText(searchText: string): this {
    this.commands = parseSearchCommands(searchText, this.columns)
    return this
  }

  /** SearchMatcher.IsMatchAll: `texts` holds a text per column, in the order the columns were given. */
  isMatchAll(texts: readonly string[]): boolean {
    for (const command of this.commands) {
      if (command.column === undefined) {
        if (!texts.some((text) => contains(text, command.text) !== command.negate))
          return false
      } else {
        const index = this.columns.findIndex((column) => column.id === command.column)
        if (index < 0 || contains(texts[index] ?? '', command.text) === command.negate)
          return false
      }
    }
    return true
  }

  /** SearchMatcher.GetMatchSpans: where a column's text matches, which the window highlights. */
  matchSpans(columnId: string, text: string): { start: number; length: number }[] {
    const spans: { start: number; length: number }[] = []
    if (!text)
      return spans
    const lower = text.toLocaleLowerCase()
    for (const command of this.commands) {
      if ((command.column !== undefined && command.column !== columnId) || command.negate || command.text.length === 0)
        continue
      const search = command.text.toLocaleLowerCase()
      for (let index = lower.indexOf(search); index >= 0; index = lower.indexOf(search, index + 1))
        spans.push({ start: index, length: search.length })
    }
    return spans
  }

  /** SearchMatcher.GetHelpText, with the window's own column names and the two lines it ends with. */
  helpText(t: (message: string, values?: Record<string, string | number>) => string): string {
    const lines = this.columns.map((column) => `-${column.shortOption} <text> ${t('Search column: {name}', { name: column.name })}`)
    if (this.columns.length > 0)
      lines.push('', t('Use \'{option}\' to invert the match, eg. {example}', { option: '-option!', example: `-${this.columns[0].shortOption}! <text>` }))
    return lines.join('\n')
  }
}
