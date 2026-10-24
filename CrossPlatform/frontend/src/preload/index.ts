import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BackendStatus, DecompilerLanguage, DnSpyApi, UiLocale } from '../shared/protocol'

// dnSpy's settings file: with one in effect the main process hands over its renderer section before the page's
// scripts run, and the page's storage — a session of its own, never written to disk — is filled from it; what is
// in the storage when the page goes away is written back. Without one this is null and the profile's is used.
const rendererSettings = ipcRenderer.sendSync('app:rendererSettings') as Record<string, string> | null
if (rendererSettings) {
  localStorage.clear()
  for (const [key, value] of Object.entries(rendererSettings))
    localStorage.setItem(key, value)
  window.addEventListener('beforeunload', () => {
    const entries: Record<string, string> = {}
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key !== null)
        entries[key] = localStorage.getItem(key) ?? ''
    }
    ipcRenderer.sendSync('app:saveRendererSettings', entries)
  })
}

const api: DnSpyApi = {
  openAssemblies: () => ipcRenderer.invoke('dialog:openAssemblies'),
  getStartupOptions: () => ipcRenderer.invoke('app:startupOptions'),
  themeFiles: ipcRenderer.sendSync('app:themeFiles'),
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
  getResourceItems: (workspaceId, nodeIds, raw, baml) => ipcRenderer.invoke('resource:getItems', workspaceId, nodeIds, raw, baml),
  getResourceItemNames: (workspaceId, nodeIds) => ipcRenderer.invoke('resource:getItemNames', workspaceId, nodeIds),
  selectMember: (workspaceId, paths, member) => ipcRenderer.invoke('tree:selectMember', workspaceId, paths, member),
  findResource: (workspaceId, nodeId) => ipcRenderer.invoke('resource:find', workspaceId, nodeId),
  getSpecialNode: (workspaceId, nodeId, kind) => ipcRenderer.invoke('module:specialNode', workspaceId, nodeId, kind),
  findByToken: (workspaceId, nodeId, token) => ipcRenderer.invoke('tree:findByToken', workspaceId, nodeId, token),
  loadDependencies: (workspaceId, nodeId, recursive) => ipcRenderer.invoke('workspace:loadDependencies', workspaceId, nodeId, recursive),
  showItemInFolder: (path) => ipcRenderer.invoke('app:showItemInFolder', path),
  saveResource: (workspaceId, nodeIds, raw, useSubDirs, baml) => ipcRenderer.invoke('edit:saveResource', workspaceId, nodeIds, raw, useSubDirs, baml),
  getRoots: (workspaceId) => ipcRenderer.invoke('tree:roots', workspaceId),
  getChildren: (workspaceId, nodeId) => ipcRenderer.invoke('tree:children', workspaceId, nodeId),
  getNode: (workspaceId, nodeId) => ipcRenderer.invoke('tree:node', workspaceId, nodeId),
  getNodePath: (workspaceId, nodeId) => ipcRenderer.invoke('tree:nodePath', workspaceId, nodeId),
  decompile: (workspaceId, nodeId, language: DecompilerLanguage, settings?: unknown, requestKey?: string) => ipcRenderer.invoke('document:decompile', workspaceId, nodeId, language, settings, requestKey),
  cancelDecompile: (requestKey) => ipcRenderer.invoke('document:cancelDecompile', requestKey),
  resolveDocumentNode: (workspaceId, nodeId, decompileFullType) => ipcRenderer.invoke('document:resolveNode', workspaceId, nodeId, decompileFullType),
  findMember: (workspaceId, modulePath, metadataToken) => ipcRenderer.invoke('document:findMember', workspaceId, modulePath, metadataToken),
  quickInfo: (workspaceId, request) => ipcRenderer.invoke('document:quickInfo', workspaceId, request),
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
  getHexStructure: (workspaceId, nodeId) => ipcRenderer.invoke('hex:getStructure', workspaceId, nodeId),
  getMetadataTable: (workspaceId, nodeId) => ipcRenderer.invoke('metadata:getTable', workspaceId, nodeId),
  getMetadataTableRows: (workspaceId, nodeId, startRid, count) => ipcRenderer.invoke('metadata:getTableRows', workspaceId, nodeId, startRid, count),
  sortMetadataTable: (workspaceId, nodeId, rid, count) => ipcRenderer.invoke('metadata:sortTable', workspaceId, nodeId, rid, count),
  getMetadataTableText: (workspaceId, nodeId, rids) => ipcRenderer.invoke('metadata:tableText', workspaceId, nodeId, rids),
  findMetadataRecord: (workspaceId, nodeId, token) => ipcRenderer.invoke('metadata:findRecord', workspaceId, nodeId, token),
  resolveHexStatement: (workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset) => ipcRenderer.invoke('hex:resolveStatement', workspaceId, modulePath, metadataToken, ilOffset, ilEndOffset),
  patchHex: (workspaceId, transactionId, nodeId, offset, base64Data) => ipcRenderer.invoke('hex:patch', workspaceId, transactionId, nodeId, offset, base64Data),
  resolveHexPosition: (workspaceId, moduleId, kind, value) => ipcRenderer.invoke('hex:resolvePosition', workspaceId, moduleId, kind, value),
  goToHexMetadata: (workspaceId, moduleId, kind, value) => ipcRenderer.invoke('hex:goToMetadata', workspaceId, moduleId, kind, value),
  findHex: (workspaceId, moduleId, base64Pattern, start, reverse, wrap) => ipcRenderer.invoke('hex:find', workspaceId, moduleId, base64Pattern, start, reverse, wrap),
  refreshDebugMemory: (sessionId) => ipcRenderer.invoke('debugMemory:refresh', sessionId).then(() => undefined),
  getDebugMemoryToolTipInfo: (sessionId, address) => ipcRenderer.invoke('debugMemory:toolTipInfo', sessionId, address),
  getDebugMemoryPositionInfo: (sessionId, address) => ipcRenderer.invoke('debugMemory:positionInfo', sessionId, address),
  resolveDebugMemoryPosition: (sessionId, caretAddress, kind, value) => ipcRenderer.invoke('debugMemory:resolvePosition', sessionId, caretAddress, kind, value),
  goToDebugMemoryMetadata: (sessionId, caretAddress, kind, value) => ipcRenderer.invoke('debugMemory:goToMetadata', sessionId, caretAddress, kind, value),
  getDebugMemoryFileInfo: (sessionId, address) => ipcRenderer.invoke('debugMemory:fileInfo', sessionId, address),
  getDebugMemorySpace: (sessionId) => ipcRenderer.invoke('debugMemory:space', sessionId),
  getDebugMemoryValidSpan: (sessionId, position, bounds, forward, fullSpan) => ipcRenderer.invoke('debugMemory:validSpan', sessionId, position, bounds, forward, fullSpan),
  searchDebugMemory: (sessionId, request) => ipcRenderer.invoke('debugMemory:search', sessionId, request),
  getEncodings: () => ipcRenderer.invoke('text:getEncodings'),
  encodeText: (codePage, text) => ipcRenderer.invoke('text:encode', codePage, text),
  searchHex: (workspaceId, moduleId, request) => ipcRenderer.invoke('hex:search', workspaceId, moduleId, request),
  getHexToolTipInfo: (workspaceId, moduleId, position) => ipcRenderer.invoke('hex:toolTipInfo', workspaceId, moduleId, position),
  getHexPositionInfo: (workspaceId, moduleId, position) => ipcRenderer.invoke('hex:positionInfo', workspaceId, moduleId, position),
  pickHexSaveFile: () => ipcRenderer.invoke('hex:pickSaveFile'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  writeHexFileChunk: (filePath, base64Data, append) => ipcRenderer.invoke('hex:writeFileChunk', filePath, base64Data, append),
  deleteHexFile: (filePath) => ipcRenderer.invoke('hex:deleteFile', filePath),
  getModuleInfo: (workspaceId, moduleId) => ipcRenderer.invoke('module:info', workspaceId, moduleId),
  beginEdit: (workspaceId) => ipcRenderer.invoke('edit:begin', workspaceId),
  getMethodBody: (workspaceId, methodNodeId) => ipcRenderer.invoke('edit:getMethodBody', workspaceId, methodNodeId),
  getIlBody: (workspaceId, methodNodeId) => ipcRenderer.invoke('edit:getIlBody', workspaceId, methodNodeId),
  queueIlBody: (workspaceId, transactionId, methodNodeId, body) => ipcRenderer.invoke('edit:replaceIlBody', workspaceId, transactionId, methodNodeId, body),
  transformIlBody: (workspaceId, methodNodeId, operation, locals, instructions, selectedIndexes, parameterNames) => ipcRenderer.invoke('edit:transformIlBody', workspaceId, methodNodeId, operation, locals, instructions, selectedIndexes, parameterNames),
  getNodeOptions: (workspaceId, kind, request) => ipcRenderer.invoke('edit:getOptions', workspaceId, kind, request),
  createNode: (workspaceId, transactionId, ownerNodeId, options, nested) => ipcRenderer.invoke('edit:create', workspaceId, transactionId, ownerNodeId, options, nested),
  setNodeOptions: (workspaceId, transactionId, nodeId, options) => ipcRenderer.invoke('edit:setOptions', workspaceId, transactionId, nodeId, options),
  queueRename: (workspaceId, transactionId, nodeId, newName) => ipcRenderer.invoke('edit:rename', workspaceId, transactionId, nodeId, newName),
  queueDelete: (workspaceId, transactionId, nodeId) => ipcRenderer.invoke('edit:delete', workspaceId, transactionId, nodeId),
  queueSetNamespace: (workspaceId, transactionId, nodeId, newName) => ipcRenderer.invoke('edit:setNamespace', workspaceId, transactionId, nodeId, newName),
  queueMethodBody: (workspaceId, transactionId, methodNodeId, body, clearExceptionHandlers) => ipcRenderer.invoke('edit:replaceMethodBody', workspaceId, transactionId, methodNodeId, body, clearExceptionHandlers),
  queueMethodBodyStub: (workspaceId, transactionId, methodNodeId) => ipcRenderer.invoke('edit:replaceMethodBodyWithStub', workspaceId, transactionId, methodNodeId),
  replaceResourceFromFile: (workspaceId, transactionId, resourceNodeId) => ipcRenderer.invoke('edit:replaceResourceFromFile', workspaceId, transactionId, resourceNodeId),
  getAssemblyAttributesSource: (workspaceId, nodeId, language) => ipcRenderer.invoke('compiler:getAssemblyAttributesSource', workspaceId, nodeId, language),
  mergeAssembly: (workspaceId, transactionId, nodeId) => ipcRenderer.invoke('compiler:merge', workspaceId, transactionId, nodeId),
  compileSource: (workspaceId, nodeId, mode, source, transactionId, language, settings) => ipcRenderer.invoke('compiler:compile', workspaceId, nodeId, mode, source, transactionId, language, settings),
  getAssemblyOptions: (workspaceId, nodeId) => ipcRenderer.invoke('assembly:getOptions', workspaceId, nodeId),
  setAssemblyOptions: (workspaceId, transactionId, nodeId, options) => ipcRenderer.invoke('assembly:setOptions', workspaceId, transactionId, nodeId, options),
  getModuleOptions: (workspaceId, nodeId) => ipcRenderer.invoke('module:getOptions', workspaceId, nodeId),
  setModuleOptions: (workspaceId, transactionId, nodeId, options) => ipcRenderer.invoke('module:setOptions', workspaceId, transactionId, nodeId, options),
  getResourceOptions: (workspaceId, resourceNodeId) => ipcRenderer.invoke('resource:getOptions', workspaceId, resourceNodeId),
  setResourceOptions: (workspaceId, transactionId, resourceNodeId, options) => ipcRenderer.invoke('resource:setOptions', workspaceId, transactionId, resourceNodeId, options),
  createResource: (workspaceId, transactionId, ownerNodeId, options) => ipcRenderer.invoke('resource:create', workspaceId, transactionId, ownerNodeId, options),
  getResourceElementOptions: (workspaceId, nodeId) => ipcRenderer.invoke('resource:getElementOptions', workspaceId, nodeId),
  setResourceElementOptions: (workspaceId, transactionId, nodeId, options) => ipcRenderer.invoke('resource:setElementOptions', workspaceId, transactionId, nodeId, options),
  createResourceElement: (workspaceId, transactionId, resourceNodeId, options) => ipcRenderer.invoke('resource:createElement', workspaceId, transactionId, resourceNodeId, options),
  convertModule: (workspaceId, transactionId, nodeId, toAssembly) => ipcRenderer.invoke('edit:convertModule', workspaceId, transactionId, nodeId, toAssembly),
  commitEdit: (workspaceId, transactionId) => ipcRenderer.invoke('edit:commit', workspaceId, transactionId),
  rollbackEdit: (workspaceId, transactionId) => ipcRenderer.invoke('edit:rollback', workspaceId, transactionId),
  undoEdit: (workspaceId) => ipcRenderer.invoke('edit:undo', workspaceId),
  redoEdit: (workspaceId) => ipcRenderer.invoke('edit:redo', workspaceId),
  saveModuleAs: (workspaceId, moduleId, suggestedName, options) => ipcRenderer.invoke('module:saveAs', workspaceId, moduleId, suggestedName, options),
  saveModule: (workspaceId, moduleId, options) => ipcRenderer.invoke('module:save', workspaceId, moduleId, options),
  askSaveModified: (count) => ipcRenderer.invoke('app:askSaveModified', count),
  saveAllModules: (workspaceId, options) => ipcRenderer.invoke('module:saveAll', workspaceId, options),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  createAssembly: (workspaceId, transactionId, options, clrVersion) => ipcRenderer.invoke('assembly:create', workspaceId, transactionId, options, clrVersion),
  createNetModule: (workspaceId, transactionId, name, mvid, clrVersion) => ipcRenderer.invoke('module:createNetModule', workspaceId, transactionId, name, mvid, clrVersion),
  addNetModule: (workspaceId, transactionId, assemblyNodeId, module) => ipcRenderer.invoke('module:addNetModule', workspaceId, transactionId, assemblyNodeId, module),
  removeNetModule: (workspaceId, transactionId, moduleNodeId) => ipcRenderer.invoke('module:removeNetModule', workspaceId, transactionId, moduleNodeId),
  getNetModuleDefaults: (workspaceId, assemblyNodeId) => ipcRenderer.invoke('module:netModuleDefaults', workspaceId, assemblyNodeId),
  pickNetModuleFile: () => ipcRenderer.invoke('dialog:pickNetModule'),
  pickImageFiles: (multiple, includeCursors) => ipcRenderer.invoke('dialog:pickImages', multiple, includeCursors),
  getIlBytes: (workspaceId, modulePath, instructions) => ipcRenderer.invoke('document:getIlBytes', workspaceId, modulePath, instructions),
  getModifiedDocuments: (workspaceId) => ipcRenderer.invoke('workspace:modifiedDocuments', workspaceId),
  getSaveOptions: (workspaceId, documentId, useMixedMode) => ipcRenderer.invoke('module:saveOptions', workspaceId, documentId, useMixedMode),
  saveDocuments: (workspaceId, documents, requestKey) => ipcRenderer.invoke('module:saveDocuments', workspaceId, documents, requestKey),
  cancelSave: (requestKey) => ipcRenderer.invoke('module:cancelSave', requestKey),
  onSaveProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('module:saveProgress', listener)
    return () => ipcRenderer.removeListener('module:saveProgress', listener)
  },
  getExportProjectInfo: (workspaceId, nodeIds) => ipcRenderer.invoke('project:getExportInfo', workspaceId, nodeIds),
  exportProject: (request, requestKey) => ipcRenderer.invoke('project:export', request, requestKey),
  cancelExportProject: (requestKey) => ipcRenderer.invoke('project:cancelExport', requestKey),
  onExportProjectProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('project:exportProgress', listener)
    return () => ipcRenderer.removeListener('project:exportProgress', listener)
  },
  pickExportDirectory: (currentDirectory) => ipcRenderer.invoke('dialog:pickExportDirectory', currentDirectory),
  isExistingFile: (path) => ipcRenderer.invoke('fs:isExistingFile', path),
  openExportedProject: (path) => ipcRenderer.invoke('shell:openExportedProject', path),
  pickSaveFileName: (defaultPath, kind, extension) => ipcRenderer.invoke('dialog:pickSaveFileName', defaultPath, kind, extension),
  validateSaveFileName: (fileName) => ipcRenderer.invoke('dialog:validateSaveFileName', fileName),
  askExitUnsaved: (count) => ipcRenderer.invoke('app:askExitUnsaved', count),
  saveCode: (suggestedName, text, title) => ipcRenderer.invoke('document:saveCode', suggestedName, text, title),
  readTextFile: (kind) => ipcRenderer.invoke('dialog:openTextFile', kind),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  writeFile: (directory, fileName, data) => ipcRenderer.invoke('file:write', directory, fileName, data),
  chooseDebugTarget: () => ipcRenderer.invoke('debug:chooseTarget'),
  chooseDebugDirectory: () => ipcRenderer.invoke('debug:chooseDirectory'),
  chooseDebugHost: () => ipcRenderer.invoke('debug:chooseHost'),
  chooseDebugModuleSavePath: (suggestedName) => ipcRenderer.invoke('debug:chooseModuleSavePath', suggestedName),
  pathExists: (path) => ipcRenderer.invoke('app:pathExists', path),
  listDebugProcesses: () => ipcRenderer.invoke('debug:listProcesses'),
  launchDebug: (options) => ipcRenderer.invoke('debug:launch', options),
  startWithoutDebugging: (options) => ipcRenderer.invoke('debug:startWithoutDebugging', options),
  attachDebug: (processId, workspaceId) => ipcRenderer.invoke('debug:attach', processId, workspaceId),
  setBreakpoints: async (sessionId, breakpoints) => ((await ipcRenderer.invoke('debug:setBreakpoints', sessionId, { breakpoints })).body?.breakpoints ?? []),
  getDebugCodeTargets: (workspaceId, references) => ipcRenderer.invoke('debug:codeTargets', workspaceId, references),
  exportBreakpoints: (workspaceId, breakpoints) => ipcRenderer.invoke('breakpoints:export', workspaceId, breakpoints),
  importBreakpoints: (workspaceId, xml) => ipcRenderer.invoke('breakpoints:import', workspaceId, xml),
  setFunctionBreakpoints: async (sessionId, breakpoints) => (await ipcRenderer.invoke('debug:setFunctionBreakpoints', sessionId, { breakpoints })).body ?? {},
  configurationDone: async (sessionId) => { await ipcRenderer.invoke('debug:configurationDone', sessionId, {}) },
  debugContinue: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:continue', sessionId, { threadId })).body ?? {},
  debugPause: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:pause', sessionId, { threadId })).body ?? {},
  debugNext: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:next', sessionId, { threadId })).body ?? {},
  debugStepIn: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:stepIn', sessionId, { threadId })).body ?? {},
  debugStepOut: async (sessionId, threadId) => (await ipcRenderer.invoke('debug:stepOut', sessionId, { threadId })).body ?? {},
  getDebugThreads: async (sessionId) => ((await ipcRenderer.invoke('debug:threads', sessionId, {})).body?.threads ?? []),
  getDebugStackTrace: async (sessionId, threadId, format) => ((await ipcRenderer.invoke('debug:stackTrace', sessionId, { threadId, startFrame: 0, levels: 1000, format })).body?.stackFrames ?? []),
  getDebugScopes: async (sessionId, frameId) => ((await ipcRenderer.invoke('debug:scopes', sessionId, { frameId })).body?.scopes ?? []),
  getDebugVariables: async (sessionId, variablesReference) => ((await ipcRenderer.invoke('debug:variables', sessionId, { variablesReference })).body?.variables ?? []),
  getDebugModules: async (sessionId) => ((await ipcRenderer.invoke('debug:modules', sessionId, { startModule: 0, moduleCount: 10000 })).body?.modules ?? []),
  getExceptionSettings: () => ipcRenderer.invoke('debug:exceptionSettings:get'),
  applyExceptionSettings: (diff) => ipcRenderer.invoke('debug:exceptionSettings:apply', diff),
  resetExceptionSettings: () => ipcRenderer.invoke('debug:exceptionSettings:reset'),
  evaluateDebugExpression: async (sessionId, frameId, expression, options) => {
    const body = (await ipcRenderer.invoke('debug:evaluate', sessionId, { expression, frameId, context: 'watch', ...options })).body
    return body ?? { name: expression, value: '', variablesReference: 0, evaluateName: expression }
  },
  setDebuggerOptions: async (options) => { await ipcRenderer.invoke('debug:setOptions', options) },
  getDebugFrameLocation: async (sessionId, frameId) => (await ipcRenderer.invoke('debug:frameLocation', sessionId, { frameId })).body,
  getDebugChildren: async (sessionId, variablesReference, start, count) => {
    const body = (await ipcRenderer.invoke('debug:variables', sessionId, { variablesReference, start, count })).body
    return { variables: body?.variables ?? [], totalCount: body?.totalCount }
  },
  setDebugExpression: async (sessionId, frameId, expression, value) => (await ipcRenderer.invoke('debug:setExpression', sessionId, { frameId, expression, value })).body,
  getDebugAutos: async (sessionId, frameId) => ((await ipcRenderer.invoke('debug:autos', sessionId, { frameId })).body?.variables ?? []),
  getDebugStaticFields: async (sessionId, frameId) => ((await ipcRenderer.invoke('debug:staticFields', sessionId, { frameId })).body?.variables ?? []),
  makeDebugObjectId: async (sessionId, frameId, expression) => (await ipcRenderer.invoke('debug:makeObjectId', sessionId, { frameId, expression })).body?.id ?? '',
  deleteDebugObjectId: async (sessionId, id) => { await ipcRenderer.invoke('debug:deleteObjectId', sessionId, { id }) },
  setNextStatement: async (sessionId, threadId, location) => { await ipcRenderer.invoke('debug:setNextStatement', sessionId, { threadId, ...location }) },
  runToDebugFrame: async (sessionId, frameId) => { await ipcRenderer.invoke('debug:runToFrame', sessionId, { frameId }) },
  setDebugModuleBreakpoints: async (sessionId, breakpoints) => { await ipcRenderer.invoke('debug:setModuleBreakpoints', sessionId, { breakpoints }) },
  runToDebugCursor: async (sessionId, location) => { await ipcRenderer.invoke('debug:runToCursor', sessionId, location) },
  resetDebugBreakpointHitCounts: async (sessionId, ids) => { await ipcRenderer.invoke('debug:resetHitCounts', sessionId, { ids }) },
  verifyBreakpointFilter: (filter) => ipcRenderer.invoke('debug:verifyFilter', filter),
  freezeDebugThreads: async (sessionId, threadIds, freeze) => { await ipcRenderer.invoke('debug:freezeThread', sessionId, { threadIds, freeze }) },
  renameDebugThread: async (sessionId, threadId, name) => { await ipcRenderer.invoke('debug:renameThread', sessionId, { threadId, name }) },
  getDebugProcess: async (sessionId) => (await ipcRenderer.invoke('debug:process', sessionId, {})).body,
  readDebugMemory: async (sessionId, address, count) => (await ipcRenderer.invoke('debug:readMemory', sessionId, { address, count })).body,
  writeDebugMemory: async (sessionId, address, data) => { await ipcRenderer.invoke('debug:writeMemory', sessionId, { address, data }) },
  disassembleDebugFrame: async (sessionId, target, options) => (await ipcRenderer.invoke('debug:disassemble', sessionId, { ...target, options })).body,
  saveDebugModule: async (sessionId, moduleId, path) => (await ipcRenderer.invoke('debug:saveModule', sessionId, { moduleId, path })).body?.path ?? '',
  disconnectDebug: (sessionId, terminateDebuggee) => ipcRenderer.invoke('debug:disconnect', sessionId, terminateDebuggee),
  evaluateScript: (code) => ipcRenderer.invoke('script:evaluate', code),
  resetScript: (options) => ipcRenderer.invoke('script:reset', options ?? {}),
  isScriptComplete: (code) => ipcRenderer.invoke('script:isComplete', code),
  onScriptOutput: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, notification: Parameters<typeof callback>[0]): void => callback(notification)
    ipcRenderer.on('script:output', listener)
    return () => ipcRenderer.removeListener('script:output', listener)
  },
  onScriptAsk: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]): void => callback(request)
    ipcRenderer.on('script:ask', listener)
    return () => ipcRenderer.removeListener('script:ask', listener)
  },
  respondScriptAsk: (id, text) => ipcRenderer.invoke('script:askResponse', id, text),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  bringWindowToFront: () => ipcRenderer.invoke('window:bringToFront'),
  focusProcessWindow: (processId: number) => ipcRenderer.invoke('window:focusProcess', processId),
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
  listSystemFonts: () => ipcRenderer.invoke('app:listSystemFonts'),
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
