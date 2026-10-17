import type { editor } from 'monaco-editor'
import { toHexColor } from './named-colors'
import { colorClassName, themeColor, themeKind, themeTextColor, type DsTheme } from './theme-service'

/**
 * A dnSpy theme as a Monaco theme: the text view's own colours (DefaultText, SelectedText, CurrentLine,
 * LineNumber, GlyphMargin and the rest of what dnSpy's WPF text view draws with) for the editor's chrome, and
 * one token rule per text colour. Code is tokenized into dnSpy's colour names — `keyword.cs`, `staticType.cs`,
 * `keyword.opcode.il` — so a rule says which of the theme's colours a token is drawn in.
 */

/** The text colours the C# tokenizer and the IL grammar name their tokens after. */
export const CODE_COLORS = [
  'Text', 'Operator', 'Punctuation', 'Number', 'Comment', 'Keyword', 'String', 'VerbatimString', 'Char',
  'Namespace', 'Type', 'SealedType', 'StaticType', 'Delegate', 'Enum', 'Interface', 'ValueType', 'Module',
  'TypeGenericParameter', 'MethodGenericParameter', 'InstanceMethod', 'StaticMethod', 'ExtensionMethod',
  'InstanceField', 'EnumField', 'LiteralField', 'StaticField', 'InstanceEvent', 'StaticEvent', 'InstanceProperty',
  'StaticProperty', 'Local', 'Parameter', 'PreprocessorKeyword', 'PreprocessorText', 'Label', 'OpCode',
  'ILDirective', 'ILModule', 'ExcludedCode', 'XmlDocCommentAttributeName', 'XmlDocCommentAttributeQuotes',
  'XmlDocCommentAttributeValue', 'XmlDocCommentCDataSection', 'XmlDocCommentComment', 'XmlDocCommentDelimiter',
  'XmlDocCommentEntityReference', 'XmlDocCommentName', 'XmlDocCommentProcessingInstruction', 'XmlDocCommentText',
  'XmlAttribute', 'XmlAttributeQuotes', 'XmlAttributeValue', 'XmlCDataSection', 'XmlComment', 'XmlDelimiter',
  'XmlKeyword', 'XmlName', 'XmlProcessingInstruction', 'XmlText', 'Error',
] as const

export type CodeColor = (typeof CODE_COLORS)[number]

/** The token a colour is written as in C#: its class name, which is also the one the backend's spans use. */
export const csharpToken = (color: CodeColor): string => `${colorClassName(color)}.cs`

/**
 * The tokens the IL grammar (il-language.ts) and Monaco's own VB and XML grammars produce, and the dnSpy colour
 * each stands for — dnSpy's IL writer colours opcodes, directives, labels and the rest of what these name.
 */
const MONARCH_TOKENS: readonly (readonly [string, CodeColor])[] = [
  ['keyword.directive.il', 'ILDirective'],
  ['keyword.opcode.il', 'OpCode'],
  ['keyword.modifier.il', 'Keyword'],
  ['type.keyword.il', 'Keyword'],
  ['type.identifier.il', 'Type'],
  ['constant.offset.il', 'Label'],
  ['constant.module-id.il', 'ILModule'],
  ['variable.il', 'Local'],
  ['identifier.member.il', 'InstanceMethod'],
  ['identifier.il', 'Text'],
  ['string.il', 'String'],
  ['string.escape.il', 'String'],
  ['number.il', 'Number'],
  ['number.float.il', 'Number'],
  ['number.hex.il', 'Number'],
  ['comment.il', 'Comment'],
  ['delimiter.il', 'Punctuation'],
  // Monaco's VB and XML grammars, by the prefixes their tokens share.
  ['keyword', 'Keyword'],
  ['comment', 'Comment'],
  ['string', 'String'],
  ['number', 'Number'],
  ['type', 'Type'],
  ['delimiter', 'Punctuation'],
  ['operator', 'Operator'],
  ['tag', 'XmlName'],
  ['metatag', 'XmlProcessingInstruction'],
  ['attribute.name', 'XmlAttribute'],
  ['attribute.value', 'XmlAttributeValue'],
]

const hex = (color: string | undefined): string | undefined => {
  const value = toHexColor(color)
  return value?.slice(1)
}

const tokenRule = (theme: DsTheme, token: string, color: CodeColor): editor.ITokenThemeRule => {
  const text = themeTextColor(theme, color)
  const styles = [text.bold ? 'bold' : '', text.italic ? 'italic' : ''].filter(Boolean).join(' ')
  return { token, foreground: hex(text.fg), fontStyle: styles || undefined }
}

const withColors = (entries: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).flatMap(([key, value]) => {
    const color = toHexColor(value)
    return color ? [[key, color]] : []
  }))

/** The Monaco base a theme builds on — only its chrome's leftovers (the find widget's icons and such) show. */
const monacoBase = (theme: DsTheme): editor.BuiltinTheme => {
  switch (themeKind(theme)) {
    case 'hc': return 'hc-black'
    case 'light': return 'vs'
    default: return 'vs-dark'
  }
}

/** The Monaco theme for a dnSpy theme; with `transparentBackground` the editor shows the background image through it. */
export const monacoThemeData = (theme: DsTheme, transparentBackground = false): editor.IStandaloneThemeData => {
  const defaultText = themeColor(theme, 'DefaultText')
  const rules: editor.ITokenThemeRule[] = [
    { token: '', foreground: hex(defaultText.fg), background: hex(defaultText.bg) },
    ...MONARCH_TOKENS.map(([token, color]) => tokenRule(theme, token, color)),
    ...CODE_COLORS.map((color) => tokenRule(theme, csharpToken(color), color)),
  ]
  const color = (name: string): ReturnType<typeof themeColor> => themeColor(theme, name)
  const colors = withColors({
    'editor.background': transparentBackground ? 'transparent' : defaultText.bg,
    'editor.foreground': defaultText.fg,
    'editorCursor.foreground': defaultText.fg,
    'editor.selectionBackground': color('SelectedText').bg,
    'editor.inactiveSelectionBackground': color('InactiveSelectedText').bg,
    // dnSpy draws the current line as a frame around it, the way Monaco's border does.
    'editor.lineHighlightBorder': color('CurrentLine').fg,
    'editorLineNumber.foreground': color('LineNumber').fg,
    'editorLineNumber.activeForeground': color('LineNumber').fg,
    'editorGutter.background': transparentBackground ? 'transparent' : color('GlyphMargin').bg,
    'editorWhitespace.foreground': color('VisibleWhitespace').fg,
    'editorBracketMatch.background': color('BraceMatching').bg,
    'editor.findMatchHighlightBackground': color('FindMatchHighlightMarker').bg,
    'editor.wordHighlightBackground': color('HighlightedReference').bg,
    'editor.wordHighlightStrongBackground': color('HighlightedWrittenReference').bg,
    'editorHoverWidget.background': color('QuickInfo').bg,
    'editorHoverWidget.foreground': color('QuickInfo').fg,
    'editorHoverWidget.border': color('QuickInfoBorder').bg,
    'editorSuggestWidget.background': color('CompletionToolTip').bg,
    'editorSuggestWidget.foreground': color('CompletionToolTip').fg,
    'editorSuggestWidget.border': color('CompletionToolTipBorder').bg,
    'editorSuggestWidget.highlightForeground': color('CompletionMatchHighlight').fg,
    'editorWidget.background': color('EnvironmentCommandBar').fg,
    'editorWidget.foreground': color('EnvironmentForeground').fg,
    'editorWidget.border': color('EnvironmentToolWindowBorder').bg,
    'input.background': color('CommonControlsTextBox').bg,
    'input.foreground': color('CommonControlsTextBox').fg,
    'input.border': color('CommonControlsTextBoxBorder').bg,
    'scrollbarSlider.background': color('EnvironmentScrollBarThumbBackground').bg,
    'scrollbarSlider.hoverBackground': color('EnvironmentScrollBarThumbMouseOverBackground').bg,
    'scrollbarSlider.activeBackground': color('EnvironmentScrollBarThumbPressedBackground').bg,
  })
  return { base: monacoBase(theme), inherit: true, rules, colors }
}

/**
 * The dnSpy colour of a token of C# by the TextMate scopes the grammar gave it, innermost first: the first
 * scope with a colour decides. This is what stands in for dnSpy's decompiler output, whose every token comes
 * with its colour, until the editor gets the backend's spans.
 */
const SCOPE_COLORS: readonly (readonly [string, CodeColor])[] = [
  ['comment.block.documentation', 'XmlDocCommentText'],
  ['punctuation.definition.tag', 'XmlDocCommentDelimiter'],
  ['entity.name.tag', 'XmlDocCommentName'],
  ['entity.other.attribute-name', 'XmlDocCommentAttributeName'],
  ['string.unquoted.cdata', 'XmlDocCommentCDataSection'],
  ['comment', 'Comment'],
  ['punctuation.definition.comment', 'Comment'],
  ['string.quoted.single', 'Char'],
  ['punctuation.definition.char', 'Char'],
  ['constant.character', 'String'],
  ['string', 'String'],
  ['punctuation.definition.string', 'String'],
  ['constant.numeric', 'Number'],
  ['constant.language', 'Keyword'],
  ['entity.name.variable.preprocessor.symbol', 'PreprocessorText'],
  ['string.unquoted.preprocessor', 'PreprocessorText'],
  ['keyword.preprocessor', 'PreprocessorKeyword'],
  ['meta.preprocessor', 'PreprocessorKeyword'],
  ['punctuation.separator.hash', 'PreprocessorKeyword'],
  ['keyword.operator.expression', 'Keyword'],
  ['keyword.operator', 'Operator'],
  ['keyword', 'Keyword'],
  ['storage', 'Keyword'],
  ['variable.language', 'Keyword'],
  ['entity.name.type.namespace', 'Namespace'],
  ['entity.name.type.struct', 'ValueType'],
  ['entity.name.type.interface', 'Interface'],
  ['entity.name.type.enum', 'Enum'],
  ['entity.name.type.delegate', 'Delegate'],
  ['entity.name.type.type-parameter', 'TypeGenericParameter'],
  ['entity.name.type', 'Type'],
  ['entity.name.function', 'InstanceMethod'],
  ['entity.name.label', 'Label'],
  ['entity.name.variable.enum-member', 'EnumField'],
  ['entity.name.variable.field', 'InstanceField'],
  ['entity.name.variable.property', 'InstanceProperty'],
  ['entity.name.variable.event', 'InstanceEvent'],
  ['entity.name.variable.parameter', 'Parameter'],
  ['entity.name.variable', 'Local'],
  ['variable.other.object.property', 'InstanceProperty'],
  ['variable.other.constant', 'LiteralField'],
  ['variable', 'Local'],
  ['invalid', 'Error'],
  ['punctuation', 'Punctuation'],
]

const scopeColor = (scope: string): CodeColor | undefined => {
  const name = scope.replace(/\.cs$/, '')
  return SCOPE_COLORS.find(([prefix]) => name === prefix || name.startsWith(`${prefix}.`))?.[1]
}

/** The Monaco token for a run of C# text, from the scopes the TextMate grammar put it in (outermost first). */
export const csharpTokenForScopes = (scopes: readonly string[]): string => {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const color = scopeColor(scopes[index])
    if (color)
      return csharpToken(color)
  }
  return csharpToken('Text')
}
