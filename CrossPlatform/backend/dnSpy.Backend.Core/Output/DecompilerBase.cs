using System.Globalization;
using System.Text;
using dnlib.DotNet;
using dnlib.PE;

namespace dnSpy.Backend.Core.Output;

/// <summary>
/// The parts of dnSpy's <c>DecompilerBase</c> every language shares: the comment lines a document starts with — an
/// assembly's and a module's header, a member's declaring type — and the document of a namespace, which lists its
/// types rather than decompiling them. Each writes in the comment syntax of the language it is given.
/// </summary>
sealed class DecompilerBase(string commentBegin = "//") {
	/// <summary>C# and IL write their comments with <c>//</c>.</summary>
	public static DecompilerBase CSharp { get; } = new("//");

	/// <summary>Visual Basic writes its comments with an apostrophe.</summary>
	public static DecompilerBase VisualBasic { get; } = new("'");

	public void WriteCommentBegin(IDecompilerOutput output, bool addSpace) =>
		output.Write(addSpace ? commentBegin + " " : commentBegin, BoxedTextColor.Comment);

	public static void WriteCommentEnd(IDecompilerOutput output, bool addSpace) { }

	/// <summary>dnSpy's <c>WriteCommentLine</c> extension: a whole comment line.</summary>
	public void WriteCommentLine(IDecompilerOutput output, string comment) {
		WriteCommentBegin(output, true);
		output.Write(comment, BoxedTextColor.Comment);
		WriteCommentEnd(output, true);
		output.WriteLine();
	}

	/// <summary>
	/// <c>DecompileNamespace</c>: a namespace is not decompiled — its document names it and lists its types, each a
	/// reference to the type.
	/// </summary>
	public void DecompileNamespace(string? @namespace, IEnumerable<TypeDef> types, IDecompilerOutput output) {
		WriteCommentLine(output, string.IsNullOrEmpty(@namespace) ? string.Empty : IdentifierEscaper.Escape(@namespace));
		WriteCommentLine(output, string.Empty);
		WriteCommentLine(output, "Types:");
		WriteCommentLine(output, string.Empty);
		foreach (var type in types) {
			WriteCommentBegin(output, true);
			output.Write(IdentifierEscaper.Escape(type.Name), type, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
			WriteCommentEnd(output, true);
			output.WriteLine();
		}
	}

	/// <summary><c>WriteAssembly</c>: the file, the assembly's name, its entry point and its timestamp.</summary>
	public void WriteAssembly(AssemblyDef assembly, IDecompilerOutput output) {
		WriteAssemblyName(assembly, output);
		output.WriteLine();
		PrintEntryPoint(assembly.ManifestModule, output);
		if (TryGetPEImage(assembly.ManifestModule) is { } peImage)
			WriteTimestampComment(output, peImage);
		output.WriteLine();
	}

	/// <summary><c>WriteModule</c>: the file, the module's name, its global type, entry point, platform, runtime and timestamp.</summary>
	public void WriteModule(ModuleDef module, IDecompilerOutput output) {
		WriteModuleName(module, output);
		output.WriteLine();
		if (module.Types.Count > 0) {
			WriteCommentBegin(output, true);
			output.Write("Global type: ", BoxedTextColor.Comment);
			output.Write(IdentifierEscaper.Escape(module.GlobalType.FullName), module.GlobalType, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
			output.WriteLine();
		}
		PrintEntryPoint(module, output);
		WriteCommentLine(output, "Architecture: " + TargetFrameworkInfo.ArchString(module));
		if (!module.IsILOnly)
			WriteCommentLine(output, "This assembly contains unmanaged code.");
		if (TargetFrameworkInfo.DisplayName(module) is { } runtimeName)
			WriteCommentLine(output, "Runtime: " + runtimeName);
		if (TryGetPEImage(module) is { } peImage)
			WriteTimestampComment(output, peImage);
		output.WriteLine();
	}

	/// <summary>The first two lines of an assembly's document: the file and the full name.</summary>
	public void WriteAssemblyName(AssemblyDef assembly, IDecompilerOutput output) {
		WriteCommentLine(output, assembly.ManifestModule.Location);
		if (assembly.IsContentTypeWindowsRuntime)
			WriteCommentLine(output, IdentifierEscaper.Escape(assembly.Name, true) + " [WinRT]");
		else
			WriteCommentLine(output, IdentifierEscaper.Escape(assembly.FullName, true));
	}

	/// <summary>The first two lines of a module's document: the file and the name.</summary>
	public void WriteModuleName(ModuleDef module, IDecompilerOutput output) {
		WriteCommentLine(output, module.Location);
		WriteCommentLine(output, IdentifierEscaper.Escape(module.Name, true));
	}

	/// <summary>
	/// <c>WriteTimestampComment</c>: the image's timestamp, in hex and as a local date — "unknown" for one that is not
	/// a date, which a deterministic build writes.
	/// </summary>
	public void WriteTimestampComment(IDecompilerOutput output, IPEImage peImage) {
		WriteCommentBegin(output, true);
		output.Write("Timestamp:", BoxedTextColor.Comment);
		output.Write(" ", BoxedTextColor.Comment);
		output.Write(TimestampText(peImage.ImageNTHeaders.FileHeader.TimeDateStamp), BoxedTextColor.Comment);
		WriteCommentEnd(output, true);
		output.WriteLine();
	}

	/// <summary>A PE timestamp the way dnSpy's documents write it.</summary>
	public static string TimestampText(uint timestamp) {
		if ((int)timestamp > 0) {
			var date = DateTime.UnixEpoch.AddSeconds(timestamp).ToLocalTime();
			return $"{timestamp:X8} ({date.ToString(CultureInfo.CurrentUICulture.DateTimeFormat)})";
		}
		return $"<Unknown> ({timestamp:X8})";
	}

	/// <summary><c>PrintEntryPoint</c>: the managed entry point, every part of its name a reference — or the native one's RVA.</summary>
	public void PrintEntryPoint(ModuleDef module, IDecompilerOutput output) {
		switch (GetEntryPoint(module)) {
		case uint rva:
			WriteCommentLine(output, string.Format(CultureInfo.InvariantCulture, "Native Entry point: 0x{0:X8}", rva));
			break;
		case MethodDef entryPoint:
			WriteCommentBegin(output, true);
			output.Write("Entry point: ", BoxedTextColor.Comment);
			if (entryPoint.DeclaringType is not null) {
				var declaringTypes = new List<TypeDef>(1);
				for (var type = entryPoint.DeclaringType; type is not null; type = type.DeclaringType)
					declaringTypes.Add(type);
				declaringTypes.Reverse();
				var ns = declaringTypes[0].Namespace;
				if (ns.Length > 0) {
					var parts = ns.String.Split('.');
					var sb = new StringBuilder(ns.Length);
					foreach (var part in parts) {
						sb.Append(part);
						output.Write(IdentifierEscaper.Escape(part), new NamespaceReference(entryPoint.Module.Assembly, sb.ToString()), DecompilerReferenceFlags.None, BoxedTextColor.Comment);
						sb.Append('.');
						output.Write(".", BoxedTextColor.Comment);
					}
				}
				foreach (var type in declaringTypes) {
					output.Write(IdentifierEscaper.Escape(type.Name), type, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
					output.Write(".", BoxedTextColor.Comment);
				}
			}
			output.Write(IdentifierEscaper.Escape(entryPoint.Name), entryPoint, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
			WriteCommentEnd(output, true);
			output.WriteLine();
			break;
		}
	}

	/// <summary>The entry point of a module — a managed method, a native RVA, or, for a multi-file assembly whose
	/// entry point is in another of its files, that file's.</summary>
	static object? GetEntryPoint(ModuleDef? module) {
		var maxIterations = 1;
		for (var i = 0; module is not null && i < maxIterations; i++) {
			var rva = module.NativeEntryPoint;
			if (rva != 0)
				return (uint)rva;
			var managed = module.ManagedEntryPoint;
			if (managed is MethodDef entryPoint)
				return entryPoint;
			if (managed is not FileDef file || module.Assembly is not { } assembly)
				return null;
			maxIterations = assembly.Modules.Count;
			module = assembly.Modules.FirstOrDefault(m => File.Exists(m.Location) && StringComparer.OrdinalIgnoreCase.Equals(Path.GetFileName(m.Location), file.Name.String));
		}
		return null;
	}

	/// <summary>
	/// <c>WriteCommentLineDeclaringType</c>: the line a member's document starts with — its declaring type's full
	/// name, a reference to the type. <paramref name="typeName"/> is the name in the document's language.
	/// </summary>
	public void WriteCommentLineDeclaringType(IDecompilerOutput output, IMemberDef member, string typeName) {
		WriteCommentBegin(output, true);
		output.Write(typeName, member.DeclaringType, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
		WriteCommentEnd(output, true);
		output.WriteLine();
	}

	static IPEImage? TryGetPEImage(ModuleDef module) => (module as ModuleDefMD)?.Metadata.PEImage;
}
