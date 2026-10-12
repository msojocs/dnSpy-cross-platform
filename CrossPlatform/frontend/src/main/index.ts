import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BackendClient } from './backend-client'
import { DialogPathHistory } from './dialog-path-history'
import { waitForElevatedStart } from './elevated-start'
import type { AnalyzeChildrenRequest, AnalyzerNode, BackendStatus, DebugLaunchOptions, SearchRequest, SearchResult, UiLocale } from '../shared/protocol'

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
let uiLocale: UiLocale = 'en'
// True while a restart-as-administrator request is being carried out, so a second one is ignored.
let restartInFlight = false
// True only for the close a successful restart asks for. The renderer's unsaved-edits guard must not
// stand in its way — that question was already answered before the request was made.
let closingForRestart = false
const initialPaths = parseInitialPaths(process.argv)
// dnSpy spells it `--dont-load-files`; both are accepted so a script written against either works.
const noLoadFiles = process.argv.includes('--no-load-files') || process.argv.includes('--dont-load-files')

const nativeMessages = {
  'zh-CN': {
    openAssembly: '打开程序集',
    dotNetAssemblies: '.NET 程序集',
    allFiles: '所有文件',
    replaceResource: '替换嵌入的资源',
    resourceTooLarge: '资源文件不能超过 64 MiB。',
    saveModuleAs: '模块另存为',
    saveCode: '保存代码',
    saveResource: '保存资源',
    codeFiles: '代码文件',
    openBookmarks: '导入书签',
    openBreakpoints: '导入断点',
    selectDebugTarget: '选择要调试的 .NET 程序',
    dotNetPrograms: '.NET 程序',
    selectDebugHost: '选择宿主可执行文件',
    executables: '可执行文件',
    selectWorkingDirectory: '选择工作目录',
    restartFailed: '无法以管理员身份重启',
    restartNoResponse: '以管理员身份启动的窗口始终没有出现',
  },
  en: {
    openAssembly: 'Open Assembly',
    dotNetAssemblies: '.NET Assemblies',
    allFiles: 'All Files',
    replaceResource: 'Replace Embedded Resource',
    resourceTooLarge: 'Resource files are limited to 64 MiB.',
    saveModuleAs: 'Save Module As',
    saveCode: 'Save Code',
    saveResource: 'Save Resource',
    codeFiles: 'Code Files',
    openBookmarks: 'Import Bookmarks',
    openBreakpoints: 'Import Breakpoints',
    selectDebugTarget: 'Select .NET Program to Debug',
    dotNetPrograms: '.NET Programs',
    selectDebugHost: 'Select Host Executable',
    executables: 'Executables',
    selectWorkingDirectory: 'Select Working Directory',
    restartFailed: 'Could not restart with elevated rights',
    restartNoResponse: 'The window started with elevated rights never appeared',
  },
} as const

const nativeText = () => nativeMessages[uiLocale]

// dnSpy's Constants.IsRunningAsAdministrator (a WindowsPrincipal role check) in Linux terms: the
// process is elevated when it owns uid 0.
const isRunningAsAdministrator = (): boolean => process.getuid?.() === 0

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
  }
}

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    title: 'dnSpy',
    width: 1000,
    height: 600,
    minWidth: 640,
    minHeight: 400,
    show: false,
    frame: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
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
  })
  // Restarting closes the window like any other quit, so a document still unsaved would normally
  // hold it open a second time over. That question was already put to the user once, before the
  // restart was asked for, so this one close is let through.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (closingForRestart)
      event.preventDefault()
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
  protocol.handle('app', async (request) => {
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
  })
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

function parseInitialPaths(args: string[]): string[] {
  const paths: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--open' && index + 1 < args.length)
      paths.push(path.resolve(args[++index]))
  }
  return paths
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
  ipcMain.handle('workspace:reload', (_event, workspaceId: string) => requireBackend().invoke('workspace/reload', { workspaceId }))
  ipcMain.handle('workspace:sortAssemblies', (_event, workspaceId: string) => requireBackend().invoke('workspace/sortAssemblies', { workspaceId }))
  ipcMain.handle('workspace:removeModule', (_event, workspaceId: string, nodeId: string) => requireBackend().invoke('workspace/removeModule', { workspaceId, nodeId }))
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
  ipcMain.handle('document:decompile', (_event, workspaceId: string, nodeId: string, language: string) =>
    requireBackend().invoke('document/decompile', { workspaceId, nodeId, language }, 600_000))
  ipcMain.handle('document:findMember', (_event, workspaceId: string, modulePath: string, metadataToken: number) => requireBackend().invoke('document/findMember', { workspaceId, modulePath, metadataToken }))
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
  ipcMain.handle('analyze:nodes', (_event, workspaceId: string, nodeIds: string[]) => requireBackend().invoke('analyze/nodes', { workspaceId, nodeIds }))
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
  ipcMain.handle('hex:resolveStatement', (_event, workspaceId: string, modulePath: string, metadataToken: number, ilOffset: number, ilEndOffset: number) => requireBackend().invoke('hex/resolveStatement', { workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset }))
  ipcMain.handle('hex:patch', (_event, workspaceId: string, transactionId: string, nodeId: string, offset: number, base64Data: string) => requireBackend().invoke('edit/hexPatch', { workspaceId, transactionId, nodeId, offset, base64Data }))
  ipcMain.handle('module:info', (_event, workspaceId: string, moduleId: string) => requireBackend().invoke('module/getInfo', { workspaceId, moduleId }))
  ipcMain.handle('edit:begin', (_event, workspaceId: string) => requireBackend().invoke('edit/begin', { workspaceId }))
  ipcMain.handle('edit:getMethodBody', (_event, workspaceId: string, methodNodeId: string) => requireBackend().invoke('edit/getMethodBody', { workspaceId, methodNodeId }))
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
  ipcMain.handle('module:saveAs', async (_event, workspaceId: string, moduleId: string, suggestedName: string) => {
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_PATH) {
      return requireBackend().invoke('module/saveAs', {
        workspaceId,
        moduleId,
        destinationPath: process.env.DNSPY_E2E_SAVE_PATH,
        overwrite: true,
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
    return requireBackend().invoke('module/saveAs', {
      workspaceId,
      moduleId,
      destinationPath: result.filePath,
      overwrite: true,
    })
  })
  // Save and Save All write back over the files the assemblies came from, so neither has a dialog to
  // go through — unlike Save As, which is the one that needs a destination.
  ipcMain.handle('module:save', (_event, workspaceId: string, moduleId: string) =>
    requireBackend().invoke('module/save', { workspaceId, moduleId }))
  ipcMain.handle('module:saveAll', (_event, workspaceId: string) =>
    requireBackend().invoke('module/saveAll', { workspaceId }))
  ipcMain.handle('document:saveCode', async (_event, suggestedName: string, text: string) => {
    if (typeof suggestedName !== 'string' || typeof text !== 'string')
      throw new TypeError('Invalid save-code request.')
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_CODE_PATH) {
      await writeFile(process.env.DNSPY_E2E_SAVE_CODE_PATH, text, 'utf8')
      return process.env.DNSPY_E2E_SAVE_CODE_PATH
    }
    const safeName = path.basename(suggestedName) || 'code.txt'
    const extension = path.extname(safeName).slice(1) || 'txt'
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: nativeText().saveCode,
      defaultPath: safeName,
      filters: [
        { name: nativeText().codeFiles, extensions: [extension] },
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
      filters: [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || result.filePaths.length === 0)
      return undefined
    await dialogPathHistory?.rememberOpenedFile(result.filePaths[0])
    return await readFile(result.filePaths[0], 'utf8')
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
  // The exception list is engine-wide rather than per session, so these three go straight to the
  // manager the way listProcesses does.
  ipcMain.handle('debug:exceptionSettings:get', () => requireBackend().invoke('exceptions/get', {}))
  ipcMain.handle('debug:exceptionSettings:apply', (_event, diff: unknown) => requireBackend().invoke('exceptions/apply', diff))
  ipcMain.handle('debug:exceptionSettings:reset', () => requireBackend().invoke('exceptions/reset', {}))
  ipcMain.handle('debug:disconnect', (_event, sessionId: string, terminateDebuggee: boolean) => requireBackend().invoke('debug/disconnect', { sessionId, terminateDebuggee }))
  // A submission may legitimately run for minutes, which the 60 s default would cut short; the
  // resulting system/cancel would look to the user like a script that simply never finished.
  ipcMain.handle('script:evaluate', (_event, code: string) => requireBackend().invoke('script/evaluate', { code }, 600_000))
  ipcMain.handle('script:reset', () => requireBackend().invoke('script/reset', {}, 600_000))
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
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
  ipcMain.handle('app:startupOptions', () => ({ initialPaths, noLoadFiles }))
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
  ipcMain.handle('edit:saveResource', async (_event, workspaceId: string, nodeId: string) => {
    const resource = await requireBackend().invoke<{ name: string; base64Data: string }>('resource/getData', { workspaceId, nodeId })
    const data = Buffer.from(resource.base64Data, 'base64')
    // A test cannot drive the native picker, so it names the file up front, the way the save dialogs do.
    if (!app.isPackaged && process.env.DNSPY_E2E_SAVE_RESOURCE_PATH) {
      await writeFile(process.env.DNSPY_E2E_SAVE_RESOURCE_PATH, data)
      return process.env.DNSPY_E2E_SAVE_RESOURCE_PATH
    }
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: nativeText().saveResource,
      defaultPath: path.basename(resource.name) || 'resource.bin',
      filters: [{ name: nativeText().allFiles, extensions: ['*'] }],
    })
    if (result.canceled || !result.filePath)
      return undefined
    await writeFile(result.filePath, data)
    return result.filePath
  })
  ipcMain.handle('app:setLocale', (_event, locale: UiLocale) => {
    if (locale === 'en' || locale === 'zh-CN')
      uiLocale = locale
  })
  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('app:isRunningAsAdministrator', () => isRunningAsAdministrator())
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

app.whenReady().then(async () => {
  uiLocale = app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  dialogPathHistory = new DialogPathHistory(path.join(app.getPath('userData'), 'dialog-state.json'))
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
})

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
