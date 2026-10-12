using System.Diagnostics.CodeAnalysis;
using dnlib.DotNet;
using dnlib.DotNet.Emit;

namespace dnSpy.Backend.Core.Analyzer.Searches;

/// <summary>"Read By" and "Assigned By": the methods that load the analyzed field, or store to it. Taking
/// its address counts as both, and so does a ldtoken.</summary>
sealed class FieldAccessSearch(IAnalyzerHost host, FieldDef analyzedField, bool showWrites) : BodySearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() {
		var includeAllModules = showWrites && CustomAttributesUtils.IsPseudoCustomAttributeType(analyzedField.DeclaringType, Host);
		return new ScopedWhereUsedAnalyzer(Host, analyzedField, includeAllModules ? ScopedWhereUsedAnalyzerOptions.IncludeAllModules : ScopedWhereUsedAnalyzerOptions.None);
	}

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		foreach (var method in type.Methods) {
			Instruction? foundInstr = null;
			if (method.HasBody) {
				foreach (var instr in method.Body.Instructions) {
					// The declaring type is compared before the field is resolved, which spares loading the
					// assembly of every field the method touches.
					if (CanBeReference(instr.OpCode.Code) && instr.Operand is IField fr &&
						AnalyzerHelpers.IsReferencedBy(analyzedField.DeclaringType, fr.DeclaringType) &&
						CheckEquals(Host.ResolveFieldDef(fr), analyzedField)) {
						foundInstr = instr;
						break;
					}
				}
			}
			if (foundInstr is not null)
				yield return BodyHit(method, foundInstr);
		}
		if (showWrites) {
			foreach (var hit in NamedArgumentWritesInType(type, analyzedField))
				yield return hit;
		}
	}

	public override void Finish(List<AnalyzerHit> hits) {
		if (showWrites)
			hits.AddRange(NamedArgumentWritesInModules(analyzedField));
	}

	bool CanBeReference(Code code) => code switch {
		Code.Ldfld or Code.Ldsfld => !showWrites,
		Code.Stfld or Code.Stsfld => showWrites,
		// always show address-loading
		Code.Ldflda or Code.Ldsflda or Code.Ldtoken => true,
		_ => false,
	};
}

/// <summary>
/// The attributes that set a field or a property by name — <c>[Marker(Level = 2)]</c> assigns
/// <c>MarkerAttribute.Level</c> — which dnSpy lists among a field's writers and a setter's users. Pseudo
/// attributes count: <c>[DllImport(EntryPoint = "...")]</c> assigns <c>DllImportAttribute.EntryPoint</c>.
/// </summary>
static class NamedArgumentWrites {
	public static IEnumerable<AnalyzerHit> Find(AssemblyDef asm, IMemberRef member) {
		if (TryGetCAWrite(asm, member, member.IsField, out _))
			yield return new AnalyzerHit(asm);
	}

	public static IEnumerable<AnalyzerHit> Find(ModuleDef module, IMemberRef member) {
		if (HasWrite(module, member, member.IsField))
			yield return new AnalyzerHit(module);
	}

	public static IEnumerable<AnalyzerHit> Find(TypeDef type, IMemberRef member) {
		var isField = member.IsField;
		if (HasWrite(type, member, isField))
			yield return new AnalyzerHit(type);
		foreach (var method in type.Methods) {
			if (HasWrite(method, member, isField))
				yield return new AnalyzerHit(method);
			foreach (var pd in method.ParamDefs) {
				if (HasWrite(pd, member, isField))
					yield return new AnalyzerHit(method);
			}
		}
		foreach (var field in type.Fields) {
			if (HasWrite(field, member, isField))
				yield return new AnalyzerHit(field);
		}
		foreach (var property in type.Properties) {
			if (HasWrite(property, member, isField))
				yield return new AnalyzerHit(property);
		}
		foreach (var @event in type.Events) {
			if (HasWrite(@event, member, isField))
				yield return new AnalyzerHit(@event);
		}
	}

	static bool HasWrite(IHasCustomAttribute hca, IMemberRef member, bool isField) =>
		TryGetCAWrite(hca, member, isField, out _);

	static bool TryGetCAWrite(IHasCustomAttribute hca, IMemberRef member, bool isField, [NotNullWhen(true)] out CustomAttribute? customAttribute) {
		customAttribute = null;
		TypeSig? memberType;
		if (isField)
			memberType = ((IField)member).FieldSig?.GetFieldType();
		else {
			var propSig = ((PropertyDef)member).PropertySig;
			if (propSig is null || propSig.Params.Count != 0)
				return false;
			memberType = propSig.GetRetType();
		}
		foreach (var ca in hca.GetCustomAttributes()) {
			if (!new SigComparer().Equals(ca.AttributeType.GetScopeType(), member.DeclaringType))
				continue;
			foreach (var namedArg in ca.NamedArguments) {
				if (namedArg.IsField != isField)
					continue;
				if (namedArg.Name != member.Name)
					continue;
				if (!new SigComparer().Equals(namedArg.Type, memberType))
					continue;
				customAttribute = ca;
				return true;
			}
		}
		return false;
	}
}
