import type { DecompilerLanguage, DecompilerSettings } from '../../shared/protocol'
import type { AppOptions } from './components/app-options'

/** The decompiler settings the options pages hold, as the backend takes them with every document it decompiles. */
export const decompilerSettingsOf = (appOptions: AppOptions): DecompilerSettings => ({
  cSharp: {
    anonymousMethods: appOptions.decompiler.cSharp.anonymousMethods,
    yieldReturn: appOptions.decompiler.cSharp.yieldReturn,
    asyncAwait: appOptions.decompiler.cSharp.asyncAwait,
    queryExpressions: appOptions.decompiler.cSharp.queryExpressions,
    expressionTrees: appOptions.decompiler.cSharp.expressionTrees,
    useDebugSymbols: appOptions.decompiler.cSharp.useDebugSymbols,
    showXmlDocumentation: appOptions.decompiler.cSharp.showXmlDocumentation,
    sortCustomAttributes: appOptions.decompiler.cSharp.sortCustomAttributes,
    fullyQualifyAllTypes: appOptions.decompiler.cSharp.fullyQualifyAllTypes,
    fullyQualifyAmbiguousTypeNames: appOptions.decompiler.cSharp.fullyQualifyAmbiguousTypeNames,
    removeEmptyDefaultConstructors: appOptions.decompiler.cSharp.removeEmptyDefaultConstructors,
    showTokenAndRvaComments: appOptions.decompiler.cSharp.showTokenAndRvaComments,
    sortMembers: appOptions.decompiler.cSharp.sortMembers,
    forceShowAllMembers: appOptions.decompiler.cSharp.forceShowAllMembers,
    sortSystemUsingStatementsFirst: appOptions.decompiler.cSharp.sortSystemUsingStatementsFirst,
    useSourceCodeOrder: appOptions.decompiler.cSharp.useSourceCodeOrder,
    oneCustomAttributePerLine: appOptions.decompiler.cSharp.oneCustomAttributePerLine,
    allowFieldInitializers: appOptions.decompiler.cSharp.allowFieldInitializers,
    typeAddInternalModifier: appOptions.decompiler.cSharp.typeAddInternalModifier,
    memberAddPrivateModifier: appOptions.decompiler.cSharp.memberAddPrivateModifier,
    hexadecimalNumbers: appOptions.decompiler.cSharp.hexadecimalNumbers,
    emitCalliAsInvocationExpression: appOptions.decompiler.cSharp.emitCalliAsInvocationExpression,
    insertParenthesesForReadability: appOptions.decompiler.cSharp.insertParenthesesForReadability,
    decompilationOrder: [...appOptions.decompiler.cSharp.decompilationOrder],
  },
  il: {
    showXmlDocumentation: appOptions.decompiler.il.showXmlDocumentation,
    showTokenAndRvaComments: appOptions.decompiler.il.showTokenAndRvaComments,
    showILBytes: appOptions.decompiler.il.showILBytes,
    showILComments: appOptions.decompiler.il.showILComments,
    sortMembers: appOptions.decompiler.il.sortMembers,
    showPdbInfo: appOptions.decompiler.il.showPdbInfo,
    hexadecimalNumbers: appOptions.decompiler.il.hexadecimalNumbers,
  },
  baml: {
    newLineOnAttributes: appOptions.baml.newLineOnAttributes,
    useTabs: appOptions.baml.useTabs,
    disassembleBaml: appOptions.baml.disassembleBaml,
  },
  decompileFullType: appOptions.environmentGeneral.decompileFullType,
  useMemoryMappedIO: appOptions.environmentGeneral.useMemoryMappedIO,
})

/**
 * The settings a document of the language depends on, which is what dnSpy's DecompilationCache keys a document by
 * besides its decompiler and nodes (`decompiler.Settings`): the C# page for C# and Visual Basic, which share it, the
 * IL page for IL, both for IL with C#. The BAML page is part of every key, since a BAML resource shows its XAML in
 * whatever language the tab is in. Whole pages are compared, so an option added to one counts without being listed.
 */
export const settingsKeyOf = (language: DecompilerLanguage, appOptions: AppOptions): string => {
  const pages: unknown[] = []
  if (language !== 'il')
    pages.push(appOptions.decompiler.cSharp)
  if (language === 'il' || language === 'ilWithCSharp')
    pages.push(appOptions.decompiler.il)
  pages.push(appOptions.baml)
  return JSON.stringify(pages)
}

/** What has to be decompiled again after the options changed — the tabs of these languages, and the BAML documents. */
export interface DecompilerRefresh {
  languages: Set<DecompilerLanguage>
  baml: boolean
}

const samePage = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/**
 * dnSpy's DecompilerAppSettingsModifiedListener: a change on the C# page decompiles the C#, Visual Basic and IL with
 * C# tabs again, a change on the IL page the IL and IL with C# ones; BamlRefresher does the same for the documents
 * of BAML resources when the BAML page changes. DecompileFullType is a navigation option and refreshes nothing.
 */
export const decompilerRefreshOf = (before: AppOptions, after: AppOptions): DecompilerRefresh => {
  const languages = new Set<DecompilerLanguage>()
  if (!samePage(before.decompiler.cSharp, after.decompiler.cSharp)) {
    languages.add('cSharp')
    languages.add('visualBasic')
    languages.add('ilWithCSharp')
  }
  if (!samePage(before.decompiler.il, after.decompiler.il)) {
    languages.add('il')
    languages.add('ilWithCSharp')
  }
  return { languages, baml: !samePage(before.baml, after.baml) }
}
