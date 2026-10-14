/**
 * Centralised store of option keys that the WPF AppSettingsDlg edits.
 *
 * Each "page" maps to an upstream `IAppSettingsPage` / `IAppSettingsPageContainer`
 * (see Extensions/dnSpy.Debugger/dnSpy.Debugger/Settings/DebuggerAppSettingsPage.cs
 * and dnSpy/dnSpy/Settings/Dialog/AppSettingsDlg.xaml.cs). Pages are grouped
 * into top-level categories that match the upstream tree shown in
 * dnSpy/dnSpy.Contracts.DnSpy/Settings/Dialog/AppSettingsConstants.cs.
 */

import { useSyncExternalStore } from 'react'
import type { SearchLocation, SearchType } from '../../../shared/protocol'

export type ThemeName = 'blue' | 'light' | 'dark' | 'hc'
/** Runtime kind hosted by the DAP backend (upstream `RuntimeDisplayName` is ".NET"). */
export type DebugEngine = 'dotnet'
/** Expression-evaluation language exposed by the .NET debug engine. */
export type DebugLanguage = 'C#' | 'Visual Basic'

export interface EnvironmentGeneralSettings {
  /** Colour theme, upstream's `ThemesVM` combo box. */
  theme: ThemeName
  allowMoreThanOneInstance: boolean
  /** "Decompile a member's enclosing class instead of the class member" */
  decompileFullType: boolean
  restoreTabs: boolean
  useMemoryMappedIO: boolean
  checkForUpdateOnStartup: boolean
}

export interface EnvironmentFontSettings {
  /** Family name of the editor font. */
  fontFamily: string
  fontSize: number
}

/**
 * Upstream's `CSharpDecompilerSettingsPage`, backed by ICSharpCode.Decompiler's
 * `DecompilerSettings`. The first block is read off the shipped 11.1.0 build; the
 * rest are dnSpy additions that no longer exist there, so their defaults could not be
 * verified from this checkout and are the conventional ILSpy choices.
 */
export interface CSharpDecompilerSettings {
  anonymousMethods: boolean
  yieldReturn: boolean
  asyncAwait: boolean
  queryExpressions: boolean
  expressionTrees: boolean
  useDebugSymbols: boolean
  showXmlDocumentation: boolean
  sortCustomAttributes: boolean
  fullyQualifyAllTypes: boolean
  fullyQualifyAmbiguousTypeNames: boolean
  removeEmptyDefaultConstructors: boolean
  showTokenAndRvaComments: boolean
  sortMembers: boolean
  forceShowAllMembers: boolean
  sortSystemUsingStatementsFirst: boolean
  useSourceCodeOrder: boolean
  oneCustomAttributePerLine: boolean
  allowFieldInitializers: boolean
  typeAddInternalModifier: boolean
  memberAddPrivateModifier: boolean
  hexadecimalNumbers: boolean
  emitCalliAsInvocationExpression: boolean
  insertParenthesesForReadability: boolean
  /** Display order of the member categories, one entry per combo box in the group box. */
  decompilationOrder: MemberKind[]
}

export interface ILDecompilerSettings {
  showXmlDocumentation: boolean
  showTokenAndRvaComments: boolean
  showILBytes: boolean
  showILComments: boolean
  sortMembers: boolean
  showPdbInfo: boolean
  hexadecimalNumbers: boolean
}

export interface DecompilerSettings {
  /** Shared by the C# and Visual Basic views. */
  cSharp: CSharpDecompilerSettings
  il: ILDecompilerSettings
}

/**
 * Keys bound by the debugger settings page, in the order the controls appear in
 * Extensions/dnSpy.Debugger/dnSpy.Debugger/Themes/wpf.styles.templates.xaml
 * (`DataTemplate` for `DebuggerAppSettingsPage`).
 *
 * `UseHexadecimal`, `UseDigitSeparators` and `ShowOnlyPublicMembers` also live in
 * upstream's `DebuggerSettings` but are toggled from the Processes / Modules /
 * Variables context menus, so they are deliberately absent here.
 */
export interface DebuggerOptions {
  // "Prevent code from detecting the debugger"
  antiIsDebuggerPresent: boolean
  antiCheckRemoteDebuggerPresent: boolean
  preventManagedDebuggerDetection: boolean
  antiNtRaiseHardError: boolean
  antiCloseHandle: boolean
  propertyEvalAndFunctionCalls: boolean
  useStringConversionFunction: boolean
  stepOverPropertiesAndOperators: boolean
  ignoreBreakInstructions: boolean
  autoOpenLocalsWindow: boolean
  useMemoryModules: boolean
  breakAllProcesses: boolean
  asyncDebugging: boolean
  focusActiveProcess: boolean
  focusDebuggerWhenProcessBreaks: boolean
  redirectGuiConsoleOutput: boolean
  enableManagedDebuggingAssistants: boolean
  enableJustMyCodeDebugging: boolean
  stepOverCodeInSystemModules: boolean
  onlyStepIntoCodeInPrimaryModule: boolean
  showRawStructureOfObjects: boolean
  ignoreUnhandledExceptions: boolean
  // "Suppress JIT optimization on module load"
  suppressJitOptimizationSystemModules: boolean
  suppressJitOptimizationProgramModules: boolean
  hideCompilerGeneratedMembers: boolean
  respectHideMemberAttributes: boolean
  hideDeprecatedError: boolean
  sortParameters: boolean
  sortLocals: boolean
  groupParametersAndLocalsTogether: boolean
  showCompilerGeneratedVariables: boolean
  showDecompilerGeneratedVariables: boolean
  showRawLocals: boolean
  showReturnValues: boolean
  highlightChangedVariables: boolean
  syntaxHighlight: boolean
  // "Language"
  debugEngine: DebugEngine
  debugLanguage: DebugLanguage
}

export type X86Disassembler = 'masm' | 'nasm' | 'gas'
export type EditorLanguageKey = 'cSharp' | 'visualBasic'
export type HexEditorView = 'hexViewer' | 'memoryWindow'
export type MemberKind = 'nestedTypes' | 'fields' | 'events' | 'properties' | 'methods'
export type DocumentFilterType = 'all' | 'allSupported' | 'dotNetOnly'
export type BlockStructureLineKind = 'solid' | 'dashed1' | 'dashed2' | 'dashed3' | 'dashed4'
export type HexOffsetFormat = 'hex' | 'cSharp' | 'vb' | 'masm'
export type ImagePlacement = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'top' | 'left' | 'right' | 'bottom' | 'center'
export type StretchMode = 'none' | 'fill' | 'uniform' | 'uniformToFill'
export type StretchDirectionMode = 'both' | 'upOnly' | 'downOnly'

/**
 * The four sub-pages shared by the Text Viewer, Code Editor, REPL and Output panes.
 * Upstream models them as one `AppSettingsPageBase` hierarchy per pane; the port lets
 * the panes share the shape and keeps the values separate.
 */
export interface EditorGeneralSettings {
  useVirtualSpace: boolean
  wordWrap: boolean
  showLineNumbers: boolean
  highlightCurrentLine: boolean
}

export interface EditorScrollBarSettings {
  horizontalScrollBar: boolean
  verticalScrollBar: boolean
}

export interface EditorTabSettings {
  tabSize: number
  indentSize: number
  convertTabsToSpaces: boolean
}

export interface EditorAdvancedSettings {
  /** "Compress blank lines" */
  compressEmptyOrWhitespaceLines: boolean
  compressNonLetterLines: boolean
  /** "Don't add extra line spacing" */
  minimumLineSpacing: boolean
  selectionMargin: boolean
  glyphMargin: boolean
  mouseWheelZoom: boolean
  zoomControl: boolean
}

/** The Text Viewer is the only pane whose Advanced page keeps the "General" group box. */
export interface TextViewerAdvancedSettings extends EditorAdvancedSettings {
  referenceHighlighting: boolean
  highlightRelatedKeywords: boolean
  highlightMatchingBrace: boolean
  lineSeparators: boolean
  showBlockStructure: boolean
  blockStructureLineKind: BlockStructureLineKind
}

export interface EditorPaneOptions<A = EditorAdvancedSettings> {
  general: EditorGeneralSettings
  scrollBars: EditorScrollBarSettings
  tabs: EditorTabSettings
  advanced: A
}

export interface OutputGeneralSettings extends EditorGeneralSettings {
  showTimestamps: boolean
  /** .NET custom date/time format string, e.g. "HH:mm:ss.fff". */
  timestampDateTimeFormat: string
}

export interface OutputPaneOptions extends EditorPaneOptions {
  general: OutputGeneralSettings
}

export interface DisassemblerSettings {
  /** x86 syntax used by the disassembler formatter. */
  syntax: X86Disassembler
  newTab: boolean
  showInstructionAddress: boolean
  showInstructionBytes: boolean
  showILCode: boolean
  showCode: boolean
  emptyLineBetweenBasicBlocks: boolean
  addLabels: boolean
}

/**
 * One x86 formatter's code style. The three dialects overlap heavily but not exactly
 * — masm and nasm add `spaceBetweenMemory*Operators` and `scaleBeforeIndex`, while
 * GAS adds `gasSpaceAfterMemoryOperandComma`, `gasNakedRegisters` and
 * `gasShowMnemonicSizeSuffix` — so a dialect's page renders a subset of these keys.
 */
export interface CodeStyleSettings {
  uppercasePrefixes: boolean
  uppercaseMnemonics: boolean
  uppercaseRegisters: boolean
  uppercaseKeywords: boolean
  uppercaseHex: boolean
  uppercaseAll: boolean
  spaceAfterOperandSeparator: boolean
  spaceAfterMemoryBracket: boolean
  spaceBetweenMemoryAddOperators: boolean
  spaceBetweenMemoryMulOperators: boolean
  scaleBeforeIndex: boolean
  alwaysShowScale: boolean
  alwaysShowSegmentRegister: boolean
  showZeroDisplacements: boolean
  leadingZeroes: boolean
  branchLeadingZeroes: boolean
  smallHexNumbersInDecimal: boolean
  addLeadingZeroToHexNumbers: boolean
  signedImmediateOperands: boolean
  signedMemoryDisplacements: boolean
  alwaysShowMemorySize: boolean
  ripRelativeAddresses: boolean
  showBranchSize: boolean
  usePseudoOps: boolean
  showSymbolAddress: boolean
  /** GAS only */
  gasSpaceAfterMemoryOperandComma: boolean
  gasNakedRegisters: boolean
  gasShowMnemonicSizeSuffix: boolean
  /** `NumberBase == Hexadecimal`; upstream starts in hexadecimal, so this reads as checked. */
  useHexNumbers: boolean
  /** 1-based column at which the operand column starts. */
  operandColumn: number
  hexPrefix: string
  hexSuffix: string
  digitSeparator: string
}

/** Shared by Compiler > C# and Compiler > Visual Basic; each page renders its own subset. */
export interface CompilerLanguageSettings {
  preprocessorSymbols: string
  optimize: boolean
  // C# only
  checkOverflow: boolean
  allowUnsafe: boolean
  // Visual Basic only
  optionExplicit: boolean
  optionInfer: boolean
  optionStrict: boolean
  optionCompareBinary: boolean
  embedVBRuntime: boolean
}

export interface HexEditorGeneralSettings {
  highlightCurrentLine: boolean
  highlightCurrentValue: boolean
  highlightStructureUnderMouseCursor: boolean
  valuesLowerCaseHex: boolean
  offsetLowerCaseHex: boolean
  enableColorization: boolean
  groupSizeInBytes: number
  hexOffsetFormat: HexOffsetFormat
  /** Name of the text encoding, as listed by .NET's `Encoding.GetEncodings()`. */
  encoding: string
}

export interface HexEditorAdvancedSettings {
  showColumnLines: boolean
  removeExtraTextLineVerticalPixels: boolean
  selectionMargin: boolean
  glyphMargin: boolean
  enableMouseWheelZoom: boolean
  zoomControl: boolean
}

/** The hex viewer and the debugger's Memory window expose the same three pages. */
export interface HexEditorPaneOptions {
  general: HexEditorGeneralSettings
  scrollBars: EditorScrollBarSettings
  advanced: HexEditorAdvancedSettings
}

export interface AssemblyExplorerSettings {
  filterDraggedItems: DocumentFilterType
  showToken: boolean
  showAssemblyVersion: boolean
  showAssemblyPublicKeyToken: boolean
  singleClickExpandsTreeViewChildren: boolean
  syntaxHighlight: boolean
  /** Display order of the member categories; one entry per position in the tree. */
  memberKindOrder: MemberKind[]
}

export interface BamlSettings {
  newLineOnAttributes: boolean
  useTabs: boolean
  disassembleBaml: boolean
}

export interface BackgroundImageSettings {
  /** Image files or folders, one path per line. */
  images: string
  imagePlacement: ImagePlacement
  opacity: number
  stretch: StretchMode
  stretchDirection: StretchDirectionMode
  /** How often the image rotates, as a .NET time span string. */
  interval: string
  zoom: number
  isRandom: boolean
  isEnabled: boolean
  horizontalOffset: number
  verticalOffset: number
  leftMarginWidthPercent: number
  rightMarginWidthPercent: number
  topMarginHeightPercent: number
  bottomMarginHeightPercent: number
  maxWidth: number
  maxHeight: number
}

/** dnSpy's BookmarksSettings — the options page's one box — together with its BookmarkDisplaySettings, the
 * Bookmarks window's own Show... options that its context menu switches and its Location column reads. */
export interface BookmarkSettings {
  syntaxHighlight: boolean
  showTokens: boolean
  showModuleNames: boolean
  showParameterTypes: boolean
  showParameterNames: boolean
  showDeclaringTypes: boolean
  showReturnTypes: boolean
  showNamespaces: boolean
  showIntrinsicTypeKeywords: boolean
}

/** dnSpy's AnalyzerSettings, which only the analyzer's own context menu changes — there is no page for them. */
export interface AnalyzerSettings {
  showToken: boolean
  syntaxHighlight: boolean
  singleClickExpandsChildren: boolean
}

/** dnSpy's SearchSettings: the search window's two boxes and the options its expander and its context menu
 * switch — kept from one session to the next the way dnSpy keeps them. */
export interface SearchSettings {
  searchType: SearchType
  location: SearchLocation
  syntaxHighlight: boolean
  matchWholeWords: boolean
  caseSensitive: boolean
  matchAnySearchTerm: boolean
  searchDecompiledData: boolean
  searchFrameworkAssemblies: boolean
  searchCompilerGeneratedMembers: boolean
}

export interface AppOptions {
  environmentGeneral: EnvironmentGeneralSettings
  environmentFont: EnvironmentFontSettings
  decompiler: DecompilerSettings
  debugger: DebuggerOptions
  disassembler: DisassemblerSettings
  disassemblerCodeStyle: Record<X86Disassembler, CodeStyleSettings>
  compiler: Record<EditorLanguageKey, CompilerLanguageSettings>
  documentViewer: EditorPaneOptions<TextViewerAdvancedSettings>
  output: OutputPaneOptions
  codeEditor: Record<EditorLanguageKey, EditorPaneOptions>
  repl: Record<EditorLanguageKey, EditorPaneOptions>
  assemblyExplorer: AssemblyExplorerSettings
  baml: BamlSettings
  hexEditor: Record<HexEditorView, HexEditorPaneOptions>
  backgroundImage: BackgroundImageSettings
  bookmarks: BookmarkSettings
  analyzer: AnalyzerSettings
  search: SearchSettings
}

const defaultEditorGeneral = (): EditorGeneralSettings => ({
  useVirtualSpace: false,
  wordWrap: true,
  showLineNumbers: true,
  highlightCurrentLine: true,
})

const defaultScrollBars = (): EditorScrollBarSettings => ({ horizontalScrollBar: true, verticalScrollBar: true })
const defaultTabs = (): EditorTabSettings => ({ tabSize: 4, indentSize: 4, convertTabsToSpaces: false })

const defaultAdvanced = (glyphMargin: boolean): EditorAdvancedSettings => ({
  compressEmptyOrWhitespaceLines: true,
  compressNonLetterLines: true,
  minimumLineSpacing: false,
  selectionMargin: true,
  glyphMargin,
  mouseWheelZoom: true,
  zoomControl: true,
})

/** The only default that separates the panes: the Indicator margin is hidden for Output and REPL. */
const defaultPane = (glyphMargin: boolean): EditorPaneOptions => ({
  general: defaultEditorGeneral(),
  scrollBars: defaultScrollBars(),
  tabs: defaultTabs(),
  advanced: defaultAdvanced(glyphMargin),
})

const defaultCodeStyle = (dialect: X86Disassembler): CodeStyleSettings => ({
  uppercasePrefixes: false,
  uppercaseMnemonics: false,
  uppercaseRegisters: false,
  uppercaseKeywords: false,
  uppercaseHex: true,
  uppercaseAll: false,
  spaceAfterOperandSeparator: false,
  spaceAfterMemoryBracket: false,
  spaceBetweenMemoryAddOperators: false,
  spaceBetweenMemoryMulOperators: false,
  scaleBeforeIndex: false,
  alwaysShowScale: false,
  alwaysShowSegmentRegister: false,
  showZeroDisplacements: false,
  leadingZeroes: false,
  branchLeadingZeroes: false,
  smallHexNumbersInDecimal: true,
  addLeadingZeroToHexNumbers: true,
  signedImmediateOperands: false,
  signedMemoryDisplacements: true,
  alwaysShowMemorySize: false,
  ripRelativeAddresses: false,
  showBranchSize: true,
  usePseudoOps: true,
  showSymbolAddress: true,
  gasSpaceAfterMemoryOperandComma: false,
  gasNakedRegisters: false,
  gasShowMnemonicSizeSuffix: false,
  useHexNumbers: true,
  operandColumn: 9,
  hexPrefix: dialect === 'gas' ? '0x' : '',
  hexSuffix: dialect === 'gas' ? '' : 'h',
  digitSeparator: '',
})

const defaultHexEditor = (): HexEditorPaneOptions => ({
  general: {
    highlightCurrentLine: true,
    highlightCurrentValue: true,
    highlightStructureUnderMouseCursor: true,
    valuesLowerCaseHex: false,
    offsetLowerCaseHex: false,
    enableColorization: true,
    groupSizeInBytes: 0,
    hexOffsetFormat: 'hex',
    encoding: 'utf8',
  },
  scrollBars: defaultScrollBars(),
  advanced: {
    showColumnLines: true,
    removeExtraTextLineVerticalPixels: false,
    selectionMargin: true,
    glyphMargin: true,
    enableMouseWheelZoom: true,
    zoomControl: true,
  },
})

export const defaultAppOptions: AppOptions = {
  environmentGeneral: {
    theme: 'dark',
    allowMoreThanOneInstance: true,
    decompileFullType: true,
    restoreTabs: true,
    useMemoryMappedIO: false,
    checkForUpdateOnStartup: true,
  },
  environmentFont: {
    // dnSpy picks the first of a list of families that is installed and sizes it at FontUtilities'
    // DEFAULT_FONT_SIZE, which is 10pt at 96 dpi — the 13 the editors were drawing at before this option was
    // read. The family is looked up with JetBrains Mono and the generic monospaced family behind it, so a
    // family the machine does not have leaves the editor as it was.
    fontFamily: 'Cascadia Mono',
    fontSize: 13,
  },
  decompiler: {
    cSharp: {
      anonymousMethods: true,
      yieldReturn: true,
      asyncAwait: true,
      queryExpressions: true,
      expressionTrees: true,
      useDebugSymbols: true,
      showXmlDocumentation: true,
      sortCustomAttributes: false,
      fullyQualifyAllTypes: false,
      fullyQualifyAmbiguousTypeNames: true,
      removeEmptyDefaultConstructors: true,
      showTokenAndRvaComments: false,
      sortMembers: false,
      forceShowAllMembers: false,
      sortSystemUsingStatementsFirst: true,
      useSourceCodeOrder: false,
      oneCustomAttributePerLine: false,
      allowFieldInitializers: true,
      typeAddInternalModifier: false,
      memberAddPrivateModifier: false,
      hexadecimalNumbers: true,
      emitCalliAsInvocationExpression: false,
      insertParenthesesForReadability: true,
      decompilationOrder: ['nestedTypes', 'fields', 'events', 'properties', 'methods'],
    },
    il: {
      showXmlDocumentation: true,
      showTokenAndRvaComments: true,
      showILBytes: true,
      showILComments: false,
      sortMembers: false,
      showPdbInfo: true,
      hexadecimalNumbers: false,
    },
  },
  debugger: {
    antiIsDebuggerPresent: true,
    antiCheckRemoteDebuggerPresent: true,
    preventManagedDebuggerDetection: true,
    antiNtRaiseHardError: false,
    antiCloseHandle: true,
    propertyEvalAndFunctionCalls: true,
    useStringConversionFunction: true,
    stepOverPropertiesAndOperators: true,
    ignoreBreakInstructions: false,
    autoOpenLocalsWindow: true,
    useMemoryModules: false,
    breakAllProcesses: true,
    asyncDebugging: true,
    focusActiveProcess: true,
    focusDebuggerWhenProcessBreaks: true,
    redirectGuiConsoleOutput: true,
    enableManagedDebuggingAssistants: true,
    enableJustMyCodeDebugging: false,
    stepOverCodeInSystemModules: false,
    onlyStepIntoCodeInPrimaryModule: false,
    showRawStructureOfObjects: false,
    ignoreUnhandledExceptions: false,
    suppressJitOptimizationSystemModules: true,
    suppressJitOptimizationProgramModules: true,
    hideCompilerGeneratedMembers: true,
    respectHideMemberAttributes: true,
    hideDeprecatedError: false,
    sortParameters: false,
    sortLocals: false,
    groupParametersAndLocalsTogether: false,
    showCompilerGeneratedVariables: false,
    showDecompilerGeneratedVariables: true,
    showRawLocals: false,
    showReturnValues: true,
    highlightChangedVariables: true,
    syntaxHighlight: true,
    debugEngine: 'dotnet',
    debugLanguage: 'C#',
  },
  disassembler: {
    syntax: 'masm',
    newTab: true,
    showInstructionAddress: true,
    showInstructionBytes: true,
    showILCode: false,
    showCode: true,
    emptyLineBetweenBasicBlocks: true,
    addLabels: true,
  },
  disassemblerCodeStyle: {
    masm: defaultCodeStyle('masm'),
    nasm: defaultCodeStyle('nasm'),
    gas: defaultCodeStyle('gas'),
  },
  compiler: {
    cSharp: {
      preprocessorSymbols: 'TRACE',
      optimize: true,
      checkOverflow: false,
      allowUnsafe: true,
      optionExplicit: false,
      optionInfer: false,
      optionStrict: false,
      optionCompareBinary: false,
      embedVBRuntime: false,
    },
    visualBasic: {
      preprocessorSymbols: 'TRACE',
      optimize: true,
      checkOverflow: false,
      allowUnsafe: false,
      optionExplicit: true,
      optionInfer: true,
      optionStrict: false,
      optionCompareBinary: true,
      embedVBRuntime: false,
    },
  },
  documentViewer: {
    ...defaultPane(true),
    advanced: {
      ...defaultAdvanced(true),
      referenceHighlighting: true,
      highlightRelatedKeywords: true,
      highlightMatchingBrace: true,
      lineSeparators: true,
      showBlockStructure: true,
      blockStructureLineKind: 'dashed3',
    },
  },
  output: {
    ...defaultPane(false),
    general: { ...defaultEditorGeneral(), showTimestamps: true, timestampDateTimeFormat: 'HH:mm:ss.fff' },
  },
  codeEditor: { cSharp: defaultPane(true), visualBasic: defaultPane(true) },
  repl: { cSharp: defaultPane(false), visualBasic: defaultPane(false) },
  assemblyExplorer: {
    filterDraggedItems: 'allSupported',
    showToken: true,
    showAssemblyVersion: true,
    showAssemblyPublicKeyToken: false,
    singleClickExpandsTreeViewChildren: true,
    syntaxHighlight: true,
    memberKindOrder: ['methods', 'properties', 'events', 'fields', 'nestedTypes'],
  },
  baml: {
    newLineOnAttributes: true,
    useTabs: true,
    disassembleBaml: false,
  },
  hexEditor: { hexViewer: defaultHexEditor(), memoryWindow: defaultHexEditor() },
  backgroundImage: {
    images: '',
    imagePlacement: 'bottomRight',
    opacity: 0.35,
    stretch: 'none',
    stretchDirection: 'both',
    interval: '00:05:00',
    zoom: 100,
    isRandom: false,
    isEnabled: true,
    horizontalOffset: 0,
    verticalOffset: 0,
    leftMarginWidthPercent: 0,
    rightMarginWidthPercent: 0,
    topMarginHeightPercent: 0,
    bottomMarginHeightPercent: 0,
    maxWidth: 0,
    maxHeight: 0,
  },
  bookmarks: {
    syntaxHighlight: true,
    showTokens: true,
    showModuleNames: false,
    showParameterTypes: true,
    showParameterNames: true,
    showDeclaringTypes: true,
    showReturnTypes: true,
    showNamespaces: false,
    showIntrinsicTypeKeywords: true,
  },
  analyzer: {
    showToken: true,
    syntaxHighlight: true,
    singleClickExpandsChildren: true,
  },
  search: {
    searchType: 'any',
    location: 'allFiles',
    syntaxHighlight: true,
    matchWholeWords: false,
    caseSensitive: false,
    matchAnySearchTerm: false,
    searchDecompiledData: true,
    searchFrameworkAssemblies: true,
    searchCompilerGeneratedMembers: true,
  },
}

const STORAGE_KEY = 'dnspy.appOptions.v1'

const deepMerge = <T>(target: T, source: Partial<T>): T => {
  const result = { ...target } as Record<string, unknown>
  for (const key of Object.keys(source)) {
    const incoming = (source as Record<string, unknown>)[key]
    const existing = result[key]
    if (incoming !== null && typeof incoming === 'object' && !Array.isArray(incoming) && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
      result[key] = deepMerge(existing, incoming as Record<string, unknown>)
    }
    else if (incoming !== undefined) {
      result[key] = incoming
    }
  }
  return result as T
}

export const loadAppOptions = (): AppOptions => {
  if (typeof localStorage === 'undefined')
    return cloneDefault()
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw)
    return cloneDefault()
  try {
    const parsed = JSON.parse(raw) as Partial<AppOptions>
    return deepMerge(cloneDefault(), parsed)
  }
  catch {
    return cloneDefault()
  }
}

export const saveAppOptions = (options: AppOptions): void => {
  if (typeof localStorage === 'undefined')
    return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  window.dispatchEvent(new Event(APP_OPTIONS_CHANGED_EVENT))
}

export const resetAppOptions = (): AppOptions => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY)
    window.dispatchEvent(new Event(APP_OPTIONS_CHANGED_EVENT))
  }
  return cloneDefault()
}

const cloneDefault = (): AppOptions => JSON.parse(JSON.stringify(defaultAppOptions)) as AppOptions

/** Fired on `window` when `saveAppOptions` or `resetAppOptions` has rewritten the stored options. */
export const APP_OPTIONS_CHANGED_EVENT = 'app-options-changed'

// The snapshot `useAppOptions` hands out; only the change event may swap it, so React sees a stable
// reference between them. It is loaded lazily — module evaluation is too early to read storage.
let optionsSnapshot: AppOptions | null = null

const subscribeToAppOptions = (onChange: () => void): (() => void) => {
  const listener = (): void => {
    optionsSnapshot = loadAppOptions()
    onChange()
  }
  window.addEventListener(APP_OPTIONS_CHANGED_EVENT, listener)
  return () => window.removeEventListener(APP_OPTIONS_CHANGED_EVENT, listener)
}

/**
 * Reads the options the way a bound control upstream does: the value tracks the dialog's save, which
 * is the only writer. Options live in localStorage alone, so this subscription is the one bridge
 * into render.
 */
export const useAppOptions = (): AppOptions =>
  useSyncExternalStore(subscribeToAppOptions, () => {
    optionsSnapshot ??= loadAppOptions()
    return optionsSnapshot
  })
