using System.Reflection.Metadata.Ecma335;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using dnSpy.Backend.Core.IL;
using dnSpy.Backend.Core.Output;
using dnSpy.Backend.Core.ProjectExport;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.CSharp.Transforms;
using ICSharpCode.Decompiler.TypeSystem;
using DecompilerAstNode = ICSharpCode.Decompiler.CSharp.Syntax.AstNode;

namespace dnSpy.Cli;

/// <summary>
/// Writes one type or member to stdout the way the WPF console's languages write it, with the GUI's decompilers:
/// C# is ICSharpCode.Decompiler's with the fork's options (token comments, member order, …) applied; Visual Basic is
/// that C# converted the way the Visual Basic view converts it; IL and IL with C# are the port of dnSpy's
/// disassembler. A member's document starts with its declaring type in a comment and, for a constructor or a field,
/// shows the field initializers it runs, as dnSpy's CSharpDecompiler writes them.
/// </summary>
sealed class DecompilerRunner(LoadedModule module, CommandLineOptions options) {
	public string IndentationString => options.Spaces <= 0 ? "\t" : new string(' ', options.Spaces);

	public void WriteTo(IMemberDef member, IDecompilerOutput output) {
		switch (options.Language.Kind) {
		case ConsoleLanguageKind.CSharp:
			WriteCSharp(member, output);
			break;
		case ConsoleLanguageKind.VisualBasic:
			WriteVisualBasic(member, output);
			break;
		case ConsoleLanguageKind.IL:
			WriteIL(member, output, withCSharp: false);
			break;
		case ConsoleLanguageKind.ILWithCSharp:
			WriteIL(member, output, withCSharp: true);
			break;
		default:
			throw new InvalidOperationException($"Unknown language: {options.Language.Name}");
		}
	}

	/// <summary>The settings the C# languages decompile with; Visual Basic's are converted from C# written with them.</summary>
	DnSpyDecompilerSettings CSharpSettings(bool visualBasic) {
		var settings = options.EffectiveSettings();
		if (visualBasic)
			settings.ToVisualBasicSettings();
		settings.CSharpFormattingOptions.IndentationString = IndentationString;
		return settings;
	}

	void WriteCSharp(IMemberDef member, IDecompilerOutput output) {
		var settings = CSharpSettings(visualBasic: false);
		if (member is not TypeDef)
			WriteCommentLineDeclaringType(output, member, "// ", CSharpTypeName.Of(null, member.DeclaringType, CSharpTypeName.Options.IncludeNamespace));
		var syntaxTree = DecompileCSharp(member, settings);
		CSharpOutputWriter.Write(syntaxTree, output, settings);
	}

	void WriteVisualBasic(IMemberDef member, IDecompilerOutput output) {
		var settings = CSharpSettings(visualBasic: true);
		var csharp = new StringWriter();
		var syntaxTree = DecompileCSharp(member, settings);
		DnSpyCSharpTransform.AfterDecompile(syntaxTree, settings);
		syntaxTree.AcceptVisitor(new ICSharpCode.Decompiler.CSharp.OutputVisitor.CSharpOutputVisitor(
			ICSharpCode.Decompiler.CSharp.OutputVisitor.TokenWriter.Create(csharp, IndentationString), settings.CSharpFormattingOptions));
		var converted = VisualBasicConversion.ConvertAsync(
			new DecompileResponse(member.Name, "csharp", csharp.ToString(), [], []), memberOnly: member is not TypeDef, CancellationToken.None, ReferencePaths()).GetAwaiter().GetResult();

		if (member is not TypeDef) {
			var typeName = new TextPartsBuilder();
			CSharpTypeName.WriteVisualBasic(typeName, null, member.DeclaringType, CSharpTypeName.Options.IncludeNamespace, null);
			WriteCommentLineDeclaringType(output, member, "' ", typeName.ToString());
		}
		WriteClassified(VisualBasicConverterFixes.Reindent(converted.Text.Replace("\r\n", "\n", StringComparison.Ordinal), IndentationString), output);
	}

	/// <summary>DecompilerBase.WriteCommentLineDeclaringType: the line a member's document starts with.</summary>
	static void WriteCommentLineDeclaringType(IDecompilerOutput output, IMemberDef member, string commentStart, string? typeName) {
		output.Write(commentStart, BoxedTextColor.Comment);
		output.Write(typeName ?? member.DeclaringType.FullName, member.DeclaringType, DecompilerReferenceFlags.None, BoxedTextColor.Comment);
		output.WriteLine();
	}

	/// <summary>Visual Basic text in the colors the Visual Basic document is colored in.</summary>
	void WriteClassified(string text, IDecompilerOutput output) {
		text = text.Replace("\r\n", "\n", StringComparison.Ordinal);
		IReadOnlyList<ClassifiedSpanDto> spans;
		try {
			spans = options.ColorizeOutput ? WorkspaceManager.SharedDecompilers.ClassifyVisualBasic(text, ReferencePaths(), CancellationToken.None) : [];
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			spans = [];
		}
		var position = 0;
		void WriteSpan(int end, string color) {
			while (position < end) {
				var newLine = text.IndexOf('\n', position, end - position);
				if (newLine < 0) {
					output.Write(text, position, end - position, color);
					position = end;
					break;
				}
				if (newLine > position)
					output.Write(text, position, newLine - position, color);
				output.WriteLine();
				position = newLine + 1;
			}
		}
		foreach (var span in spans.OrderBy(span => span.Start)) {
			if (span.Start < position)
				continue;
			WriteSpan(span.Start, BoxedTextColor.Text);
			WriteSpan(Math.Min(text.Length, span.Start + span.Length), span.Color);
		}
		WriteSpan(text.Length, BoxedTextColor.Text);
		if (text.Length > 0 && text[^1] != '\n')
			output.WriteLine();
	}

	/// <summary>The module and every assembly it references that resolves: what its Visual Basic is compiled against.</summary>
	List<string> ReferencePaths() {
		var paths = new List<string> { module.Path };
		foreach (var reference in module.File.AssemblyReferences) {
			if (module.Resolver.FindAssemblyFile(reference) is { } path)
				paths.Add(path);
		}
		return paths;
	}

	CSharpDecompiler CreateCSharpDecompiler(DecompilerSettings settings, IAstTransform? select = null) {
		var decompiler = new CSharpDecompiler(module.File, module.Resolver, settings) {
			CancellationToken = CancellationToken.None,
			DebugInfoProvider = settings.UseDebugSymbols ? module.DebugInfo : null,
		};
		if (select is not null)
			decompiler.AstTransforms.Add(select);
		DnSpyCSharpTransform.AddTo(decompiler, module.Module, settings);
		return decompiler;
	}

	/// <summary>
	/// dnSpy's CSharpDecompiler.Decompile for each kind: a type whole; a member alone, without using declarations;
	/// an instance constructor of a class with the fields and the other constructors it shares initializers with,
	/// then only it and the fields it initializes kept (SelectCtorTransform); a field that is not a constant with the
	/// constructors that initialize it, then only it kept (SelectFieldTransform).
	/// </summary>
	SyntaxTree DecompileCSharp(IMemberDef member, DnSpyDecompilerSettings settings) {
		if (member is TypeDef type) {
			// AstBuilder.AddType: the type inside its namespace, with the using declarations it needs.
			var handles = new[] { (System.Reflection.Metadata.TypeDefinitionHandle)Handle(type) };
			var decompiler = CreateCSharpDecompiler(settings);
			var syntaxTree = decompiler.DecompileTypes(handles);
			if (settings.ForceShowAllMembers)
				MergeHiddenMembers(syntaxTree, decompiler, handles, settings);
			return syntaxTree;
		}

		var memberSettings = (DnSpyDecompilerSettings)settings.Clone();
		memberSettings.UsingDeclarations = false;
		memberSettings.FullyQualifiedTypesKeepUsings = false;
		switch (member) {
		case MethodDef { IsConstructor: true, IsStatic: false } constructor when !constructor.DeclaringType.IsValueType:
			return CreateCSharpDecompiler(memberSettings, new SelectCtorTransform(module.Module, constructor))
				.Decompile(FieldsAndConstructors(constructor.DeclaringType, isStatic: false));
		case FieldDef { IsLiteral: true } literal:
			return CreateCSharpDecompiler(memberSettings, new SelectFieldTransform(module.Module, literal)).Decompile([Handle(literal)]);
		case FieldDef field:
			return CreateCSharpDecompiler(memberSettings, new SelectFieldTransform(module.Module, field))
				.Decompile(FieldsAndConstructors(field.DeclaringType, field.IsStatic));
		default:
			return CreateCSharpDecompiler(memberSettings).Decompile([Handle(member)]);
		}
	}

	/// <summary>AddFieldsAndCtors: the type's fields, then its constructors, of the one kind — static or instance.</summary>
	static System.Reflection.Metadata.EntityHandle[] FieldsAndConstructors(TypeDef type, bool isStatic) => [
		.. type.Fields.Where(field => field.IsStatic == isStatic).Select(field => Handle(field)),
		.. type.Methods.Where(method => method.IsConstructor && method.IsStatic == isStatic).Select(method => Handle(method)),
	];

	/// <summary>ForceShowAllMembers: the members a second decompilation with the hiding switches off adds to a type.</summary>
	void MergeHiddenMembers(SyntaxTree syntaxTree, CSharpDecompiler decompiler, System.Reflection.Metadata.TypeDefinitionHandle[] handles, DnSpyDecompilerSettings settings) {
		try {
			var showAll = settings.ForShowAllMembers();
			var second = new CSharpDecompiler(decompiler.TypeSystem, showAll) { CancellationToken = CancellationToken.None, DebugInfoProvider = decompiler.DebugInfoProvider };
			DnSpyCSharpTransform.AddTo(second, module.Module, showAll);
			HiddenMemberMerger.Merge(syntaxTree, second.DecompileTypes(handles), showAll.SortSystemUsingStatementsFirst);
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			// The option only ever adds members.
		}
	}

	void WriteIL(IMemberDef member, IDecompilerOutput output, bool withCSharp) {
		CSharpDecompiler? csharp = null;
		DecompilerSettings? csharpSettings = null;
		if (withCSharp) {
			// ILWithCSharpDecompiler: the C# settings, without using declarations since only the statements are shown.
			csharpSettings = CSharpSettings(visualBasic: false);
			csharpSettings.UsingDeclarations = false;
			csharp = CreateCSharpDecompiler(csharpSettings);
		}
		var context = new ILDecompilationContext {
			CancellationToken = CancellationToken.None,
			GetXmlDocumentation = WorkspaceManager.SharedDecompilers.RawXmlDocumentation,
			GetFrameworkDocumentation = WorkspaceManager.SharedDecompilers.FrameworkDocumentation,
			CreateSourceStatementProvider = csharp is null ? null : method => WorkspaceManager.SharedDecompilers.CreateSourceStatementProvider(csharp, csharpSettings!, method, CancellationToken.None),
		};
		var decompiler = new ILDecompiler(options.IlOptions.ToSettings(), context);
		switch (member) {
		case TypeDef type:
			decompiler.Decompile(type, output);
			break;
		case MethodDef method:
			decompiler.Decompile(method, output);
			break;
		case FieldDef field:
			decompiler.Decompile(field, output);
			break;
		case PropertyDef property:
			decompiler.Decompile(property, output);
			break;
		case EventDef @event:
			decompiler.Decompile(@event, output);
			break;
		default:
			throw new ConsoleErrorException(ConsoleStrings.InvalidMemberToDecompile);
		}
	}

	static System.Reflection.Metadata.EntityHandle Handle(IMDTokenProvider member) =>
		MetadataTokens.EntityHandle(unchecked((int)member.MDToken.Raw));
}

/// <summary>
/// SelectCtorTransform: of the fields and constructors decompiled together, the constructor asked for and the fields
/// it initializes; when it chains to another constructor with <c>this(...)</c>, no fields at all.
/// </summary>
sealed class SelectCtorTransform(ModuleDef module, MethodDef constructor) : IAstTransform {
	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		ConstructorDeclaration? ctorDecl = null;
		foreach (var node in rootNode.Children.ToArray()) {
			switch (node) {
			case ConstructorDeclaration ctor:
				if (SelectedMembers.Resolve(module, ctor) == constructor)
					ctorDecl = ctor;
				else
					ctor.Remove();
				break;
			// Remove any fields without initializers
			case FieldDeclaration field when field.Variables.All(variable => variable.Initializer is null):
				field.Remove();
				break;
			}
		}
		if (ctorDecl?.Initializer?.ConstructorInitializerType == ConstructorInitializerType.This) {
			// remove all fields
			foreach (var field in rootNode.Children.OfType<FieldDeclaration>().ToArray())
				field.Remove();
		}
	}
}

/// <summary>SelectFieldTransform: every declaration but the field's taken out.</summary>
sealed class SelectFieldTransform(ModuleDef module, FieldDef field) : IAstTransform {
	public void Run(DecompilerAstNode rootNode, TransformContext context) {
		foreach (var entity in rootNode.Children.OfType<EntityDeclaration>().ToArray()) {
			if (SelectedMembers.Resolve(module, entity) != field)
				entity.Remove();
		}
	}
}

static class SelectedMembers {
	/// <summary>The row of the module a top-level declaration declares.</summary>
	public static IMemberDef? Resolve(ModuleDef module, EntityDeclaration declaration) {
		var symbol = declaration.GetSymbol()
			?? (declaration as FieldDeclaration)?.Variables.FirstOrDefault()?.GetSymbol()
			?? (declaration as EventDeclaration)?.Variables.FirstOrDefault()?.GetSymbol();
		if (symbol is not IEntity entity || entity.MetadataToken.IsNil)
			return null;
		try {
			return module.ResolveToken(unchecked((uint)MetadataTokens.GetToken(entity.MetadataToken))) as IMemberDef;
		}
		catch (Exception) {
			return null;
		}
	}
}
