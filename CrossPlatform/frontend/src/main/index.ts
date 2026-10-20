import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BackendClient } from './backend-client'
import { readBackgroundImages } from './background-images'
import { formatAppTitle } from './app-info'
import { focusProcessWindow } from './focus-process'
import { loadAppMainSettings, saveAppMainSettings, toAppMainSettings } from './app-settings'
import { parseCommandLine, userArguments } from './command-line'
import { DialogPathHistory } from './dialog-path-history'
import { waitForElevatedStart } from './elevated-start'
import { nativeMessagesFor } from './native-messages'
import { resourceFileName, resourceFileSegments } from './resource-files'
import { captureWindowState, loadWindowState, resolveWindowPlacement, saveWindowState, toSavedWindowState, type SavedWindowState } from './window-state'
import { readThemeFiles, themeDirectories } from './theme-files'
import { rendererEntries, resolveSettingsFile, SettingsFile } from './settings-file'
import { listSystemFonts } from './system-fonts'
import type { AnalyzeChildrenRequest, AnalyzerNode, AppCommandLine, BackendStatus, DebugLaunchOptions, DecompilerLanguage, SearchRequest, SearchResult, StringReference, StringReferencesSearchRequest, UiLocale } from '../shared/protocol'
import { isUiLocale, matchUiLocale } from '../shared/ui-locales'

let mainWindow: BrowserWindow | undefined
let backend: BackendClient | undefined
let dialogPathHistory: DialogPathHistory | undefined
let lastBackendStatus: BackendStatus = { state: 'starting' }
// The analyzer searches still running, by window and the key the renderer named each with, so a row
// collapsed mid-search can call its search off, and what a search finds as it goes reaches the window that
// asked: the map key is the progress token the backend hands back.
const analyzerRequests = new Map<string, { controller: AbortController; sender: WebContents; requestKey: string }>()
// The search window's searches still running, kept the same way: a new query calls the last one off.
const searchRequests = new Map<string, { controller: AbortController; sender: WebContents; requestKey: string }>()
const stringReferencesRequests = new Map<string, { controller: AbortController; sender: WebContents; requestKey: string }>()
// The save runs of the Save Module and Save Modules windows, whose Cancel calls them off.
const saveRequests = new Map<string, { controller: AbortController; sender: WebContents; requestKey: string }>()
let uiLocale: UiLocale = 'en'
// True while a restart-as-administrator request is being carried out, so a second one is ignored.
let restartInFlight = false
// True only for the close a successful restart asks for. The renderer's unsaved-edits guard must not
// stand in its way — that question was already answered before the request was made.
let closingForRestart = false
// Whether the renderer holds edits that have not been saved, which it reports as they change. The close is
// only held back while it does, so a window with nothing to lose still closes without a round trip.
let rendererDirty = false
// True once the renderer has answered that the window may close. The close a restart asks for, and the
// second one the answer itself makes, both need it — the question is put exactly once.
let closeApproved = false
// dnSpy's command line: the files to open, the member `--select` names in them, and `--no-load-files` (dnSpy spells
// it `--dont-load-files`; both are accepted so a script written against either works).
const commandLine = parseCommandLine(userArguments(process.argv, process.defaultApp === true), process.cwd())
/** When this process started, which is what `--show-startup-time` measures the app's loading against. */
const processStartTime = Date.now()

// dnSpy keeps its window state and the few settings the process itself needs in the user's dnSpy settings file.
// This port keeps them beside the dialog's remembered directories, in the directory Electron gives the app.
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json')
const appSettingsFile = path.join(app.getPath('userData'), 'app-settings.json')
// dnSpy's settings file, when `--settings-file` names one or a portable one sits beside the program: then all of
// it lives there, the renderer's options included, and the profile directory's files are left alone.
const settingsFilePath = resolveSettingsFile(commandLine.settingsFile, path.dirname(app.getPath('exe')))
const settingsFile = settingsFilePath ? new SettingsFile(settingsFilePath) : undefined
// The renderer of a run with a settings file gets a session of its own that is never written to disk, so the
// profile's options and those of the file stay apart; the preload fills its storage from the file.
const SETTINGS_FILE_PARTITION = 'dnspy-settings-file'
const appSettings = settingsFile ? toAppMainSettings(settingsFile.get('appSettings')) : loadAppMainSettings(appSettingsFile)
const readWindowState = (): SavedWindowState | undefined => settingsFile ? toSavedWindowState(settingsFile.get('windowState')) : loadWindowState(windowStateFile)
const writeWindowState = (state: SavedWindowState): void => {
  if (settingsFile)
    settingsFile.set('windowState', state)
  else
    saveWindowState(windowStateFile, state)
}

// dnSpy starts one instance and hands every later command line to the one already running
// (App.SwitchToOtherInstance) — which is what a desktop's "Open With" relies on — unless the command line asks
// for `--multiple` or the "allow more than one instance" option is on. The lock has to be taken before anything
// is created: the copy that fails to take it hands its arguments over and goes away without a window.
const keepsOneInstance = commandLine.singleInstance && !appSettings.allowMoreThanOneInstance
const isPrimaryInstance = !keepsOneInstance || app.requestSingleInstanceLock()

const nativeText = () => nativeMessagesFor(uiLocale)

// dnSpy's Constants.IsRunningAsAdministrator (a WindowsPrincipal role check) in Linux terms: the
// process is elevated when it owns uid 0.
const isRunningAsAdministrator = (): boolean => process.getuid?.() === 0

/** dnSpy's AppWindow.GetDefaultTitle. The version is the packaged app's; the infos are the ones dnSpy's
 * own main window carries, minus "Debug Build", which only a debug build of this port would have. */
const appTitle = (): string => formatAppTitle('dnSpy', app.getVersion(), {
  bitness: process.arch.includes('64') ? '64-bit' : '32-bit',
  runtime: '.NET',
  isAdministrator: isRunningAsAdministrator(),
  administratorText: nativeText().administrator,
})

// Set on the elevated copy so it can report back that it came up; see relaunchElevated.
const elevatedMarkerVariable = 'DNSPY_ELEVATED_MARKER'
// How long the polkit prompt and the elevated copy's startup get before the restart is called off.
const elevatedStartTimeoutMs = 30_000

// pkexec hands its command a stripped environment — HOME becomes the target user's, and the display
// and session variables are dropped — so an elevated GUI would start and die at once for want of a
// display. Put back the ones a desktop app needs, through env(1).
//
// WAYLAND_DISPLAY is left out on purpose, and the copy is sent to X11 instead (see relaunchElevated):
// a Wayland compositor authenticates its clients by uid, so the one running as root would be refused
// the user's socket. X11 authenticates by cookie, and XAUTHORITY is a file root can read.
const sessionEnvironment = (): string[] =>
  ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
    .flatMap((name) => process.env[name] ? [`${name}=${process.env[name]}`] : [])
const relaunchElevated = async (): Promise<string | undefined> => {
  // The marker goes in a directory of this process's own making: the elevated copy writes the file
  // as root, and /tmp's sticky bit would leave an unprivileged process unable to clear it away.
  // The directory must be readable by root so it can access the Xauthority copy inside.
  const markerDirectory = mkdtempSync(path.join(app.getPath('temp'), 'dnspy-elevated-'))
  chmodSync(markerDirectory, 0o755)
  const marker = path.join(markerDirectory, 'ready')
  const discardMarker = (): void => {
    try {
      rmSync(markerDirectory, { recursive: true, force: true })
    }
    catch {
      // A leftover directory under the temp path is not worth failing a restart over.
    }
  }
  const args = app.isPackaged ? [] : [app.getAppPath()]
  // The copy's own output goes to a file rather than a pipe: it outlives this process, and a pipe
  // whose reader has gone would hand it a broken stdout. It is also the only account of what a copy
  // that never puts a window up was doing.
  const logPath = path.join(markerDirectory, 'elevated.log')
  const logHandle = openSync(logPath, 'a')
  // pkexec strips most environment variables before passing control to the target program — only a
  // small allowlist (PATH, HOME, SHELL, etc.) survives the transition. Wrap everything in env(1) to
  // restore the session variables the elevated copy needs: DISPLAY and XAUTHORITY for X11, and the
  // DNSPY_ELEVATED_MARKER so the elevated copy can announce it came up.
  //
  // XAUTHORITY is a cookie file the user owns — pkexec's target runs as root and cannot read it.
  // Copy it into the marker directory (which root will be writing to anyway) so the elevated copy
  // has something to point XAUTHORITY at.
  const envVars = sessionEnvironment()
  const xauthorityIndex = envVars.findIndex((e) => e.startsWith('XAUTHORITY='))
  if (xauthorityIndex !== -1) {
    const originalXauthority = envVars[xauthorityIndex].split('=')[1]
    if (originalXauthority && existsSync(originalXauthority)) {
      const elevatedXauthority = path.join(markerDirectory, '.Xauthority')
      try {
        const xauthContent = readFileSync(originalXauthority)
        writeFileSync(elevatedXauthority, xauthContent, { mode: 0o644 })
        envVars[xauthorityIndex] = `XAUTHORITY=${elevatedXauthority}`
      }
      catch {
        // If we cannot copy the Xauthority, the elevated copy will fall back to software rendering.
      }
    }
  }
  const child = spawn('pkexec', [
    '--disable-internal-agent',
    '--keep-cwd',
    'env',
    ...envVars,
    `${elevatedMarkerVariable}=${marker}`,
    process.execPath,
    '--no-sandbox',
    '--ozone-platform=x11',
    ...args,
  ], { detached: true, stdio: ['ignore', logHandle, logHandle] })
  closeSync(logHandle)
  let spawnError = ''
  child.on('error', (error) => { spawnError += error.message })

  const failure = await waitForElevatedStart(
    child,
    marker,
    elevatedStartTimeoutMs,
    spawnError || nativeText().restartFailed,
    nativeText().restartNoResponse,
  )

  if (failure !== undefined) {
    if (child.pid !== undefined) {
      try {
        // The copy has this process group to itself, so this reaches whatever it started too.
        process.kill(-child.pid, 'SIGTERM')
      }
      catch {
        child.kill()
      }
    }
    const log = readFileSync(logPath, 'utf8').trim()
    if (log)
      console.error('[elevated restart]', log)
    discardMarker()
    // Whatever the copy said on its way out goes with the message: there is no window of its own to
    // look at, so this is the only account of why it never put one up.
    return log ? `${failure}\n\n${log.slice(-1500)}` : failure
  }
  discardMarker()
  child.unref()
  return undefined
}

// The elevated copy says hello this way, which is what tells the app that asked for it to stand down.
// It does so once its window is on screen rather than once the window object exists: the window is
// built hidden and only shown from ready-to-show, so announcing any earlier would let the app that
// asked for the restart quit out from under a copy the user cannot see yet.
const announceElevatedStart = (): void => {
  const marker = process.env[elevatedMarkerVariable]
  if (!marker)
    return
  try {
    writeFileSync(marker, String(process.pid))
  }
  catch {
    // Nothing to do about it here; the copy that is waiting will time out and say so.
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
  },
}])

const sendBackendStatus = (status: BackendStatus): void => {
  lastBackendStatus = status
  mainWindow?.webContents.send('backend:status', status)
}

const sendBackendNotification = (method: string, parameters: unknown): void => {
  if (method === 'debug/event')
    mainWindow?.webContents.send('debug:event', parameters)
  else if (method === 'analyze/progress') {
    // A batch for a search that was called off in the meantime has no one left to take it.
    const progress = parameters as { progressToken: string; start: number; children: AnalyzerNode[] }
    const request = analyzerRequests.get(progress.progressToken)
    if (request && !request.sender.isDestroyed())
      request.sender.send('analyze:progress', { requestKey: request.requestKey, start: progress.start, children: progress.children })
  } else if (method === 'search/progress') {
    const progress = parameters as { progressToken: string; start: number; results: SearchResult[] }
    const request = searchRequests.get(progress.progressToken)
    if (request && !request.sender.isDestroyed())
      request.sender.send('search:progress', { requestKey: request.requestKey, start: progress.start, results: progress.results })
  } else if (method === 'script/output') {
    mainWindow?.webContents.send('script:output', parameters)
  } else if (method === 'client/request') {
    void handleClientRequest(parameters as ClientRequest)
  } else if (method === 'module/saveProgress') {
    const progress = parameters as { progressToken: string; fileIndex: number; fileName: string; fileProgress: number; totalProgress: number }
    const request = saveRequests.get(progress.progressToken)
    if (request && !request.sender.isDestroyed())
      request.sender.send('module:saveProgress', { ...progress, progressToken: undefined, requestKey: request.requestKey })
  } else if (method === 'stringReferences/progress') {
    const progress = parameters as { progressToken: string; start: number; references: StringReference[] }
    const request = stringReferencesRequests.get(progress.progressToken)
    if (request && !request.sender.isDestroyed())
      request.sender.send('stringReferences:progress', { requestKey: request.requestKey, start: progress.start, references: progress.references })
  }
}

// What a script's message box and input box ask the client for. The host waits for the answer, so a
// question that cannot be shown has to be answered anyway — with the box closed.
interface ClientRequest {
  id: string
  method: string
  parameters: {
    message?: string
    buttons?: string[]
    label?: string
    defaultText?: string | null
    title?: string | null
    error?: string | null
  }
}

const answerClientRequest = (id: string, result: unknown): void =>
  backend?.notify('client/response', { id, result, error: null })

/** The text of one of dnSpy's MsgBox buttons. */
const msgBoxButtonLabel = (id: string): string => {
  const text = nativeText()
  switch (id) {
    case 'cancel': return text.cancel
    case 'yes': return text.yes
    case 'no': return text.no
    default: return text.ok
  }
}

const handleClientRequest = async (request: ClientRequest): Promise<void> => {
  const parameters = request.parameters ?? {}
  if (request.method === 'script/ask') {
    if (!mainWindow || mainWindow.webContents.isDestroyed()) {
      answerClientRequest(request.id, { text: null })
      return
    }
    mainWindow.webContents.send('script:ask', {
      id: request.id,
      label: parameters.label ?? '',
      defaultText: parameters.defaultText ?? null,
      title: parameters.title ?? null,
      error: parameters.error ?? null,
    })
    return
  }
  // dnSpy's MsgBox: a message and the buttons the script asked for. The answer is a button name.
  const names = parameters.buttons && parameters.buttons.length > 0 ? parameters.buttons : ['ok']
  if (!mainWindow) {
    answerClientRequest(request.id, { button: names[0] })
    return
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: parameters.title ?? 'dnSpy',
    message: parameters.message ?? '',
    buttons: names.map(msgBoxButtonLabel),
    defaultId: 0,
    cancelId: names.includes('cancel') ? names.indexOf('cancel') : -1,
    noLink: true,
  })
  answerClientRequest(request.id, { button: names[response] ?? names[0] })
}

const createWindow = (): void => {
  // dnSpy's SavedWindowStateRestorer: the size, position and state the window was left in, as long as what
  // was saved still lands on a display. A window left full screen comes back full screen, not maximized.
  const placement = resolveWindowPlacement(readWindowState(), screen.getAllDisplays().map((display) => display.bounds))
  const window = new BrowserWindow({
    title: appTitle(),
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    minWidth: 250,
    minHeight: 200,
    show: false,
    frame: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      ...(settingsFile ? { partition: SETTINGS_FILE_PARTITION } : {}),
    },
  })
  mainWindow = window
  if (placement.isMaximized)
    window.maximize()
  if (placement.isFullScreen)
    window.setFullScreen(true)
  // dnSpy's DocumentSaver.AskUserToSaveIfModified runs while the main window closes: unsaved work is offered
  // to be saved first, and "Cancel" keeps the window open. Whether there is any is the renderer's to know, so
  // the close is held back and the question put to it; the window state is written only once it lets go.
  // Restarting has already put that question — the renderer's guard must not stand in the way of it.
  window.on('close', (event) => {
    if (!closingForRestart && !closeApproved && rendererDirty) {
      event.preventDefault()
      window.webContents.send('app:closeRequested')
      return
    }
    writeWindowState(captureWindowState(window))
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send('backend:status', lastBackendStatus)
    announceElevatedStart()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[renderer load failed]', { errorCode, errorDescription, validatedURL })
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer process gone]', details)
    // If this is an elevated restart, the old window will be gone soon anyway — no need to treat it
    // as an unexpected crash of a process the user is still using.
    if (details.reason === 'clean-exit' || closingForRestart)
      return
    dialog.showErrorBox('dnSpy', `The renderer process exited unexpectedly: ${details.reason}`)
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current)
      event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
    restartInFlight = false
    closingForRestart = false
    closeApproved = false
    rendererDirty = false
  })
  const sendMaximizedState = (): void => {
    mainWindow?.webContents.send('window:maximized-changed', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendMaximizedState)
  mainWindow.on('unmaximize', sendMaximizedState)
  const sendFullScreenState = (): void => {
    mainWindow?.webContents.send('window:fullscreen-changed', mainWindow.isFullScreen())
  }
  mainWindow.on('enter-full-screen', sendFullScreenState)
  mainWindow.on('leave-full-screen', sendFullScreenState)

  if (process.env.ELECTRON_RENDERER_URL)
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else
    void mainWindow.loadURL('app://dnspy/index.html')
}

const registerAppProtocol = (): void => {
  const rendererRoot = path.resolve(__dirname, '../renderer')
  const handler = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
      const requestedPath = path.resolve(rendererRoot, relativePath)
      if (requestedPath !== rendererRoot && !requestedPath.startsWith(`${rendererRoot}${path.sep}`))
        return new Response('Forbidden', { status: 403 })
      const contents = await readFile(requestedPath)
      return new Response(contents, {
        headers: { 'Content-Type': contentTypeFor(requestedPath) },
      })
    } catch (error) {
      console.error('[app protocol]', error)
      return new Response('Not found', { status: 404 })
    }
  }
  protocol.handle('app', handler)
  // A run with a settings file shows the renderer in a session of its own, which needs the scheme too.
  if (settingsFile)
    session.fromPartition(SETTINGS_FILE_PARTITION).protocol.handle('app', handler)
}

const contentTypeFor = (filePath: string): string => {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    case '.ttf': return 'font/ttf'
    case '.woff': return 'font/woff'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

/**
 * Chromium commits localStorage to disk on its own schedule, so the session saved just before the
 * window went away can still be sitting in memory when the process ends. Without this the last state
 * of every run — which is the only state a restore ever reads — is the one that gets lost.
 */
function flushSessionStorage(): void {
  try {
    session.defaultSession.flushStorageData()
  } catch {
    // Storage is not reachable once the session is torn down; quitting must not be held up by it.
  }
}

const requireBackend = (): BackendClient => {
  if (!backend)
    throw new Error('The backend is not available.')
  return backend
}

const registerIpc = (): void => {
  // The assembly picker answers with the same file every time, so a test that wants a second, different
  // file — which is what shows an open appending to the tree — needs a counter to tell the picks apart.
  let openAssembliesCalls = 0
  ipcMain.handle('dialog:openAssemblies', async () => {
    if (!app.isPackaged && process.env.DNSPY_E2E_ASSEMBLY) {
      const second = process.env.DNSPY_E2E_SECOND_ASSEMBLY
      if (second && openAssembliesCalls++ > 0)
        return second.split(path.delimiter).filter(Boolean)
      return process.env.DNSPY_E2E_ASSEMBLY.split(path.delimiter).filter(Boolean)
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().openAssembly,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: nativeText().dotNetAssemblies, extensions: ['dll', 'exe', 'netmodule', 'winmd'] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0)
      return []
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return result.filePaths
  })
  ipcMain.handle('workspace:open', (_event, paths: string[]) => requireBackend().invoke('workspace/open', { paths }))
  ipcMain.handle('workspace:addModules', (_event, workspaceId: string, paths: string[]) => requireBackend().invoke('workspace/addModules', { workspaceId, paths }))
  ipcMain.handle('workspace:loadDependencies', (_event, workspaceId: string, nodeId: string, recursive: boolean) => requireBackend().invoke('workspace/loadDependencies', { workspaceId, nodeId, recursive }))
  ipcMain.handle('workspace:close', (_event, workspaceId: string) => requireBackend().invoke('workspace/close', { workspaceId }))
  ipcMain.handle('workspace:reload', (_event, workspaceId: string, autoLoadedPaths?: string[]) => requireBackend().invoke('workspace/reload', { workspaceId, autoLoadedPaths: autoLoadedPaths ?? null }))
  ipcMain.handle('workspace:sortAssemblies', (_event, workspaceId: string) => requireBackend().invoke('workspace/sortAssemblies', { workspaceId }))
  ipcMain.handle('workspace:removeModule', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('workspace/removeModule', { workspaceId, nodeId }))
  ipcMain.handle('workspace:removeModules', (_event, workspaceId: string, nodeIds: string[]) => requireBackend().invoke('workspace/removeModules', { workspaceId, nodeIds }))
  ipcMain.handle('workspace:getModifiedModules', (_event, workspaceId: string, nodeIds?: string[]) => requireBackend().invoke('workspace/getModifiedModules', { workspaceId, nodeIds }))
  ipcMain.handle('workspace:getCloseCandidates', (_event, workspaceId: string) => requireBackend().invoke('workspace/getCloseCandidates', { workspaceId }))
  ipcMain.handle('workspace:moveRoots', (_event, workspaceId: string, nodeIds: string[], index: number) => requireBackend().invoke('workspace/moveRoots', { workspaceId, nodeIds, index }))
  ipcMain.handle('workspace:dropFiles', (_event, workspaceId: string | null, paths: string[], index: number, filter: string) => requireBackend().invoke('workspace/dropFiles', { workspaceId, paths, index, filter }))
  ipcMain.handle('tree:activate', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('tree/activate', { workspaceId, nodeId }))
  ipcMain.handle('gac:list', () => requireBackend().invoke('gac/list', {}))
  ipcMain.handle('gac:getDetails', (_event, path: string) => requireBackend().invoke('gac/getDetails', { path }))
  ipcMain.handle('documentList:defaults', () => requireBackend().invoke('documentList/defaults', {}))
  ipcMain.handle('resource:getItems', (_event, workspaceId: string, nodeIds: string[], raw: boolean) => requireBackend().invoke('resource/getItems', { workspaceId, nodeIds, raw }))
  ipcMain.handle('resource:find', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('resource/find', { workspaceId, nodeId }))
  ipcMain.handle('resource:getItemNames', (_event, workspaceId: string, nodeIds: string[]) => requireBackend().invoke('resource/getItemNames', { workspaceId, nodeIds, raw: false }))
  ipcMain.handle('compiler:getAssemblyAttributesSource', (_event, workspaceId: string, nodeId: string, language?: string) => requireBackend().invoke('compiler/getAssemblyAttributesSource', { workspaceId, nodeId, language: language ?? 'csharp' }))
  ipcMain.handle('compiler:merge', async (_event, workspaceId: string, transactionId: string, nodeId: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().mergeWithAssembly,
      filters: [
        { name: nativeText().dotNetAssemblies, extensions: ['dll', 'exe', 'netmodule'] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0)
      return false
    const data = await readFile(result.filePaths[0])
    await requireBackend().invoke('compiler/merge', { workspaceId, transactionId, nodeId, base64Data: data.toString('base64') })
    return true
  })
  ipcMain.handle('compiler:compile', (_event, workspaceId: string, nodeId: string, mode: string, source: string, transactionId?: string, language?: string, settings?: Record<string, unknown>) =>
    requireBackend().invoke('compiler/compile', { workspaceId, nodeId, mode, source, transactionId, language: language ?? 'csharp', settings }))
  ipcMain.handle('assembly:getOptions', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('assembly/getOptions', { workspaceId, nodeId }))
  ipcMain.handle('assembly:setOptions', (_event, workspaceId: string, transactionId: string, nodeId: string, options: Record<string, unknown>) => requireBackend().invoke('assembly/setOptions', { workspaceId, transactionId, nodeId, options }))
  ipcMain.handle('module:getOptions', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('module/getOptions', { workspaceId, nodeId }))
  ipcMain.handle('module:setOptions', (_event, workspaceId: string, transactionId: string, nodeId: string, options: Record<string, unknown>) => requireBackend().invoke('module/setOptions', { workspaceId, transactionId, nodeId, options }))
  ipcMain.handle('resource:getOptions', (_event, workspaceId: string, resourceNodeId: string) => requireBackend().invoke('resource/getOptions', { workspaceId, resourceNodeId }))
  ipcMain.handle('resource:setOptions', (_event, workspaceId: string, transactionId: string, resourceNodeId: string, options: Record<string, unknown>) => requireBackend().invoke('resource/setOptions', { workspaceId, transactionId, resourceNodeId, options }))
  ipcMain.handle('resource:create', (_event, workspaceId: string, transactionId: string, ownerNodeId: string, options: Record<string, unknown>) => requireBackend().invoke('resource/create', { workspaceId, transactionId, ownerNodeId, ...options }))
  ipcMain.handle('resource:getElementOptions', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('resource/getElementOptions', { workspaceId, nodeId }))
  ipcMain.handle('resource:setElementOptions', (_event, workspaceId: string, transactionId: string, nodeId: string, options: Record<string, unknown>) => requireBackend().invoke('resource/setElementOptions', { workspaceId, transactionId, nodeId, options }))
  ipcMain.handle('resource:createElement', (_event, workspaceId: string, transactionId: string, resourceNodeId: string, options: Record<string, unknown>) => requireBackend().invoke('resource/createElement', { workspaceId, transactionId, resourceNodeId, ...options }))
  ipcMain.handle('tree:selectMember', (_event, workspaceId: string, paths: string[], member: string) => requireBackend().invoke('tree/selectMember', { workspaceId, paths, member }))
  ipcMain.handle('module:specialNode', (_event, workspaceId: string, nodeId: string, kind: string) => requireBackend().invoke('module/getSpecialNode', { workspaceId, nodeId, kind }))
  ipcMain.handle('tree:findByToken', (_event, workspaceId: string, nodeId: string, token: string) => requireBackend().invoke('tree/findByToken', { workspaceId, nodeId, token }))
  ipcMain.handle('tree:roots', (_event, workspaceId: string) => requireBackend().invoke('tree/getRoots', { workspaceId }))
  // A tree request can wait for a whole-assembly decompile because both operations use the
  // workspace's serialized model. Give it the same deadline as decompilation so a valid request
  // is not canceled merely because it was queued behind a long-running document operation.
  ipcMain.handle('tree:children', (_event, workspaceId: string, nodeId: string) =>
    requireBackend().invoke('tree/getChildren', { workspaceId, nodeId }, 600_000))
  ipcMain.handle('tree:node', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('tree/getNode', { workspaceId, nodeId }))
  // Asked for right after a document was decompiled, which is why it shares the long deadline the tree
  // requests above have.
  ipcMain.handle('tree:nodePath', (_event, workspaceId: string, nodeId: string) =>
    requireBackend().invoke('tree/getNodePath', { workspaceId, nodeId }, 600_000))
  // Decompiling an assembly root requires ILSpy to walk every type and build source/IL mappings. Large
  // assemblies can legitimately take several minutes; the generic RPC deadline is intentionally shorter
  // for interactive tree operations, so give this operation its own deadline.
  ipcMain.handle('document:decompile', (_event, workspaceId: string, nodeId: string, language: string, settings?: unknown) =>
    requireBackend().invoke('document/decompile', { workspaceId, nodeId, language, settings }, 600_000))
  ipcMain.handle('document:findMember', (_event, workspaceId: string, modulePath: string, metadataToken: number) => requireBackend().invoke('document/findMember', { workspaceId, modulePath, metadataToken }))
  // Quick Info is asked for on hover, so it takes the short interactive deadline the tree's own calls do.
  ipcMain.handle('document:quickInfo', (_event, workspaceId: string, request: Record<string, unknown>) =>
    requireBackend().invoke('document/quickInfo', { ...request, workspaceId }))
  // The Bookmarks window's Location column, and dnSpy's bookmark files. None of them needs a workspace: a
  // module the workspace does not hold — or a bookmark restored before anything was opened — is read from
  // its file.
  ipcMain.handle('bookmarks:formatLocations', async (_event, workspaceId: string | undefined, locations: unknown[], format: unknown) =>
    (await requireBackend().invoke<{ locations: unknown[] }>('bookmarks/formatLocations', { workspaceId: workspaceId ?? null, locations, format })).locations)
  ipcMain.handle('bookmarks:export', async (_event, workspaceId: string | undefined, bookmarks: unknown[]) =>
    (await requireBackend().invoke<{ xml: string }>('bookmarks/export', { workspaceId: workspaceId ?? null, bookmarks })).xml)
  ipcMain.handle('debug:codeTargets', (_event, workspaceId: string | undefined, references: unknown[]) =>
    requireBackend().invoke('debug/codeTargets', { workspaceId: workspaceId ?? null, references }))
  ipcMain.handle('breakpoints:export', async (_event, workspaceId: string | undefined, breakpoints: unknown[]) =>
    (await requireBackend().invoke<{ xml: string }>('breakpoints/export', { workspaceId: workspaceId ?? null, breakpoints })).xml)
  ipcMain.handle('breakpoints:import', (_event, workspaceId: string | undefined, xml: string) =>
    requireBackend().invoke('breakpoints/import', { workspaceId: workspaceId ?? null, xml }))
  ipcMain.handle('bookmarks:import', (_event, workspaceId: string | undefined, xml: string) =>
    requireBackend().invoke('bookmarks/import', { workspaceId: workspaceId ?? null, xml }))
  // A search walks every file it covers, which over the framework takes a while: it gets the long deadline,
  // and the renderer calls it off by the key it named it with when the query or an option changes.
  ipcMain.handle('search:run', async (event, workspaceId: string, request: SearchRequest, requestKey: string) => {
    const key = `${event.sender.id}:${requestKey}`
    const entry = { controller: new AbortController(), sender: event.sender, requestKey }
    searchRequests.set(key, entry)
    try {
      return await requireBackend().invoke('search/run', { workspaceId, ...request, progressToken: key }, 600_000, entry.controller.signal)
    } finally {
      if (searchRequests.get(key) === entry)
        searchRequests.delete(key)
    }
  })
  ipcMain.handle('search:cancel', (event, requestKey: string) => {
    searchRequests.get(`${event.sender.id}:${requestKey}`)?.controller.abort()
  })
  // The backend keeps the last few searches by the token they ran with, which a change of language writes again.
  ipcMain.handle('search:relabel', (event, workspaceId: string, requestKey: string, language: DecompilerLanguage, start: number, count: number) =>
    requireBackend().invoke('search/relabel', { workspaceId, progressToken: `${event.sender.id}:${requestKey}`, language, start, count }))
  // A string references scan reads every method body of the assemblies it covers; it gets the long deadline,
  // and the renderer calls it off by its key when a new scan replaces it.
  ipcMain.handle('stringReferences:search', async (event, workspaceId: string, request: StringReferencesSearchRequest, requestKey: string) => {
    const key = `${event.sender.id}:${requestKey}`
    const entry = { controller: new AbortController(), sender: event.sender, requestKey }
    stringReferencesRequests.set(key, entry)
    try {
      return await requireBackend().invoke('stringReferences/search', { workspaceId, ...request, progressToken: key }, 600_000, entry.controller.signal)
    } finally {
      if (stringReferencesRequests.get(key) === entry)
        stringReferencesRequests.delete(key)
    }
  })
  ipcMain.handle('stringReferences:cancel', (event, requestKey: string) => {
    stringReferencesRequests.get(`${event.sender.id}:${requestKey}`)?.controller.abort()
  })
  ipcMain.handle('analyze:nodes', (_event, workspaceId: string, nodeIds: string[], language?: DecompilerLanguage) => requireBackend().invoke('analyze/nodes', { workspaceId, nodeIds, language }))
  // An analyzer search walks every module that can see the member, which on a framework assembly takes a
  // while; it gets the long deadline, and the renderer can call it off by the key it named it with — a row
  // collapsed while its search runs, the way dnSpy cancels a search node that is folded away.
  ipcMain.handle('analyze:children', async (event, workspaceId: string, request: AnalyzeChildrenRequest, requestKey: string) => {
    const key = `${event.sender.id}:${requestKey}`
    const entry = { controller: new AbortController(), sender: event.sender, requestKey }
    analyzerRequests.set(key, entry)
    try {
      return await requireBackend().invoke('analyze/children', { workspaceId, ...request, progressToken: key }, 600_000, entry.controller.signal)
    } finally {
      if (analyzerRequests.get(key) === entry)
        analyzerRequests.delete(key)
    }
  })
  ipcMain.handle('analyze:cancel', (event, requestKey: string) => {
    analyzerRequests.get(`${event.sender.id}:${requestKey}`)?.controller.abort()
  })
  ipcMain.handle('hex:length', (_event, workspaceId: string, moduleId: string) => requireBackend().invoke('hex/getLength', { workspaceId, moduleId }))
  ipcMain.handle('hex:read', (_event, workspaceId: string, moduleId: string, offset: number, count: number) => requireBackend().invoke('hex/readRange', { workspaceId, moduleId, offset, count }))
  ipcMain.handle('hex:resolveTarget', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('hex/resolveTarget', { workspaceId, nodeId }))
  ipcMain.handle('hex:getStructure', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('hex/getStructure', { workspaceId, nodeId }))
  ipcMain.handle('metadata:getTable', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('metadata/getTable', { workspaceId, nodeId }))
  ipcMain.handle('metadata:getTableRows', (_event, workspaceId: string, nodeId: string, startRid: number, count: number) => requireBackend().invoke('metadata/getTableRows', { workspaceId, nodeId, startRid, count }))
  ipcMain.handle('metadata:sortTable', (_event, workspaceId: string, nodeId: string, rid: number, count: number) => requireBackend().invoke('metadata/sortTable', { workspaceId, nodeId, rid, count }))
  ipcMain.handle('metadata:tableText', (_event, workspaceId: string, nodeId: string, rids: number[]) => requireBackend().invoke('metadata/tableText', { workspaceId, nodeId, rids }))
  ipcMain.handle('metadata:findRecord', (_event, workspaceId: string, nodeId: string, token: number) => requireBackend().invoke('metadata/findRecord', { workspaceId, nodeId, token }))
  ipcMain.handle('hex:resolveStatement', (_event, workspaceId: string, modulePath: string, metadataToken: number, ilOffset: number, ilEndOffset: number) => requireBackend().invoke('hex/resolveStatement', { workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset }))
  ipcMain.handle('hex:patch', (_event, workspaceId: string, transactionId: string, nodeId: string, offset: number, base64Data: string) => requireBackend().invoke('edit/hexPatch', { workspaceId, transactionId, nodeId, offset, base64Data }))
  ipcMain.handle('hex:resolvePosition', (_event, workspaceId: string, moduleId: string, kind: string, value: number) => requireBackend().invoke('hex/resolvePosition', { workspaceId, moduleId, kind, value }))
  ipcMain.handle('hex:goToMetadata', (_event, workspaceId: string, moduleId: string, kind: string, value: number) => requireBackend().invoke('hex/goToMetadata', { workspaceId, moduleId, kind, value }))
  ipcMain.handle('hex:find', (_event, workspaceId: string, moduleId: string, base64Pattern: string, start: number, reverse: boolean, wrap: boolean) => requireBackend().invoke('hex/find', { workspaceId, moduleId, base64Pattern, start, reverse, wrap }))
  // dnSpy's Hex Editor › Save Selection: the bytes are read back in the same bounded chunks the view uses
  // and written to the file the user picks, so a selection of any size saves without being held twice.
  ipcMain.handle('hex:saveSelection', async (_event, workspaceId: string, moduleId: string, offset: number, count: number, suggestedName?: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: nativeText().saveCode,
      defaultPath: suggestedName ?? 'hex.bin',
      filters: [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath)
      return undefined
    const chunks: Buffer[] = []
    const maxRead = 1024 * 1024
    for (let position = 0; position < count; position += maxRead) {
      const read = Math.min(maxRead, count - position)
      const response = await requireBackend().invoke<{ base64Data: string }>('hex/readRange', { workspaceId, moduleId, offset: offset + position, count: read })
      chunks.push(Buffer.from(response.base64Data, 'base64'))
    }
    await writeFile(result.filePath, Buffer.concat(chunks))
    return result.filePath
  })
  ipcMain.handle('module:info', (_event, workspaceId: string, moduleId: string) => requireBackend().invoke('module/getInfo', { workspaceId, moduleId }))
  ipcMain.handle('edit:begin', (_event, workspaceId: string) => requireBackend().invoke('edit/begin', { workspaceId }))
  ipcMain.handle('edit:getMethodBody', (_event, workspaceId: string, methodNodeId: string) => requireBackend().invoke('edit/getMethodBody', { workspaceId, methodNodeId }))
  ipcMain.handle('edit:getIlBody', (_event, workspaceId: string, methodNodeId: string) => requireBackend().invoke('edit/getIlBody', { workspaceId, methodNodeId }))
  ipcMain.handle('edit:replaceIlBody', (_event, workspaceId: string, transactionId: string, methodNodeId: string, body: Record<string, unknown>) =>
    requireBackend().invoke('edit/replaceIlBody', { workspaceId, transactionId, methodNodeId, ...body }))
  ipcMain.handle('edit:transformIlBody', (_event, workspaceId: string, methodNodeId: string, operation: string, locals: unknown[], instructions: unknown[], selectedIndexes: number[], parameterNames: string[]) =>
    requireBackend().invoke('edit/transformIlBody', { workspaceId, methodNodeId, operation, locals, instructions, selectedIndexes, parameterNames }))
  ipcMain.handle('edit:getOptions', (_event, workspaceId: string, kind: string, request: { nodeId?: string, ownerNodeId?: string, isNew?: boolean }) => requireBackend().invoke('edit/getOptions', { workspaceId, kind, ...request }))
  ipcMain.handle('edit:create', (_event, workspaceId: string, transactionId: string, ownerNodeId: string, options: unknown, nested = false) => requireBackend().invoke('edit/create', { workspaceId, transactionId, ownerNodeId, options, nested }))
  ipcMain.handle('edit:setOptions', (_event, workspaceId: string, transactionId: string, nodeId: string, options: unknown) => requireBackend().invoke('edit/setOptions', { workspaceId, transactionId, nodeId, options }))
  ipcMain.handle('edit:rename', (_event, workspaceId: string, transactionId: string, nodeId: string, newName: string) => requireBackend().invoke('edit/rename', { workspaceId, transactionId, nodeId, newName }))
  ipcMain.handle('edit:delete', (_event, workspaceId: string, transactionId: string, nodeId: string) => requireBackend().invoke('edit/delete', { workspaceId, transactionId, nodeId }))
  ipcMain.handle('edit:setNamespace', (_event, workspaceId: string, transactionId: string, nodeId: string, newName: string) => requireBackend().invoke('edit/setNamespace', { workspaceId, transactionId, nodeId, newName }))
  ipcMain.handle('edit:replaceMethodBody', (_event, workspaceId: string, transactionId: string, methodNodeId: string, body: { maxStack: number; initLocals: boolean; instructions: unknown[] }, clearExceptionHandlers: boolean) => requireBackend().invoke('edit/replaceMethodBody', {
    workspaceId,
    transactionId,
    methodNodeId,
    instructions: body.instructions,
    maxStack: body.maxStack,
    initLocals: body.initLocals,
    clearExceptionHandlers,
  }))
  ipcMain.handle('edit:replaceResourceFromFile', async (_event, workspaceId: string, transactionId: string, resourceNodeId: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().replaceResource,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openFile'],
      filters: [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0)
      return false
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    const data = await readFile(result.filePaths[0])
    if (data.length > 64 * 1024 * 1024)
      throw new Error(nativeText().resourceTooLarge)
    await requireBackend().invoke('edit/replaceResource', {
      workspaceId,
      transactionId,
      resourceNodeId,
      base64Data: data.toString('base64'),
    })
    return true
  })
  ipcMain.handle('edit:convertModule', (_event, workspaceId: string, transactionId: string, nodeId: string, toAssembly: boolean) => requireBackend().invoke('edit/convertModule', { workspaceId, transactionId, nodeId, toAssembly }))
  ipcMain.handle('edit:replaceMethodBodyWithStub', (_event, workspaceId: string, transactionId: string, methodNodeId: string) => requireBackend().invoke('edit/replaceMethodBodyWithStub', { workspaceId, transactionId, methodNodeId }))
  ipcMain.handle('edit:commit', (_event, workspaceId: string, transactionId: string) => requireBackend().invoke('edit/commit', { workspaceId, transactionId }))
  ipcMain.handle('edit:rollback', (_event, workspaceId: string, transactionId: string) => requireBackend().invoke('edit/rollback', { workspaceId, transactionId }))
  ipcMain.handle('edit:undo', (_event, workspaceId: string) => requireBackend().invoke('edit/undo', { workspaceId }))
  ipcMain.handle('edit:redo', (_event, workspaceId: string) => requireBackend().invoke('edit/redo', { workspaceId }))
  ipcMain.handle('module:saveAs', async (_event, workspaceId: string, moduleId: string, suggestedName: string, options?: Record<string, unknown>) => {
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_PATH) {
      return requireBackend().invoke('module/saveAsWithOptions', {
        workspaceId,
        moduleId,
        destinationPath: process.env.DNSPY_E2E_SAVE_PATH,
        overwrite: true,
        options,
      })
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: nativeText().saveModuleAs,
      defaultPath: suggestedName,
      filters: [
        { name: nativeText().dotNetAssemblies, extensions: ['dll', 'exe', 'netmodule'] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath)
      return undefined
    return requireBackend().invoke('module/saveAsWithOptions', {
      workspaceId,
      moduleId,
      destinationPath: result.filePath,
      overwrite: true,
      options,
    })
  })
  // Save and Save All write back over the files the assemblies came from, so neither has a dialog to
  // go through — unlike Save As, which is the one that needs a destination.
  ipcMain.handle('module:save', (_event, workspaceId: string, moduleId: string) =>
    requireBackend().invoke('module/save', { workspaceId, moduleId }))
  ipcMain.handle('module:saveAll', (_event, workspaceId: string, options?: Record<string, unknown>) =>
    requireBackend().invoke('module/saveAllWithOptions', { workspaceId, options }))
  ipcMain.handle('workspace:create', () => requireBackend().invoke('workspace/create', {}))
  ipcMain.handle('assembly:create', (_event, workspaceId: string, transactionId: string, options: Record<string, unknown>, clrVersion: string) =>
    requireBackend().invoke('assembly/create', { workspaceId, transactionId, options, clrVersion }))
  ipcMain.handle('module:createNetModule', (_event, workspaceId: string, transactionId: string, name: string, mvid: string, clrVersion: string) =>
    requireBackend().invoke('module/createNetModule', { workspaceId, transactionId, name, mvid, clrVersion }))
  ipcMain.handle('module:addNetModule', (_event, workspaceId: string, transactionId: string, assemblyNodeId: string, module: Record<string, unknown>) =>
    requireBackend().invoke('module/addNetModule', { workspaceId, transactionId, assemblyNodeId, ...module }))
  ipcMain.handle('module:removeNetModule', (_event, workspaceId: string, transactionId: string, moduleNodeId: string) =>
    requireBackend().invoke('module/removeNetModule', { workspaceId, transactionId, moduleNodeId }))
  ipcMain.handle('module:netModuleDefaults', (_event, workspaceId: string, assemblyNodeId: string) =>
    requireBackend().invoke('module/getNetModuleDefaults', { workspaceId, assemblyNodeId }))
  // dnSpy's NetModuleFilter for Add Existing NetModule. A test names the file up front.
  ipcMain.handle('dialog:pickNetModule', async () => {
    if (!app.isPackaged && process.env.DNSPY_E2E_NETMODULE_PATH)
      return process.env.DNSPY_E2E_NETMODULE_PATH
    const text = nativeText()
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: `${text.dotNetNetModules} (*.netmodule)`, extensions: ['netmodule'] }, { name: text.allFiles, extensions: ['*'] }],
    })
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0]
  })
  // dnSpy's PickFilenameConstants.ImagesFilter. A test names the files up front.
  ipcMain.handle('dialog:pickImages', async (_event, multiple: boolean, includeCursors: boolean) => {
    const e2ePaths = !app.isPackaged ? process.env.DNSPY_E2E_IMAGE_PATHS : undefined
    let paths: string[]
    if (e2ePaths) {
      paths = e2ePaths.split(path.delimiter).filter(Boolean)
    }
    else {
      const text = nativeText()
      const extensions = ['png', 'gif', 'bmp', 'dib', 'jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'ico', ...(includeCursors ? ['cur'] : [])]
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: text.images, extensions }, { name: text.allFiles, extensions: ['*'] }],
      })
      if (result.canceled)
        return []
      paths = result.filePaths
    }
    const files = []
    for (const file of paths)
      files.push({ name: path.basename(file), base64Data: (await readFile(file)).toString('base64') })
    return files
  })
  ipcMain.handle('document:getIlBytes', (_event, workspaceId: string, modulePath: string, instructions: unknown[]) =>
    requireBackend().invoke('document/getIlBytes', { workspaceId, modulePath, instructions }))
  ipcMain.handle('workspace:modifiedDocuments', async (_event, workspaceId: string) =>
    (await requireBackend().invoke<{ documents: unknown[] }>('workspace/getModifiedDocuments', { workspaceId })).documents)
  ipcMain.handle('module:saveOptions', (_event, workspaceId: string, documentId: string, useMixedMode?: boolean) =>
    requireBackend().invoke('module/getSaveOptions', { workspaceId, documentId, useMixedMode: useMixedMode ?? null }))
  // dnSpy's Save Module and Save Modules windows run the save while they show its progress; a big module takes a
  // while, so it gets the long deadline, and the window's Cancel calls it off by the key it named it with.
  ipcMain.handle('module:saveDocuments', async (event, workspaceId: string, documents: unknown[], requestKey: string) => {
    const key = `${event.sender.id}:${requestKey}`
    const entry = { controller: new AbortController(), sender: event.sender, requestKey }
    saveRequests.set(key, entry)
    try {
      return await requireBackend().invoke('module/saveDocuments', { workspaceId, documents, progressToken: key }, 600_000, entry.controller.signal)
    } finally {
      if (saveRequests.get(key) === entry)
        saveRequests.delete(key)
    }
  })
  ipcMain.handle('module:cancelSave', (event, requestKey: string) => {
    saveRequests.get(`${event.sender.id}:${requestKey}`)?.controller.abort()
  })
  // dnSpy's PathUtils.ValidateFileName, which looks at the disk as well as at the name: the main process is the
  // side that can. Answers the message's template and its argument, or nothing for a name that will do.
  ipcMain.handle('dialog:validateSaveFileName', (_event, fileName: string): { template: string; folder?: string } | undefined => {
    if (fileName.length === 0)
      return { template: "Filename can't be empty." }
    if (fileName.trim().length === 0)
      return { template: "Filename can't contain only white space" }
    if (fileName.length >= 4096)
      return { template: 'Filename is too long.' }
    if (fileName.includes('\0') || (process.platform === 'win32' && /[<>"|?*]/.test(fileName.replace(/^[a-zA-Z]:/, ''))))
      return { template: 'Filename contains at least one invalid path character.' }
    if (path.basename(fileName).length === 0 || fileName.endsWith(path.sep))
      return { template: "Filename can't be empty." }
    if (existsSync(fileName) && statSync(fileName).isDirectory())
      return { template: 'A folder with the same name as the filename already exists.' }
    const folder = path.dirname(fileName)
    if (folder && !existsSync(folder))
      return { template: "Folder '{folder}' doesn't exist.", folder }
    return undefined
  })
  // The "..." beside the Save Module window's file name: dnSpy's DotNetAssemblyOrModuleFilter for a module, any
  // file for a document saved as bytes. A test names the file up front.
  ipcMain.handle('dialog:pickSaveFileName', async (_event, defaultPath: string, kind: 'module' | 'any', extension?: string) => {
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_PATH)
      return process.env.DNSPY_E2E_SAVE_PATH
    const text = nativeText()
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultPath || undefined,
      filters: kind === 'module'
        ? [{ name: `${text.dotNetExecutables} (*.exe, *.dll, *.netmodule, *.winmd)`, extensions: extension ? [extension, 'exe', 'dll', 'netmodule', 'winmd'] : ['exe', 'dll', 'netmodule', 'winmd'] }, { name: text.allFiles, extensions: ['*'] }]
        : [{ name: text.allFiles, extensions: ['*'] }],
    })
    return result.canceled || !result.filePath ? undefined : result.filePath
  })
  ipcMain.handle('document:saveCode', async (_event, suggestedName: string, text: string, title?: string) => {
    if (typeof suggestedName !== 'string' || typeof text !== 'string')
      throw new TypeError('Invalid save-code request.')
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_CODE_PATH) {
      await writeFile(process.env.DNSPY_E2E_SAVE_CODE_PATH, text, 'utf8')
      return process.env.DNSPY_E2E_SAVE_CODE_PATH
    }
    const safeName = path.basename(suggestedName) || 'code.txt'
    const extension = path.extname(safeName).slice(1) || 'txt'
    const result = await dialog.showSaveDialog(mainWindow!, {
      // The renderer names the box when it is saving something other than code — the Output window's text,
      // which is written out the same way — since it is the side that knows which language to say it in.
      title: title ?? nativeText().saveCode,
      defaultPath: safeName,
      // dnSpy's bookmark and breakpoint files are XML, and its picker says so (PickFilenameConstants.XmlFilenameFilter).
      filters: [
        { name: extension === 'xml' ? nativeText().xmlFiles : nativeText().codeFiles, extensions: [extension] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath)
      return undefined
    await writeFile(result.filePath, text, 'utf8')
    return result.filePath
  })
  ipcMain.handle('dialog:openTextFile', async (_event, kind?: 'bookmarks' | 'breakpoints') => {
    // A test cannot drive the native picker, so it names the file up front; a file that is not there
    // answers like a cancelled dialog rather than throwing through the IPC channel.
    if (!app.isPackaged && process.env.DNSPY_E2E_OPEN_TEXT_FILE) {
      try {
        return await readFile(process.env.DNSPY_E2E_OPEN_TEXT_FILE, 'utf8')
      } catch {
        return undefined
      }
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: kind === 'breakpoints' ? nativeText().openBreakpoints : nativeText().openBookmarks,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openFile'],
      // dnSpy's bookmark files are its settings XML; the JSON an earlier build of this port wrote still reads.
      filters: kind === 'bookmarks' || kind === 'breakpoints'
        ? [{ name: nativeText().xmlFiles, extensions: ['xml'] }, { name: nativeText().allFiles, extensions: ['*'] }]
        : [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return await readFile(result.filePaths[0], 'utf8')
  })
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().selectDirectory,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('file:write', async (_event, directory: string, fileName: string, data: Uint8Array) => {
    try {
      const filePath = path.join(directory, fileName)
      await writeFile(filePath, data)
      return filePath
    } catch {
      return undefined
    }
  })
  ipcMain.handle('debug:chooseTarget', async () => {
    if (!app.isPackaged && process.env.DNSPY_E2E_DEBUG_TARGET)
      return process.env.DNSPY_E2E_DEBUG_TARGET
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().selectDebugTarget,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openFile'],
      filters: [
        { name: nativeText().dotNetPrograms, extensions: ['dll', 'exe'] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return result.filePaths[0]
  })
  // Save Module in the Modules window: where the image read out of the process goes.
  ipcMain.handle('debug:chooseModuleSavePath', async (_event, suggestedName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: nativeText().saveModuleAs,
      defaultPath: path.basename(String(suggestedName ?? '')) || 'module.dll',
      filters: [
        { name: nativeText().dotNetAssemblies, extensions: ['dll', 'exe', 'netmodule'] },
        { name: nativeText().allFiles, extensions: ['*'] },
      ],
    })
    return result.canceled || !result.filePath ? undefined : result.filePath
  })
  ipcMain.handle('debug:chooseHost', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().selectDebugHost,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openFile'],
      // A host is marked by its executable bit, not by an extension: on Linux the `dotnet` CLI and
      // apphosts such as `Fiddler.WebUi` have no suffix at all, and `.exe` names nothing there. The
      // chooser matches filters against names and never reads permissions, so no name filter can pick
      // out executables — all files is the only one that shows every host, and it is all that is
      // offered. The upstream `.exe` filter survives on Windows, where a host really does carry it,
      // and leads there so the default still narrows to the executables that platform has.
      filters: process.platform === 'win32'
        ? [
            { name: nativeText().executables, extensions: ['exe'] },
            { name: nativeText().allFiles, extensions: ['*'] },
          ]
        : [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle('debug:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: nativeText().selectWorkingDirectory,
      defaultPath: dialogPathHistory?.openDirectory,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    return result.filePaths[0]
  })
  ipcMain.handle('debug:listProcesses', () => requireBackend().invoke('debug/listProcesses', {}))
  // The workspace id is what lets the engine resolve decompiled-source breakpoints to IL offsets,
  // so it travels with launch/attach rather than being inferred later from the session.
  ipcMain.handle('debug:launch', (_event, options: DebugLaunchOptions) => requireBackend().invoke('debug/launch', options))
  // Start Without Debugging: the program is started the way the engine would start it — through the host for
  // a framework-dependent .dll — but on its own, detached from this process.
  ipcMain.handle('debug:startWithoutDebugging', async (_event, options: DebugLaunchOptions) => {
    const useHost = options.useHost ?? options.program.toLowerCase().endsWith('.dll')
    const command = useHost ? options.host || 'dotnet' : options.program
    const commandArguments = useHost ? [...(options.hostArguments ?? []), options.program, ...(options.arguments ?? [])] : [...(options.arguments ?? [])]
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, commandArguments, {
        cwd: options.workingDirectory || path.dirname(options.program),
        env: { ...process.env, ...options.environment },
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve(child.pid ?? 0)
      })
    })
  })
  ipcMain.handle('debug:attach', (_event, processId: number, workspaceId?: string) => requireBackend().invoke('debug/attach', { processId, workspaceId }))
  const debugRequest = (channel: string, command: string): void => {
    ipcMain.handle(channel, (_event, sessionId: string, args: unknown) => requireBackend().invoke('debug/request', { sessionId, command, arguments: args }))
  }
  debugRequest('debug:setBreakpoints', 'setBreakpoints')
  debugRequest('debug:setFunctionBreakpoints', 'setFunctionBreakpoints')
  debugRequest('debug:configurationDone', 'configurationDone')
  debugRequest('debug:continue', 'continue')
  debugRequest('debug:pause', 'pause')
  debugRequest('debug:next', 'next')
  debugRequest('debug:stepIn', 'stepIn')
  debugRequest('debug:stepOut', 'stepOut')
  debugRequest('debug:threads', 'threads')
  debugRequest('debug:stackTrace', 'stackTrace')
  debugRequest('debug:scopes', 'scopes')
  debugRequest('debug:variables', 'variables')
  debugRequest('debug:modules', 'modules')
  debugRequest('debug:evaluate', 'evaluate')
  debugRequest('debug:frameLocation', 'frameLocation')
  debugRequest('debug:setExpression', 'setExpression')
  debugRequest('debug:autos', 'autos')
  debugRequest('debug:staticFields', 'staticFields')
  debugRequest('debug:makeObjectId', 'makeObjectId')
  debugRequest('debug:deleteObjectId', 'deleteObjectId')
  debugRequest('debug:setNextStatement', 'setNextStatement')
  debugRequest('debug:runToFrame', 'runToFrame')
  debugRequest('debug:runToCursor', 'runToCursor')
  debugRequest('debug:setModuleBreakpoints', 'setModuleBreakpoints')
  debugRequest('debug:freezeThread', 'freezeThread')
  debugRequest('debug:renameThread', 'renameThread')
  debugRequest('debug:process', 'process')
  debugRequest('debug:readMemory', 'readMemory')
  debugRequest('debug:writeMemory', 'writeMemory')
  debugRequest('debug:disassemble', 'disassemble')
  debugRequest('debug:saveModule', 'saveModule')
  debugRequest('debug:resetHitCounts', 'resetHitCounts')
  ipcMain.handle('debug:verifyFilter', async (_event, filter: string) =>
    (await requireBackend().invoke<{ error?: string | null }>('debug/verifyFilter', { filter })).error ?? null)
  ipcMain.handle('debug:setOptions', (_event, options: unknown) => requireBackend().invoke('debug/setOptions', options))
  // The exception list is engine-wide rather than per session, so these three go straight to the
  // manager the way listProcesses does.
  ipcMain.handle('debug:exceptionSettings:get', () => requireBackend().invoke('exceptions/get', {}))
  ipcMain.handle('debug:exceptionSettings:apply', (_event, diff: unknown) => requireBackend().invoke('exceptions/apply', diff))
  ipcMain.handle('debug:exceptionSettings:reset', () => requireBackend().invoke('exceptions/reset', {}))
  ipcMain.handle('debug:disconnect', (_event, sessionId: string, terminateDebuggee: boolean) => requireBackend().invoke('debug/disconnect', { sessionId, terminateDebuggee }))
  // A submission may legitimately run for minutes, which the 60 s default would cut short; the
  // resulting system/cancel would look to the user like a script that simply never finished.
  ipcMain.handle('script:evaluate', (_event, code: string) => requireBackend().invoke('script/evaluate', { code }, 600_000))
  ipcMain.handle('script:reset', (_event, options: { loadConfig?: boolean; showBanner?: boolean } | undefined) =>
    requireBackend().invoke('script/reset', { loadConfig: options?.loadConfig ?? true, showBanner: options?.showBanner ?? false }, 600_000))
  ipcMain.handle('script:isComplete', (_event, code: string) => requireBackend().invoke('script/isComplete', { code }))
  ipcMain.handle('script:askResponse', (_event, id: string, text: string | null) => {
    requireBackend().notify('client/response', { id, result: { text }, error: null })
  })

  ipcMain.handle('script:classify', (_event, code: string) => requireBackend().invoke('script/classify', { code }))
  // The Roslyn language service of a C# code editor: one backend workspace per open document.
  ipcMain.handle('languageService:open', (_event, request: unknown) => requireBackend().invoke('languageService/open', request))
  ipcMain.handle('languageService:update', async (_event, documentId: string, text: string) => {
    await requireBackend().invoke('languageService/update', { documentId, text })
  })
  ipcMain.handle('languageService:close', async (_event, documentId: string) => {
    await requireBackend().invoke('languageService/close', { documentId })
  })
  ipcMain.handle('languageService:classify', (_event, documentId: string) =>
    requireBackend().invoke('languageService/classify', { documentId }))
  ipcMain.handle('languageService:completion', (_event, documentId: string, position: number, triggerCharacter: string | null) =>
    requireBackend().invoke('languageService/completion', { documentId, position, triggerCharacter }))
  ipcMain.handle('languageService:completionDescription', (_event, documentId: string, resultId: number, index: number) =>
    requireBackend().invoke('languageService/completionDescription', { documentId, resultId, index }))
  ipcMain.handle('languageService:quickInfo', (_event, documentId: string, position: number) =>
    requireBackend().invoke('languageService/quickInfo', { documentId, position }))
  ipcMain.handle('languageService:signatureHelp', (_event, documentId: string, position: number, triggerCharacter: string | null) =>
    requireBackend().invoke('languageService/signatureHelp', { documentId, position, triggerCharacter }))
  // Compiling is what produces the messages, so this one gets the time a compile can take.
  ipcMain.handle('languageService:diagnostics', (_event, documentId: string) =>
    requireBackend().invoke('languageService/diagnostics', { documentId }, 120_000))
  ipcMain.handle('languageService:indentation', (_event, request: unknown) => requireBackend().invoke('languageService/indentation', request))
  ipcMain.handle('languageService:selectionRanges', (_event, documentId: string, positions: number[]) =>
    requireBackend().invoke('languageService/selectionRanges', { documentId, positions }))
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  // The debugger's "Bring dnSpy to the foreground when breaking": the window comes back up and takes the focus.
  ipcMain.handle('window:bringToFront', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  ipcMain.handle('window:focusProcess', (_event, processId: number) => focusProcessWindow(processId))
  ipcMain.handle('window:toggleMaximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window)
      return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('window:isMaximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  ipcMain.handle('window:setFullScreen', (event, fullScreen: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window)
      return false
    window.setFullScreen(fullScreen)
    return window.isFullScreen()
  })
  ipcMain.handle('window:toggleFullScreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window)
      return false
    const next = !window.isFullScreen()
    window.setFullScreen(next)
    return next
  })
  ipcMain.handle('window:isFullScreen', (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false)
  ipcMain.handle('backend:status:get', () => lastBackendStatus)
  ipcMain.handle('app:startupOptions', () => ({ commandLine, title: appTitle(), version: app.getVersion(), processStartTime }))
  // The Background Image window's sources: the paths its options list, folders expanded to the images in
  // them, each handed over as a data URL — the renderer may not read the disk for itself.
  ipcMain.handle('app:backgroundImages', (_event, paths: string[]) => readBackgroundImages(paths))
  ipcMain.handle('app:filterExistingPaths', (_event, paths: string[]) => paths.filter((candidate) => existsSync(candidate)))
  // dnSpy's File.Exists: a directory is not a file, and any error — missing, unreadable — just means
  // "no", so statSync inside a try rather than existsSync.
  ipcMain.handle('app:pathExists', (_event, candidate: string) => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  ipcMain.handle('app:processId', () => process.pid)
  // The desktop's file manager is a process of its own that this app cannot observe, so — like the save
  // dialogs — a test-driven run writes down the path it was asked to show instead of opening anything.
  ipcMain.handle('app:showItemInFolder', (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0)
      throw new TypeError('A file path is required.')
    if (!app.isPackaged && process.env.DNSPY_E2E_SHOW_IN_FOLDER_PATH) {
      writeFileSync(process.env.DNSPY_E2E_SHOW_IN_FOLDER_PATH, target, 'utf8')
      return
    }
    shell.showItemInFolder(target)
  })
  // Save Resource writes one node's bytes out, so it needs a destination the backend knows nothing about.
  // The bytes come from the workspace (an unsaved edit is what gets saved) and the file is written here.
  // dnSpy's SaveResources.Save: one item goes through a save dialog under its own name; several go into a
  // folder the user picks, each under its name with the characters a file name cannot hold made '_'. A
  // .resources file saves as its entries, the way dnSpy's deserialized save does, so even one resource can
  // be several files. `raw` is the Raw Save command: an entry's serialized bytes instead of its value.
  ipcMain.handle('edit:saveResource', async (_event, workspaceId: string, nodeIds: string[], raw: boolean, useSubDirs = false) => {
    const { items } = await requireBackend().invoke<{ items: { name: string; base64Data: string }[] }>('resource/getItems', { workspaceId, nodeIds, raw })
    if (items.length === 0)
      return []
    // A test cannot drive the native pickers, so it names the file or folder up front.
    const e2ePath = !app.isPackaged ? process.env.DNSPY_E2E_SAVE_RESOURCE_PATH : undefined
    if (items.length === 1) {
      let target = e2ePath
      if (!target) {
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: nativeText().saveResource,
          defaultPath: resourceFileName(items[0].name),
          filters: [{ name: nativeText().allFiles, extensions: ['*'] }],
        })
        if (result.canceled || !result.filePath)
          return []
        target = result.filePath
      }
      await writeFile(target, Buffer.from(items[0].base64Data, 'base64'))
      return [target]
    }
    let directory = e2ePath
    if (!directory) {
      const result = await dialog.showOpenDialog(mainWindow!, { title: nativeText().saveResources, properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || result.filePaths.length === 0)
        return []
      directory = result.filePaths[0]
    }
    // dnSpy's ResourceSaver: the directories a name keeps under the "use sub dirs" variant are made as needed.
    const written: string[] = []
    for (const item of items) {
      const target = path.join(directory, ...resourceFileSegments(item.name, useSubDirs))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(item.base64Data, 'base64'))
      written.push(target)
    }
    return written
  })
  // dnSpy's DocumentSaver.AskUserToSaveIfModified: Yes saves the files first, No lets them go unsaved, and closing
  // the box calls the command off — here a Cancel button, which Escape presses. A test names its answer up front.
  ipcMain.handle('app:askSaveModified', async (_event, count: number): Promise<'save' | 'discard' | 'cancel'> => {
    const e2eAnswer = !app.isPackaged ? process.env.DNSPY_E2E_SAVE_PROMPT : undefined
    if (e2eAnswer === 'save' || e2eAnswer === 'discard' || e2eAnswer === 'cancel')
      return e2eAnswer
    if (!mainWindow)
      return 'cancel'
    const text = nativeText()
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'dnSpy',
      message: count === 1 ? text.askSaveFile : text.askSaveFiles,
      buttons: [text.yes, text.no, text.cancel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
  })
  // dnSpy's AppWindow_MainWindowClosing: Yes saves the files, No exits without them, and closing the box — Escape
  // here, which no button answers to — stays. A test names its answer up front.
  ipcMain.handle('app:askExitUnsaved', async (_event, count: number): Promise<'save' | 'discard' | 'cancel'> => {
    const e2eAnswer = !app.isPackaged ? process.env.DNSPY_E2E_SAVE_PROMPT : undefined
    if (e2eAnswer === 'save' || e2eAnswer === 'discard' || e2eAnswer === 'cancel')
      return e2eAnswer
    if (!mainWindow)
      return 'cancel'
    const text = nativeText()
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'dnSpy',
      message: count === 1 ? text.askExitUnsavedFile : text.askExitUnsavedFiles.replace('{0}', String(count)),
      buttons: [text.yes, text.no],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
  })
  ipcMain.handle('app:setLocale', (_event, locale: UiLocale) => {
    if (isUiLocale(locale)) {
      uiLocale = locale
      // The title reports the administrator rights in the user's own language, so it is written again here.
      mainWindow?.setTitle(appTitle())
    }
  })
  // The renderer's option store is where every option is written; this is the handful the main process has to
  // know about before there is a renderer to ask, kept in a file of its own for the next start to read.
  ipcMain.handle('app:mainSettings', (_event, settings: { allowMoreThanOneInstance?: boolean }) => {
    appSettings.allowMoreThanOneInstance = settings.allowMoreThanOneInstance === true
    if (settingsFile)
      settingsFile.set('appSettings', appSettings)
    else
      saveAppMainSettings(appSettingsFile, appSettings)
  })
  // Whether the renderer holds unsaved edits. Reported as they change, so the close handler knows whether
  // there is anything to ask about without having to call across and wait for an answer.
  ipcMain.handle('app:setUnsavedChanges', (_event, dirty: boolean) => { rendererDirty = dirty === true })
  // The renderer's answer to the close question. "No" — Cancel, or a save that was itself called off — leaves
  // the window where it is, and the whole question will be put again the next time it is asked to close.
  ipcMain.handle('app:closeResponse', (_event, approved: boolean) => {
    if (!approved)
      return
    closeApproved = true
    mainWindow?.close()
  })
  ipcMain.handle('app:quit', () => app.quit())
  // dnSpy's ShowIgnorableMessage, as the native box the port draws it with: the caller decides what a box
  // whose "Don't show again" was ticked means — this only reports that it was.
  ipcMain.handle('app:askMessage', async (_event, message: string, buttons: string[]) => {
    // A native box no test can press: a test answers every question with its first button — dnSpy's "Yes".
    if (!mainWindow || (!app.isPackaged && process.env.DNSPY_E2E_ASK_ANSWER === 'first'))
      return { button: buttons[0], dontShowAgain: false }
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'dnSpy',
      message,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
      checkboxLabel: nativeText().dontShowAgain,
    })
    return { button: buttons[response] ?? buttons[0], dontShowAgain: checkboxChecked }
  })
  // dnSpy's MsgBox: a message, an OK button and nothing to answer. The title is the app's, as it is there.
  ipcMain.handle('app:showMessage', async (_event, message: string) => {
    if (mainWindow)
      await dialog.showMessageBox(mainWindow, { type: 'info', title: 'dnSpy', message, buttons: [nativeText().ok], noLink: true })
    else
      dialog.showErrorBox('dnSpy', message)
  })
  ipcMain.handle('app:isRunningAsAdministrator', () => isRunningAsAdministrator())
  ipcMain.handle('app:listSystemFonts', () => listSystemFonts())
  // The renderer's half of the settings file: read before the page's scripts run, written back as it unloads,
  // which is when dnSpy writes its settings file too. Without a settings file the profile's storage is used.
  ipcMain.on('app:rendererSettings', (event) => {
    event.returnValue = settingsFile ? settingsFile.get('renderer') ?? {} : null
  })
  ipcMain.on('app:saveRendererSettings', (event, entries: Record<string, unknown>) => {
    if (settingsFile && typeof entries === 'object' && entries !== null)
      settingsFile.set('renderer', rendererEntries(entries))
    event.returnValue = true
  })
  // dnSpy reads its themes before the window opens; the preload asks for them the same way, before the first paint.
  ipcMain.on('app:themeFiles', (event) => {
    event.returnValue = readThemeFiles(themeDirectories(path.dirname(app.getPath('exe')), app.getPath('userData')))
  })
  ipcMain.handle('app:restartAsAdministrator', async () => {
    // The renderer has already settled the unsaved-edits question by the time it asks for this.
    // Only once the elevated copy is up does this window go — unlike dnSpy, which closes first and
    // has nothing left to say if the elevation is refused. A restart that doesn't come off leaves
    // the app exactly as it was, with a dialog saying why.
    if (!mainWindow || restartInFlight)
      return
    restartInFlight = true
    const failure = await relaunchElevated()
    if (failure !== undefined || !mainWindow) {
      restartInFlight = false
      if (failure !== undefined)
        dialog.showErrorBox('dnSpy', failure)
      return
    }
    closingForRestart = true
    mainWindow.close()
  })
}

// The window is the entire interface, so where the menu bar is a strip attached to that window there is
// nothing to put in it and it is removed: Linux and Windows draw it inside the window, and every command
// lives in the shell's toolbar. macOS draws a single menu bar for the whole application and routes the
// standard editing shortcuts and Quit through it, so removing it there would cost the shell Cmd+C/V/A/Z,
// Cmd+Q and the About/Window menus — role-built submenus supply the platform's own localizations.
const installApplicationMenu = (): void => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]))
}

/**
 * dnSpy's App.SwitchToOtherInstance, seen from the instance that holds the lock: a second process's command
 * line is read here exactly as this one's was, the window is brought forward unless `--dont-activate` was
 * asked for, and the renderer is handed the options so it can open the files and follow the rest.
 */
const handleForwardedCommandLine = (argv: readonly string[], workingDirectory: string): void => {
  const forwarded = parseCommandLine(userArguments(argv, process.defaultApp === true), workingDirectory)
  if (!mainWindow)
    return
  if (forwarded.activate) {
    if (mainWindow.isMinimized())
      mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.webContents.send('app:commandLine', forwarded)
}

const start = async (): Promise<void> => {
  // The renderer names the language it settles on as soon as it is up; until then the native dialogs follow the
  // operating system's, matched the way the renderer matches its "System" language.
  uiLocale = matchUiLocale([app.getLocale()]) ?? 'en'
  dialogPathHistory = new DialogPathHistory(path.join(app.getPath('userData'), 'dialog-state.json'), settingsFile && {
    read: () => settingsFile.get('dialogState'),
    write: (settings) => settingsFile.set('dialogState', settings),
  })
  await dialogPathHistory.load()
  installApplicationMenu()
  registerAppProtocol()
  registerIpc()
  createWindow()
  backend = new BackendClient(sendBackendStatus, sendBackendNotification)
  try {
    await backend.start()
  } catch (error) {
    sendBackendStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

if (!isPrimaryInstance) {
  // dnSpy's second instance hands its arguments over and exits (App.SwitchToOtherInstance); the dialog the
  // lock was refused with is Electron's, and it never opens a window.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => handleForwardedCommandLine(argv, workingDirectory))
  void app.whenReady().then(start)
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0)
    createWindow()
})

app.on('window-all-closed', () => {
  flushSessionStorage()
  app.quit()
})

app.on('before-quit', () => {
  flushSessionStorage()
})

// `before-quit` can still be canceled by a renderer before its window closes (for example, by the
// unsaved-edits guard). Stop the backend only once Electron has committed to quitting, so canceling that
// guard leaves the current session usable.
app.on('will-quit', () => {
  void backend?.dispose()
})
