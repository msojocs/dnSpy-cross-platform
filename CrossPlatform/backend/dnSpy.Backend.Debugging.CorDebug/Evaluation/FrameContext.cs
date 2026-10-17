using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>The generic arguments a signature is read with: the frame's own instantiation.</summary>
internal sealed record SignatureContext(IReadOnlyList<ITypeSymbol> TypeArguments, IReadOnlyList<ITypeSymbol> MethodArguments);

/// <summary>
/// Reads a metadata signature (a method's parameters, a body's locals) as Roslyn symbols, so a variable is
/// declared in an expression with the type its slot really has rather than the type of whatever it holds.
/// </summary>
internal sealed class RoslynSignatureProvider(DebuggeeTypeSystem types, ModuleTable.ModuleEntry module) : ISignatureTypeProvider<ITypeSymbol, SignatureContext> {
	Compilation Compilation => types.Compilation;

	public ITypeSymbol GetPrimitiveType(PrimitiveTypeCode typeCode) => Compilation.GetSpecialType(typeCode switch {
		PrimitiveTypeCode.Boolean => SpecialType.System_Boolean,
		PrimitiveTypeCode.Byte => SpecialType.System_Byte,
		PrimitiveTypeCode.Char => SpecialType.System_Char,
		PrimitiveTypeCode.Double => SpecialType.System_Double,
		PrimitiveTypeCode.Int16 => SpecialType.System_Int16,
		PrimitiveTypeCode.Int32 => SpecialType.System_Int32,
		PrimitiveTypeCode.Int64 => SpecialType.System_Int64,
		PrimitiveTypeCode.IntPtr => SpecialType.System_IntPtr,
		PrimitiveTypeCode.Object => SpecialType.System_Object,
		PrimitiveTypeCode.SByte => SpecialType.System_SByte,
		PrimitiveTypeCode.Single => SpecialType.System_Single,
		PrimitiveTypeCode.String => SpecialType.System_String,
		PrimitiveTypeCode.TypedReference => SpecialType.System_TypedReference,
		PrimitiveTypeCode.UInt16 => SpecialType.System_UInt16,
		PrimitiveTypeCode.UInt32 => SpecialType.System_UInt32,
		PrimitiveTypeCode.UInt64 => SpecialType.System_UInt64,
		PrimitiveTypeCode.UIntPtr => SpecialType.System_UIntPtr,
		PrimitiveTypeCode.Void => SpecialType.System_Void,
		_ => SpecialType.System_Object,
	});

	ITypeSymbol Object => Compilation.GetSpecialType(SpecialType.System_Object);

	public ITypeSymbol GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) =>
		types.GetTypeDefinition(module, MetadataTokens.GetToken(handle)) ?? Object;

	public ITypeSymbol GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) =>
		ResolveReference(reader, handle) ?? Object;

	INamedTypeSymbol? ResolveReference(MetadataReader reader, TypeReferenceHandle handle) {
		var reference = reader.GetTypeReference(handle);
		var name = reader.GetString(reference.Name);
		var @namespace = reader.GetString(reference.Namespace);
		switch (reference.ResolutionScope.Kind) {
			case HandleKind.TypeReference: {
				var outer = ResolveReference(reader, (TypeReferenceHandle)reference.ResolutionScope);
				return outer?.GetTypeMembers().FirstOrDefault(member => member.MetadataName == name);
			}
			case HandleKind.AssemblyReference: {
				var assemblyName = reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)reference.ResolutionScope).Name);
				var metadataName = @namespace.Length == 0 ? name : @namespace + "." + name;
				var assembly = types.FindAssembly(assemblyName);
				return assembly?.GetTypeByMetadataName(metadataName) ?? assembly?.ResolveForwardedType(metadataName) ?? types.FindType(metadataName);
			}
			default: {
				var metadataName = @namespace.Length == 0 ? name : @namespace + "." + name;
				return types.GetAssembly(module)?.GetTypeByMetadataName(metadataName) ?? types.FindType(metadataName);
			}
		}
	}

	public ITypeSymbol GetTypeFromSpecification(MetadataReader reader, SignatureContext genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
		reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

	public ITypeSymbol GetSZArrayType(ITypeSymbol elementType) => Compilation.CreateArrayTypeSymbol(elementType);

	public ITypeSymbol GetArrayType(ITypeSymbol elementType, ArrayShape shape) => Compilation.CreateArrayTypeSymbol(elementType, shape.Rank);

	public ITypeSymbol GetByReferenceType(ITypeSymbol elementType) => elementType;

	public ITypeSymbol GetPointerType(ITypeSymbol elementType) => Compilation.CreatePointerTypeSymbol(elementType);

	public ITypeSymbol GetPinnedType(ITypeSymbol elementType) => elementType;

	public ITypeSymbol GetModifiedType(ITypeSymbol modifier, ITypeSymbol unmodifiedType, bool isRequired) => unmodifiedType;

	public ITypeSymbol GetFunctionPointerType(MethodSignature<ITypeSymbol> signature) => Compilation.GetSpecialType(SpecialType.System_IntPtr);

	public ITypeSymbol GetGenericInstantiation(ITypeSymbol genericType, ImmutableArray<ITypeSymbol> typeArguments) =>
		genericType is INamedTypeSymbol named ? DebuggeeTypeSystem.Construct(named, typeArguments) : genericType;

	public ITypeSymbol GetGenericTypeParameter(SignatureContext genericContext, int index) =>
		index < genericContext.TypeArguments.Count ? genericContext.TypeArguments[index] : Object;

	public ITypeSymbol GetGenericMethodParameter(SignatureContext genericContext, int index) =>
		index < genericContext.MethodArguments.Count ? genericContext.MethodArguments[index] : Object;
}

/// <summary>What a variable of a frame is, for the Locals window.</summary>
internal enum FrameVariableKind {
	This,
	Parameter,
	Local,
}

/// <summary>One variable of a frame: the name the user reads, where it lives and what it is declared as.</summary>
internal sealed record FrameVariable(string Name, VariableSource Source, ITypeSymbol Type, FrameVariableKind Kind, bool IsCompilerGenerated);

/// <summary>
/// The names a frame offers: its <c>this</c>, parameters and locals, named by the decompiler (no PDB needed),
/// with the declared type of each slot. A frame inside compiler-generated code — the <c>MoveNext</c> of an
/// async or iterator method, the body of a lambda — shows the variables of the method the user wrote: the
/// locals the compiler hoisted into fields and the <c>this</c> it captured, which is what Roslyn's own
/// expression evaluator reads out of the generated names.
/// </summary>
internal sealed class FrameContext {
	public required EvalContextShape Shape { get; init; }

	public required IReadOnlyList<FrameVariable> Variables { get; init; }

	public IMethodSymbol? Method { get; init; }

	/// <summary>The frame's type parameters and the types they are instantiated with.</summary>
	public IReadOnlyList<(ITypeParameterSymbol Parameter, ITypeSymbol Argument)> TypeVariables { get; init; } = [];

	public string ModulePath { get; init; } = string.Empty;

	public int MethodToken { get; init; }

	public int IlOffset { get; init; }

	/// <summary>The raw facts of a frame, read on the COM thread before anything is decompiled.</summary>
	internal sealed record RawFrame(ModuleTable.ModuleEntry? Module, int MethodToken, int IlOffset, int ArgumentCount, int LocalCount, IReadOnlyList<ITypeSymbol> ClassArguments, IReadOnlyList<ITypeSymbol> MethodArguments, string? Error);

	public static readonly FrameContext Empty = new() { Shape = new EvalContextShape(), Variables = [] };

	/// <summary>
	/// Builds the context of a frame. <paramref name="names"/> are the decompiler's names for the slots, which
	/// win over everything metadata knows; a slot without one is compiler generated.
	/// </summary>
	public static FrameContext Build(DebuggeeTypeSystem types, RawFrame raw, IReadOnlyList<dnSpy.Backend.Contracts.DebugVariableNameDto> names, bool rawLocals, IReadOnlyList<ContextVariable> aliases) {
		if (raw.Module is null || raw.MethodToken == 0)
			return new FrameContext { Shape = new EvalContextShape { Aliases = aliases, CacheKey = "none" }, Variables = [] };
		var definition = types.GetMember(raw.Module, raw.MethodToken) as IMethodSymbol;
		if (definition is null)
			return new FrameContext { Shape = new EvalContextShape { Aliases = aliases, CacheKey = "nomethod" }, Variables = [] };
		var declaringType = definition.ContainingType;
		INamedTypeSymbol instantiatedType = declaringType;
		var typeParameterCount = DebuggeeTypeSystem.AllTypeArguments(declaringType).Count;
		if (typeParameterCount > 0 && raw.ClassArguments.Count == typeParameterCount)
			instantiatedType = DebuggeeTypeSystem.Construct(declaringType, raw.ClassArguments);
		var method = ReferenceEquals(instantiatedType, declaringType)
			? definition
			: instantiatedType.GetMembers(definition.Name).OfType<IMethodSymbol>().FirstOrDefault(candidate => SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, definition)) ?? definition;
		if (method.IsGenericMethod && raw.MethodArguments.Count == method.Arity)
			method = method.Construct(raw.MethodArguments.ToArray());

		var signatureContext = new SignatureContext(raw.ClassArguments, raw.MethodArguments);
		var localTypes = DecodeLocals(types, raw.Module, raw.MethodToken, signatureContext);
		var argumentNames = names.Where(name => name.IsArgument).GroupBy(name => name.Index).ToDictionary(group => group.Key, group => group.First());
		var localNames = names.Where(name => !name.IsArgument).GroupBy(name => name.Index).ToDictionary(group => group.Key, group => group.First());

		var variables = new List<FrameVariable>();
		var hasThis = !method.IsStatic;
		ITypeSymbol? thisType = null;
		VariableSource? thisSource = null;
		INamedTypeSymbol? contextType = instantiatedType;
		var generated = IsCompilerGenerated(declaringType);

		if (hasThis && !(generated && !rawLocals)) {
			thisType = instantiatedType;
			thisSource = new VariableSource.Argument(0);
			variables.Add(new FrameVariable("this", thisSource, thisType, FrameVariableKind.This, false));
		}
		for (var index = 0; index < method.Parameters.Length; index++) {
			var slot = index + (hasThis ? 1 : 0);
			var parameter = method.Parameters[index];
			var name = !rawLocals && argumentNames.TryGetValue(slot, out var known) ? known.Name : parameter.Name;
			if (string.IsNullOrEmpty(name))
				name = "A_" + slot.ToString(System.Globalization.CultureInfo.InvariantCulture);
			variables.Add(new FrameVariable(name, new VariableSource.Argument(slot), parameter.Type, FrameVariableKind.Parameter, false));
		}
		if (generated && hasThis && !rawLocals) {
			// The frame's own this is the closure or the state machine; what the user sees are its fields.
			foreach (var field in instantiatedType.GetMembers().OfType<IFieldSymbol>()) {
				if (field.IsStatic)
					continue;
				if (field.Name == "<>4__this") {
					thisType = field.Type;
					thisSource = new VariableSource.HoistedField(field);
					variables.Insert(0, new FrameVariable("this", thisSource, field.Type, FrameVariableKind.This, false));
					continue;
				}
				var hoisted = HoistedLocalName(field.Name);
				if (hoisted is not null)
					variables.Add(new FrameVariable(hoisted, new VariableSource.HoistedField(field), field.Type, FrameVariableKind.Local, false));
				else if (!field.Name.Contains('<', StringComparison.Ordinal))
					variables.Add(new FrameVariable(field.Name, new VariableSource.HoistedField(field), field.Type, FrameVariableKind.Parameter, false));
			}
			contextType = OutermostUserType(declaringType);
			if (thisType is INamedTypeSymbol named)
				contextType = named;
		}
		for (var index = 0; index < raw.LocalCount; index++) {
			var type = index < localTypes.Count ? localTypes[index] : types.Compilation.GetSpecialType(SpecialType.System_Object);
			if (!rawLocals && localNames.TryGetValue(index, out var known) && !string.IsNullOrEmpty(known.Name)) {
				// A local the state machine also hoisted is the same variable; the field is what holds it.
				if (variables.Any(variable => variable.Name == known.Name))
					continue;
				variables.Add(new FrameVariable(known.Name, new VariableSource.Local(index), type, FrameVariableKind.Local, false));
			}
			else
				variables.Add(new FrameVariable("V_" + index.ToString(System.Globalization.CultureInfo.InvariantCulture), new VariableSource.Local(index), type, FrameVariableKind.Local, !rawLocals));
		}

		var typeVariables = new List<(ITypeParameterSymbol, ITypeSymbol)>();
		var allTypeParameters = new List<ITypeParameterSymbol>();
		for (var current = declaringType; current is not null; current = current.ContainingType)
			allTypeParameters.InsertRange(0, current.TypeParameters);
		for (var index = 0; index < allTypeParameters.Count && index < raw.ClassArguments.Count; index++)
			typeVariables.Add((allTypeParameters[index], raw.ClassArguments[index]));
		for (var index = 0; index < definition.TypeParameters.Length && index < raw.MethodArguments.Count; index++)
			typeVariables.Add((definition.TypeParameters[index], raw.MethodArguments[index]));

		var contextVariables = new List<ContextVariable>();
		var seen = new HashSet<string>(StringComparer.Ordinal);
		foreach (var variable in variables) {
			if (variable.Kind == FrameVariableKind.This || !seen.Add(variable.Name))
				continue;
			contextVariables.Add(new ContextVariable(variable.Name, variable.Type, variable.Source, variable.Kind == FrameVariableKind.Parameter));
		}
		var key = new System.Text.StringBuilder();
		key.Append(raw.Module.Order).Append(':').Append(raw.MethodToken).Append(':').Append(rawLocals);
		foreach (var argument in raw.ClassArguments.Concat(raw.MethodArguments))
			key.Append(':').Append(argument.ToDisplayString());
		foreach (var variable in contextVariables)
			key.Append('|').Append(variable.Name).Append('=').Append(variable.Type.ToDisplayString());
		foreach (var alias in aliases)
			key.Append('|').Append(alias.Name).Append('=').Append(alias.Type.ToDisplayString());
		return new FrameContext {
			Shape = new EvalContextShape {
				ContextType = contextType,
				ThisType = thisType,
				ThisSource = thisSource,
				Variables = contextVariables,
				Aliases = aliases,
				TypeArguments = typeVariables.Select(pair => (pair.Item1.Name, pair.Item2)).ToArray(),
				CacheKey = key.ToString(),
			},
			Variables = variables,
			Method = method,
			TypeVariables = typeVariables,
			ModulePath = raw.Module.Path,
			MethodToken = raw.MethodToken,
			IlOffset = raw.IlOffset,
		};
	}

	/// <summary>The local a compiler-generated field holds: <c>&lt;sum&gt;5__1</c> is <c>sum</c>.</summary>
	internal static string? HoistedLocalName(string fieldName) {
		if (fieldName.Length < 4 || fieldName[0] != '<')
			return null;
		var close = fieldName.IndexOf('>', StringComparison.Ordinal);
		if (close <= 1 || close + 2 >= fieldName.Length || fieldName[close + 1] != '5')
			return null;
		return fieldName[1..close];
	}

	static bool IsCompilerGenerated(INamedTypeSymbol type) {
		for (var current = type; current is not null; current = current.ContainingType) {
			if (current.Name.StartsWith('<'))
				return true;
		}
		return false;
	}

	static INamedTypeSymbol? OutermostUserType(INamedTypeSymbol type) {
		var current = type;
		while (current is not null && current.Name.StartsWith('<'))
			current = current.ContainingType;
		return current;
	}

	static IReadOnlyList<ITypeSymbol> DecodeLocals(DebuggeeTypeSystem types, ModuleTable.ModuleEntry module, int methodToken, SignatureContext context) {
		var reader = types.GetReader(module);
		if (reader is null)
			return [];
		try {
			var handle = MetadataTokens.MethodDefinitionHandle(methodToken & 0x00FFFFFF);
			var definition = reader.GetMethodDefinition(handle);
			if (definition.RelativeVirtualAddress == 0)
				return [];
			var body = GetBody(types, module, definition.RelativeVirtualAddress);
			if (body is null || body.LocalSignature.IsNil)
				return [];
			var signature = reader.GetStandaloneSignature(body.LocalSignature);
			return signature.DecodeLocalSignature(new RoslynSignatureProvider(types, module), context);
		}
		catch (Exception ex) when (ex is BadImageFormatException or InvalidOperationException or ArgumentException) {
			return [];
		}
	}

	static MethodBodyBlock? GetBody(DebuggeeTypeSystem types, ModuleTable.ModuleEntry module, int rva) => types.GetMethodBody(module, rva);
}
