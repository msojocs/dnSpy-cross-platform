using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.OutputVisitor;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.CSharp.Transforms;
using ICSharpCode.Decompiler.Semantics;
using ICSharpCode.Decompiler.TypeSystem;
using DecompilerAstNode = ICSharpCode.Decompiler.CSharp.Syntax.AstNode;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// The decompiler a project's files are written with — what dnSpy's MSBuildProjectCreator asks of its IDecompiler:
/// a type's file, the part of a partial type one file holds (DecompilePartialType), the AssemblyInfo file, and
/// whether a type is shown at all. The C# is ICSharpCode.Decompiler's with the C# page's fork-only options
/// (<see cref="DnSpyCSharpTransform"/>); Visual Basic is that C# converted the way the Visual Basic view converts it.
/// One instance serves a module's files from any number of threads.
/// </summary>
sealed partial class ProjectDecompiler : IDisposable {
	readonly ProjectExportModule module;
	readonly DecompilerSettings settings;
	readonly string indentation;
	readonly object typeSystemLock = new();
	DecompilerTypeSystem? typeSystem;
	readonly Lazy<PortablePdbInfoProvider?> debugInfo;

	public ProjectDecompiler(ProjectExportOptions options, ProjectExportModule module) {
		this.module = module;
		IsVisualBasic = options.Language == ProjectExportLanguage.VisualBasic;
		indentation = options.IndentationString;
		settings = ProjectExporter.SettingsForLanguage(options.Settings, IsVisualBasic);
		settings.ThrowOnAssemblyResolveErrors = false;
		// dnSpy's files declare their namespace with a block; its decompiler predates file-scoped namespaces.
		settings.FileScopedNamespaces = false;
		settings.CSharpFormattingOptions.IndentationString = indentation;
		debugInfo = new(() => settings.UseDebugSymbols ? PortablePdbInfoProvider.TryCreate(module.Path) : null, LazyThreadSafetyMode.ExecutionAndPublication);
	}

	public bool IsVisualBasic { get; }
	public string FileExtension => IsVisualBasic ? ".vb" : ".cs";
	public string ProjectFileExtension => IsVisualBasic ? ".vbproj" : ".csproj";

	/// <summary>
	/// The project's RootNamespace. Visual Basic puts every namespace of the project's files under it, so a Visual
	/// Basic file names its namespaces from the global one (<c>Namespace Global.Ns</c>) and its types keep their names.
	/// </summary>
	public string RootNamespace { get; set; } = string.Empty;

	/// <summary>BamlDecompilerOptions.InternalClassModifier: what x:ClassModifier says for a type that is not public.</summary>
	public string InternalClassModifier => IsVisualBasic ? "Friend" : "internal";

	/// <summary>The C# version the code is written in, which an SDK project names so its compiler accepts it.</summary>
	public LanguageVersion LanguageVersion => settings.GetMinimumRequiredVersion();

	/// <summary>ShowMember: whether a type of the module is written — not when the decompiler folds it into another.</summary>
	public bool ShowMember(TypeDef type) =>
		settings is DnSpyDecompilerSettings { ForceShowAllMembers: true } ||
		!CSharpDecompiler.MemberIsHidden(module.File, MetadataTokens.TypeDefinitionHandle((int)type.Rid), settings);

	DecompilerTypeSystem TypeSystem {
		get {
			lock (typeSystemLock)
				return typeSystem ??= new DecompilerTypeSystem(module.File, module.Resolver, settings);
		}
	}

	CSharpDecompiler CreateDecompiler(DecompilerSettings decompilerSettings, CancellationToken cancellationToken) {
		var decompiler = new CSharpDecompiler(TypeSystem, decompilerSettings) {
			CancellationToken = cancellationToken,
			DebugInfoProvider = debugInfo.Value,
		};
		DnSpyCSharpTransform.AddTo(decompiler, module.Module, decompilerSettings);
		return decompiler;
	}

	/// <summary>The type's file: its namespace, the usings it needs, the type.</summary>
	public async Task DecompileTypeAsync(TypeDef type, TextWriter output, string filename, DecompileContext ctx) {
		var handles = new[] { MetadataTokens.TypeDefinitionHandle((int)type.Rid) };
		var decompiler = CreateDecompiler(settings, ctx.CancellationToken);
		var syntaxTree = decompiler.DecompileTypes(handles);
		if (settings is DnSpyDecompilerSettings { ForceShowAllMembers: true } dnSpySettings)
			MergeHiddenMembers(syntaxTree, handles, dnSpySettings, ctx.CancellationToken);
		await WriteAsync(Render(syntaxTree, settings), output, filename, ctx).ConfigureAwait(false);
	}

	/// <summary>
	/// ForceShowAllMembers: the compiler-generated members the decompilation folded away, from a second decompilation
	/// with the switches that hide them off — what the C# view adds to a type's document.
	/// </summary>
	void MergeHiddenMembers(SyntaxTree syntaxTree, TypeDefinitionHandle[] handles, DnSpyDecompilerSettings dnSpySettings, CancellationToken cancellationToken) {
		try {
			var showAll = dnSpySettings.ForShowAllMembers();
			var source = CreateDecompiler(showAll, cancellationToken).DecompileTypes(handles);
			HiddenMemberMerger.Merge(syntaxTree, source, showAll.SortSystemUsingStatementsFirst);
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			// The option only ever adds members; a second pass that fails leaves the file as the first one wrote it.
		}
	}

	/// <summary>
	/// DecompilePartial: the type written partial and with only part of its members — without the definitions, or
	/// only them — the way the fork's DecompilePartialTransform cuts the type. A file without using declarations
	/// (a WinForms Designer file) writes every type with its namespace and keeps <c>new EventHandler(...)</c>.
	/// </summary>
	public async Task DecompilePartialTypeAsync(PartialTypeRequest info, TextWriter output, string filename, DecompileContext ctx) {
		var partialSettings = CreatePartialSettings(info.UseUsingDeclarations);
		var decompiler = CreateDecompiler(partialSettings, ctx.CancellationToken);
		decompiler.AstTransforms.Add(new DecompilePartialTransform(module.Module, info));
		var syntaxTree = decompiler.DecompileTypes([MetadataTokens.TypeDefinitionHandle((int)info.Type.Rid)]);
		await WriteAsync(Render(syntaxTree, partialSettings), output, filename, ctx).ConfigureAwait(false);
	}

	/// <summary>
	/// CSharpDecompiler.CreateDecompilerSettings: using declarations as asked; without them every type is written with
	/// its namespace, and a delegate creation keeps its <c>new</c>. No hidden members are shown in a partial file.
	/// </summary>
	DecompilerSettings CreatePartialSettings(bool useUsingDeclarations) {
		// The converter writes a namespace-qualified C# name relative to the Imports it assumes, which a Visual Basic
		// project does not have, and drops the AddressOf of a delegate creation: Visual Basic is converted from the
		// C# a file with using declarations has.
		if (IsVisualBasic)
			useUsingDeclarations = true;
		var partialSettings = settings.Clone();
		partialSettings.UsingDeclarations = useUsingDeclarations;
		if (partialSettings is DnSpyDecompilerSettings dnSpy) {
			// The fork's FullyQualifyAllTypes keeps the usings; without them the package's own qualification is that.
			if (!useUsingDeclarations)
				dnSpy.FullyQualifyAllTypes = false;
			dnSpy.RemoveNewDelegateClass = useUsingDeclarations;
			dnSpy.ForceShowAllMembers = false;
		}
		else
			partialSettings.UseImplicitMethodGroupConversion = useUsingDeclarations;
		return partialSettings;
	}

	/// <summary>
	/// DecompileAssemblyInfo: the assembly's and the module's attributes, less the ones the compiler writes itself
	/// (the fork's AssemblyInfoTransform).
	/// </summary>
	public async Task DecompileAssemblyInfoAsync(TextWriter output, DecompileContext ctx) {
		var decompiler = CreateDecompiler(settings, ctx.CancellationToken);
		decompiler.AstTransforms.Add(new AssemblyInfoTransform());
		var syntaxTree = decompiler.DecompileModuleAndAssemblyAttributes();
		var csharp = Render(syntaxTree, settings);
		if (IsVisualBasic) {
			await output.WriteAsync(await WorkspaceManager.SharedDecompilers.AttributesToVisualBasicAsync(csharp, ctx.CancellationToken).ConfigureAwait(false)).ConfigureAwait(false);
			return;
		}
		await output.WriteAsync(csharp).ConfigureAwait(false);
	}

	string Render(SyntaxTree syntaxTree, DecompilerSettings decompilerSettings) {
		DnSpyCSharpTransform.AfterDecompile(syntaxTree, decompilerSettings);
		var writer = new StringWriter();
		syntaxTree.AcceptVisitor(new CSharpOutputVisitor(TokenWriter.Create(writer, indentation), decompilerSettings.CSharpFormattingOptions));
		return writer.ToString();
	}

	/// <summary>The C# of a file, or for Visual Basic its conversion — the converter's own failure written as comments.</summary>
	async Task WriteAsync(string csharp, TextWriter output, string filename, DecompileContext ctx) {
		if (!IsVisualBasic) {
			await output.WriteAsync(csharp).ConfigureAwait(false);
			return;
		}
		var converted = await VisualBasicConversion.ConvertAsync(new DecompileResponse(Path.GetFileName(filename), "csharp", csharp, [], []), memberOnly: false, ctx.CancellationToken, ReferencePaths).ConfigureAwait(false);
		if (converted.Diagnostics.FirstOrDefault(diagnostic => diagnostic.Severity == "error") is { } failure)
			ctx.Logger($"Failed to convert '{filename}' to Visual Basic: {failure.Message}");
		var text = VisualBasicConverterFixes.Reindent(converted.Text, indentation);
		if (!string.IsNullOrEmpty(RootNamespace))
			text = NamespaceLine().Replace(text, "${indent}Namespace Global.${name}");
		await output.WriteAsync(text).ConfigureAwait(false);
		if (!text.EndsWith('\n'))
			await output.WriteLineAsync().ConfigureAwait(false);
	}

	[System.Text.RegularExpressions.GeneratedRegex(@"^(?<indent>[ \t]*)Namespace (?!Global\.)(?<name>\S[^\r\n]*)$", System.Text.RegularExpressions.RegexOptions.Multiline | System.Text.RegularExpressions.RegexOptions.CultureInvariant)]
	private static partial System.Text.RegularExpressions.Regex NamespaceLine();

	/// <summary>The module's file and the files of the assemblies it references, as its resolver finds them.</summary>
	IReadOnlyList<string> ReferencePaths {
		get {
			lock (typeSystemLock) {
				if (referencePaths is not null)
					return referencePaths;
				var paths = new List<string> { module.Path };
				foreach (var reference in module.File.AssemblyReferences) {
					try {
						if (module.Resolver.Resolve(reference)?.FileName is { Length: > 0 } path && File.Exists(path))
							paths.Add(path);
					}
					catch (Exception ex) when (ex is not OperationCanceledException) {
					}
				}
				return referencePaths = paths;
			}
		}
	}
	IReadOnlyList<string>? referencePaths;

	public void Dispose() {
		if (debugInfo.IsValueCreated)
			debugInfo.Value?.Dispose();
	}
}

/// <summary>
/// The fork's DecompilePartialTransform: on the type itself, <c>partial</c> and the interfaces taken off its base
/// list; every other declaration of the module removed when it is one of the definitions — or, with ShowDefinitions,
/// when it is not.
/// </summary>
sealed class DecompilePartialTransform(ModuleDef module, PartialTypeRequest info) : IAstTransform {
	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		var mainModule = context.TypeSystem.MainModule;
		foreach (var entity in rootNode.Descendants.OfType<EntityDeclaration>().ToArray()) {
			if (Resolve(entity, mainModule) is not { } def)
				continue;
			if (def == info.Type) {
				if (entity is not TypeDeclaration typeDeclaration)
					continue;
				if (info.AddPartialKeyword && typeDeclaration.ClassType != ClassType.Enum)
					typeDeclaration.Modifiers |= Modifiers.Partial;
				foreach (var baseType in typeDeclaration.BaseTypes.ToArray()) {
					if (baseType.Annotation<TypeResolveResult>()?.Type is { } type && info.InterfacesToRemove.Contains(type.FullName))
						baseType.Remove();
				}
			}
			else if (info.ShowDefinitions ? !info.Definitions.Contains(def) : info.Definitions.Contains(def))
				entity.Remove();
		}
	}

	/// <summary>The row of the module a declaration declares; null for a declaration of anything else.</summary>
	IMemberDef? Resolve(DecompilerAstNode node, ICSharpCode.Decompiler.TypeSystem.IModule mainModule) {
		var symbol = node.GetSymbol()
			?? (node as FieldDeclaration)?.Variables.FirstOrDefault()?.GetSymbol()
			?? (node as EventDeclaration)?.Variables.FirstOrDefault()?.GetSymbol();
		if (symbol is not IEntity entity || entity.MetadataToken.IsNil || entity.ParentModule != mainModule)
			return null;
		try {
			return module.ResolveToken(unchecked((uint)MetadataTokens.GetToken(entity.MetadataToken))) as IMemberDef;
		}
		catch (Exception) {
			return null;
		}
	}
}

/// <summary>
/// The fork's AssemblyInfoTransform: the attributes the compiler writes itself left out of AssemblyInfo — the target
/// framework, unverifiable code, compilation relaxations, runtime compatibility, debuggable, the declarative security
/// — and RefSafetyRules, which a current compiler both writes and refuses to be given.
/// </summary>
sealed class AssemblyInfoTransform : IAstTransform {
	static readonly HashSet<string> removed = new(StringComparer.Ordinal) {
		"System.Runtime.Versioning.TargetFrameworkAttribute",
		"System.Security.UnverifiableCodeAttribute",
		"System.Runtime.CompilerServices.CompilationRelaxationsAttribute",
		"System.Runtime.CompilerServices.RuntimeCompatibilityAttribute",
		"System.Diagnostics.DebuggableAttribute",
		"System.Runtime.CompilerServices.RefSafetyRulesAttribute",
	};

	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		foreach (var section in rootNode.Descendants.OfType<AttributeSection>().ToArray()) {
			if (section.Attributes.FirstOrDefault()?.Type.Annotation<TypeResolveResult>()?.Type is not { } type)
				continue;
			if (removed.Contains(type.FullName) || IsSecurityAttribute(type))
				section.Remove();
		}
	}

	/// <summary>A permission attribute: what a DeclSecurity row decompiles to.</summary>
	static bool IsSecurityAttribute(ICSharpCode.Decompiler.TypeSystem.IType type) {
		if (type.Namespace == "System.Security.Permissions" && type.Name.EndsWith("PermissionAttribute", StringComparison.Ordinal))
			return true;
		return type.GetAllBaseTypes().Any(baseType => baseType.FullName == "System.Security.Permissions.SecurityAttribute");
	}
}
