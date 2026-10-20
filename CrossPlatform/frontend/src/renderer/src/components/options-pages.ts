import { themeKey, themeMenuName, visibleThemes } from '../theme-service'

/**
 * Declarative description of the Options dialog tree.
 *
 * Upstream builds this tree from every exported `IAppSettingsPage`; a page's
 * position is its `Order`, and a page with a `ParentGuid` becomes a child of that
 * container (see dnSpy/dnSpy.Contracts.DnSpy/Settings/Dialog/AppSettingsConstants.cs
 * and dnSpy/dnSpy/Settings/Dialog/AppSettingsPageVM.cs). `PageSpec` mirrors that
 * one-for-one: `groups` describe the controls of a leaf page, `pages` its children
 * in the tree.
 */

export interface BaseControlSpec {
  /** English label, also the key used to look up a translation. */
  labelKey: string
  /**
   * Disable this control until this expression holds. A dot-path is on when its option is truthy; `!` before a
   * path negates it, and `|` joins alternatives — the shape upstream's `UseVirtualSpaceEnabled` needs, since
   * either toggling word wrap off or checking the box itself keeps the box usable.
   */
  enabledWhen?: string
  /** Turning this control off resets the listed option dot-paths. */
  resetWhenOff?: string[]
}

export interface CheckboxSpec extends BaseControlSpec {
  kind: 'checkbox'
  /** Path into AppOptions using dot notation, e.g. "debugger.ignoreBreakInstructions". */
  path: string
}

export interface SelectOption {
  value: string
  labelKey: string
}

export interface SelectSpec extends BaseControlSpec {
  kind: 'select'
  path: string
  /** The choices, or a function giving them for a list that is only known at run time (the loaded themes). */
  options: SelectOption[] | (() => SelectOption[])
}

export interface NumberSpec extends BaseControlSpec {
  kind: 'number'
  path: string
  min: number
  max: number
  step?: number
}

export interface TextSpec extends BaseControlSpec {
  kind: 'text'
  path: string
  /** Hint shown while the box is empty, matching the WPF placeholder text. */
  placeholder?: string
}

export interface TextAreaSpec extends BaseControlSpec {
  kind: 'textarea'
  path: string
  rows: number
}

/** A command button on a page, which acts on the options being edited rather than binding one of them. */
export interface ButtonSpec extends BaseControlSpec {
  kind: 'button'
  /** The option the button clears; the button is enabled while it holds anything. */
  path: string
}

/** The Environment › Font page's own controls: the category, its font family and its size (FontAppSettingsPage). */
export interface FontsSpec extends BaseControlSpec {
  kind: 'fonts'
  path: string
}

export type ControlSpec = CheckboxSpec | SelectSpec | NumberSpec | TextSpec | TextAreaSpec | ButtonSpec | FontsSpec

/** A select's choices, whether they are fixed or read when the page is shown. */
export const selectOptions = (spec: SelectSpec): SelectOption[] => typeof spec.options === 'function' ? spec.options() : spec.options

/** A group of controls. Upstream renders a titled group as a WPF `GroupBox`. */
export interface GroupSpec {
  id: string
  /** Group box header. Omit for a plain, untitled block of controls. */
  titleKey?: string
  /** Lay the controls out in this many columns (upstream uses 2 for the anti-debug grid). */
  columns?: number
  controls: ControlSpec[]
}

export interface PageSpec {
  id: string
  titleKey: string
  descriptionKey?: string
  /** Leaf pages render these groups. */
  groups?: GroupSpec[]
  /** Container pages render these children in the tree instead. */
  pages?: PageSpec[]
}

/**
 * A node may be both a page and a container: upstream's Disassembler node owns
 * controls *and* parents the Code Style sub-tree, so selection and expandability
 * are tracked separately.
 */
export const hasChildren = (page: PageSpec): boolean => (page.pages?.length ?? 0) > 0

export const pageControls = (page: PageSpec): ControlSpec[] =>
  page.groups?.flatMap((group) => group.controls) ?? []

/** The page a container node shows when it is selected: its first page descendant. */
export const firstSelectablePage = (page: PageSpec): PageSpec | undefined => {
  if (page.groups)
    return page
  return page.pages?.map(firstSelectablePage).find((found): found is PageSpec => found !== undefined)
}

/** Ancestor chain ending at the page with `id`, or undefined when it is not in the tree. */
export const findPagePath = (pages: PageSpec[], id: string, trail: PageSpec[] = []): PageSpec[] | undefined => {
  for (const page of pages) {
    const next = [...trail, page]
    if (page.id === id)
      return next
    const found = page.pages ? findPagePath(page.pages, id, next) : undefined
    if (found)
      return found
  }
  return undefined
}

/** Every option path that must be cleared when `path` is turned off. */
export const collectResets = (pages: PageSpec[]): Map<string, string[]> => {
  const resets = new Map<string, string[]>()
  const visit = (page: PageSpec): void => {
    for (const group of page.groups ?? []) {
      for (const control of group.controls) {
        if (control.resetWhenOff?.length)
          resets.set(control.path, control.resetWhenOff)
      }
    }
    page.pages?.forEach(visit)
  }
  pages.forEach(visit)
  return resets
}

/**
 * Upstream's Environment category has exactly two pages. "Integrate with Windows Explorer" (a registry-backed
 * shell setting) has no Electron equivalent, and "Reset ignored updates" belongs to the update check this port
 * leaves out, so neither is here. "Enable all warning messages" brings back every message a "Don't show again"
 * has silenced, which the port keeps with the rest of its options.
 *
 * The theme box is GeneralAppSettingsPage's ThemesVM: the themes the theme service shows, by the names
 * ThemeHelpers.GetName gives them — dnSpy's own four by their translated names.
 */
const themeOptions = (): SelectOption[] => visibleThemes().map((theme) => ({ value: themeKey(theme), labelKey: themeMenuName(theme) }))

const environmentCategory: PageSpec = {
  id: 'environment',
  titleKey: 'Environment',
  descriptionKey: 'Cross-cutting settings that affect every part of the app.',
  pages: [
    {
      id: 'environment.general',
      titleKey: 'General',
      descriptionKey: 'App-wide behaviour such as the colour theme, restart handling and update checks.',
      groups: [
        {
          id: 'general',
          controls: [
            { kind: 'select', path: 'environmentGeneral.theme', labelKey: 'Theme', options: themeOptions },
            { kind: 'checkbox', path: 'environmentGeneral.allowMoreThanOneInstance', labelKey: 'Allow more than one instance (restart required)' },
            { kind: 'checkbox', path: 'environmentGeneral.decompileFullType', labelKey: "Decompile a member's enclosing class instead of the class member" },
            { kind: 'checkbox', path: 'environmentGeneral.restoreTabs', labelKey: 'Restore tabs at startup' },
            { kind: 'checkbox', path: 'environmentGeneral.useMemoryMappedIO', labelKey: 'Use memory mapped I/O' },
            { kind: 'checkbox', path: 'environmentGeneral.checkForUpdateOnStartup', labelKey: 'Check for updates on startup' },
            { kind: 'button', path: 'environmentGeneral.ignoredWarnings', labelKey: 'Enable all warning messages' },
          ],
        },
      ],
    },
    {
      id: 'environment.font',
      titleKey: 'Font',
      descriptionKey: 'The fonts and sizes used by the text editor, the hex editor and the Output window.',
      groups: [
        {
          id: 'font',
          controls: [
            { kind: 'fonts', path: 'environmentFont.byTheme', labelKey: 'Font' },
          ],
        },
      ],
    },
  ],
}

const MEMBER_KIND_OPTIONS: SelectOption[] = [
  { value: 'nestedTypes', labelKey: 'Nested Types' },
  { value: 'fields', labelKey: 'Fields' },
  { value: 'events', labelKey: 'Events' },
  { value: 'properties', labelKey: 'Properties' },
  { value: 'methods', labelKey: 'Methods' },
]

/** Upstream renders one combo box per position, each free to repeat a member kind. */
const MEMBER_KIND_ORDER = ['methods', 'properties', 'events', 'fields', 'nestedTypes'] as const

/** The Decompiler's "Decompilation order" group box uses the same five member kinds. */
const DECOMPILATION_ORDER_OPTIONS: SelectOption[] = MEMBER_KIND_OPTIONS

const decompilerCategory: PageSpec = {
  id: 'decompiler',
  titleKey: 'Decompiler',
  descriptionKey: 'Settings that influence how .NET assemblies are decompiled into source code.',
  pages: [
    {
      id: 'decompiler.cSharp',
      titleKey: 'C# / Visual Basic (ILSpy)',
      groups: [
        {
          id: 'settings',
          controls: [
            { kind: 'checkbox', path: 'decompiler.cSharp.anonymousMethods', labelKey: 'Decompile anonymous methods/lambdas' },
            { kind: 'checkbox', path: 'decompiler.cSharp.yieldReturn', labelKey: 'Decompile enumerators (yield return)' },
            { kind: 'checkbox', path: 'decompiler.cSharp.asyncAwait', labelKey: 'Decompile async methods (async/await)' },
            { kind: 'checkbox', path: 'decompiler.cSharp.queryExpressions', labelKey: 'Decompile query expressions', enabledWhen: 'decompiler.cSharp.anonymousMethods' },
            { kind: 'checkbox', path: 'decompiler.cSharp.expressionTrees', labelKey: 'Decompile expression trees' },
            { kind: 'checkbox', path: 'decompiler.cSharp.useDebugSymbols', labelKey: 'Use variable names from debug symbols, if available' },
            { kind: 'checkbox', path: 'decompiler.cSharp.fullyQualifyAllTypes', labelKey: 'Add namespaces to all types' },
            { kind: 'checkbox', path: 'decompiler.cSharp.fullyQualifyAmbiguousTypeNames', labelKey: 'Add a namespace to types with the same name' },
            { kind: 'checkbox', path: 'decompiler.cSharp.showXmlDocumentation', labelKey: 'Show XML documentation in decompiled code' },
            { kind: 'checkbox', path: 'decompiler.cSharp.removeEmptyDefaultConstructors', labelKey: 'Remove empty default constructors' },
            { kind: 'checkbox', path: 'decompiler.cSharp.showTokenAndRvaComments', labelKey: 'Show tokens, RVAs and file offsets' },
            { kind: 'checkbox', path: 'decompiler.cSharp.sortMembers', labelKey: 'Sort methods, fields, properties, events and types' },
            { kind: 'checkbox', path: 'decompiler.cSharp.forceShowAllMembers', labelKey: 'Show hidden compiler generated types and methods' },
            { kind: 'checkbox', path: 'decompiler.cSharp.sortSystemUsingStatementsFirst', labelKey: "Place 'System' directives first when sorting usings" },
            { kind: 'checkbox', path: 'decompiler.cSharp.sortCustomAttributes', labelKey: 'Sort custom attributes' },
            { kind: 'checkbox', path: 'decompiler.cSharp.useSourceCodeOrder', labelKey: 'Order members in source code order' },
            { kind: 'checkbox', path: 'decompiler.cSharp.oneCustomAttributePerLine', labelKey: 'Show one custom attribute per line' },
            { kind: 'checkbox', path: 'decompiler.cSharp.allowFieldInitializers', labelKey: 'Allow field initializers' },
            { kind: 'checkbox', path: 'decompiler.cSharp.typeAddInternalModifier', labelKey: "Add 'internal' modifier to types" },
            { kind: 'checkbox', path: 'decompiler.cSharp.memberAddPrivateModifier', labelKey: "Add 'private' modifier to type members" },
            { kind: 'checkbox', path: 'decompiler.cSharp.hexadecimalNumbers', labelKey: 'Hexadecimal numbers' },
            { kind: 'checkbox', path: 'decompiler.cSharp.emitCalliAsInvocationExpression', labelKey: 'Decompile calli to invocation expression' },
            { kind: 'checkbox', path: 'decompiler.cSharp.insertParenthesesForReadability', labelKey: 'Insert parentheses for readability' },
          ],
        },
        {
          id: 'order',
          titleKey: 'Decompilation order',
          controls: MEMBER_KIND_ORDER.map((_, index) => ({
            kind: 'select' as const,
            path: `decompiler.cSharp.decompilationOrder.${index}`,
            labelKey: `Member kind ${index + 1}`,
            options: DECOMPILATION_ORDER_OPTIONS,
          })),
        },
      ],
    },
    {
      id: 'decompiler.il',
      titleKey: 'IL (ILSpy)',
      groups: [
        {
          id: 'settings',
          controls: [
            { kind: 'checkbox', path: 'decompiler.il.showXmlDocumentation', labelKey: 'Show XML documentation in decompiled code' },
            { kind: 'checkbox', path: 'decompiler.il.showTokenAndRvaComments', labelKey: 'Show tokens, RVAs and file offsets' },
            { kind: 'checkbox', path: 'decompiler.il.showILBytes', labelKey: 'Show IL instruction bytes' },
            { kind: 'checkbox', path: 'decompiler.il.showILComments', labelKey: 'Show IL opcode comments' },
            { kind: 'checkbox', path: 'decompiler.il.sortMembers', labelKey: 'Sort methods, fields, properties, events and types' },
            { kind: 'checkbox', path: 'decompiler.il.showPdbInfo', labelKey: 'Show line numbers and filenames if available' },
            { kind: 'checkbox', path: 'decompiler.il.hexadecimalNumbers', labelKey: 'Hexadecimal numbers' },
          ],
        },
      ],
    },
  ],
}

/**
 * The debugger settings page. Upstream exposes every debugger option as a single
 * `DebuggerAppSettingsPage` (`ORDER_DEBUGGER`) whose XAML lives in
 * Extensions/dnSpy.Debugger/dnSpy.Debugger/Themes/wpf.styles.templates.xaml, so the
 * groups and the control order below mirror that template one-for-one.
 */
const debuggerCategory: PageSpec = {
  id: 'debugger',
  titleKey: 'Debugger',
  descriptionKey: 'Settings shared by every debugger engine that the cross-platform backend supports.',
  groups: [
    {
      id: 'detection',
      titleKey: 'Prevent code from detecting the debugger',
      columns: 2,
      controls: [
        { kind: 'checkbox', path: 'debugger.antiIsDebuggerPresent', labelKey: 'IsDebuggerPresent' },
        { kind: 'checkbox', path: 'debugger.antiCheckRemoteDebuggerPresent', labelKey: 'CheckRemoteDebuggerPresent' },
        { kind: 'checkbox', path: 'debugger.preventManagedDebuggerDetection', labelKey: 'System.Diagnostics.Debugger' },
        { kind: 'checkbox', path: 'debugger.antiNtRaiseHardError', labelKey: 'NtRaiseHardError' },
        { kind: 'checkbox', path: 'debugger.antiCloseHandle', labelKey: 'CloseHandle' },
      ],
    },
    {
      id: 'options',
      controls: [
        {
          kind: 'checkbox',
          path: 'debugger.propertyEvalAndFunctionCalls',
          labelKey: 'Enable property evaluation and other implicit function calls',
          resetWhenOff: ['debugger.useStringConversionFunction'],
        },
        {
          kind: 'checkbox',
          path: 'debugger.useStringConversionFunction',
          labelKey: 'Call string-conversion function on objects in variables windows',
          enabledWhen: 'debugger.propertyEvalAndFunctionCalls',
        },
        { kind: 'checkbox', path: 'debugger.stepOverPropertiesAndOperators', labelKey: 'Step over properties and operators' },
        { kind: 'checkbox', path: 'debugger.ignoreBreakInstructions', labelKey: 'Ignore Debugger.Break() and break instructions' },
        { kind: 'checkbox', path: 'debugger.autoOpenLocalsWindow', labelKey: 'Show the Locals window when the debugger starts' },
        { kind: 'checkbox', path: 'debugger.useMemoryModules', labelKey: 'Debug files loaded from the process\' memory (uncheck to use disk files)' },
        { kind: 'checkbox', path: 'debugger.breakAllProcesses', labelKey: 'Break all processes when one process breaks' },
        { kind: 'checkbox', path: 'debugger.asyncDebugging', labelKey: 'Enable async debugging' },
        { kind: 'checkbox', path: 'debugger.focusActiveProcess', labelKey: 'Give focus to debugged process' },
        { kind: 'checkbox', path: 'debugger.focusDebuggerWhenProcessBreaks', labelKey: 'Bring dnSpy to the foreground when breaking in the debugger' },
        { kind: 'checkbox', path: 'debugger.redirectGuiConsoleOutput', labelKey: 'Redirect GUI applications\' console output to the Output window' },
        { kind: 'checkbox', path: 'debugger.enableManagedDebuggingAssistants', labelKey: 'Enable Managed Debugging Assistants (MDA)' },
        {
          kind: 'checkbox',
          path: 'debugger.enableJustMyCodeDebugging',
          labelKey: 'Enable Just My Code debugging support',
          resetWhenOff: ['debugger.stepOverCodeInSystemModules', 'debugger.onlyStepIntoCodeInPrimaryModule'],
        },
        {
          kind: 'checkbox',
          path: 'debugger.stepOverCodeInSystemModules',
          labelKey: 'Step over code in system modules',
          enabledWhen: 'debugger.enableJustMyCodeDebugging',
        },
        {
          kind: 'checkbox',
          path: 'debugger.onlyStepIntoCodeInPrimaryModule',
          labelKey: 'Only step into code located in primary module',
          enabledWhen: 'debugger.enableJustMyCodeDebugging',
        },
        { kind: 'checkbox', path: 'debugger.showRawStructureOfObjects', labelKey: 'Show raw structure of objects in variables windows' },
        { kind: 'checkbox', path: 'debugger.ignoreUnhandledExceptions', labelKey: 'Ignore unhandled exceptions' },
      ],
    },
    {
      id: 'jit',
      titleKey: 'Suppress JIT optimization on module load',
      controls: [
        { kind: 'checkbox', path: 'debugger.suppressJitOptimizationSystemModules', labelKey: 'System modules' },
        { kind: 'checkbox', path: 'debugger.suppressJitOptimizationProgramModules', labelKey: 'Program modules' },
      ],
    },
    {
      id: 'variables',
      controls: [
        { kind: 'checkbox', path: 'debugger.hideCompilerGeneratedMembers', labelKey: 'Hide compiler generated members' },
        { kind: 'checkbox', path: 'debugger.respectHideMemberAttributes', labelKey: 'Respect attributes that hide members' },
        { kind: 'checkbox', path: 'debugger.hideDeprecatedError', labelKey: 'Hide deprecated members in variables windows' },
        { kind: 'checkbox', path: 'debugger.sortParameters', labelKey: 'Sort parameters' },
        { kind: 'checkbox', path: 'debugger.sortLocals', labelKey: 'Sort locals' },
        { kind: 'checkbox', path: 'debugger.groupParametersAndLocalsTogether', labelKey: 'Group parameters and locals together' },
        { kind: 'checkbox', path: 'debugger.showCompilerGeneratedVariables', labelKey: 'Show compiler generated variables' },
        { kind: 'checkbox', path: 'debugger.showDecompilerGeneratedVariables', labelKey: 'Show decompiler generated variables' },
        { kind: 'checkbox', path: 'debugger.showRawLocals', labelKey: 'Show raw locals' },
        { kind: 'checkbox', path: 'debugger.showReturnValues', labelKey: 'Show return values' },
        { kind: 'checkbox', path: 'debugger.highlightChangedVariables', labelKey: 'Highlight changed variables in variables windows' },
        { kind: 'checkbox', path: 'debugger.syntaxHighlight', labelKey: 'Syntax highlight' },
      ],
    },
    {
      id: 'language',
      titleKey: 'Language',
      controls: [
        { kind: 'select', path: 'debugger.debugEngine', labelKey: 'Debug Engine', options: [{ value: 'dotnet', labelKey: '.NET' }] },
        {
          kind: 'select',
          path: 'debugger.debugLanguage',
          labelKey: 'Language',
          options: [
            { value: 'C#', labelKey: 'C#' },
            { value: 'Visual Basic', labelKey: 'Visual Basic' },
          ],
        },
      ],
    },
  ],
}

/**
 * Text Viewer, Code Editor, REPL and Output all expose the same
 * General / Scroll Bars / Tabs / Advanced sub-pages (`AppSettingsPage.Order`
 * ORDER_*_GENERAL 1000, _SCROLLBARS 2000, _TABS 3000, _ADVANCED 4000), so the control
 * lists are built from these helpers rather than repeated once per pane.
 */

/**
 * `Virtual space` is only offered where upstream's `UseVirtualSpaceEnabled` content
 * option is set, and the REPL does not support it at all, so callers opt in. Upstream's page also makes the two
 * options take turns: word wrap is greyed out while virtual space is on and the other way round, each staying
 * usable while it is checked so it can be switched off again.
 */
const generalGroup = (base: string, virtualSpace: boolean): GroupSpec => ({
  id: 'general',
  controls: [
    ...(virtualSpace
      ? [{
          kind: 'checkbox',
          path: `${base}.general.useVirtualSpace`,
          labelKey: 'Virtual space',
          enabledWhen: `${base}.general.useVirtualSpace | !${base}.general.wordWrap`,
        } as CheckboxSpec]
      : []),
    {
      kind: 'checkbox',
      path: `${base}.general.wordWrap`,
      labelKey: 'Word wrap',
      enabledWhen: `${base}.general.wordWrap | !${base}.general.useVirtualSpace`,
    },
    { kind: 'checkbox', path: `${base}.general.showLineNumbers`, labelKey: 'Line numbers' },
    { kind: 'checkbox', path: `${base}.general.highlightCurrentLine`, labelKey: 'Highlight current line' },
  ],
})

const scrollBarsGroup = (base: string): GroupSpec => ({
  id: 'scrollBars',
  controls: [
    { kind: 'checkbox', path: `${base}.scrollBars.horizontalScrollBar`, labelKey: 'Show horizontal scroll bar' },
    { kind: 'checkbox', path: `${base}.scrollBars.verticalScrollBar`, labelKey: 'Show vertical scroll bar' },
  ],
})

/** Upstream hard-disables the Tabs page in every pane, so the port keeps it read-only too. */
const tabsGroup = (base: string): GroupSpec => ({
  id: 'tabs',
  controls: [
    { kind: 'number', path: `${base}.tabs.tabSize`, labelKey: 'Tab size', min: 1, max: 60 },
    { kind: 'number', path: `${base}.tabs.indentSize`, labelKey: 'Indent size', min: 1, max: 60 },
    { kind: 'checkbox', path: `${base}.tabs.convertTabsToSpaces`, labelKey: 'Convert tabs to spaces' },
  ],
})

const BLOCK_STRUCTURE_LINE_KINDS: SelectOption[] = [
  { value: 'solid', labelKey: 'Solid lines' },
  { value: 'dashed1', labelKey: 'Dashed lines (1px)' },
  { value: 'dashed2', labelKey: 'Dashed lines (2px)' },
  { value: 'dashed3', labelKey: 'Dashed lines (3px)' },
  { value: 'dashed4', labelKey: 'Dashed lines (4px)' },
]

/**
 * The Advanced page. The leading "General" group box exists only in the Text Viewer
 * template; upstream has it commented out for the Code Editor, REPL and Output.
 */
const advancedGroups = (base: string, includeGeneral: boolean): GroupSpec[] => [
  ...(includeGeneral
    ? [{
        id: 'general',
        titleKey: 'General',
        controls: [
          { kind: 'checkbox', path: `${base}.advanced.referenceHighlighting`, labelKey: 'Highlight references' },
          { kind: 'checkbox', path: `${base}.advanced.highlightRelatedKeywords`, labelKey: 'Highlight related keywords' },
          { kind: 'checkbox', path: `${base}.advanced.highlightMatchingBrace`, labelKey: 'Highlight braces' },
          { kind: 'checkbox', path: `${base}.advanced.lineSeparators`, labelKey: 'Show procedure line separators' },
          { kind: 'checkbox', path: `${base}.advanced.showBlockStructure`, labelKey: 'Show indent guides' },
          {
            kind: 'select',
            path: `${base}.advanced.blockStructureLineKind`,
            labelKey: 'Indent guides style',
            enabledWhen: `${base}.advanced.showBlockStructure`,
            options: BLOCK_STRUCTURE_LINE_KINDS,
          },
        ],
      } as GroupSpec]
    : []),
  {
    id: 'lineHeight',
    titleKey: 'Line height',
    controls: [
      { kind: 'checkbox', path: `${base}.advanced.compressEmptyOrWhitespaceLines`, labelKey: 'Compress blank lines' },
      { kind: 'checkbox', path: `${base}.advanced.compressNonLetterLines`, labelKey: 'Compress lines that do not have any alphanumeric characters' },
      { kind: 'checkbox', path: `${base}.advanced.minimumLineSpacing`, labelKey: "Don't add extra line spacing" },
    ],
  },
  {
    id: 'margins',
    titleKey: 'Margins',
    controls: [
      { kind: 'checkbox', path: `${base}.advanced.selectionMargin`, labelKey: 'Selection margin' },
      { kind: 'checkbox', path: `${base}.advanced.glyphMargin`, labelKey: 'Indicator margin' },
    ],
  },
  {
    id: 'zoom',
    titleKey: 'Zoom',
    controls: [
      { kind: 'checkbox', path: `${base}.advanced.mouseWheelZoom`, labelKey: 'Mouse wheel zoom' },
      { kind: 'checkbox', path: `${base}.advanced.zoomControl`, labelKey: 'Zoom control' },
    ],
  },
]

/** Builds General / Scroll Bars / Tabs / Advanced for one editor pane. */
const panePages = (id: string, base: string, virtualSpace: boolean, advancedGeneral: boolean): PageSpec[] => [
  { id: `${id}.general`, titleKey: 'General', groups: [generalGroup(base, virtualSpace)] },
  { id: `${id}.scrollBars`, titleKey: 'Scroll Bars', groups: [scrollBarsGroup(base)] },
  { id: `${id}.tabs`, titleKey: 'Tabs', groups: [tabsGroup(base)] },
  { id: `${id}.advanced`, titleKey: 'Advanced', groups: advancedGroups(base, advancedGeneral) },
]

/**
 * The x86 code style pages. Every boolean is a `DisasmBooleanSetting`; upstream pairs
 * each one with a read-only text box showing an example disassembly, which the port
 * drops — a static sample carries no state and would need a live formatter.
 */
interface CodeStyleOption {
  key: string
  labelKey: string
}

/** masm and nasm expose the same options in the same order (shared formatter base). */
const MASM_NASM_STYLE: CodeStyleOption[] = [
  { key: 'uppercasePrefixes', labelKey: 'Upper case prefixes' },
  { key: 'uppercaseMnemonics', labelKey: 'Upper case mnemonics' },
  { key: 'uppercaseRegisters', labelKey: 'Upper case registers' },
  { key: 'uppercaseKeywords', labelKey: 'Upper case keywords' },
  { key: 'uppercaseHex', labelKey: 'Upper case hex numbers' },
  { key: 'uppercaseAll', labelKey: 'Upper case everything' },
  { key: 'spaceAfterOperandSeparator', labelKey: 'Space after operand separator' },
  { key: 'spaceAfterMemoryBracket', labelKey: 'Space after memory operand brackets' },
  { key: 'spaceBetweenMemoryAddOperators', labelKey: "Space between '+'" },
  { key: 'spaceBetweenMemoryMulOperators', labelKey: "Space between '*'" },
  { key: 'scaleBeforeIndex', labelKey: 'Show scale before index register' },
  { key: 'alwaysShowScale', labelKey: 'Always show the scale value' },
  { key: 'alwaysShowSegmentRegister', labelKey: 'Always show segment registers' },
  { key: 'showZeroDisplacements', labelKey: 'Show zero displacements' },
  { key: 'leadingZeroes', labelKey: 'Add leading zeroes' },
  { key: 'branchLeadingZeroes', labelKey: 'Add leading zeroes (branches)' },
  { key: 'smallHexNumbersInDecimal', labelKey: 'Show small numbers in decimal' },
  { key: 'addLeadingZeroToHexNumbers', labelKey: "Add leading '0' to hex numbers if needed" },
  { key: 'signedImmediateOperands', labelKey: 'Signed numbers' },
  { key: 'signedMemoryDisplacements', labelKey: 'Signed displacements' },
  { key: 'alwaysShowMemorySize', labelKey: 'Always show size of memory operands' },
  { key: 'ripRelativeAddresses', labelKey: 'RIP-relative addresses' },
  { key: 'showBranchSize', labelKey: 'Show branch size' },
  { key: 'usePseudoOps', labelKey: 'Pseudo instructions' },
  { key: 'showSymbolAddress', labelKey: 'Show symbol address' },
  { key: 'useHexNumbers', labelKey: 'Hex numbers' },
]

/** GAS shares most of the list but has its own extras and omissions. */
const GAS_STYLE: CodeStyleOption[] = [
  { key: 'uppercasePrefixes', labelKey: 'Upper case prefixes' },
  { key: 'uppercaseMnemonics', labelKey: 'Upper case mnemonics' },
  { key: 'uppercaseRegisters', labelKey: 'Upper case registers' },
  { key: 'uppercaseHex', labelKey: 'Upper case hex numbers' },
  { key: 'uppercaseAll', labelKey: 'Upper case everything' },
  { key: 'spaceAfterOperandSeparator', labelKey: 'Space after operand separator' },
  { key: 'spaceAfterMemoryBracket', labelKey: 'Space after memory operand brackets' },
  { key: 'gasSpaceAfterMemoryOperandComma', labelKey: 'Space after memory operand comma' },
  { key: 'alwaysShowScale', labelKey: 'Always show the scale value' },
  { key: 'alwaysShowSegmentRegister', labelKey: 'Always show segment registers' },
  { key: 'showZeroDisplacements', labelKey: 'Show zero displacements' },
  { key: 'leadingZeroes', labelKey: 'Add leading zeroes' },
  { key: 'branchLeadingZeroes', labelKey: 'Add leading zeroes (branches)' },
  { key: 'smallHexNumbersInDecimal', labelKey: 'Show small numbers in decimal' },
  { key: 'addLeadingZeroToHexNumbers', labelKey: "Add leading '0' to hex numbers if needed" },
  { key: 'signedImmediateOperands', labelKey: 'Signed numbers' },
  { key: 'signedMemoryDisplacements', labelKey: 'Signed displacements' },
  { key: 'ripRelativeAddresses', labelKey: 'RIP-relative addresses' },
  { key: 'usePseudoOps', labelKey: 'Pseudo instructions' },
  { key: 'showSymbolAddress', labelKey: 'Show symbol address' },
  { key: 'gasNakedRegisters', labelKey: 'Naked registers' },
  { key: 'gasShowMnemonicSizeSuffix', labelKey: 'Always show mnemonic size suffix' },
  { key: 'useHexNumbers', labelKey: 'Hex numbers' },
]

const codeStyleGroups = (dialect: string, style: CodeStyleOption[]): GroupSpec[] => [
  {
    id: 'style',
    controls: [
      ...style.map((option): CheckboxSpec => ({
        kind: 'checkbox',
        path: `disassemblerCodeStyle.${dialect}.${option.key}`,
        labelKey: option.labelKey,
      })),
      { kind: 'number', path: `disassemblerCodeStyle.${dialect}.operandColumn`, labelKey: 'Operand column', min: 1, max: 100 },
      { kind: 'text', path: `disassemblerCodeStyle.${dialect}.hexPrefix`, labelKey: 'Hex prefix' },
      { kind: 'text', path: `disassemblerCodeStyle.${dialect}.hexSuffix`, labelKey: 'Hex suffix' },
      { kind: 'text', path: `disassemblerCodeStyle.${dialect}.digitSeparator`, labelKey: 'Digit separator' },
    ],
  },
]

const documentViewerCategory: PageSpec = {
  id: 'documentViewer',
  titleKey: 'Text Viewer',
  pages: panePages('documentViewer', 'documentViewer', true, true),
}

const outputCategory: PageSpec = {
  id: 'output',
  titleKey: 'Output Window',
  pages: [
    {
      id: 'output.general',
      titleKey: 'General',
      groups: [
        {
          id: 'general',
          controls: [
            ...generalGroup('output', true).controls,
            { kind: 'checkbox', path: 'output.general.showTimestamps', labelKey: 'Show timestamps' },
            { kind: 'text', path: 'output.general.timestampDateTimeFormat', labelKey: 'Timestamp format', placeholder: 'HH:mm:ss.fff' },
          ],
        },
      ],
    },
    ...panePages('output', 'output', false, false).slice(1),
  ],
}

const CODE_EDITOR_LANGUAGES: Array<{ id: string; titleKey: string }> = [
  { id: 'cSharp', titleKey: 'C#' },
  { id: 'visualBasic', titleKey: 'Visual Basic' },
]

/**
 * The Code Editor (and REPL) category nests a node per language, and each of those
 * nests its own General / Scroll Bars / Tabs / Advanced pages — the three-level tree
 * built by dnSpy/dnSpy/Text/CodeEditor/AppSettingsPageProvider.cs.
 */
const languagePanePages = (categoryId: string, optionsKey: string, virtualSpace: boolean, advancedGeneral: boolean): PageSpec[] =>
  CODE_EDITOR_LANGUAGES.map((language) => ({
    id: `${categoryId}.${language.id}`,
    titleKey: language.titleKey,
    pages: panePages(`${categoryId}.${language.id}`, `${optionsKey}.${language.id}`, virtualSpace, advancedGeneral),
  }))

const codeEditorCategory: PageSpec = {
  id: 'codeEditor',
  titleKey: 'Code Editor',
  pages: languagePanePages('codeEditor', 'codeEditor', true, false),
}

const replCategory: PageSpec = {
  id: 'repl',
  titleKey: 'REPL',
  pages: languagePanePages('repl', 'repl', false, false),
}

const compilerCategory: PageSpec = {
  id: 'compiler',
  titleKey: 'Compiler',
  pages: [
    {
      id: 'compiler.cSharp',
      titleKey: 'C#',
      groups: [
        {
          id: 'general',
          controls: [
            { kind: 'text', path: 'compiler.cSharp.preprocessorSymbols', labelKey: 'Conditional compilation symbols', placeholder: 'TRACE' },
            { kind: 'checkbox', path: 'compiler.cSharp.optimize', labelKey: 'Optimize code' },
            { kind: 'checkbox', path: 'compiler.cSharp.checkOverflow', labelKey: 'Check for arithmetic overflow/underflow' },
            { kind: 'checkbox', path: 'compiler.cSharp.allowUnsafe', labelKey: 'Allow unsafe code' },
          ],
        },
      ],
    },
    {
      id: 'compiler.visualBasic',
      titleKey: 'Visual Basic',
      groups: [
        {
          id: 'general',
          controls: [
            { kind: 'text', path: 'compiler.visualBasic.preprocessorSymbols', labelKey: 'Conditional compilation symbols', placeholder: 'TRACE' },
            { kind: 'checkbox', path: 'compiler.visualBasic.optimize', labelKey: 'Optimize code' },
            { kind: 'checkbox', path: 'compiler.visualBasic.optionExplicit', labelKey: 'Option explicit' },
            { kind: 'checkbox', path: 'compiler.visualBasic.optionInfer', labelKey: 'Option infer' },
            { kind: 'checkbox', path: 'compiler.visualBasic.optionStrict', labelKey: 'Option strict' },
            { kind: 'checkbox', path: 'compiler.visualBasic.optionCompareBinary', labelKey: 'Option compare: binary' },
            { kind: 'checkbox', path: 'compiler.visualBasic.embedVBRuntime', labelKey: 'Embed Visual Basic runtime' },
          ],
        },
      ],
    },
  ],
}

/**
 * The Disassembler node is both a page and a container: it owns the viewer options and
 * parents the "Code Style" sub-tree (`CodeStyleAppSettingsPageContainer`).
 */
const disassemblerCategory: PageSpec = {
  id: 'disassembler',
  titleKey: 'Disassembler',
  groups: [
    {
      id: 'general',
      controls: [
        {
          kind: 'select',
          path: 'disassembler.syntax',
          labelKey: 'Syntax',
          options: [
            { value: 'masm', labelKey: 'masm' },
            { value: 'nasm', labelKey: 'nasm' },
            { value: 'gas', labelKey: 'AT&T' },
          ],
        },
        { kind: 'checkbox', path: 'disassembler.newTab', labelKey: 'Show disassembly in a new tab' },
        { kind: 'checkbox', path: 'disassembler.showInstructionAddress', labelKey: 'Show instruction address' },
        { kind: 'checkbox', path: 'disassembler.showInstructionBytes', labelKey: 'Show instruction bytes' },
        { kind: 'checkbox', path: 'disassembler.showILCode', labelKey: 'Show IL code' },
        { kind: 'checkbox', path: 'disassembler.showCode', labelKey: 'Show decompiled code' },
        { kind: 'checkbox', path: 'disassembler.emptyLineBetweenBasicBlocks', labelKey: 'Add an empty line between blocks' },
        { kind: 'checkbox', path: 'disassembler.addLabels', labelKey: 'Add labels' },
      ],
    },
  ],
  pages: [
    {
      id: 'disassembler.codeStyle',
      titleKey: 'Code Style',
      pages: [
        { id: 'disassembler.codeStyle.masm', titleKey: 'masm', groups: codeStyleGroups('masm', MASM_NASM_STYLE) },
        { id: 'disassembler.codeStyle.nasm', titleKey: 'nasm', groups: codeStyleGroups('nasm', MASM_NASM_STYLE) },
        { id: 'disassembler.codeStyle.gas', titleKey: 'AT&T', groups: codeStyleGroups('gas', GAS_STYLE) },
      ],
    },
  ],
}

const assemblyExplorerCategory: PageSpec = {
  id: 'assemblyExplorer',
  titleKey: 'Assembly Explorer',
  groups: [
    {
      id: 'general',
      controls: [
        {
          kind: 'select',
          path: 'assemblyExplorer.filterDraggedItems',
          labelKey: 'Dragged items filter',
          options: [
            { value: 'all', labelKey: 'All' },
            { value: 'allSupported', labelKey: 'All supported' },
            { value: 'dotNetOnly', labelKey: '.NET only' },
          ],
        },
        { kind: 'checkbox', path: 'assemblyExplorer.showToken', labelKey: 'Show metadata tokens' },
        { kind: 'checkbox', path: 'assemblyExplorer.showAssemblyVersion', labelKey: 'Show assembly version' },
        { kind: 'checkbox', path: 'assemblyExplorer.showAssemblyPublicKeyToken', labelKey: 'Show assembly public key token' },
        { kind: 'checkbox', path: 'assemblyExplorer.singleClickExpandsTreeViewChildren', labelKey: 'Single-click expands nodes' },
        { kind: 'checkbox', path: 'assemblyExplorer.syntaxHighlight', labelKey: 'Syntax highlight' },
      ],
    },
    {
      id: 'order',
      titleKey: 'Order (restart needed)',
      controls: MEMBER_KIND_ORDER.map((_, index) => ({
        kind: 'select' as const,
        path: `assemblyExplorer.memberKindOrder.${index}`,
        labelKey: `Member kind ${index + 1}`,
        options: MEMBER_KIND_OPTIONS,
      })),
    },
  ],
}

const bamlCategory: PageSpec = {
  id: 'baml',
  titleKey: 'BAML',
  groups: [
    {
      id: 'settings',
      controls: [
        { kind: 'checkbox', path: 'baml.newLineOnAttributes', labelKey: 'One attribute per line' },
        { kind: 'checkbox', path: 'baml.useTabs', labelKey: 'Use tabs' },
        { kind: 'checkbox', path: 'baml.disassembleBaml', labelKey: 'Disassemble BAML' },
      ],
    },
  ],
}

/** Both hex editor groups ("Default" and "Memory Window") reuse the same three pages. */
const hexEditorGroups = (base: string): PageSpec[] => [
  {
    id: `${base}.general`,
    titleKey: 'General',
    groups: [
      {
        id: 'general',
        controls: [
          { kind: 'checkbox', path: `${base}.general.highlightCurrentLine`, labelKey: 'Highlight current line' },
          { kind: 'checkbox', path: `${base}.general.highlightCurrentValue`, labelKey: 'Highlight current value' },
          { kind: 'checkbox', path: `${base}.general.highlightStructureUnderMouseCursor`, labelKey: 'Highlight structure under mouse cursor' },
          { kind: 'checkbox', path: `${base}.general.valuesLowerCaseHex`, labelKey: 'Lower case hex (values)' },
          { kind: 'checkbox', path: `${base}.general.offsetLowerCaseHex`, labelKey: 'Lower case hex (offset)' },
          { kind: 'checkbox', path: `${base}.general.enableColorization`, labelKey: 'Colorize the text' },
          { kind: 'number', path: `${base}.general.groupSizeInBytes`, labelKey: 'Group size', min: 0, max: 64 },
          {
            kind: 'select',
            path: `${base}.general.hexOffsetFormat`,
            labelKey: 'Offset',
            options: [
              { value: 'hex', labelKey: '6789ABCD' },
              { value: 'cSharp', labelKey: '0x6789ABCD' },
              { value: 'vb', labelKey: '&H6789ABCD' },
              { value: 'masm', labelKey: '6789ABCDh' },
            ],
          },
          {
            kind: 'select',
            path: `${base}.general.encoding`,
            labelKey: 'Encoding',
            options: [
              { value: 'utf8', labelKey: 'UTF-8' },
              { value: 'utf16', labelKey: 'UTF-16' },
              { value: 'utf16BE', labelKey: 'UTF-16 (Big Endian)' },
              { value: 'ascii', labelKey: 'ASCII' },
              { value: 'latin1', labelKey: 'Western European (ISO)' },
            ],
          },
        ],
      },
    ],
  },
  { id: `${base}.scrollBars`, titleKey: 'Scroll Bars', groups: [scrollBarsGroup(base)] },
  {
    id: `${base}.advanced`,
    titleKey: 'Advanced',
    groups: [
      {
        id: 'general',
        titleKey: 'General',
        controls: [
          { kind: 'checkbox', path: `${base}.advanced.showColumnLines`, labelKey: 'Show column line separators' },
          { kind: 'checkbox', path: `${base}.advanced.removeExtraTextLineVerticalPixels`, labelKey: "Don't add extra line spacing" },
        ],
      },
      {
        id: 'margins',
        titleKey: 'Margins',
        controls: [
          { kind: 'checkbox', path: `${base}.advanced.selectionMargin`, labelKey: 'Selection margin' },
          { kind: 'checkbox', path: `${base}.advanced.glyphMargin`, labelKey: 'Indicator margin' },
        ],
      },
      {
        id: 'zoom',
        titleKey: 'Zoom',
        controls: [
          { kind: 'checkbox', path: `${base}.advanced.mouseWheelZoom`, labelKey: 'Mouse wheel zoom' },
          { kind: 'checkbox', path: `${base}.advanced.zoomControl`, labelKey: 'Zoom control' },
        ],
      },
    ],
  },
]

const hexEditorCategory: PageSpec = {
  id: 'hexEditor',
  titleKey: 'Hex Editor',
  pages: [
    { id: 'hexEditor.hexViewer', titleKey: 'Default', pages: hexEditorGroups('hexEditor.hexViewer') },
    { id: 'hexEditor.memoryWindow', titleKey: 'Memory Window', pages: hexEditorGroups('hexEditor.memoryWindow') },
  ],
}

/**
 * Background Image. Upstream's page also carries a named-settings combo box, two file
 * pickers and a per-page Reset button; the port keeps a single settings set and has no
 * native file dialog wired to the options window, so only the value controls are here.
 */
const backgroundImageCategory: PageSpec = {
  id: 'backgroundImage',
  titleKey: 'Background Image',
  groups: [
    {
      id: 'general',
      controls: [
        { kind: 'textarea', path: 'backgroundImage.images', labelKey: 'Add paths to images and image folders, one path per line:', rows: 3, enabledWhen: 'backgroundImage.isEnabled' },
        {
          kind: 'select',
          path: 'backgroundImage.imagePlacement',
          labelKey: 'Placement',
          enabledWhen: 'backgroundImage.isEnabled',
          options: [
            { value: 'topLeft', labelKey: 'Top Left' },
            { value: 'topRight', labelKey: 'Top Right' },
            { value: 'bottomLeft', labelKey: 'Bottom Left' },
            { value: 'bottomRight', labelKey: 'Bottom Right' },
            { value: 'top', labelKey: 'Top' },
            { value: 'left', labelKey: 'Left' },
            { value: 'right', labelKey: 'Right' },
            { value: 'bottom', labelKey: 'Bottom' },
            { value: 'center', labelKey: 'Center' },
          ],
        },
        { kind: 'number', path: 'backgroundImage.opacity', labelKey: 'Opacity', min: 0, max: 1, step: 0.05, enabledWhen: 'backgroundImage.isEnabled' },
        {
          kind: 'select',
          path: 'backgroundImage.stretch',
          labelKey: 'Stretch',
          enabledWhen: 'backgroundImage.isEnabled',
          options: [
            { value: 'none', labelKey: 'None' },
            { value: 'fill', labelKey: 'Fill' },
            { value: 'uniform', labelKey: 'Uniform' },
            { value: 'uniformToFill', labelKey: 'UniformToFill' },
          ],
        },
        {
          kind: 'select',
          path: 'backgroundImage.stretchDirection',
          labelKey: 'Direction',
          enabledWhen: 'backgroundImage.isEnabled',
          options: [
            { value: 'both', labelKey: 'Both' },
            { value: 'upOnly', labelKey: 'Up Only' },
            { value: 'downOnly', labelKey: 'Down Only' },
          ],
        },
        { kind: 'text', path: 'backgroundImage.interval', labelKey: 'Interval', placeholder: '00:05:00', enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.zoom', labelKey: 'Zoom %', min: 1, max: 1000, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'checkbox', path: 'backgroundImage.isRandom', labelKey: 'Random Image', enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'checkbox', path: 'backgroundImage.isEnabled', labelKey: 'Show Images' },
        { kind: 'number', path: 'backgroundImage.horizontalOffset', labelKey: 'Horizontal Offset', min: -10000, max: 10000, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.verticalOffset', labelKey: 'Vertical Offset', min: -10000, max: 10000, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.leftMarginWidthPercent', labelKey: 'Left Margin %', min: 0, max: 100, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.rightMarginWidthPercent', labelKey: 'Right Margin %', min: 0, max: 100, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.topMarginHeightPercent', labelKey: 'Top Margin %', min: 0, max: 100, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.bottomMarginHeightPercent', labelKey: 'Bottom Margin %', min: 0, max: 100, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.maxWidth', labelKey: 'Max Width', min: 0, max: 10000, enabledWhen: 'backgroundImage.isEnabled' },
        { kind: 'number', path: 'backgroundImage.maxHeight', labelKey: 'Max Height', min: 0, max: 10000, enabledWhen: 'backgroundImage.isEnabled' },
      ],
    },
  ],
}

const bookmarksCategory: PageSpec = {
  id: 'bookmarks',
  titleKey: 'Bookmarks',
  groups: [
    {
      id: 'general',
      controls: [
        { kind: 'checkbox', path: 'bookmarks.syntaxHighlight', labelKey: 'Syntax highlight' },
      ],
    },
  ],
}

/** The dialog's tree, ordered like upstream's `AppSettingsPage.Order`. */
export const OPTION_PAGES: PageSpec[] = [
  environmentCategory,
  decompilerCategory,
  compilerCategory,
  debuggerCategory,
  disassemblerCategory,
  documentViewerCategory,
  codeEditorCategory,
  replCategory,
  outputCategory,
  assemblyExplorerCategory,
  bamlCategory,
  hexEditorCategory,
  backgroundImageCategory,
  bookmarksCategory,
]
