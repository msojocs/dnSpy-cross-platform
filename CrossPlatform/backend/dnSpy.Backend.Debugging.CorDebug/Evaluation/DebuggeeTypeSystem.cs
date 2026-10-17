using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using ICorDebugSharp;
using ICorDebugSharp.Extensions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.VisualBasic;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>
/// The debuggee's type system, seen through Roslyn: a compilation whose references are the modules the
/// process has loaded, so the compiler binds an expression against exactly the code the program runs —
/// the port's answer to dnSpy's <c>DmdAppDomain</c>.
/// </summary>
/// <remarks>
/// <para>
/// The runtime speaks <c>(module, metadata token)</c>; the compiler speaks symbols. A symbol read from
/// metadata knows its token (<see cref="ISymbol.MetadataToken"/>) and module, which is how a bound call
/// becomes an <see cref="ICorDebugFunction"/>; the other direction goes through the module's own metadata
/// (System.Reflection.Metadata), which names the type a token stands for.
/// </para>
/// <para>
/// The references import every member, private ones included, and the C# compilation is told to ignore
/// accessibility — what Roslyn's own expression evaluator does — so a watch can read a private field the way
/// the variables windows already show it.
/// </para>
/// </remarks>
internal sealed class DebuggeeTypeSystem : IDisposable {
	readonly ModuleTable modules;
	readonly Func<ModuleTable.ModuleEntry, byte[]?> readModuleImage;
	readonly Dictionary<int, ModuleData?> moduleData = new();
	readonly object gate = new();
	int builtVersion = -1;
	CSharpCompilation? csharp;
	VisualBasicCompilation? visualBasic;
	Dictionary<IModuleSymbol, ModuleTable.ModuleEntry> entryByModule = new(SymbolEqualityComparer.Default);
	Dictionary<int, IAssemblySymbol> assemblyByOrder = new();
	Dictionary<string, List<IAssemblySymbol>> assembliesByName = new(StringComparer.OrdinalIgnoreCase);

	public DebuggeeTypeSystem(ModuleTable modules, Func<ModuleTable.ModuleEntry, byte[]?> readModuleImage) {
		this.modules = modules;
		this.readModuleImage = readModuleImage;
	}

	/// <summary>One module's metadata, read once: what the compiler references, and what names its tokens.</summary>
	sealed class ModuleData(MetadataReference reference, PEReader pe) : IDisposable {
		public MetadataReference Reference { get; } = reference;
		public PEReader PE { get; } = pe;
		public MetadataReader Reader { get; } = pe.GetMetadataReader();

		public void Dispose() => PE.Dispose();
	}

	/// <summary>The compilation the C# evaluator binds against, rebuilt when a module comes or goes.</summary>
	public CSharpCompilation CSharp {
		get {
			lock (gate) {
				EnsureBuilt();
				return csharp!;
			}
		}
	}

	public VisualBasicCompilation VisualBasic {
		get {
			lock (gate) {
				EnsureBuilt();
				return visualBasic ??= CreateVisualBasic(csharp!.References);
			}
		}
	}

	/// <summary>Either language's compilation; types and members are the same symbols' worth in both.</summary>
	public Compilation Compilation => CSharp;

	/// <summary>The version of the module list the compilations were built from; caches key on it.</summary>
	public int BuiltVersion {
		get {
			lock (gate) {
				EnsureBuilt();
				return builtVersion;
			}
		}
	}

	static readonly Lazy<Func<CSharpCompilationOptions, CSharpCompilationOptions>> IgnoreAccessibility = new(() => {
		// BinderFlags.IgnoreAccessibility is how Roslyn's expression evaluator reads private members; the
		// switch is internal, so it is reached by name. When a future Roslyn renames it the evaluator still
		// works, it just needs the member to be accessible.
		var method = typeof(CSharpCompilationOptions).GetMethod("WithTopLevelBinderFlags", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
		var flags = typeof(CSharpCompilationOptions).Assembly.GetType("Microsoft.CodeAnalysis.CSharp.BinderFlags");
		if (method is null || flags is null || !Enum.TryParse(flags, "IgnoreAccessibility", out var value))
			return options => options;
		return options => (CSharpCompilationOptions)method.Invoke(options, [value])!;
	});

	void EnsureBuilt() {
		var version = modules.Version;
		if (csharp is not null && version == builtVersion)
			return;
		var entries = modules.Entries();
		var references = new List<MetadataReference>();
		var referenceEntries = new List<(MetadataReference Reference, ModuleTable.ModuleEntry Entry)>();
		var seenIdentities = new Dictionary<string, MetadataReference>(StringComparer.OrdinalIgnoreCase);
		var duplicates = new List<(MetadataReference Reference, ModuleTable.ModuleEntry Entry)>();
		foreach (var entry in entries) {
			var data = GetModuleData(entry);
			if (data is null)
				continue;
			// The same assembly loaded twice (two load contexts) would make every one of its types ambiguous,
			// so the second copy is read through the first one's symbols.
			var identity = AssemblyIdentityOf(data.Reader);
			if (identity is not null && seenIdentities.TryGetValue(identity, out var first)) {
				duplicates.Add((first, entry));
				continue;
			}
			if (identity is not null)
				seenIdentities[identity] = data.Reference;
			references.Add(data.Reference);
			referenceEntries.Add((data.Reference, entry));
		}
		var options = IgnoreAccessibility.Value(new CSharpCompilationOptions(
				OutputKind.DynamicallyLinkedLibrary,
				allowUnsafe: true,
				nullableContextOptions: NullableContextOptions.Disable)
			.WithMetadataImportOptions(MetadataImportOptions.All));
		csharp = CSharpCompilation.Create("<debugger-eval>", [], references, options);
		visualBasic = null;
		var byModule = new Dictionary<IModuleSymbol, ModuleTable.ModuleEntry>(SymbolEqualityComparer.Default);
		var byOrder = new Dictionary<int, IAssemblySymbol>();
		var byName = new Dictionary<string, List<IAssemblySymbol>>(StringComparer.OrdinalIgnoreCase);
		foreach (var (reference, entry) in referenceEntries) {
			if (csharp.GetAssemblyOrModuleSymbol(reference) is not IAssemblySymbol assembly)
				continue;
			foreach (var module in assembly.Modules)
				byModule[module] = entry;
			byOrder[entry.Order] = assembly;
			if (!byName.TryGetValue(assembly.Name, out var list))
				byName[assembly.Name] = list = new List<IAssemblySymbol>();
			list.Add(assembly);
		}
		foreach (var (reference, entry) in duplicates) {
			if (csharp.GetAssemblyOrModuleSymbol(reference) is IAssemblySymbol assembly)
				byOrder[entry.Order] = assembly;
		}
		entryByModule = byModule;
		assemblyByOrder = byOrder;
		assembliesByName = byName;
		builtVersion = version;
	}

	static VisualBasicCompilation CreateVisualBasic(IEnumerable<MetadataReference> references) =>
		VisualBasicCompilation.Create("<debugger-eval>", [], references, new VisualBasicCompilationOptions(
				OutputKind.DynamicallyLinkedLibrary,
				optionStrict: OptionStrict.Off,
				optionInfer: true,
				optionExplicit: true)
			.WithMetadataImportOptions(MetadataImportOptions.All));

	static string? AssemblyIdentityOf(MetadataReader reader) {
		if (!reader.IsAssembly)
			return null;
		var definition = reader.GetAssemblyDefinition();
		return $"{reader.GetString(definition.Name)},{definition.Version}";
	}

	ModuleData? GetModuleData(ModuleTable.ModuleEntry entry) {
		if (moduleData.TryGetValue(entry.Order, out var cached))
			return cached;
		var data = LoadModuleData(entry);
		moduleData[entry.Order] = data;
		return data;
	}

	ModuleData? LoadModuleData(ModuleTable.ModuleEntry entry) {
		if (entry.IsDynamic)
			return null;
		try {
			if (!entry.IsInMemory && File.Exists(entry.Path)) {
				var stream = File.OpenRead(entry.Path);
				var pe = new PEReader(stream);
				if (!pe.HasMetadata) {
					pe.Dispose();
					return null;
				}
				return new ModuleData(MetadataReference.CreateFromFile(entry.Path), pe);
			}
			// An assembly loaded from a byte array has no file: its image is read out of the process, where
			// the runtime keeps it in file layout.
			var bytes = readModuleImage(entry);
			if (bytes is null || bytes.Length == 0)
				return null;
			var image = ImmutableArray.Create(bytes);
			var reader = new PEReader(image);
			if (!reader.HasMetadata) {
				reader.Dispose();
				return null;
			}
			return new ModuleData(MetadataReference.CreateFromImage(image, filePath: entry.Path.Length == 0 ? null : entry.Path), reader);
		}
		catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or BadImageFormatException or InvalidOperationException) {
			return null;
		}
	}

	// ---------------------------------------------------------------- module lookups

	/// <summary>The loaded module a symbol was read from, or null for a symbol the compiler made up.</summary>
	public ModuleTable.ModuleEntry? GetModuleEntry(ISymbol symbol) {
		lock (gate) {
			EnsureBuilt();
			var module = symbol.OriginalDefinition.ContainingModule;
			return module is not null && entryByModule.TryGetValue(module, out var entry) ? entry : null;
		}
	}

	public IAssemblySymbol? GetAssembly(ModuleTable.ModuleEntry entry) {
		lock (gate) {
			EnsureBuilt();
			return assemblyByOrder.GetValueOrDefault(entry.Order);
		}
	}

	public MetadataReader? GetReader(ModuleTable.ModuleEntry entry) {
		lock (gate)
			return GetModuleData(entry)?.Reader;
	}

	/// <summary>A method body of a loaded module, by its RVA.</summary>
	public MethodBodyBlock? GetMethodBody(ModuleTable.ModuleEntry entry, int rva) {
		lock (gate) {
			var data = GetModuleData(entry);
			if (data is null)
				return null;
			try {
				return data.PE.GetMethodBody(rva);
			}
			catch (Exception ex) when (ex is BadImageFormatException or InvalidOperationException) {
				return null;
			}
		}
	}

	/// <summary>The type a TypeDef token of a loaded module stands for.</summary>
	public INamedTypeSymbol? GetTypeDefinition(ModuleTable.ModuleEntry entry, int typeDefToken) {
		var reader = GetReader(entry);
		var assembly = GetAssembly(entry);
		if (reader is null || assembly is null)
			return null;
		var handle = MetadataTokens.EntityHandle(typeDefToken);
		if (handle.Kind != HandleKind.TypeDefinition)
			return null;
		return assembly.GetTypeByMetadataName(MetadataNameOf(reader, (TypeDefinitionHandle)handle));
	}

	/// <summary>The metadata name Roslyn looks a type up by: namespace, '+' for nesting, backtick arity.</summary>
	internal static string MetadataNameOf(MetadataReader reader, TypeDefinitionHandle handle) {
		var definition = reader.GetTypeDefinition(handle);
		var name = reader.GetString(definition.Name);
		var declaring = definition.GetDeclaringType();
		if (!declaring.IsNil)
			return MetadataNameOf(reader, declaring) + "+" + name;
		var @namespace = reader.GetString(definition.Namespace);
		return @namespace.Length == 0 ? name : @namespace + "." + name;
	}

	/// <summary>The member a method or field token of a loaded module stands for.</summary>
	public ISymbol? GetMember(ModuleTable.ModuleEntry entry, int memberToken) {
		var reader = GetReader(entry);
		if (reader is null)
			return null;
		var handle = MetadataTokens.EntityHandle(memberToken);
		TypeDefinitionHandle owner;
		string name;
		switch (handle.Kind) {
			case HandleKind.MethodDefinition: {
				var method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
				owner = method.GetDeclaringType();
				name = reader.GetString(method.Name);
				break;
			}
			case HandleKind.FieldDefinition: {
				var field = reader.GetFieldDefinition((FieldDefinitionHandle)handle);
				owner = field.GetDeclaringType();
				name = reader.GetString(field.Name);
				break;
			}
			default:
				return null;
		}
		var type = GetTypeDefinition(entry, MetadataTokens.GetToken(owner));
		return type?.GetMembers(name).FirstOrDefault(member => member.MetadataToken == memberToken);
	}

	/// <summary>An assembly the compilation references, by simple name.</summary>
	public IAssemblySymbol? FindAssembly(string name) {
		lock (gate) {
			EnsureBuilt();
			return assembliesByName.TryGetValue(name, out var list) ? list[0] : null;
		}
	}

	/// <summary>A type by its metadata name, looked up in every loaded assembly; the core library wins ties.</summary>
	public INamedTypeSymbol? FindType(string metadataName) {
		var compilation = Compilation;
		var found = compilation.GetTypeByMetadataName(metadataName);
		if (found is not null)
			return found;
		// GetTypeByMetadataName refuses a name two assemblies declare; the debuggee's own resolution is the
		// one that matters, and the core library is what it reaches for first.
		var corLibrary = compilation.GetSpecialType(SpecialType.System_Object).ContainingAssembly;
		return corLibrary.GetTypeByMetadataName(metadataName)
			?? compilation.SourceModule.ReferencedAssemblySymbols.Select(assembly => assembly.GetTypeByMetadataName(metadataName)).FirstOrDefault(type => type is not null);
	}

	// ---------------------------------------------------------------- runtime type -> symbol

	/// <summary>The symbol of a runtime type, generic instantiation and all; null for what cannot be named.</summary>
	public ITypeSymbol? GetSymbol(ICorDebugType? type) {
		if (type is null)
			return null;
		try {
			return GetSymbolCore(type, 0);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	ITypeSymbol? GetSymbolCore(ICorDebugType type, int depth) {
		if (depth > 64)
			return null;
		var compilation = Compilation;
		var element = type.Type;
		if (SpecialTypeOf(element) is { } special)
			return compilation.GetSpecialType(special);
		switch (element) {
			case CorElementType.CLASS:
			case CorElementType.VALUETYPE: {
				var cls = type.Class;
				var entry = modules.FindEntry(cls.Module);
				if (entry is null)
					return null;
				var definition = GetTypeDefinition(entry, unchecked((int)cls.Token.Value));
				if (definition is null)
					return null;
				var parameters = type.TypeParameters;
				if (parameters.Length == 0)
					return definition;
				var arguments = new ITypeSymbol[parameters.Length];
				for (var index = 0; index < parameters.Length; index++)
					arguments[index] = GetSymbolCore(parameters[index], depth + 1) ?? compilation.GetSpecialType(SpecialType.System_Object);
				return Construct(definition, arguments);
			}
			case CorElementType.SZARRAY:
			case CorElementType.ARRAY: {
				var elementType = GetSymbolCore(type.FirstTypeParameter, depth + 1);
				if (elementType is null)
					return null;
				return element == CorElementType.SZARRAY
					? compilation.CreateArrayTypeSymbol(elementType)
					: compilation.CreateArrayTypeSymbol(elementType, type.Rank);
			}
			case CorElementType.PTR: {
				var elementType = GetSymbolCore(type.FirstTypeParameter, depth + 1);
				return elementType is null ? null : compilation.CreatePointerTypeSymbol(elementType);
			}
			case CorElementType.BYREF:
				return GetSymbolCore(type.FirstTypeParameter, depth + 1);
			case CorElementType.FNPTR:
				return compilation.GetSpecialType(SpecialType.System_IntPtr);
			default:
				return null;
		}
	}

	internal static SpecialType? SpecialTypeOf(CorElementType element) => element switch {
		CorElementType.VOID => SpecialType.System_Void,
		CorElementType.BOOLEAN => SpecialType.System_Boolean,
		CorElementType.CHAR => SpecialType.System_Char,
		CorElementType.I1 => SpecialType.System_SByte,
		CorElementType.U1 => SpecialType.System_Byte,
		CorElementType.I2 => SpecialType.System_Int16,
		CorElementType.U2 => SpecialType.System_UInt16,
		CorElementType.I4 => SpecialType.System_Int32,
		CorElementType.U4 => SpecialType.System_UInt32,
		CorElementType.I8 => SpecialType.System_Int64,
		CorElementType.U8 => SpecialType.System_UInt64,
		CorElementType.R4 => SpecialType.System_Single,
		CorElementType.R8 => SpecialType.System_Double,
		CorElementType.STRING => SpecialType.System_String,
		CorElementType.I => SpecialType.System_IntPtr,
		CorElementType.U => SpecialType.System_UIntPtr,
		CorElementType.OBJECT => SpecialType.System_Object,
		CorElementType.TYPEDBYREF => SpecialType.System_TypedReference,
		_ => null,
	};

	/// <summary>
	/// A generic type instantiated with its arguments in metadata order — the outer type's first, then the
	/// nested type's own — which is how the runtime lists them and not how Roslyn constructs them.
	/// </summary>
	public static INamedTypeSymbol Construct(INamedTypeSymbol definition, IReadOnlyList<ITypeSymbol> arguments) {
		definition = definition.OriginalDefinition;
		var chain = new List<INamedTypeSymbol>();
		for (var current = definition; current is not null; current = current.ContainingType)
			chain.Add(current);
		chain.Reverse();
		var total = chain.Sum(type => type.Arity);
		if (total != arguments.Count || total == 0)
			return definition;
		var index = 0;
		INamedTypeSymbol? constructed = null;
		foreach (var type in chain) {
			var symbol = constructed is null
				? type
				: constructed.GetTypeMembers(type.Name, type.Arity).FirstOrDefault() ?? type;
			if (type.Arity > 0) {
				symbol = symbol.Construct(arguments.Skip(index).Take(type.Arity).ToArray());
				index += type.Arity;
			}
			constructed = symbol;
		}
		return constructed ?? definition;
	}

	/// <summary>Every type argument of a type, outer types' first — the order the runtime wants them in.</summary>
	public static IReadOnlyList<ITypeSymbol> AllTypeArguments(INamedTypeSymbol type) {
		var chain = new List<INamedTypeSymbol>();
		for (var current = type; current is not null; current = current.ContainingType)
			chain.Add(current);
		chain.Reverse();
		return chain.SelectMany(current => current.TypeArguments).ToArray();
	}

	// ---------------------------------------------------------------- symbol -> runtime

	/// <summary>The runtime class of a type definition.</summary>
	public ICorDebugClass? GetClass(INamedTypeSymbol type) {
		var definition = type.OriginalDefinition;
		var entry = GetModuleEntry(definition);
		if (entry is null || definition.MetadataToken == 0)
			return null;
		try {
			return entry.Module.GetClassFromToken(definition.MetadataToken);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>The runtime function of a method definition, generic or not.</summary>
	public ICorDebugFunction? GetFunction(IMethodSymbol method) {
		var definition = (method.ReducedFrom ?? method).OriginalDefinition;
		var entry = GetModuleEntry(definition);
		if (entry is null || definition.MetadataToken == 0)
			return null;
		try {
			return entry.Module.GetFunctionFromToken(definition.MetadataToken);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	/// <summary>
	/// The runtime type a symbol stands for, which is what a generic call, a default value and a new array
	/// need. dnSpy's <c>CorDebugTypeCreator</c>: a definition is its class parameterized as class or value
	/// type, the rest are built from their element types by the app domain.
	/// </summary>
	public ICorDebugType? GetCorType(ITypeSymbol type, ICorDebugAppDomain appDomain) {
		try {
			return GetCorTypeCore(type, appDomain, 0);
		}
		catch (Exception ex) when (ModuleTable.IsComFailure(ex)) {
			return null;
		}
	}

	ICorDebugType? GetCorTypeCore(ITypeSymbol type, ICorDebugAppDomain appDomain, int depth) {
		if (depth > 64)
			return null;
		switch (type) {
			case IArrayTypeSymbol array: {
				var element = GetCorTypeCore(array.ElementType, appDomain, depth + 1);
				if (element is null || appDomain is not ICorDebugAppDomain2 domain2)
					return null;
				var kind = array.IsSZArray ? CorElementType.SZARRAY : CorElementType.ARRAY;
				return domain2.TryGetArrayOrPointerType(kind, (uint)array.Rank, element, out var result) >= 0 ? result : null;
			}
			case IPointerTypeSymbol pointer: {
				var element = GetCorTypeCore(pointer.PointedAtType, appDomain, depth + 1);
				if (element is null || appDomain is not ICorDebugAppDomain2 domain2)
					return null;
				return domain2.TryGetArrayOrPointerType(CorElementType.PTR, 0, element, out var result) >= 0 ? result : null;
			}
			case INamedTypeSymbol named: {
				var cls = GetClass(named);
				if (cls is not ICorDebugClass2 class2)
					return null;
				var arguments = AllTypeArguments(named);
				var corArguments = new ICorDebugType[arguments.Count];
				for (var index = 0; index < arguments.Count; index++)
					corArguments[index] = GetCorTypeCore(arguments[index], appDomain, depth + 1) ?? throw new InvalidOperationException("A type argument has no runtime type.");
				return class2.GetParameterizedType(named.IsValueType ? CorElementType.VALUETYPE : CorElementType.CLASS, corArguments.Length, corArguments);
			}
			case IDynamicTypeSymbol:
				return GetCorTypeCore(Compilation.GetSpecialType(SpecialType.System_Object), appDomain, depth + 1);
			default:
				return null;
		}
	}

	public void Dispose() {
		lock (gate) {
			foreach (var data in moduleData.Values)
				data?.Dispose();
			moduleData.Clear();
			csharp = null;
			visualBasic = null;
		}
	}
}
