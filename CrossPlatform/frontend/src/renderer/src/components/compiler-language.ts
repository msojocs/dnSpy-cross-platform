import { compilerLanguageFor, useAppStore } from '../app-store'

/**
 * The language dnSpy's compiler commands are headed with and the image they wear: the decompiler's when it has a
 * compiler, C# otherwise — EditCodeVMCreator's GetHeader and GetIcon. Read when a menu is built, which is when
 * dnSpy reads it too.
 */
export const compilerCommandLanguage = (): { name: string; icon: string } =>
  compilerLanguageFor(useAppStore.getState().defaultLanguage) === 'visualBasic'
    ? { name: 'Visual Basic', icon: 'VBFileNode' }
    : { name: 'C#', icon: 'CSFileNode' }
