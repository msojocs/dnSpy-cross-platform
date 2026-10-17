using System.Diagnostics;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using dnSpy.Backend.Contracts;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;

namespace dnSpy.Backend.Debugging.CorDebug;

/// <summary>
/// Tracks the modules the runtime reports through <c>LoadModule</c>/<c>UnloadModule</c>. Modules
/// carry the metadata the engine needs to turn a <c>(token, IL offset)</c> pair into a breakpoint,
/// so the table is also the lookup the breakpoint table binds against.
/// </summary>
internal sealed class ModuleTable {
	readonly object gate = new();
	readonly List<ModuleEntry> modules = new();
	int order;

	/// <summary>Bumped on every load and unload, so a cache built from the module list can tell it is stale.</summary>
	public int Version { get; private set; }

	public ModuleEntry Add(ICorDebugModule module) {
		ModuleEntry entry;
		lock (gate) {
			entry = ModuleEntry.Create(module, ++order);
			// A module loaded again at another address is a different module, but the same file loaded twice
			// into one process (an unload followed by a reload) replaces the stale row.
			modules.RemoveAll(existing => existing.Address == entry.Address && string.Equals(existing.Path, entry.Path, StringComparison.Ordinal));
			modules.Add(entry);
			Version++;
		}
		return entry;
	}

	public ModuleEntry? Remove(ICorDebugModule module) {
		var address = TryGetAddress(module);
		var path = BreakpointTable.TryGetModulePath(module);
		lock (gate) {
			var entry = modules.FirstOrDefault(existing => existing.Address == address && string.Equals(existing.Path, path, StringComparison.Ordinal))
				?? modules.FirstOrDefault(existing => string.Equals(existing.Path, path, StringComparison.Ordinal));
			if (entry is not null) {
				modules.Remove(entry);
				Version++;
			}
			return entry;
		}
	}

	public IReadOnlyList<DebugModuleDto> Snapshot() {
		ModuleEntry[] snapshot;
		lock (gate)
			snapshot = modules.ToArray();
		return snapshot
			.OrderBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
			.Select(entry => new DebugModuleDto(entry.Path, entry.Name, entry.Path, null, "No symbols (IL only)"))
			.ToArray();
	}

	/// <summary>Every loaded module with what the Modules window shows of it, in load order.</summary>
	public IReadOnlyList<ModuleEntry> Entries() {
		lock (gate)
			return modules.OrderBy(entry => entry.Order).ToArray();
	}

	/// <summary>The loaded modules, for callers that need to sweep all of them.</summary>
	public IReadOnlyList<ICorDebugModule> Enumerate() {
		lock (gate)
			return modules.Select(entry => entry.Module).ToArray();
	}

	/// <summary>Finds a loaded module by absolute path, falling back to a file-name match.</summary>
	public ICorDebugModule? Find(string path) => FindEntry(path)?.Module;

	public ModuleEntry? FindEntry(string path) {
		ModuleEntry[] snapshot;
		lock (gate)
			snapshot = modules.ToArray();
		foreach (var entry in snapshot) {
			if (string.Equals(entry.Path, path, StringComparison.Ordinal))
				return entry;
		}
		var fileName = Path.GetFileName(path);
		foreach (var entry in snapshot) {
			if (string.Equals(Path.GetFileName(entry.Path), fileName, StringComparison.OrdinalIgnoreCase))
				return entry;
		}
		return null;
	}

	/// <summary>The entry of a module the runtime handed back, matched by base address.</summary>
	public ModuleEntry? FindEntry(ICorDebugModule module) {
		var address = TryGetAddress(module);
		lock (gate) {
			var entry = modules.FirstOrDefault(existing => existing.Address == address && address != 0);
			if (entry is not null)
				return entry;
		}
		return FindEntry(BreakpointTable.TryGetModulePath(module));
	}

	public ModuleEntry? FindByOrder(int order) {
		lock (gate)
			return modules.FirstOrDefault(entry => entry.Order == order);
	}

	public ICorDebugModule? FindByToken(int token) {
		lock (gate)
			return modules.FirstOrDefault(entry => entry.Token == token)?.Module;
	}

	public void Clear() {
		lock (gate) {
			modules.Clear();
			Version++;
		}
	}

	static int? TryGetToken(ICorDebugModule module) {
		try {
			return module.Token;
		}
		catch (Exception ex) when (IsComFailure(ex)) {
			return null;
		}
	}

	static ulong TryGetAddress(ICorDebugModule module) {
		try {
			return module.BaseAddress.Value;
		}
		catch (Exception ex) when (IsComFailure(ex)) {
			return 0;
		}
	}

	internal static bool IsComFailure(Exception ex) =>
		ex is COMException or InvalidCastException or InvalidOperationException or NotSupportedException;

	/// <summary>
	/// One loaded module and the facts the Modules window lists about it — WPF's <c>DbgModule</c>. The facts
	/// that come from the file are read once, when the module loads.
	/// </summary>
	internal sealed record ModuleEntry(int Token, string Path, string Name, ICorDebugModule Module) {
		static readonly DateTime Epoch = new(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

		/// <summary>The load order, 1-based — the Modules window's Order column.</summary>
		public int Order { get; init; }

		public ulong Address { get; init; }

		public uint Size { get; init; }

		public bool IsDynamic { get; init; }

		public bool IsInMemory { get; init; }

		public bool IsExe { get; init; }

		public string Version { get; init; } = string.Empty;

		public DateTime? Timestamp { get; init; }

		public int AppDomainId { get; init; }

		public string AppDomainName { get; init; } = string.Empty;

		/// <summary>Whether the runtime JIT-optimizes the module's code; null until the JIT flags are known.</summary>
		public bool? IsOptimized { get; set; }

		/// <summary>Whether the module is the user's code for Just My Code.</summary>
		public bool IsJustMyCode { get; set; } = true;

		/// <summary>A module the program brought rather than one of the runtime's own.</summary>
		public bool IsProgramModule { get; set; } = true;

		public static ModuleEntry Create(ICorDebugModule module, int order) {
			string path;
			try {
				// On Linux this is the absolute path of the file the module was loaded from.
				path = module.Name ?? string.Empty;
			}
			catch (Exception ex) when (IsComFailure(ex)) {
				path = string.Empty;
			}
			var token = TryGetToken(module) ?? 0;
			var isDynamic = Try(() => module.IsDynamic);
			var isInMemory = Try(() => module.IsInMemory);
			var address = TryGetAddress(module);
			var size = (uint)Try(() => module.Size);
			var (appDomainId, appDomainName) = ReadAppDomain(module);
			var (isExe, version, timestamp) = ReadFileFacts(path, isDynamic || isInMemory);
			// Fully qualified: the enclosing record's Path property would otherwise win here.
			var name = string.IsNullOrEmpty(path) ? path : System.IO.Path.GetFileName(path);
			return new ModuleEntry(token, path, name, module) {
				Order = order,
				Address = address,
				Size = size,
				IsDynamic = isDynamic,
				IsInMemory = isInMemory,
				IsExe = isExe,
				Version = version,
				Timestamp = timestamp,
				AppDomainId = appDomainId,
				AppDomainName = appDomainName,
			};
		}

		static T Try<T>(Func<T> read) {
			try {
				return read();
			}
			catch (Exception ex) when (IsComFailure(ex)) {
				return default!;
			}
		}

		static (int Id, string Name) ReadAppDomain(ICorDebugModule module) {
			try {
				var appDomain = module.Assembly.AppDomain;
				return (appDomain.Id, appDomain.Name ?? string.Empty);
			}
			catch (Exception ex) when (IsComFailure(ex)) {
				return (0, string.Empty);
			}
		}

		/// <summary>
		/// WPF's <c>ModuleCreator.InitializeExeFields</c>: the file version, the PE timestamp — unless the
		/// compiler was deterministic, when the field holds a hash instead of a time — and whether it is an EXE.
		/// </summary>
		static (bool IsExe, string Version, DateTime? Timestamp) ReadFileFacts(string path, bool notOnDisk) {
			if (notOnDisk || string.IsNullOrEmpty(path) || !File.Exists(path))
				return (false, string.Empty, null);
			var version = string.Empty;
			try {
				version = FileVersionInfo.GetVersionInfo(path).FileVersion ?? string.Empty;
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) {
			}
			try {
				using var stream = File.OpenRead(path);
				using var pe = new PEReader(stream);
				var header = pe.PEHeaders.CoffHeader;
				var isExe = (header.Characteristics & Characteristics.Dll) == 0;
				var stamp = unchecked((uint)header.TimeDateStamp);
				DateTime? timestamp = stamp != 0 && stamp < 0x80000000 ? Epoch.AddSeconds(stamp) : null;
				if (string.IsNullOrEmpty(version) && pe.HasMetadata) {
					var reader = System.Reflection.Metadata.PEReaderExtensions.GetMetadataReader(pe);
					if (reader.IsAssembly)
						version = reader.GetAssemblyDefinition().Version.ToString();
				}
				return (isExe, version, timestamp);
			}
			catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or BadImageFormatException or InvalidOperationException) {
				return (false, version, null);
			}
		}
	}
}
