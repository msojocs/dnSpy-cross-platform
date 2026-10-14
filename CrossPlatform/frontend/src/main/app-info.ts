/** What dnSpy's AppWindow adds to the window title, one entry each, in the order it adds them. */
export interface AppTitleInfo {
  /** Which of the two processes the app runs as — dnSpy's "32-bit" or "64-bit". */
  bitness: string
  /** The framework underneath: dnSpy says ".NET Framework" or ".NET". */
  runtime?: string
  isDebugBuild?: boolean
  isAdministrator?: boolean
  /** dnSpy's User_Administrator resource, which is localized. */
  administratorText?: string
}

/**
 * dnSpy's AppWindow.GetDefaultTitle: "dnSpy <version> (<info>, <info>, ...)". The version comes from the
 * assembly's informational version there and from the packaged app here, and the infos are the bitness,
 * the framework and — said in the user's own language — whether the app has administrator rights.
 */
export const formatAppTitle = (appName: string, version: string, info: AppTitleInfo): string => {
  const infos = [info.bitness]
  if (info.runtime)
    infos.push(info.runtime)
  if (info.isDebugBuild)
    infos.push('Debug Build')
  if (info.isAdministrator)
    infos.push(info.administratorText ?? 'Administrator')
  return `${appName} ${version} (${infos.join(', ')})`
}
