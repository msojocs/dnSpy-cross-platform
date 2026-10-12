using dnlib.DotNet;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// What the search leaves out when "Search compiler generated members" is off: dnSpy's
/// <c>!decompiler.ShowMember(member)</c>, the C# decompiler's MemberIsHidden with its default settings — the
/// lambdas and their closure classes, the iterator and async state machines, the backing fields of
/// properties and events, and the compiler's private implementation details. Accessors are members dnSpy
/// shows, so they are never left out.
/// </summary>
static class CompilerGeneratedMembers {
	const string CompilerGeneratedAttribute = "System.Runtime.CompilerServices.CompilerGeneratedAttribute";
	const string PrivateImplementationDetails = "<PrivateImplementationDetails>";

	public static bool IsHidden(IMemberDef member) => member switch {
		MethodDef method => IsHidden(method),
		TypeDef type => IsHidden(type),
		FieldDef field => IsHidden(field),
		_ => false,
	};

	static bool IsHidden(MethodDef method) {
		if (method.IsGetter || method.IsSetter || method.IsAddOn || method.IsRemoveOn)
			return false;
		if (method.SemanticsAttributes is not (MethodSemanticsAttributes.None or MethodSemanticsAttributes.Other))
			return true;
		var name = method.Name.String;
		if (name == ".ctor" && method.RVA == 0 && method.DeclaringType.IsImport)
			return true;
		// Lambdas, local functions and the stub an async Main is called through.
		if (IsGeneratedName(name) && IsCompilerGenerated(method))
			return true;
		return false;
	}

	static bool IsHidden(TypeDef type) {
		var name = type.Name.String;
		if (type.DeclaringType is not null) {
			if (!IsCompilerGenerated(type))
				return false;
			// Closures — reference and value type display classes — and the state machines the
			// compiler writes for iterators and async methods.
			if (name.Contains("DisplayClass", StringComparison.Ordinal) || name.Contains("AnonStorey", StringComparison.Ordinal) || name.StartsWith("<>c", StringComparison.Ordinal))
				return true;
			if (IsGeneratedName(name) && (Implements(type, "System.Collections.IEnumerator") || Implements(type, "System.Runtime.CompilerServices.IAsyncStateMachine")
				|| Implements(type, "System.Collections.Generic.IAsyncEnumerator`1")))
				return true;
			if (IsGeneratedName(name) && name.Contains("__FixedBuffer", StringComparison.Ordinal))
				return true;
			return false;
		}
		if (name.StartsWith(PrivateImplementationDetails, StringComparison.Ordinal))
			return true;
		if (IsCompilerGenerated(type)) {
			if (name.StartsWith("<>", StringComparison.Ordinal) && name.Contains("AnonymousType", StringComparison.Ordinal))
				return true;
			if (type.IsDelegate && (name.StartsWith("<>A", StringComparison.Ordinal) || name.StartsWith("<>F", StringComparison.Ordinal)))
				return true;
		}
		return false;
	}

	static bool IsHidden(FieldDef field) {
		var name = field.Name.String;
		if (IsCompilerGenerated(field)) {
			// The delegate a lambda is cached in, a property's backing field, and a switch-on-string table.
			if (name.StartsWith("CS$<>", StringComparison.Ordinal) || name.StartsWith("<>f__am", StringComparison.Ordinal) || name.StartsWith("<>9__", StringComparison.Ordinal))
				return true;
			if (name.StartsWith('<') && name.EndsWith(">k__BackingField", StringComparison.Ordinal))
				return true;
			if (name.StartsWith("<>f__switch", StringComparison.Ordinal))
				return true;
		}
		// An event's field carries no attribute, only the event's name.
		if (field.DeclaringType is { } declaringType) {
			foreach (var @event in declaringType.Events) {
				if (@event.Name == field.Name)
					return true;
			}
			if (declaringType.Name.StartsWith(PrivateImplementationDetails, StringComparison.Ordinal))
				return true;
		}
		return false;
	}

	static bool IsGeneratedName(string name) => name.StartsWith('<') || name.Contains('$', StringComparison.Ordinal);

	static bool IsCompilerGenerated(IHasCustomAttribute member) => member.CustomAttributes.IsDefined(CompilerGeneratedAttribute);

	static bool Implements(TypeDef type, string interfaceFullName) {
		foreach (var implemented in type.Interfaces) {
			if (implemented.Interface?.ScopeType?.FullName == interfaceFullName)
				return true;
		}
		return false;
	}
}
