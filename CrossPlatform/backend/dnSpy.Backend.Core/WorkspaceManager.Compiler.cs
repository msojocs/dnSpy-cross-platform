using System.Globalization;
using dnlib.DotNet;
using dnlib.DotNet.Writer;
using dnSpy.AsmEditor.Compiler;
using dnSpy.AsmEditor.Event;
using dnSpy.AsmEditor.Field;
using dnSpy.AsmEditor.Method;
using dnSpy.AsmEditor.Property;
using dnSpy.AsmEditor.Types;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.LanguageService;
using ICSharpCode.Decompiler;
using dnSpy.Contracts.AsmEditor.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;
using CSharpDiagnosticSeverity = Microsoft.CodeAnalysis.DiagnosticSeverity;

namespace dnSpy.Backend.Core;

/// <summary>
/// The C# compiler half of dnSpy's AsmEditor — Edit Method (C#), Edit Class (C#), Add Class Members,
/// Add Class and Edit Assembly Attributes. The source is compiled with Roslyn against the module itself
/// and its references, and the generated assembly is merged back with dnSpy's own <c>ModuleImporter</c>,
/// which is why an edited method body can add members, types and compiler-generated state machines.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<CompileSourceResponse> CompileSourceAsync(CompileSourceRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.CompileSource(request), cancellationToken);

	public Task<CompilerSourceResponse> GetAssemblyAttributesSourceAsync(CompilerAssemblyAttributesRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => w.GetAssemblyAttributesSource(request.NodeId, cancellationToken), cancellationToken);

	public Task MergeAssemblyAsync(MergeAssemblyRequest request, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).RunAsync(w => {
			w.QueueMergeAssembly(request);
			return true;
		}, cancellationToken);

	sealed partial class Workspace {
		/// <summary>
		/// The assembly's and module's attributes as C# source, which is what Edit Assembly Attributes shows.
		/// Decompiling them is the only way to keep the attributes the module already has in the source the
		/// compiler imports, so the window starts from what is there rather than from an empty file.
		/// </summary>
		public CompilerSourceResponse GetAssemblyAttributesSource(string nodeId, CancellationToken cancellationToken) {
			var node = GetNode(nodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support editing attributes.");
			var settings = new DecompilerSettings();
			using var session = CreateCSharpDecompilerSession(moduleEntry, settings, cancellationToken);
			return new CompilerSourceResponse(session.Decompiler.DecompileModuleAndAssemblyAttributesToString());
		}

		/// <summary>
		/// dnSpy's Merge with Assembly: every type of the picked assembly is imported into this module.
		/// Dependencies are not merged, which is dnSpy's own limit — a reference to them has no new
		/// definition to redirect to.
		/// </summary>
		public void QueueMergeAssembly(MergeAssemblyRequest request) {
			var transaction = GetTransaction(request.TransactionId);
			var node = GetNode(request.NodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support merging.");
			byte[] bytes;
			try {
				bytes = Convert.FromBase64String(request.Base64Data);
			}
			catch (FormatException ex) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The assembly is not valid base64.", null, ex);
			}
			ModuleDefMD sourceModule;
			try {
				sourceModule = ModuleDefMD.Load(bytes);
			}
			catch (Exception ex) when (ex is not OperationCanceledException) {
				throw new RpcException(ErrorCodes.EditValidationFailed, "The file is not a .NET assembly.", null, ex);
			}
			using (sourceModule) {
				var importer = new ModuleImporter(moduleEntry.Module, moduleEntry.Module.Context.AssemblyResolver);
				var snapshot = new CompilerSnapshot(moduleEntry.Module, sourceModule.Types.Select(type => type.Name.String), null);
				transaction.Add(node.Id, moduleEntry, () => {
					try {
						importer.Import(bytes, new DebugFileResult(DebugFileFormat.None, null), ModuleImporterOptions.None);
						ApplyImport(importer, moduleEntry.Module);
					}
					catch (ModuleImporterAbortedException) {
						throw new RpcException(ErrorCodes.EditValidationFailed, string.Join(Environment.NewLine, importer.Diagnostics.Select(diagnostic => diagnostic.ToString())));
					}
					return snapshot.Restore;
				});
			}
		}

		public CompileSourceResponse CompileSource(CompileSourceRequest request) {
			var node = GetNode(request.NodeId);
			var moduleEntry = node.AsModuleEntry
				?? throw new RpcException(ErrorCodes.EditValidationFailed, "PE-only modules do not support editing code.");
			var (target, targetType) = CompilerTarget(node, request.Mode);
			var compilation = CompileCSharp(moduleEntry, request.Source);
			var diagnostics = compilation.Diagnostics
				.Select(ToDiagnosticDto)
				.ToArray();
			if (!compilation.Success)
				return new CompileSourceResponse(false, diagnostics);

			// A compile-only request stops here; the editor's Compile button uses it to show the errors
			// without touching the module.
			if (request.TransactionId is not { Length: > 0 })
				return new CompileSourceResponse(true, diagnostics);

			var transaction = GetTransaction(request.TransactionId);
			var importer = new ModuleImporter(moduleEntry.Module, moduleEntry.Module.Context.AssemblyResolver);
			var snapshot = new CompilerSnapshot(moduleEntry.Module, request.Source, targetType);
			var newDiagnostics = new List<CompilerDiagnostic>();
			transaction.Add(node.Id, moduleEntry, () => {
				try {
					Import(importer, request.Mode, compilation, target, targetType, moduleEntry);
				}
				catch (ModuleImporterAbortedException) {
					throw new RpcException(ErrorCodes.EditValidationFailed, string.Join(Environment.NewLine, importer.Diagnostics.Select(diagnostic => diagnostic.ToString())));
				}
				catch (Exception ex) when (ex is not RpcException and not OperationCanceledException) {
					throw new RpcException(ErrorCodes.EditValidationFailed, "The compiled code could not be imported.", null, ex);
				}
				return snapshot.Restore;
			});
			newDiagnostics.AddRange(importer.Diagnostics);
			return new CompileSourceResponse(true, diagnostics.Concat(newDiagnostics.Select(ToDiagnosticDto)).ToArray());
		}

		(object Target, TypeDef? TargetType) CompilerTarget(NodeEntry node, string mode) {
			TypeDef SelectedType() => node.Value switch {
				TypeDef type => type,
				IMemberDef member => member.DeclaringType ?? throw CompilerError("The selected member has no type."),
				_ => throw CompilerError("Select a type to compile."),
			};
			return mode switch {
				CompilerModes.EditMethod => (node.Value as MethodDef ?? throw CompilerError("Select a method to edit."), OutermostType(SelectedType())),
				CompilerModes.EditClass => (SelectedType(), OutermostType(SelectedType())),
				CompilerModes.AddMembers => (SelectedType(), OutermostType(SelectedType())),
				CompilerModes.AddClass => (node, null),
				CompilerModes.EditAssembly => (node, null),
				_ => throw CompilerError($"Unknown compiler mode '{mode}'."),
			};
		}

		static TypeDef OutermostType(TypeDef type) {
			while (type.DeclaringType is not null)
				type = type.DeclaringType;
			return type;
		}

		static RpcException CompilerError(string message) => new(ErrorCodes.EditValidationFailed, message);

		void Import(ModuleImporter importer, string mode, CSharpCompilationResult compilation, object target, TypeDef? targetType, ModuleEntry moduleEntry) {
			var debugFile = new DebugFileResult(compilation.Pdb is null ? DebugFileFormat.None : DebugFileFormat.PortablePdb, compilation.Pdb);
			switch (mode) {
				case CompilerModes.EditMethod:
					importer.Import(compilation.Assembly!, debugFile, (MethodDef)target);
					break;
				case CompilerModes.EditClass:
					importer.Import(compilation.Assembly!, debugFile, targetType!);
					break;
				case CompilerModes.AddMembers:
					importer.ImportNewMembers(compilation.Assembly!, debugFile, targetType!);
					break;
				case CompilerModes.AddClass:
					importer.Import(compilation.Assembly!, debugFile, ModuleImporterOptions.None);
					break;
				case CompilerModes.EditAssembly:
					importer.Import(
						compilation.Assembly!,
						debugFile,
						ModuleImporterOptions.ReplaceModuleAssemblyAttributes | ModuleImporterOptions.ReplaceAssemblyDeclSecurities);
					ApplyAssemblyAttributes(importer, moduleEntry);
					break;
				default:
					throw CompilerError($"Unknown compiler mode '{mode}'.");
			}
			ApplyImport(importer, moduleEntry.Module);
		}

		/// <summary>
		/// Applies what the importer worked out: the types it added, the members it added, edited or
		/// deleted, and the resources it brought along — dnSpy's <c>AddUpdatedNodesHelper</c> and the
		/// node updaters it holds, without the tree rows those also carry.
		/// </summary>
		static void ApplyImport(ModuleImporter importer, ModuleDef module) {
			foreach (var imported in importer.NewNonNestedTypes)
				AddType(imported.TargetType!);
			foreach (var merged in importer.MergedNonNestedTypes)
				ApplyMergedType(merged);
			if (importer.NewResources is not null) {
				foreach (var resource in importer.NewResources)
					module.Resources.Add(resource);
			}
			if (importer.NewExportedTypes is not null) {
				module.ExportedTypes.Clear();
				foreach (var exported in importer.NewExportedTypes)
					module.ExportedTypes.Add(exported);
			}

			void AddType(TypeDef type) {
				if (type.DeclaringType is null)
					module.Types.Add(type);
				else
					type.DeclaringType.NestedTypes.Add(type);
			}

			void ApplyImported(ImportedType imported) {
				switch (imported) {
					case NewImportedType added:
						AddType(added.TargetType!);
						break;
					case MergedImportedType merged:
						ApplyMergedType(merged);
						break;
				}
			}

			void ApplyMergedType(MergedImportedType mergedType) {
				var target = mergedType.TargetType!;
				mergedType.NewTypeDefOptions.CopyTo(target, module);
				foreach (var deleted in mergedType.DeletedNestedTypes)
					target.NestedTypes.Remove(deleted);
				foreach (var deleted in mergedType.DeletedFields)
					target.Fields.Remove(deleted);
				foreach (var deleted in mergedType.DeletedMethods)
					target.Methods.Remove(deleted);
				foreach (var deleted in mergedType.DeletedProperties)
					target.Properties.Remove(deleted);
				foreach (var deleted in mergedType.DeletedEvents)
					target.Events.Remove(deleted);
				foreach (var nested in mergedType.NewOrExistingNestedTypes)
					ApplyImported(nested);
				foreach (var field in mergedType.NewFields)
					target.Fields.Add(field);
				foreach (var method in mergedType.NewMethods)
					target.Methods.Add(method);
				foreach (var @event in mergedType.NewEvents)
					target.Events.Add(@event);
				foreach (var property in mergedType.NewProperties)
					target.Properties.Add(property);
				foreach (var edited in mergedType.EditedFields)
					edited.FieldDefOptions.CopyTo(edited.OriginalField);
				foreach (var edited in mergedType.EditedMethods) {
					edited.OriginalMethod.MethodBody = edited.NewBody;
					edited.MethodDefOptions.CopyTo(edited.OriginalMethod);
				}
				foreach (var edited in mergedType.EditedProperties)
					edited.PropertyDefOptions.CopyTo(edited.OriginalProperty);
				foreach (var edited in mergedType.EditedEvents)
					edited.EventDefOptions.CopyTo(edited.OriginalEvent);
			}
		}

		/// <summary>
		/// Writes the attributes the compiled assembly declared back over the target assembly and module —
		/// what dnSpy's Edit Assembly Attributes command changes.
		/// </summary>
		static void ApplyAssemblyAttributes(ModuleImporter importer, ModuleEntry moduleEntry) {
			var module = moduleEntry.Module;
			if (importer.NewModuleCustomAttributes is not null) {
				module.CustomAttributes.Clear();
				foreach (var attribute in importer.NewModuleCustomAttributes)
					module.CustomAttributes.Add(attribute);
			}
			if (module.Assembly is not { } assembly)
				return;
			if (importer.NewAssemblyCustomAttributes is not null) {
				assembly.CustomAttributes.Clear();
				foreach (var attribute in importer.NewAssemblyCustomAttributes)
					assembly.CustomAttributes.Add(attribute);
			}
			if (importer.NewAssemblyDeclSecurities is not null) {
				assembly.DeclSecurities.Clear();
				foreach (var security in importer.NewAssemblyDeclSecurities)
					assembly.DeclSecurities.Add(security);
			}
			if (importer.NewAssemblyVersion is not null)
				assembly.Version = importer.NewAssemblyVersion;
		}

		CSharpCompilationResult CompileCSharp(ModuleEntry moduleEntry, string source) {
			var assemblyName = Guid.NewGuid().ToString("N");
			var syntaxTree = CSharpSyntaxTree.ParseText(
				SourceText.From(source, System.Text.Encoding.UTF8),
				new CSharpParseOptions(LanguageVersion.Latest),
				path: "main.cs");
			var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
				.WithOptimizationLevel(OptimizationLevel.Debug)
				.WithAllowUnsafe(true)
				.WithNullableContextOptions(NullableContextOptions.Enable)
				.WithDeterministic(true);
			var compilation = CSharpCompilation.Create(assemblyName, [syntaxTree], CreateCompilerReferences(moduleEntry), options);
			using var peStream = new MemoryStream();
			using var pdbStream = new MemoryStream();
			var result = compilation.Emit(
				peStream,
				pdbStream,
				options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
			if (!result.Success)
				return new CSharpCompilationResult(null, null, result.Diagnostics);
			return new CSharpCompilationResult(peStream.ToArray(), pdbStream.Length == 0 ? null : pdbStream.ToArray(), result.Diagnostics);
		}

		/// <summary>
		/// The references the edited source compiles against: the target module itself (its types are
		/// visible, which is what the source's own definition shadows), every assembly its row references,
		/// and the framework's reference pack. The pack wins when a reference resolves to a runtime copy of
		/// the same assembly, so the compiler does not see two System.Runtime assemblies.
		/// </summary>
		static IReadOnlyList<Microsoft.CodeAnalysis.MetadataReference> CreateCompilerReferences(ModuleEntry moduleEntry) {
			var paths = new List<string>();
			var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
			void Add(string? path, string? name = null) {
				if (string.IsNullOrEmpty(path) || !File.Exists(path))
					return;
				var simpleName = name ?? Path.GetFileNameWithoutExtension(path);
				if (!names.Add(simpleName))
					return;
				paths.Add(path);
			}
			var module = moduleEntry.Module;
			Add(moduleEntry.Path, module.Assembly?.Name ?? module.Name);
			foreach (var path in ReferenceAssemblies.Framework)
				Add(path);
			foreach (var reference in module.GetAssemblyRefs()) {
				IAssembly? resolved = null;
				try {
					resolved = module.Context.AssemblyResolver.Resolve(reference, module);
				}
				catch (Exception) {
					// A reference that cannot be resolved is reported by the compiler as a missing type.
				}
				Add((resolved as AssemblyDef)?.ManifestModule?.Location, reference.Name);
			}
			return ReferenceAssemblies.Create(paths);
		}

		static CompilerDiagnosticDto ToDiagnosticDto(Diagnostic diagnostic) {
			var span = diagnostic.Location.GetLineSpan();
			return new CompilerDiagnosticDto(
				diagnostic.Severity switch {
					CSharpDiagnosticSeverity.Error => "error",
					CSharpDiagnosticSeverity.Warning => "warning",
					CSharpDiagnosticSeverity.Info => "info",
					_ => "hidden",
				},
				diagnostic.GetMessage(CultureInfo.InvariantCulture),
				diagnostic.Id,
				span.Path is { Length: > 0 } ? span.Path : null,
				span.StartLinePosition.Line,
				span.StartLinePosition.Character,
				span.EndLinePosition.Line,
				span.EndLinePosition.Character);
		}

		static CompilerDiagnosticDto ToDiagnosticDto(CompilerDiagnostic diagnostic) => new(
			diagnostic.Severity switch {
				CompilerDiagnosticSeverity.Error => "error",
				CompilerDiagnosticSeverity.Warning => "warning",
				CompilerDiagnosticSeverity.Info => "info",
				_ => "hidden",
			},
			diagnostic.Description,
			diagnostic.Id,
			diagnostic.Filename,
			diagnostic.LineLocationSpan?.StartLinePosition.Line ?? 0,
			diagnostic.LineLocationSpan?.StartLinePosition.Character ?? 0,
			diagnostic.LineLocationSpan?.EndLinePosition.Line ?? 0,
			diagnostic.LineLocationSpan?.EndLinePosition.Character ?? 0);

		sealed record CSharpCompilationResult(byte[]? Assembly, byte[]? Pdb, IReadOnlyList<Diagnostic> Diagnostics) {
			public bool Success => Assembly is not null;
		}

		/// <summary>
		/// The state an import is undone from: the module's type list, the edited type's member lists and
		/// every member's own options, so members the importer added go away and the ones it changed go
		/// back to what they were — dnSpy's <c>EditedMethodUpdater</c> and the node creators, without the
		/// tree nodes they also carry.
		/// </summary>
		sealed class CompilerSnapshot {
			readonly ModuleDef module;
			readonly TypeDef[] topLevelTypes;
			readonly Dictionary<TypeDef, TypeState> types = [];
			readonly CustomAttribute[] moduleAttributes;
			readonly CustomAttribute[]? assemblyAttributes;
			readonly DeclSecurity[]? assemblySecurities;
			readonly Version? assemblyVersion;
			readonly Resource[] resources;
			readonly ExportedType[] exportedTypes;

			public CompilerSnapshot(ModuleDef module, string source, TypeDef? targetType)
				: this(module, SourceTypeNames(source), targetType) {
			}

			public CompilerSnapshot(ModuleDef module, IEnumerable<string> sourceTypeNames, TypeDef? targetType) {
				this.module = module;
				topLevelTypes = module.Types.ToArray();
				moduleAttributes = module.CustomAttributes.ToArray();
				assemblyAttributes = module.Assembly?.CustomAttributes.ToArray();
				assemblySecurities = module.Assembly?.DeclSecurities.ToArray();
				assemblyVersion = module.Assembly?.Version;
				resources = module.Resources.ToArray();
				exportedTypes = module.ExportedTypes.ToArray();
				// The types the compiled source could touch: the one being edited and any existing type the
				// source declares (a class that is added under an existing name is merged into it).
				var names = new HashSet<string>(sourceTypeNames, StringComparer.Ordinal);
				foreach (var type in module.GetTypes()) {
					if (type != targetType && !names.Contains(type.Name.String))
						continue;
					Capture(type);
				}
			}

			/// <summary>The names of the types the source declares, read without compiling it again.</summary>
			static IEnumerable<string> SourceTypeNames(string source) {
				var names = new HashSet<string>(StringComparer.Ordinal);
				var tree = CSharpSyntaxTree.ParseText(source);
				foreach (var declaration in tree.GetRoot().DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.BaseTypeDeclarationSyntax>())
					names.Add(declaration.Identifier.ValueText);
				return names;
			}

			void Capture(TypeDef type) {
				var state = new TypeState {
					Options = new TypeDefOptions(type),
					Methods = type.Methods.ToArray(),
					Fields = type.Fields.ToArray(),
					Properties = type.Properties.ToArray(),
					Events = type.Events.ToArray(),
					NestedTypes = type.NestedTypes.ToArray(),
					MethodStates = type.Methods.ToDictionary(method => method, method => new MethodState(method)),
					FieldOptions = type.Fields.ToDictionary(field => field, field => new FieldDefOptions(field)),
					PropertyOptions = type.Properties.ToDictionary(property => property, property => new PropertyDefOptions(property)),
					EventOptions = type.Events.ToDictionary(@event => @event, @event => new EventDefOptions(@event)),
				};
				types[type] = state;
			}

			public void Restore() {
				module.Types.Clear();
				foreach (var type in topLevelTypes)
					module.Types.Add(type);
				module.Resources.Clear();
				foreach (var resource in resources)
					module.Resources.Add(resource);
				module.ExportedTypes.Clear();
				foreach (var type in exportedTypes)
					module.ExportedTypes.Add(type);
				module.CustomAttributes.Clear();
				foreach (var attribute in moduleAttributes)
					module.CustomAttributes.Add(attribute);
				if (module.Assembly is { } assembly) {
					if (assemblyAttributes is not null) {
						assembly.CustomAttributes.Clear();
						foreach (var attribute in assemblyAttributes)
							assembly.CustomAttributes.Add(attribute);
					}
					if (assemblySecurities is not null) {
						assembly.DeclSecurities.Clear();
						foreach (var security in assemblySecurities)
							assembly.DeclSecurities.Add(security);
					}
					if (assemblyVersion is not null)
						assembly.Version = assemblyVersion;
				}
				foreach (var (type, state) in types) {
					RestoreList(type.Methods, state.Methods);
					RestoreList(type.Fields, state.Fields);
					RestoreList(type.Properties, state.Properties);
					RestoreList(type.Events, state.Events);
					RestoreList(type.NestedTypes, state.NestedTypes);
					state.Options.CopyTo(type, module);
					foreach (var (method, methodState) in state.MethodStates)
						methodState.Restore(method);
					foreach (var (field, options) in state.FieldOptions)
						options.CopyTo(field);
					foreach (var (property, options) in state.PropertyOptions)
						options.CopyTo(property);
					foreach (var (@event, options) in state.EventOptions)
						options.CopyTo(@event);
				}
			}

			static void RestoreList<T>(IList<T> list, IReadOnlyList<T> snapshot) {
				list.Clear();
				foreach (var item in snapshot)
					list.Add(item);
			}

			sealed class TypeState {
				public required TypeDefOptions Options { get; init; }
				public required MethodDef[] Methods { get; init; }
				public required FieldDef[] Fields { get; init; }
				public required PropertyDef[] Properties { get; init; }
				public required EventDef[] Events { get; init; }
				public required TypeDef[] NestedTypes { get; init; }
				public required Dictionary<MethodDef, MethodState> MethodStates { get; init; }
				public required Dictionary<FieldDef, FieldDefOptions> FieldOptions { get; init; }
				public required Dictionary<PropertyDef, PropertyDefOptions> PropertyOptions { get; init; }
				public required Dictionary<EventDef, EventDefOptions> EventOptions { get; init; }
			}

			sealed class MethodState {
				readonly MethodDefOptions options;
				readonly dnlib.DotNet.Emit.MethodBody? body;
				readonly MethodImplAttributes codeType;
				readonly ParamDef[] parameters;

				public MethodState(MethodDef method) {
					options = new MethodDefOptions(method);
					body = method.MethodBody;
					codeType = method.CodeType;
					parameters = method.ParamDefs.ToArray();
				}

				public void Restore(MethodDef method) {
					options.CopyTo(method);
					method.MethodBody = body;
					method.CodeType = codeType;
					method.ParamDefs.Clear();
					foreach (var parameter in parameters)
						method.ParamDefs.Add(parameter);
				}
			}
		}
	}
}

/// <summary>The modes dnSpy's compiler commands run in.</summary>
public static class CompilerModes {
	public const string EditMethod = "editMethod";
	public const string EditClass = "editClass";
	public const string AddMembers = "addMembers";
	public const string AddClass = "addClass";
	public const string EditAssembly = "editAssembly";
}
