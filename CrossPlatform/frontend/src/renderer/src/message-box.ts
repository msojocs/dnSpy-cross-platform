import { loadAppOptions, saveAppOptions } from './components/app-options'

/**
 * dnSpy's IMessageBoxService.ShowIgnorableMessage: the question is put with a "Don't show again" box beside
 * its buttons, and one the user has told it not to show again answers nothing at all. Every caller that
 * takes a suppressed answer as a "yes" — which is what dnSpy's own do, since the user asked not to be
 * troubled again — is what makes the box worth having.
 *
 * The ids are dnSpy's own, so a warning suppressed here is the same warning its WPF build suppresses.
 */
export const askIgnorableMessage = async (id: string, message: string, buttons: string[]): Promise<string | undefined> => {
  const options = loadAppOptions()
  if (options.environmentGeneral.ignoredWarnings.includes(id))
    return undefined
  const { button, dontShowAgain } = await window.dnSpy.askMessage(message, buttons)
  if (dontShowAgain) {
    saveAppOptions({
      ...options,
      environmentGeneral: {
        ...options.environmentGeneral,
        ignoredWarnings: [...options.environmentGeneral.ignoredWarnings, id],
      },
    })
  }
  return button
}

/** dnSpy's DebuggerImpl.DeleteAllBreakpointsAskUser; the id is the one it passes to the service. */
export const askDeleteAllBreakpointsId = '37250D26-E844-49F4-904B-29600B90476C'
