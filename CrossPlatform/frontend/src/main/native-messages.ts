import type { UiLocale } from '../shared/protocol'
import { generatedNativeMessages } from './native-messages.generated'

// The strings the main process puts in front of the user itself: the titles and filters of the native file
// dialogs, and the buttons of the message boxes it asks. English is the neutral text, and Simplified Chinese
// is kept by hand, the way the renderer's table is. Every other language is dnSpy's own translation of the
// resource the English is quoted from, looked up by scripts/generate-locales.mjs — which has to be run again
// when a string is added here. A string dnSpy has no resource for is shown in English in those languages.
const en = {
  openAssembly: 'Open Assembly',
  dotNetAssemblies: '.NET Assemblies',
  allFiles: 'All Files',
  xmlFiles: 'XML Files',
  replaceResource: 'Replace Embedded Resource',
  resourceTooLarge: 'Resource files are limited to 64 MiB.',
  saveModuleAs: 'Save Module As',
  mergeWithAssembly: 'Merge with Assembly',
  saveCode: 'Save Code',
  saveResource: 'Save Resource',
  saveResources: 'Save Resources',
  codeFiles: 'Code Files',
  openBookmarks: 'Import Bookmarks',
  openBreakpoints: 'Import Breakpoints',
  selectDebugTarget: 'Select .NET Program to Debug',
  dotNetPrograms: '.NET Programs',
  selectDebugHost: 'Select Host Executable',
  executables: 'Executables',
  selectWorkingDirectory: 'Select Working Directory',
  selectDirectory: 'Select Directory',
  administrator: 'Administrator',
  ok: 'OK',
  dontShowAgain: "Don't show this message again",
  restartFailed: 'Could not restart with elevated rights',
  restartNoResponse: 'The window started with elevated rights never appeared',
  askSaveFile: 'The file hasn\'t been saved yet. Do you want to save it before continuing?',
  askSaveFiles: 'The files haven\'t been saved yet. Do you want to save them before continuing?',
  yes: 'Yes',
  no: 'No',
  cancel: 'Cancel',
}

export type NativeMessages = { readonly [Key in keyof typeof en]: string }

const zhCN: NativeMessages = {
  openAssembly: '打开程序集',
  dotNetAssemblies: '.NET 程序集',
  allFiles: '所有文件',
  xmlFiles: 'XML 文件',
  replaceResource: '替换嵌入的资源',
  resourceTooLarge: '资源文件不能超过 64 MiB。',
  saveModuleAs: '模块另存为',
  mergeWithAssembly: '与程序集合并',
  saveCode: '保存代码',
  saveResource: '保存资源',
  saveResources: '保存资源',
  codeFiles: '代码文件',
  openBookmarks: '导入书签',
  openBreakpoints: '导入断点',
  selectDebugTarget: '选择要调试的 .NET 程序',
  dotNetPrograms: '.NET 程序',
  selectDebugHost: '选择宿主可执行文件',
  executables: '可执行文件',
  selectWorkingDirectory: '选择工作目录',
  selectDirectory: '选择目录',
  administrator: '管理员',
  ok: '确定',
  dontShowAgain: '不再显示此消息',
  restartFailed: '无法以管理员身份重启',
  restartNoResponse: '以管理员身份启动的窗口始终没有出现',
  askSaveFile: '有一个文件尚未被保存，是否要在继续之前保存？',
  askSaveFiles: '有多个文件尚未被保存，是否要在继续前保存它们？',
  yes: '是',
  no: '否',
  cancel: '取消',
}

/** The native strings in a language, English where it has no translation for one. */
export const nativeMessagesFor = (locale: UiLocale): NativeMessages =>
  locale === 'en' ? en : locale === 'zh-CN' ? zhCN : { ...en, ...generatedNativeMessages[locale] }
