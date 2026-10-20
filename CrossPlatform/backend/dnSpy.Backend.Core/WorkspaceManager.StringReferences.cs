using System.Diagnostics;
using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Search;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's String References window (<c>Extensions/dnSpy.StringSearcher</c>): every string the modules of the
/// selected assemblies hold — the operand of each <c>ldstr</c>, the string constants of fields, properties and
/// parameters, and the string arguments of custom attributes — each with the member it is in.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<StringReferencesSearchResponse> SearchStringReferencesAsync(StringReferencesSearchRequest request, CancellationToken cancellationToken) =>
		SearchStringReferencesAsync(request, null, cancellationToken);

	/// <summary>
	/// Scans the modules the request names. A scan asked with a progress token hands what it finds to
	/// <paramref name="progress"/> as it goes, the way dnSpy's window fills while its scan runs; the response
	/// then carries only the rest.
	/// </summary>
	public Task<StringReferencesSearchResponse> SearchStringReferencesAsync(StringReferencesSearchRequest request, Func<StringReferencesProgressNotification, Task>? progress, CancellationToken cancellationToken) =>
		GetWorkspace(request.WorkspaceId).SearchStringReferencesAsync(request, AnalyzerSliceBudget, AnalyzerProgressInterval, progress, cancellationToken);

	sealed partial class Workspace {
		public async Task<StringReferencesSearchResponse> SearchStringReferencesAsync(StringReferencesSearchRequest request, TimeSpan sliceBudget, TimeSpan progressInterval,
			Func<StringReferencesProgressNotification, Task>? progress, CancellationToken cancellationToken) {
			var progressToken = progress is null ? null : request.ProgressToken;
			var scan = await RunAsync(w => w.PrepareStringReferences(request), cancellationToken).ConfigureAwait(false);
			var sent = 0;
			var sinceSent = Stopwatch.StartNew();
			while (!scan.Completed) {
				var batch = await RunAsync(w => {
					w.CheckStringReferencesEpoch(scan);
					scan.RunSlice(sliceBudget);
					if (progressToken is null || scan.Found.Count == sent || sinceSent.Elapsed < progressInterval)
						return null;
					return scan.Found.GetRange(sent, scan.Found.Count - sent);
				}, cancellationToken).ConfigureAwait(false);
				// Written with the gate let go: the tree has no reason to wait for the pipe.
				if (batch is { Count: > 0 }) {
					await progress!(new StringReferencesProgressNotification(progressToken!, sent, batch)).ConfigureAwait(false);
					sent += batch.Count;
					sinceSent.Restart();
				}
			}
			return await RunAsync(w => {
				w.CheckStringReferencesEpoch(scan);
				return new StringReferencesSearchResponse(scan.Found.GetRange(sent, scan.Found.Count - sent), sent, scan.ModulePaths);
			}, cancellationToken).ConfigureAwait(false);
		}

		void CheckStringReferencesEpoch(StringReferenceScan scan) {
			if (scan.Epoch != analyzerEpoch)
				throw new RpcException(ErrorCodes.EditConflict, "The workspace changed while the string references were being scanned.");
		}

		/// <summary>
		/// The modules a scan reads: those named by path that are still open, and every module of each selected
		/// node's assembly — dnSpy's <c>n.GetModule()?.Assembly.Modules</c>.
		/// </summary>
		StringReferenceScan PrepareStringReferences(StringReferencesSearchRequest request) {
			var modules = new List<ModuleEntry>();
			var seen = new HashSet<string>(StringComparer.Ordinal);
			void Add(ModuleEntry entry) {
				if (seen.Add(entry.Path))
					modules.Add(entry);
			}
			if (request.ModulePaths is { Count: > 0 } paths) {
				var open = OrderedModules()
					.Where(root => nodes.ContainsKey(root.Id))
					.SelectMany(root => ModulesOfAssembly(nodes[root.Id]))
					.ToArray();
				foreach (var path in paths) {
					if (open.FirstOrDefault(entry => string.Equals(entry.Path, path, StringComparison.Ordinal)) is { } entry)
						Add(entry);
				}
			}
			foreach (var id in request.NodeIds ?? []) {
				if (nodes.GetValueOrDefault(id)?.AsModuleEntry is not { IsExternal: false } owner || !nodes.TryGetValue(owner.Id, out var root))
					continue;
				foreach (var entry in ModulesOfAssembly(root))
					Add(entry);
			}
			var scan = new StringReferenceScan(analyzerEpoch, modules.Select(entry => entry.Path).ToArray());
			scan.Start(ScanStringReferences(modules, scan.Found, request.ShowAllMembers, request.Language));
			return scan;
		}

		IEnumerable<ModuleEntry> ModulesOfAssembly(NodeEntry root) =>
			GetAssemblyChildren(root).Select(node => node.AsModuleEntry).OfType<ModuleEntry>();

		/// <summary>dnSpy's AnalyzeMetadataRoots then AnalyzeModules, one type a step.</summary>
		IEnumerable<bool> ScanStringReferences(IReadOnlyList<ModuleEntry> modules, List<StringReferenceDto> found, bool showAllMembers, DecompilerLanguage language) {
			// dnSpy asks the decompiler which members it shows: C# and VB hide what the compiler made, IL hides nothing.
			bool Show(IMemberDef member) => showAllMembers || !CompilerGeneratedMembers.IsHidden(member);
			var writer = new ReferrerWriter(language, TypeColor);

			foreach (var entry in modules) {
				var module = entry.Module;
				ScanCustomAttributes(found, writer, entry, module, module, module);
				if (module.IsManifestModule && module.Assembly is { } assembly)
					ScanCustomAttributes(found, writer, entry, assembly, assembly, assembly);
			}
			yield return true;

			foreach (var entry in modules) {
				foreach (var type in entry.Module.GetTypes()) {
					if (!Show(type))
						continue;
					ScanCustomAttributes(found, writer, entry, type, type, type);
					// A type's generic parameters, fields, properties and events are filed under the type: dnSpy's
					// AnalyzeConstantProviders keeps the type's context and only changes the object.
					foreach (var genericParam in type.GenericParameters)
						ScanConstantProvider(found, writer, entry, type, genericParam, Show);
					foreach (var field in type.Fields)
						ScanConstantProvider(found, writer, entry, type, field, Show);
					foreach (var property in type.Properties)
						ScanConstantProvider(found, writer, entry, type, property, Show);
					foreach (var @event in type.Events)
						ScanConstantProvider(found, writer, entry, type, @event, Show);
					foreach (var method in type.Methods) {
						if (!Show(method))
							continue;
						ScanCustomAttributes(found, writer, entry, method, method, method);
						foreach (var genericParam in method.GenericParameters)
							ScanConstantProvider(found, writer, entry, method, genericParam, Show);
						foreach (var paramDef in method.ParamDefs)
							ScanConstantProvider(found, writer, entry, method, paramDef, Show);
						if (method.HasBody && method.Body is { HasInstructions: true } body) {
							foreach (var instruction in body.Instructions) {
								if (instruction is { OpCode.Code: Code.Ldstr, Operand: string { Length: > 0 } literal })
									found.Add(ILReference(writer, entry, method, literal, instruction.Offset));
							}
						}
					}
					yield return true;
				}
			}
		}

		void ScanConstantProvider(List<StringReferenceDto> found, ReferrerWriter writer, ModuleEntry entry, IMDTokenProvider container, IMDTokenProvider item, Func<IMemberDef, bool> show) {
			if (item is IMemberDef member && !show(member))
				return;
			if (item is IHasConstant { Constant: { Type: ElementType.String, Value: string { Length: > 0 } literal } } hasConstant)
				found.Add(ConstantReference(writer, entry, hasConstant, literal));
			if (item is IHasCustomAttribute hasCustomAttribute)
				ScanCustomAttributes(found, writer, entry, container, item, hasCustomAttribute);
		}

		void ScanCustomAttributes(List<StringReferenceDto> found, ReferrerWriter writer, ModuleEntry entry, IMDTokenProvider container, IMDTokenProvider referrer, IHasCustomAttribute provider) {
			foreach (var attribute in provider.CustomAttributes) {
				for (var i = 0; i < attribute.ConstructorArguments.Count; i++)
					ScanAttributeArgument(found, writer, entry, container, referrer, attribute, $"Argument #{i}", attribute.ConstructorArguments[i].Value);
				foreach (var argument in attribute.NamedArguments)
					ScanAttributeArgument(found, writer, entry, container, referrer, attribute, argument.Name.String, argument.Value);
			}
		}

		void ScanAttributeArgument(List<StringReferenceDto> found, ReferrerWriter writer, ModuleEntry entry, IMDTokenProvider container, IMDTokenProvider referrer, CustomAttribute attribute, string argumentName, object? value) {
			switch (value) {
			case IEnumerable<CAArgument> list:
				foreach (var item in list)
					ScanAttributeArgument(found, writer, entry, container, referrer, attribute, argumentName, item.Value);
				break;
			case CAArgument argument:
				ScanAttributeArgument(found, writer, entry, container, referrer, attribute, argumentName, argument.Value);
				break;
			case UTF8String { Length: > 0 } literal:
				found.Add(AttributeReference(writer, entry, container, referrer, attribute, argumentName, literal.String));
				break;
			}
		}

		/// <summary>ILStringReference: the method, then "+IL_xxxx".</summary>
		StringReferenceDto ILReference(ReferrerWriter writer, ModuleEntry entry, MethodDef method, string literal, uint offset) {
			var referrer = new TextPartsBuilder();
			writer.WriteMember(referrer, method);
			referrer.Write(TextColors.Punctuation, "+").Write(TextColors.Label, $"IL_{offset:X4}");
			return Reference(StringReferenceKinds.IL, literal, referrer, ReferrerIcon(method), entry, method.MDToken.Raw, GetMemberNode(method, entry).Id, (int)offset);
		}

		/// <summary>ConstantStringReference: the field or property, or the parameter's method and the parameter.</summary>
		StringReferenceDto ConstantReference(ReferrerWriter writer, ModuleEntry entry, IHasConstant referrer, string literal) {
			IMemberDef container = referrer is ParamDef { DeclaringMethod: { } method } ? method : (IMemberDef)referrer;
			var output = new TextPartsBuilder();
			writer.WriteMember(output, container);
			if (referrer is ParamDef paramDef)
				WriteParameterReference(output, paramDef);
			return Reference(StringReferenceKinds.Constant, literal, output, ReferrerIcon(container), entry, referrer.MDToken.Raw, GetMemberNode(container, entry).Id, null);
		}

		/// <summary>CustomAttributeStringReference: the container, the parameter the attribute is on, then the
		/// attribute's type and the argument the string is.</summary>
		StringReferenceDto AttributeReference(ReferrerWriter writer, ModuleEntry entry, IMDTokenProvider container, IMDTokenProvider referrer, CustomAttribute attribute, string argumentName, string literal) {
			var output = new TextPartsBuilder();
			switch (container) {
			case ModuleDef module:
				output.Write(TextColors.AssemblyModule, module.Name.String);
				break;
			case AssemblyDef assembly:
				WriteAssemblyNode(output, assembly);
				break;
			case IMemberDef member:
				writer.WriteMember(output, member);
				break;
			default:
				output.Write(TextColors.Text, container.ToString());
				break;
			}
			switch (referrer) {
			case ParamDef paramDef:
				WriteParameterReference(output, paramDef);
				break;
			case GenericParam genericParam:
				output.WriteSpace().Write(TextColors.DarkGray, "generic").WriteSpace();
				writer.WriteMember(output, genericParam);
				break;
			}
			output.WriteSpace().Write(TextColors.DarkGray, "attribute").WriteSpace();
			if (attribute.AttributeType is { } attributeType)
				writer.WriteType(output, attributeType);
			else
				output.Write(TextColors.Type, attribute.TypeFullName);
			output.Write(TextColors.Punctuation, " (").Write(TextColors.InstanceProperty, argumentName).Write(TextColors.Punctuation, ")");
			return Reference(StringReferenceKinds.Attribute, literal, output, ReferrerIcon(container), entry, container.MDToken.Raw, FollowNodeId(entry, referrer), null);
		}

		static void WriteParameterReference(TextPartsBuilder output, ParamDef paramDef) {
			output.WriteSpace().Write(TextColors.DarkGray, "parameter").WriteSpace();
			if (paramDef.DeclaringMethod?.Parameters.ReturnParameter.ParamDef == paramDef)
				output.Write(TextColors.Keyword, "return");
			else
				output.Write(TextColors.Parameter, paramDef.Name.String);
		}

		/// <summary>NodeFormatter.Write(AssemblyDef) with the version and the public key token, and no token.</summary>
		static void WriteAssemblyNode(TextPartsBuilder output, AssemblyDef assembly) {
			output.Write(IsExe(assembly) ? TextColors.AssemblyExe : TextColors.Assembly, assembly.Name.String);
			output.WriteSpace().Write(TextColors.Punctuation, "(").WriteVersion(assembly.Version);
			if (!PublicKeyBase.IsNullOrEmpty2(assembly.PublicKeyToken))
				output.WriteCommaSpace().Write(TextColors.Number, assembly.PublicKeyToken.ToString());
			output.Write(TextColors.Punctuation, ")");
		}

		static bool IsExe(AssemblyDef assembly) =>
			assembly.ManifestModule is { } manifest && (manifest.Characteristics & dnlib.PE.Characteristics.Dll) == 0;

		/// <summary>dnSpy's ReferrerImage: the container's image.</summary>
		static string ReferrerIcon(IMDTokenProvider container) => container switch {
			AssemblyDef assembly => IsExe(assembly) ? "assembly-exe" : "assembly",
			ModuleDef => "module",
			TypeDef type => DotNetImages.Of(type),
			MethodDef => "method",
			FieldDef => "field",
			PropertyDef => "property",
			EventDef => "event",
			_ => "namespace",
		};

		/// <summary>
		/// The node following an attribute's string goes to — dnSpy follows the attribute's owner: a parameter or
		/// a generic parameter to its method or type, an assembly or a module to its own row.
		/// </summary>
		string? FollowNodeId(ModuleEntry entry, IMDTokenProvider referrer) => referrer switch {
			AssemblyDef => entry.Id,
			ModuleDef => GetOrAddNode($"module:{entry.Path}", NodeKind.Module, entry.Module, entry).Id,
			ParamDef { DeclaringMethod: { } method } => GetMemberNode(method, entry).Id,
			GenericParam { DeclaringMethod: { } method } => GetMemberNode(method, entry).Id,
			GenericParam { DeclaringType: { } type } => GetMemberNode(type, entry).Id,
			IMemberDef member => GetMemberNode(member, entry).Id,
			_ => null,
		};

		static StringReferenceDto Reference(string kind, string literal, TextPartsBuilder referrer, string icon, ModuleEntry entry, uint token, string? nodeId, int? ilOffset) {
			var formatted = StringLiteralFormatter.Format(literal, out var isVerbatim);
			return new StringReferenceDto(kind, literal, formatted, isVerbatim, referrer.ToParts(), icon, entry.Module.Name.String, (int)token, nodeId, ilOffset);
		}
	}

	/// <summary>
	/// The decompiler's Write a row's referrer goes through, with dnSpy's StringReference.DefaultFormatterOptions:
	/// the Visual Basic formatter for VB ("Sub Program.Main(String())"), and the C# one for C# and both IL views,
	/// which do not override it ("Program.Main(string[])").
	/// </summary>
	sealed class ReferrerWriter(DecompilerLanguage language, Func<ITypeDefOrRef, string> typeColor) {
		/// <summary>FormatterOptions.Default less parameter names, field values, return types and field types.</summary>
		const CSharpMemberFormatter.Options Options =
			CSharpMemberFormatter.Options.ParameterTypes | CSharpMemberFormatter.Options.DeclaringTypes | CSharpMemberFormatter.Options.IntrinsicTypeKeywords;

		public void WriteMember(TextPartsBuilder output, IMemberDef member) {
			if (language == DecompilerLanguage.VisualBasic)
				VisualBasicMemberFormatter.Write(output, member, Options, typeColor);
			else
				CSharpMemberFormatter.Write(output, member, Options, typeColor);
		}

		public void WriteType(TextPartsBuilder output, ITypeDefOrRef type) {
			if (language == DecompilerLanguage.VisualBasic)
				VisualBasicMemberFormatter.WriteType(output, type, Options, typeColor);
			else
				CSharpMemberFormatter.WriteType(output, type, Options, typeColor);
		}
	}

	/// <summary>A scan in progress: the walk, advanced a slice at a time, and what it found so far.</summary>
	sealed class StringReferenceScan(long epoch, IReadOnlyList<string> modulePaths) {
		IEnumerator<bool>? steps;

		/// <summary>The workspace's model count the scan started at; a slice that finds it moved on stops the scan.</summary>
		public long Epoch { get; } = epoch;
		public IReadOnlyList<string> ModulePaths { get; } = modulePaths;
		public List<StringReferenceDto> Found { get; } = [];
		public bool Completed { get; private set; }

		public void Start(IEnumerable<bool> walk) => steps = walk.GetEnumerator();

		/// <summary>Walks on until the budget is spent — one step at least, however small the budget.</summary>
		public void RunSlice(TimeSpan budget) {
			var watch = Stopwatch.StartNew();
			do {
				if (!steps!.MoveNext()) {
					Completed = true;
					steps.Dispose();
					return;
				}
			} while (watch.Elapsed < budget);
		}
	}
}

/// <summary>
/// dnSpy's StringFormatter (adapted from its CSharpFormatter): a string as a C# literal — verbatim when it has a
/// backslash and nothing a verbatim string cannot hold, quoted with escapes otherwise.
/// </summary>
public static class StringLiteralFormatter {
	public static string Format(string value, out bool isVerbatim) {
		isVerbatim = CanUseVerbatimString(value);
		return isVerbatim ? FormatVerbatim(value) : FormatQuoted(value);
	}

	static bool CanUseVerbatimString(string s) {
		var foundBackslash = false;
		foreach (var c in s) {
			switch (c) {
			case '"':
				break;
			case '\\':
				foundBackslash = true;
				break;
			// The control characters a verbatim string would show as themselves, and the other newlines.
			case '\a' or '\b' or '\f' or '\n' or '\r' or '\t' or '\v' or '\0' or '\u0085' or '\u2028' or '\u2029':
				return false;
			default:
				if (char.IsControl(c))
					return false;
				break;
			}
		}
		return foundBackslash;
	}

	static string FormatQuoted(string value) {
		var sb = new StringBuilder(value.Length + 2);
		sb.Append('"');
		foreach (var c in value) {
			switch (c) {
			case '\a': sb.Append(@"\a"); break;
			case '\b': sb.Append(@"\b"); break;
			case '\f': sb.Append(@"\f"); break;
			case '\n': sb.Append(@"\n"); break;
			case '\r': sb.Append(@"\r"); break;
			case '\t': sb.Append(@"\t"); break;
			case '\v': sb.Append(@"\v"); break;
			case '\\': sb.Append(@"\\"); break;
			case '\0': sb.Append(@"\0"); break;
			case '"': sb.Append("\\\""); break;
			default:
				if (char.IsControl(c))
					sb.Append(@"\u").Append(((ushort)c).ToString("X4", CultureInfo.InvariantCulture));
				else
					sb.Append(c);
				break;
			}
		}
		return sb.Append('"').ToString();
	}

	static string FormatVerbatim(string value) {
		var sb = new StringBuilder(value.Length + 3);
		sb.Append("@\"");
		foreach (var c in value)
			sb.Append(c == '"' ? "\"\"" : c.ToString());
		return sb.Append('"').ToString();
	}
}
