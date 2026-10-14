using System.Buffers;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Core.LanguageService;
using dnSpy.Backend.Debugging.CorDebug;

namespace dnSpy.Backend.Host;

internal sealed class JsonRpcServer {
	const int MaxHeaderLength = 8192;
	const int MaxMessageLength = 32 * 1024 * 1024;
	readonly Stream input;
	readonly Stream output;
	readonly WorkspaceManager workspaces;
	readonly CSharpScriptService scripts;
	readonly RoslynLanguageService languageService;
	readonly CorDebugSessionManager? debugSessions;
	readonly HostOptions hostOptions;
	readonly CancellationTokenSource shutdown;
	readonly SemaphoreSlim outputGate = new(1, 1);
	readonly ConcurrentDictionary<string, CancellationTokenSource> requests = new(StringComparer.Ordinal);
	readonly JsonSerializerOptions jsonOptions = CreateJsonOptions();
	volatile bool handshakeComplete;

	public JsonRpcServer(Stream input, Stream output, WorkspaceManager workspaces, CSharpScriptService scripts, RoslynLanguageService languageService, CorDebugSessionManager? debugSessions, HostOptions hostOptions, CancellationTokenSource shutdown) {
		this.input = input;
		this.output = output;
		this.workspaces = workspaces;
		this.scripts = scripts;
		this.languageService = languageService;
		this.debugSessions = debugSessions;
		this.hostOptions = hostOptions;
		this.shutdown = shutdown;
		if (debugSessions is not null)
			debugSessions.EventReceived += DebugSessions_EventReceived;
	}

	void DebugSessions_EventReceived(object? sender, DebugEventNotification e) =>
		_ = WriteNotificationAsync(RpcMethods.DebugEvent, e);

	static JsonSerializerOptions CreateJsonOptions() {
		var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) {
			PropertyNameCaseInsensitive = true,
		};
		options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
		return options;
	}

	public async Task RunAsync(CancellationToken cancellationToken) {
		HostLog.Info("backend-started", new {
			protocolVersion = ProtocolInfo.Version,
			processId = Environment.ProcessId,
		});
		var activeTasks = new HashSet<Task>();
		while (!cancellationToken.IsCancellationRequested) {
			var payload = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
			if (payload is null)
				break;

			RpcRequest? request;
			try {
				request = JsonSerializer.Deserialize<RpcRequest>(payload, jsonOptions);
				if (request is null || request.JsonRpc != "2.0" || string.IsNullOrWhiteSpace(request.Method))
					throw new JsonException("Invalid JSON-RPC request.");
			}
			catch (JsonException ex) {
				await WriteResponseAsync(new RpcResponse {
					Error = new RpcError(ErrorCodes.ParseError, "The JSON-RPC request could not be parsed."),
				}, CancellationToken.None).ConfigureAwait(false);
				HostLog.Error("request-parse-failed", ex);
				continue;
			}

			if (request.Method == RpcMethods.Cancel) {
				CancelRequest(request.Params);
				continue;
			}

			// Keep the pre-handshake checks ordered: the first request must be system/hello,
			// and a later request must not race the hello task on the thread pool. Once the
			// handshake is complete, ProcessRequestAsync can enter a synchronous, CPU-heavy
			// operation before its first await (for example, ILSpy decompiling a whole
			// assembly), so run it away from this loop so that the host can continue reading
			// cancellation and other RPC messages.
			// Do not pass the server token to Task.Run: a shutdown must still let a request
			// which has already been accepted finish its response/cleanup path.
			var task = !handshakeComplete
				? ProcessRequestAsync(request, cancellationToken)
				: Task.Run(() => ProcessRequestAsync(request, cancellationToken), CancellationToken.None);
			lock (activeTasks)
				activeTasks.Add(task);
			_ = task.ContinueWith(
				completed => {
					lock (activeTasks)
						activeTasks.Remove(completed);
				},
				CancellationToken.None,
				TaskContinuationOptions.ExecuteSynchronously,
				TaskScheduler.Default);
		}

		Task[] remaining;
		lock (activeTasks)
			remaining = activeTasks.ToArray();
		await Task.WhenAll(remaining).ConfigureAwait(false);
		HostLog.Info("backend-stopped");
	}

	async Task ProcessRequestAsync(RpcRequest request, CancellationToken serverCancellationToken) {
		if (request.Id is null) {
			await ProcessNotificationAsync(request, serverCancellationToken).ConfigureAwait(false);
			return;
		}

		var requestKey = request.Id.Value.GetRawText();
		using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(serverCancellationToken);
		if (!requests.TryAdd(requestKey, requestCancellation)) {
			await WriteErrorAsync(request.Id, ErrorCodes.InvalidRequest, "A request with this ID is already active.").ConfigureAwait(false);
			return;
		}

		try {
			var result = await DispatchAsync(request, requestCancellation.Token).ConfigureAwait(false);
			await WriteResponseAsync(new RpcResponse { Id = request.Id, Result = result }, CancellationToken.None).ConfigureAwait(false);
		}
		catch (OperationCanceledException) {
			await WriteErrorAsync(request.Id, ErrorCodes.RequestCanceled, "The request was canceled.").ConfigureAwait(false);
		}
		catch (RpcException ex) {
			await WriteResponseAsync(new RpcResponse {
				Id = request.Id,
				Error = new RpcError(ex.Code, ex.Message, ex.DataValue),
			}, CancellationToken.None).ConfigureAwait(false);
		}
		catch (JsonException ex) {
			await WriteErrorAsync(request.Id, ErrorCodes.InvalidParams, "The request parameters are invalid.").ConfigureAwait(false);
			HostLog.Error("invalid-request-params", ex);
		}
		catch (Exception ex) {
			await WriteErrorAsync(request.Id, ErrorCodes.InternalError, "The backend could not complete the request.").ConfigureAwait(false);
			HostLog.Error("request-failed", ex);
		}
		finally {
			requests.TryRemove(requestKey, out _);
		}
	}

	async Task ProcessNotificationAsync(RpcRequest request, CancellationToken cancellationToken) {
		try {
			await DispatchAsync(request, cancellationToken).ConfigureAwait(false);
		}
		catch (Exception ex) {
			HostLog.Error("notification-failed", ex);
		}
	}

	async Task<object?> DispatchAsync(RpcRequest request, CancellationToken cancellationToken) {
		if (!handshakeComplete && request.Method != RpcMethods.Hello)
			throw new RpcException(ErrorCodes.InvalidRequest, "system/hello must be the first request.");

		switch (request.Method) {
			case RpcMethods.Hello:
				return Hello(DeserializeParams<HelloRequest>(request));
			case RpcMethods.Shutdown:
				await shutdown.CancelAsync().ConfigureAwait(false);
				return new { acknowledged = true };
			case RpcMethods.WorkspaceOpen:
				return await workspaces.OpenAsync(DeserializeParams<OpenWorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceAddModules:
				return await workspaces.AddModulesAsync(DeserializeParams<AddModulesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceClose:
				workspaces.Close(DeserializeParams<WorkspaceRequest>(request));
				return new { closed = true };
			case RpcMethods.TreeGetRoots:
				return await workspaces.GetRootsAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeGetChildren:
				return await workspaces.GetChildrenAsync(DeserializeParams<NodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeGetNode:
				return await workspaces.GetNodeAsync(DeserializeParams<NodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeGetNodePath:
				return await workspaces.GetNodePathAsync(DeserializeParams<NodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DocumentDecompile:
				return await workspaces.DecompileAsync(DeserializeParams<DecompileRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DocumentFindMember:
				return await workspaces.FindMemberAsync(DeserializeParams<FindMemberRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.Search:
				return await workspaces.SearchAsync(
					DeserializeParams<SearchRequest>(request),
					progress => WriteNotificationAsync(RpcMethods.SearchProgress, progress),
					cancellationToken).ConfigureAwait(false);
			case RpcMethods.StringReferencesSearch:
				return await workspaces.SearchStringReferencesAsync(
					DeserializeParams<StringReferencesSearchRequest>(request),
					progress => WriteNotificationAsync(RpcMethods.StringReferencesProgress, progress),
					cancellationToken).ConfigureAwait(false);
			case RpcMethods.AnalyzeNodes:
				return await workspaces.AnalyzeNodesAsync(DeserializeParams<AnalyzeNodesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.AnalyzeChildren:
				return await workspaces.AnalyzeChildrenAsync(
					DeserializeParams<AnalyzeChildrenRequest>(request),
					progress => WriteNotificationAsync(RpcMethods.AnalyzeProgress, progress),
					cancellationToken).ConfigureAwait(false);
			case RpcMethods.HexGetLength:
				return await workspaces.GetHexLengthAsync(DeserializeParams<HexLengthRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.HexReadRange:
				return await workspaces.ReadHexAsync(DeserializeParams<HexReadRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.HexResolveTarget:
				return await workspaces.ResolveHexTargetAsync(DeserializeParams<HexTargetRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.HexResolveStatement:
				return await workspaces.ResolveHexStatementAsync(DeserializeParams<HexStatementRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ModuleGetInfo:
				return await workspaces.GetModuleInfoAsync(DeserializeParams<ModuleInfoRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditBegin:
				return await workspaces.BeginEditAsync(DeserializeParams<BeginEditRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditGetMethodBody:
				return await workspaces.GetMethodBodyAsync(DeserializeParams<MethodBodyRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditGetOptions:
				return await workspaces.GetOptionsAsync(DeserializeParams<GetNodeOptionsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditCreate:
				return await workspaces.QueueCreateAsync(DeserializeParams<CreateNodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditSetOptions:
				return await workspaces.QueueSetOptionsAsync(DeserializeParams<SetNodeOptionsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditRename:
				await workspaces.QueueRenameAsync(DeserializeParams<RenameEditRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditDelete:
				await workspaces.QueueDeleteAsync(DeserializeParams<DeleteEditRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditSetNamespace:
				await workspaces.QueueSetNamespaceAsync(DeserializeParams<SetNamespaceEditRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditReplaceMethodBody:
				await workspaces.QueueMethodBodyAsync(DeserializeParams<ReplaceMethodBodyRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditReplaceMethodBodyWithStub:
				await workspaces.QueueMethodBodyStubAsync(DeserializeParams<ReplaceMethodBodyWithStubRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditReplaceResource:
				await workspaces.QueueResourceAsync(DeserializeParams<ReplaceResourceRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditConvertModule:
				await workspaces.QueueConvertModuleAsync(DeserializeParams<ConvertModuleRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditHexPatch:
				await workspaces.QueueHexPatchAsync(DeserializeParams<HexPatchRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { queued = true };
			case RpcMethods.EditCommit:
				return await workspaces.CommitEditAsync(DeserializeParams<EditTransactionRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditRollback:
				await workspaces.RollbackEditAsync(DeserializeParams<EditTransactionRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { rolledBack = true };
			case RpcMethods.EditUndo:
				return await workspaces.UndoAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.EditRedo:
				return await workspaces.RedoAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ModuleSaveAs:
				return await workspaces.SaveModuleAsync(DeserializeParams<SaveModuleRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ModuleSave:
				return await workspaces.SaveModuleInPlaceAsync(DeserializeParams<SaveModuleInPlaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ModuleSaveAll:
				return await workspaces.SaveAllModulesAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceReload:
				return await workspaces.ReloadAsync(DeserializeParams<ReloadWorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceSortAssemblies:
				return await workspaces.SortAssembliesAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceRemoveModule:
				return await workspaces.RemoveModuleAsync(DeserializeParams<NodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceRemoveModules:
				return await workspaces.RemoveModulesAsync(DeserializeParams<RemoveModulesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceGetModifiedModules:
				return await workspaces.GetModifiedModulesAsync(DeserializeParams<ModifiedModulesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceGetCloseCandidates:
				return await workspaces.GetCloseCandidatesAsync(DeserializeParams<WorkspaceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceMoveRoots:
				return await workspaces.MoveRootsAsync(DeserializeParams<MoveRootsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceDropFiles:
				return await workspaces.DropFilesAsync(DeserializeParams<DropFilesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ModuleGetSpecialNode:
				return await workspaces.GetSpecialNodeAsync(DeserializeParams<SpecialNodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeFindByToken:
				return await workspaces.FindByTokenAsync(DeserializeParams<FindByTokenRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ResourceGetData:
				return await workspaces.GetResourceDataAsync(DeserializeParams<ResourceDataRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.WorkspaceLoadDependencies:
				return await workspaces.LoadDependenciesAsync(DeserializeParams<LoadDependenciesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.BookmarksFormatLocations:
				return await workspaces.FormatBookmarkLocationsAsync(DeserializeParams<FormatBookmarkLocationsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.BookmarksExport:
				return await workspaces.ExportBookmarksAsync(DeserializeParams<ExportBookmarksRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.BookmarksImport:
				return await workspaces.ImportBookmarksAsync(DeserializeParams<ImportBookmarksRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.GacList:
				return await workspaces.ListGacAsync(cancellationToken).ConfigureAwait(false);
			case RpcMethods.GacGetDetails:
				return await workspaces.GetGacDetailsAsync(DeserializeParams<GacDetailsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DocumentListDefaults:
				return await Task.Run(DefaultDocumentLists.Find, cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeActivate:
				return await workspaces.ActivateNodeAsync(DeserializeParams<NodeRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ResourceGetItems:
				return await workspaces.GetResourceItemsAsync(DeserializeParams<ResourceItemsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ResourceFind:
				return await workspaces.FindResourceAsync(DeserializeParams<FindResourceRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ResourceGetItemNames:
				return await workspaces.GetResourceItemNamesAsync(DeserializeParams<ResourceItemsRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.TreeSelectMember:
				return await workspaces.SelectMemberAsync(DeserializeParams<SelectMemberRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.ScriptEvaluate:
				return await scripts.EvaluateAsync(DeserializeParams<ScriptEvaluateRequest>(request).Code, cancellationToken).ConfigureAwait(false);
			case RpcMethods.ScriptReset:
				return await scripts.ResetAsync().ConfigureAwait(false);
			case RpcMethods.ScriptClassify:
				return await scripts.ClassifyAsync(DeserializeParams<ScriptClassifyRequest>(request).Code, cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceOpen:
				return languageService.Open(DeserializeParams<CodeDocumentOpenRequest>(request));
			case RpcMethods.LanguageServiceUpdate:
				languageService.Update(DeserializeParams<CodeDocumentUpdateRequest>(request));
				return new { updated = true };
			case RpcMethods.LanguageServiceClose:
				languageService.Close(DeserializeParams<CodeDocumentRequest>(request));
				return new { closed = true };
			case RpcMethods.LanguageServiceClassify:
				return await languageService.ClassifyAsync(DeserializeParams<CodeDocumentRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceCompletion:
				return await languageService.GetCompletionAsync(DeserializeParams<CodeCompletionRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceCompletionDescription:
				return await languageService.GetCompletionDescriptionAsync(DeserializeParams<CodeCompletionDescriptionRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceQuickInfo:
				return await languageService.GetQuickInfoAsync(DeserializeParams<CodePositionRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceSignatureHelp:
				return await languageService.GetSignatureHelpAsync(DeserializeParams<CodeSignatureHelpRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceDiagnostics:
				return await languageService.GetDiagnosticsAsync(DeserializeParams<CodeDocumentRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceIndentation:
				return await languageService.GetIndentationAsync(DeserializeParams<CodeIndentationRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.LanguageServiceSelectionRanges:
				return await languageService.GetSelectionRangesAsync(DeserializeParams<CodeSelectionRangesRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DebugLaunch:
				return await GetDebugSessions().LaunchAsync(DeserializeParams<DebugLaunchRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DebugListProcesses:
				return GetDebugSessions().ListProcesses();
			case RpcMethods.DebugAttach:
				return await GetDebugSessions().AttachAsync(DeserializeParams<DebugAttachRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DebugRequest:
				return await GetDebugSessions().RequestAsync(DeserializeParams<DebugAdapterRequest>(request), cancellationToken).ConfigureAwait(false);
			case RpcMethods.DebugDisconnect:
				await GetDebugSessions().DisconnectAsync(DeserializeParams<DebugDisconnectRequest>(request), cancellationToken).ConfigureAwait(false);
				return new { disconnected = true };
			case RpcMethods.ExceptionGet:
				return GetDebugSessions().GetExceptionSettings();
			case RpcMethods.ExceptionApply:
				return GetDebugSessions().ApplyExceptionSettings(ReadParamsElement(request));
			case RpcMethods.ExceptionReset:
				return GetDebugSessions().ResetExceptionSettings();
			default:
				throw new RpcException(ErrorCodes.MethodNotFound, $"Unknown method: {request.Method}");
		}
	}

	HelloResponse Hello(HelloRequest request) {
		if (request.ProtocolVersion != ProtocolInfo.Version)
			throw new RpcException(ErrorCodes.InvalidRequest, $"Protocol version {request.ProtocolVersion} is not supported.");
		if (hostOptions.Nonce is not null && !CryptographicEquals(request.Nonce, hostOptions.Nonce))
			throw new RpcException(ErrorCodes.InvalidRequest, "The backend handshake nonce is invalid.");
		handshakeComplete = true;
		return new HelloResponse(
			ProtocolInfo.Version,
			typeof(JsonRpcServer).Assembly.GetName().Version?.ToString() ?? "0.0.0",
			request.Nonce,
			RuntimeInformation.OSDescription,
			RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
			new Dictionary<string, bool>(StringComparer.Ordinal) {
				["workspace.open"] = true,
				["document.csharp"] = true,
				["document.visualBasic"] = true,
				["document.il"] = true,
				["document.ilWithCSharp"] = true,
				["search"] = true,
				["analyze"] = true,
				["hex.read"] = true,
				["hex.write"] = true,
				["assembly.edit"] = true,
				["assembly.edit.il"] = true,
				["assembly.edit.resources"] = true,
				["script.csharp"] = true,
				["debug.coreclr.launch"] = debugSessions is not null,
				["debug.coreclr.attach"] = debugSessions is not null,
			});
	}

	CorDebugSessionManager GetDebugSessions() => debugSessions
		?? throw new RpcException(ErrorCodes.InvalidRequest, "The CoreCLR debug adapter is not installed.");

	T DeserializeParams<T>(RpcRequest request) {
		if (request.Params is null)
			throw new JsonException("The request does not contain params.");
		return request.Params.Value.Deserialize<T>(jsonOptions)
			?? throw new JsonException("The request params evaluated to null.");
	}

	/// <summary>The raw params object, for a request whose shape the receiving service reads itself.</summary>
	static JsonElement ReadParamsElement(RpcRequest request) =>
		request.Params ?? throw new JsonException("The request does not contain params.");

	void CancelRequest(JsonElement? parameters) {
		if (parameters is null || !parameters.Value.TryGetProperty("id", out var id))
			return;
		if (requests.TryGetValue(id.GetRawText(), out var cancellation))
			cancellation.Cancel();
	}

	async Task WriteErrorAsync(JsonElement? id, int code, string message) => await WriteResponseAsync(new RpcResponse {
		Id = id,
		Error = new RpcError(code, message),
	}, CancellationToken.None).ConfigureAwait(false);

	async Task WriteResponseAsync(RpcResponse response, CancellationToken cancellationToken) {
		var payload = JsonSerializer.SerializeToUtf8Bytes(response, jsonOptions);
		var header = Encoding.ASCII.GetBytes($"Content-Length: {payload.Length}\r\n\r\n");
		await outputGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try {
			await output.WriteAsync(header, cancellationToken).ConfigureAwait(false);
			await output.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
			await output.FlushAsync(cancellationToken).ConfigureAwait(false);
		}
		finally {
			outputGate.Release();
		}
	}

	async Task WriteNotificationAsync(string method, object parameters) {
		try {
			var payload = JsonSerializer.SerializeToUtf8Bytes(new {
				jsonrpc = "2.0",
				method,
				@params = parameters,
			}, jsonOptions);
			var header = Encoding.ASCII.GetBytes($"Content-Length: {payload.Length}\r\n\r\n");
			await outputGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
			try {
				await output.WriteAsync(header).ConfigureAwait(false);
				await output.WriteAsync(payload).ConfigureAwait(false);
				await output.FlushAsync().ConfigureAwait(false);
			}
			finally {
				outputGate.Release();
			}
		}
		catch (Exception ex) {
			HostLog.Error("notification-write-failed", ex);
		}
	}

	async Task<byte[]?> ReadFrameAsync(CancellationToken cancellationToken) {
		var headerBuffer = new ArrayBufferWriter<byte>();
		var state = 0;
		while (headerBuffer.WrittenCount < MaxHeaderLength) {
			var oneByte = new byte[1];
			var bytesRead = await input.ReadAsync(oneByte, cancellationToken).ConfigureAwait(false);
			if (bytesRead == 0)
				return headerBuffer.WrittenCount == 0 ? null : throw new EndOfStreamException("The JSON-RPC header ended unexpectedly.");
			headerBuffer.Write(oneByte);
			state = (state, oneByte[0]) switch {
				(0, (byte)'\r') => 1,
				(1, (byte)'\n') => 2,
				(2, (byte)'\r') => 3,
				(3, (byte)'\n') => 4,
				(_, (byte)'\r') => 1,
				_ => 0,
			};
			if (state == 4)
				break;
		}
		if (state != 4)
			throw new RpcException(ErrorCodes.InvalidRequest, "The JSON-RPC header is too large.");

		var header = Encoding.ASCII.GetString(headerBuffer.WrittenSpan);
		var contentLength = ParseContentLength(header);
		if (contentLength < 0 || contentLength > MaxMessageLength)
			throw new RpcException(ErrorCodes.InvalidRequest, $"Content-Length must be between 0 and {MaxMessageLength} bytes.");
		var rented = ArrayPool<byte>.Shared.Rent(contentLength);
		try {
			await input.ReadExactlyAsync(rented.AsMemory(0, contentLength), cancellationToken).ConfigureAwait(false);
			return rented.AsSpan(0, contentLength).ToArray();
		}
		finally {
			ArrayPool<byte>.Shared.Return(rented);
		}
	}

	static int ParseContentLength(string header) {
		foreach (var line in header.Split("\r\n", StringSplitOptions.RemoveEmptyEntries)) {
			var separator = line.IndexOf(':');
			if (separator < 0 || !line[..separator].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
				continue;
			if (int.TryParse(line[(separator + 1)..].Trim(), out var length))
				return length;
		}
		throw new RpcException(ErrorCodes.InvalidRequest, "The JSON-RPC frame has no valid Content-Length header.");
	}

	static bool CryptographicEquals(string left, string right) {
		var leftBytes = Encoding.UTF8.GetBytes(left);
		var rightBytes = Encoding.UTF8.GetBytes(right);
		return leftBytes.Length == rightBytes.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
	}
}
