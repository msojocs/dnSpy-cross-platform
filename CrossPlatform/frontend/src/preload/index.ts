import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BackendStatus, DecompilerLanguage, DnSpyApi, UiLocale } from '../shared/protocol'

const api: DnSpyApi = {
  openAssemblies: () => ipcRenderer.invoke('dialog:openAssemblies'),
  getStartupOptions: () => ipcRenderer.invoke('app:startupOptions'),
  filterExistingPaths: (paths) => ipcRenderer.invoke('app:filterExistingPaths', paths),
  openWorkspace: (paths) => ipcRenderer.invoke('workspace:open', paths),
  addModules: (workspaceId, paths) => ipcRenderer.invoke('workspace:addModules', workspaceId, paths),
  closeWorkspace: (workspaceId) => ipcRenderer.invoke('workspace:close', workspaceId),
  reloadWorkspace: (workspaceId, autoLoadedPaths) => ipcRenderer.invoke('workspace:reload', workspaceId, autoLoadedPaths),
  sortAssemblies: (workspaceId) => ipcRenderer.invoke('workspace:sortAssemblies', workspaceId),
  removeModule: (workspaceId, nodeId) => ipcRenderer.invoke('workspace:removeModule', workspaceId, nodeId),
  removeModules: (workspaceId, nodeIds) => ipcRenderer.invoke('workspace:removeModules', workspaceId, nodeIds),
  getModifiedModules: (workspaceId, nodeIds) => ipcRenderer.invoke('workspace:getModifiedModules', workspaceId, nodeIds),
  getCloseCandidates: (workspaceId) => ipcRenderer.invoke('workspace:getCloseCandidates', workspaceId),
  moveRoots: (workspaceId, nodeIds, index) => ipcRenderer.invoke('workspace:moveRoots', workspaceId, nodeIds, index),
  activateNode: (workspaceId, nodeId) => ipcRenderer.invoke('tree:activate', workspaceId, nodeId),
  dropFiles: (workspaceId, paths, index, filter) => ipcRenderer.invoke('workspace:dropFiles', workspaceId, paths, index, filter),
  pathForFile: (file) => webUtils.getPathForFile(file),
  listGacAssemblies: () => ipcRenderer.invoke('gac:list'),
  getGacDetails: (path) => ipcRenderer.invoke('gac:getDetails', path),
  listDefaultDocumentLists: () => ipcRenderer.invoke('documentList:defaults'),
  getResourceItems: (workspaceId, nodeIds, raw) => ipcRenderer.invoke('resource:getItems', workspaceId, nodeIds, raw),
  getResourceItemNames: (workspaceId, nodeIds) => ipcRenderer.invoke('resource:getItemNames', workspaceId, nodeIds),
  selectMember: (workspaceId, paths, member) => ipcRenderer.invoke('tree:selectMember', workspaceId, paths, member),
  findResource: (workspaceId, nodeId) => ipcRenderer.invoke('resource:find', workspaceId, nodeId),
  getSpecialNode: (workspaceId, nodeId, kind) => ipcRenderer.invoke('module:specialNode', workspaceId, nodeId, kind),
  findByToken: (workspaceId, nodeId, token) => ipcRenderer.invoke('tree:findByToken', workspaceId, nodeId, token),
  loadDependencies: (workspaceId, nodeId, recursive) => ipcRenderer.invoke('workspace:loadDependencies', workspaceId, nodeId, recursive),
  showItemInFolder: (path) => ipcRenderer.invoke('app:showItemInFolder', path),
  saveResource: (workspaceId, nodeIds, raw, useSubDirs) => ipcRenderer.invoke('edit:saveResource', workspaceId, nodeIds, raw, useSubDirs),
  getRoots: (workspaceId) => ipcRenderer.invoke('tree:roots', workspaceId),
  getChildren: (workspaceId, nodeId) => ipcRenderer.invoke('tree:children', workspaceId, nodeId),
  getNode: (workspaceId, nodeId) => ipcRenderer.invoke('tree:node', workspaceId, nodeId),
  getNodePath: (workspaceId, nodeId) => ipcRenderer.invoke('tree:nodePath', workspaceId, nodeId),
  decompile: (workspaceId, nodeId, language: DecompilerLanguage, settings?: unknown) => ipcRenderer.invoke('document:decompile', workspaceId, nodeId, language, settings),
  findMember: (workspaceId, modulePath, metadataToken) => ipcRenderer.invoke('document:findMember', workspaceId, modulePath, metadataToken),
  formatBookmarkLocations: (workspaceId, locations, format) => ipcRenderer.invoke('bookmarks:formatLocations', workspaceId, locations, format),
  exportBookmarks: (workspaceId, bookmarks) => ipcRenderer.invoke('bookmarks:export', workspaceId, bookmarks),
  importBookmarks: (workspaceId, xml) => ipcRenderer.invoke('bookmarks:import', workspaceId, xml),
  search: (workspaceId, request, requestKey) => ipcRenderer.invoke('search:run', workspaceId, request, requestKey),
  searchStringReferences: (workspaceId, request, requestKey) => ipcRenderer.invoke('stringReferences:search', workspaceId, request, requestKey),
  cancelStringReferences: (requestKey) => ipcRenderer.invoke('stringReferences:cancel', requestKey),
  cancelSearch: (requestKey) => ipcRenderer.invoke('search:cancel', requestKey),
  relabelSearch: (workspaceId, requestKey, language, start, count) => ipcRenderer.invoke('search:relabel', workspaceId, requestKey, language, start, count),
  analyzeNodes: (workspaceId, nodeIds, language) => ipcRenderer.invoke('analyze:nodes', workspaceId, nodeIds, language),
  analyzeChildren: (workspaceId, request, requestKey) => ipcRenderer.invoke('analyze:children', workspaceId, request, requestKey),
  cancelAnalyze: (requestKey) => ipcRenderer.invoke('analyze:cancel', requestKey),
  getHexLength: (workspaceId, moduleId) => ipcRenderer.invoke('hex:length', workspaceId, moduleId),
  readHex: (workspaceId, moduleId, offset, count) => ipcRenderer.invoke('hex:read', workspaceId, moduleId, offset, count),
  resolveHexTarget: (workspaceId, nodeId) => ipcRenderer.invoke('hex:resolveTarget', workspaceId, nodeId),
  resolveHexStatement: (workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset) => ipcRenderer.invoke('hex:resolveStatement', workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset),
  patchHex: (workspaceId, transactionId, nodeId, offset, base64Data) => ipcRenderer.invoke('hex:patch', workspaceId, transactionId, nodeId, offset, base64Data),
  getModuleInfo: (workspaceId, moduleId) => ipcRenderer.invoke('module:info', workspaceId, moduleId),
  beginEdit: (workspaceId) => ipcRenderer.invoke('edit:begin', workspaceId),
  getMethodBody: (workspaceId, methodNodeId) => ipcRenderer.invoke('edit:getMethodBody', workspaceId, methodNodeId),
  getNodeOptions: (workspaceId, kind, request) => ipcRenderer.invoke('edit:getOptions', workspaceId, kind, request),
  createNode: (workspaceId, transactionId, ownerNodeId, options, nested) => ipcRenderer.invoke('edit:create', workspaceId, transactionId, ownerNodeId, options, nested),
  setNodeOptions: (workspaceId, transactionId, nodeId, options) => ipcRenderer.invoke('edit:setOptions', workspaceId, transactionId, nodeId, options),
  queueRename: (workspaceId, transactionId, nodeId, newName) => ipcRenderer.invoke('edit:rename', workspaceId, transactionId, nodeId, newName),
  queueDelete: (workspaceId, transactionId, nodeId) => ipcRenderer.invoke('edit:delete', workspaceId, transactionId, nodeId),
  queueSetNamespace: (workspaceId, transactionId, nodeId, newName) => ipcRenderer.invoke('edit:setNamespace', workspaceId, transactionId, nodeId, newName),
  queueMethodBody: (workspaceId, transactionId, methodNodeId, body, clearExceptionHandlers) => ipcRenderer.invoke('edit:replaceMethodBody', workspaceId, transactionId, methodNodeId, body, clearExceptionHandlers),
  queueMethodBodyStub: (workspaceId, transactionId, methodNodeId) => ipcRenderer.invoke('edit:replaceMethodBodyWithStub', workspaceId, transactionId, methodNodeId),
  replaceResourceFromFile: (workspaceId, transactionId, resourceNodeId) => ipcRenderer.invoke('edit:replaceResourceFromFile', workspaceId, transactionId, resourceNodeId),
  convertModule: (workspaceId, transactionId, nodeId, toAssembly) => ipcRenderer.invoke('edit:convertModule', workspaceId, transactionId, nodeId, toAssembly),
  commitEdit: (workspaceId, transactionId) => ipcRenderer.invoke('edit:commit', workspaceId, transactionId),
  rollbackEdit: (workspaceId, transactionId) => ipcRenderer.invoke('edit:rollback', workspaceId, transactionId),
  undoEdit: (workspaceId) => ipcRenderer.invoke('edit:undo', workspaceId),
  redoEdit: (workspaceId) => ipcRenderer.invoke('edit:redo', workspaceId),
  saveModuleAs: (workspaceId, moduleId, suggestedName) => ipcRenderer.invoke('module:saveAs', workspaceId, moduleId, suggestedName),
  saveModule: (workspaceId, moduleId) => ipcRenderer.invoke('module:save', workspaceId, moduleId),
  askSaveModified: (count) => ipcRenderer.invoke('app:askSaveModified', count),
  saveAllModules: (workspaceId) => ipcRenderer.invoke('module:saveAll', workspaceId),
  saveCode: (suggestedName, text, title) => ipcRenderer.invoke('document:saveCode', suggestedName, text, title),
  readTextFile: (kind) => ipcRenderer.invoke('dialog:openTextFile', kind),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  writeFile: (directory, fileName, data) => ipcRenderer.invoke('file:write', directory, fileName, data),
  chooseDebugTarget: () => ipcRenderer.invoke('debug:chooseTarget'),
  chooseDebugDirectory: () => ipcRenderer.invoke('debug:chooseDirectory'),
  chooseDebugHost: () => ipcRenderer.invoke('debug:chooseHost'),
  pathExists: (path) => ipcRenderer.invoke('app:pathExists', path),
  listDebugProcesses: () => ipcRenderer.invoke('debug:listProcesses'),
  launchDebug: (options) => ipcRenderer.invoke('debug:launch', options),
  attachDebug: (processId, workspaceId) => ipcRenderer.invoke('debug:attach', processId, workspaceId),
  setBreakpoints: async (sessionId, breakpoints) => ((await ipcRenderer.invoke('debug:setBreakpoints', sessionId, { breakpoints })).body?.breakpoints ?? []),
  setFunctionBreakpoints: async (sessionId, breakpoints) => (await ipcRenderer.invoke('debug:setFunctionBreakpoints', sessionId, { breakpoints })).body ?? {},
  configurationDone: async (sessionId) => { await ipcRenderer.invoke('debug:configurationDone', sessionId, {}) },
  debugContinue: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:continue', sessionId, { threadId })).body ?? {},
  debugPause: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:pause', sessionId, { threadId })).body ?? {},
  debugNext: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:next', sessionId, { threadId })).body ?? {},
  debugStepIn: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:stepIn', sessionId, { threadId })).body ?? {},
  debugStepOut: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:stepOut', sessionId, { threadId })).body ?? {},
  getDebugThreads: async (sessionId) => ((await ipcRenderer.invoke('debug:threads', sessionId, {})).body?.threads ?? []),
  getDebugStackTrace: async (sessionId, threadId) => ((await ipcRenderer.invoke('debug:stackTrace', sessionId, { threadId, startFrame: 0, levels: 100 })).body?.stackFrames ?? []),
  getDebugScopes: async (sessionId, frameId) => ((await ipcRenderer.invoke('debug:scopes', sessionId, { frameId })).body?.scopes ?? []),
  getDebugVariables: async (sessionId, variablesReference) => ((await ipcRenderer.invoke('debug:variables', sessionId, { variablesReference })).body?.variables ?? []),
  getDebugModules: async (sessionId) => ((await ipcRenderer.invoke('debug:modules', sessionId, { startModule: 0, moduleCount: 10000 })).body?.modules ?? []),
  getExceptionSettings: () => ipcRenderer.invoke('debug:exceptionSettings:get'),
  applyExceptionSettings: (diff) => ipcRenderer.invoke('debug:exceptionSettings:apply', diff),
  resetExceptionSettings: () => ipcRenderer.invoke('debug:exceptionSettings:reset'),
  evaluateDebugExpression: async (sessionId, frameId, expression) => {
    const body = (await ipcRenderer.invoke('debug:evaluate', sessionId, { expression, frameId, context: 'watch' })).body
    return { name: expression, value: body?.result ?? '', type: body?.type, variablesReference: body?.variablesReference ?? 0, evaluateName: expression }
  },
  disconnectDebug: (sessionId, terminateDebuggee) => ipcRenderer.invoke('debug:disconnect', sessionId, terminateDebuggee),
  evaluateScript: (code) => ipcRenderer.invoke('script:evaluate', code),
  resetScript: () => ipcRenderer.invoke('script:reset'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  setFullScreen: (fullScreen: boolean) => ipcRenderer.invoke('window:setFullScreen', fullScreen),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  quit: () => ipcRenderer.invoke('app:quit'),
  loadBackgroundImages: (paths) => ipcRenderer.invoke('app:backgroundImages', paths),
  showMessage: (message) => ipcRenderer.invoke('app:showMessage', message),
  askMessage: (message, buttons) => ipcRenderer.invoke('app:askMessage', message, buttons),
  setUnsavedChanges: (dirty) => ipcRenderer.invoke('app:setUnsavedChanges', dirty),
  respondToClose: (approved) => ipcRenderer.invoke('app:closeResponse', approved),
  onCloseRequested: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:closeRequested', listener)
    return () => ipcRenderer.removeListener('app:closeRequested', listener)
  },
  isRunningAsAdministrator: () => ipcRenderer.invoke('app:isRunningAsAdministrator'),
  restartAsAdministrator: () => ipcRenderer.invoke('app:restartAsAdministrator'),
  getBackendStatus: () => ipcRenderer.invoke('backend:status:get'),
  getProcessId: () => ipcRenderer.invoke('app:processId'),
  setLocale: (locale: UiLocale) => ipcRenderer.invoke('app:setLocale', locale),
  updateMainSettings: (settings) => ipcRenderer.invoke('app:mainSettings', settings),
  onWindowMaximizedChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean): void => callback(isMaximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  onFullScreenChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean): void => callback(isFullScreen)
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
  },
  onBackendStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: BackendStatus): void => callback(status)
    ipcRenderer.on('backend:status', listener)
    return () => ipcRenderer.removeListener('backend:status', listener)
  },
  onCommandLine: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, commandLine: Parameters<typeof callback>[0]): void => callback(commandLine)
    ipcRenderer.on('app:commandLine', listener)
    return () => ipcRenderer.removeListener('app:commandLine', listener)
  },
  onDebugEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, debugEvent: Parameters<typeof callback>[0]): void => callback(debugEvent)
    ipcRenderer.on('debug:event', listener)
    return () => ipcRenderer.removeListener('debug:event', listener)
  },
  onAnalyzeProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('analyze:progress', listener)
    return () => ipcRenderer.removeListener('analyze:progress', listener)
  },
  onSearchProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('search:progress', listener)
    return () => ipcRenderer.removeListener('search:progress', listener)
  },
  onStringReferencesProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('stringReferences:progress', listener)
    return () => ipcRenderer.removeListener('stringReferences:progress', listener)
  },
  classifyScript: (code) => ipcRenderer.invoke('script:classify', code),
  openCodeDocument: (request) => ipcRenderer.invoke('languageService:open', request),
  updateCodeDocument: (documentId, text) => ipcRenderer.invoke('languageService:update', documentId, text),
  closeCodeDocument: (documentId) => ipcRenderer.invoke('languageService:close', documentId),
  classifyCodeDocument: (documentId) => ipcRenderer.invoke('languageService:classify', documentId),
  getCodeCompletion: (documentId, position, triggerCharacter) => ipcRenderer.invoke('languageService:completion', documentId, position, triggerCharacter ?? null),
  getCodeCompletionDescription: (documentId, resultId, index) => ipcRenderer.invoke('languageService:completionDescription', documentId, resultId, index),
  getCodeQuickInfo: (documentId, position) => ipcRenderer.invoke('languageService:quickInfo', documentId, position),
  getCodeSignatureHelp: (documentId, position, triggerCharacter) => ipcRenderer.invoke('languageService:signatureHelp', documentId, position, triggerCharacter ?? null),
  getCodeDiagnostics: (documentId) => ipcRenderer.invoke('languageService:diagnostics', documentId),
  getCodeIndentation: (request) => ipcRenderer.invoke('languageService:indentation', request),
  getCodeSelectionRanges: (documentId, positions) => ipcRenderer.invoke('languageService:selectionRanges', documentId, positions),
}

contextBridge.exposeInMainWorld('dnSpy', api)
