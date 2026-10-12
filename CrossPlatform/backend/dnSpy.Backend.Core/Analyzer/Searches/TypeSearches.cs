using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer.Searches;

/// <summary>
/// "Applied To": what the analyzed attribute class is applied to — assemblies, modules, types, members,
/// generic parameters, parameters and return values, as far as its [AttributeUsage] allows. It works out
/// its own module list rather than the member scope: every module that references the attribute type,
/// each searched for the reference that module has to it.
/// </summary>
sealed class AttributeAppliedToSearch : AnalyzerSearch {
	readonly TypeDef analyzedType;
	readonly AttributeTargets usage;
	readonly HashSet<MethodDef> foundMethods = [];
	readonly HashSet<AssemblyDef> checkedAsms = [];

	public AttributeAppliedToSearch(IAnalyzerHost host, TypeDef analyzedType) : base(host) {
		this.analyzedType = analyzedType;
		var ca = analyzedType.CustomAttributes.Find("System.AttributeUsageAttribute");
		usage = ca is not null && ca.ConstructorArguments.Count == 1 && ca.ConstructorArguments[0].Value is int targets
			? (AttributeTargets)targets
			: AttributeTargets.All;
	}

	public static bool CanShow(TypeDef type, IAnalyzerHost host) => type.IsClass && IsCustomAttribute(type, host);

	static bool IsCustomAttribute(TypeDef type, IAnalyzerHost host) {
		while (type is not null) {
			// The name is read off the reference before it is resolved, so an attribute class is known for
			// one without the core library that defines System.Attribute.
			if (type.BaseType?.FullName == "System.Attribute")
				return true;
			var bt = host.ResolveTypeDef(type.BaseType);
			if (bt is null)
				return false;
			if (bt.FullName == "System.Attribute")
				return true;
			type = bt;
		}
		return false;
	}

	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) {
		IEnumerable<(ModuleDef module, ITypeDefOrRef type)> modules;
		if (CustomAttributesUtils.IsPseudoCustomAttributeType(analyzedType, Host))
			modules = GetAllModules();
		else if (IsPublic(analyzedType))
			modules = GetReferencingModules(analyzedType.Module, cancellationToken);
		else
			modules = GetModuleAndAnyFriends(analyzedType.Module, cancellationToken);
		return modules.Select(a => AnalyzerScanUnit.ForModule(a.module, a.type)).ToList();
	}

	static bool IsPublic(TypeDef type) {
		for (;;) {
			if (type.DeclaringType is TypeDef declType) {
				if (!(type.IsNestedFamily || type.IsNestedFamilyOrAssembly || type.IsNestedPublic))
					return false;
				type = declType;
			}
			else
				return type.IsPublic;
		}
	}

	public override void BeginUnit(AnalyzerScanUnit unit, List<AnalyzerHit> hits) {
		var trScopeType = ((ITypeDefOrRef)unit.State!).GetScopeType();
		var module = unit.Module;
		if ((usage & AttributeTargets.Assembly) != 0) {
			var asm = module.Assembly;
			if (asm is not null && checkedAsms.Add(asm)) {
				foreach (var attribute in asm.GetCustomAttributes()) {
					if (new SigComparer().Equals(attribute.AttributeType?.GetScopeType(), trScopeType)) {
						hits.Add(new AnalyzerHit(asm));
						break;
					}
				}
			}
		}
		if ((usage & AttributeTargets.Module) != 0) {
			foreach (var attribute in module.GetCustomAttributes()) {
				if (new SigComparer().Equals(attribute.AttributeType?.GetScopeType(), trScopeType)) {
					hits.Add(new AnalyzerHit(module));
					break;
				}
			}
		}
	}

	public override IReadOnlyList<AnalyzerHit> Collect(TypeDef type, AnalyzerScanUnit unit) {
		const AttributeTargets memberTargets = AttributeTargets.Class | AttributeTargets.Enum | AttributeTargets.Interface | AttributeTargets.Struct | AttributeTargets.GenericParameter | AttributeTargets.Field | AttributeTargets.Property | AttributeTargets.Event | AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.ReturnValue | AttributeTargets.Parameter;
		return (usage & memberTargets) != 0 ? FindReferencesWithinInType(type, (ITypeDefOrRef)unit.State!).ToList() : [];
	}

	/// <summary>A method is listed once: the user method a lambda's attribute is shown as may hold several.</summary>
	public override bool Accept(AnalyzerHit hit) => hit.Entity is not MethodDef method || foundMethods.Add(method);

	IEnumerable<AnalyzerHit> FindReferencesWithinInType(TypeDef type, ITypeDefOrRef attrTypeRef) {
		var attrTypeRefScopeType = attrTypeRef.GetScopeType();
		bool Matches(CustomAttribute attribute) => new SigComparer().Equals(attribute.AttributeType?.GetScopeType(), attrTypeRefScopeType);

		var searchRequired = (type.IsClass && usage.HasFlag(AttributeTargets.Class))
			|| (type.IsEnum && usage.HasFlag(AttributeTargets.Enum))
			|| (type.IsInterface && usage.HasFlag(AttributeTargets.Interface))
			|| (type.IsValueType && usage.HasFlag(AttributeTargets.Struct));
		if (searchRequired && type.GetCustomAttributes().Any(Matches))
			yield return new AnalyzerHit(type);

		if ((usage & AttributeTargets.GenericParameter) != 0 && type.HasGenericParameters) {
			foreach (var parameter in type.GenericParameters) {
				if (parameter.GetCustomAttributes().Any(Matches))
					yield return new AnalyzerHit(type);
			}
		}

		if ((usage & AttributeTargets.Field) != 0 && type.HasFields) {
			foreach (var field in type.Fields) {
				if (field.GetCustomAttributes().Any(Matches))
					yield return new AnalyzerHit(field);
			}
		}

		if ((usage & AttributeTargets.Property) != 0 && type.HasProperties) {
			foreach (var property in type.Properties) {
				if (property.GetCustomAttributes().Any(Matches))
					yield return new AnalyzerHit(property);
			}
		}

		if ((usage & AttributeTargets.Event) != 0 && type.HasEvents) {
			foreach (var @event in type.Events) {
				if (@event.GetCustomAttributes().Any(Matches))
					yield return new AnalyzerHit(@event);
			}
		}

		if ((usage & (AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.ReturnValue | AttributeTargets.Parameter)) != 0 && type.HasMethods) {
			foreach (var method in type.Methods) {
				var found = false;
				if ((usage & (AttributeTargets.Method | AttributeTargets.Constructor)) != 0)
					found = method.GetCustomAttributes().Any(Matches);
				if (!found && (usage & AttributeTargets.ReturnValue) != 0 && method.Parameters.ReturnParameter.ParamDef is ParamDef retParamDef)
					found = retParamDef.GetCustomAttributes().Any(Matches);
				if (!found && (usage & AttributeTargets.Parameter) != 0 && method.Parameters.Count > 0) {
					foreach (var parameter in method.Parameters.Where(param => param.HasParamDef)) {
						if (parameter.IsHiddenThisParameter)
							continue;
						if (parameter.ParamDef.GetCustomAttributes().Any(Matches)) {
							found = true;
							break;
						}
					}
				}
				if (found)
					yield return new AnalyzerHit(GetOriginalCodeLocation(method));
			}
		}
	}

	IEnumerable<(ModuleDef module, ITypeDefOrRef type)> GetAllModules() {
		foreach (var module in Host.Documents)
			yield return (module, GetScopeTypeRefInModule(module) ?? module.Import(analyzedType));
	}

	IEnumerable<(ModuleDef module, ITypeDefOrRef type)> GetReferencingModules(ModuleDef mod, CancellationToken cancellationToken) {
		var asm = mod.Assembly;
		if (asm is null) {
			yield return (mod, analyzedType);
			yield break;
		}

		foreach (var m in asm.Modules)
			yield return (m, analyzedType);

		foreach (var module in Host.Documents.Where(a => AnalyzerHelpers.CanIncludeModule(mod, a))) {
			cancellationToken.ThrowIfCancellationRequested();
			var typeref = GetScopeTypeRefInModule(module);
			if (typeref is not null)
				yield return (module, typeref);
		}
	}

	IEnumerable<(ModuleDef module, ITypeDefOrRef type)> GetModuleAndAnyFriends(ModuleDef mod, CancellationToken cancellationToken) {
		var asm = mod.Assembly;
		if (asm is null) {
			yield return (mod, analyzedType);
			yield break;
		}

		foreach (var m in asm.Modules)
			yield return (m, analyzedType);

		var friendAssemblies = AnalyzerHelpers.GetFriendAssemblies(Host, mod, out var modules);
		if (friendAssemblies.Count > 0) {
			foreach (var module in modules) {
				cancellationToken.ThrowIfCancellationRequested();
				if (module.Assembly is null || friendAssemblies.Contains(module.Assembly.Name)) {
					var typeref = GetScopeTypeRefInModule(module);
					if (typeref is not null)
						yield return (module, typeref);
				}
			}
		}
	}

	ITypeDefOrRef? GetScopeTypeRefInModule(ModuleDef mod) {
		foreach (var typeref in mod.GetTypeRefs()) {
			if (new SigComparer().Equals(analyzedType, typeref))
				return typeref;
		}
		return null;
	}
}

/// <summary>"Instantiated By": the methods that construct the analyzed type, chained constructors aside.</summary>
sealed class TypeInstantiationsSearch(IAnalyzerHost host, TypeDef analyzedType) : ScopedSearch(host) {
	readonly bool isSystemObject = analyzedType.DefinitionAssembly.IsCorLib() && analyzedType.FullName == "System.Object";

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedType);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;

			// ignore chained constructors
			// (since object is the root of everything, we can short circuit the test in this case)
			if (method.Name == ".ctor" &&
				(isSystemObject || new SigComparer().Equals(analyzedType, type) || TypesHierarchyHelpers.IsBaseType(Host, analyzedType, type, false)))
				continue;

			foreach (var instr in method.Body.Instructions) {
				if (instr.Operand is IMethod mr && !mr.IsField && mr.Name == ".ctor" && AnalyzerHelpers.IsReferencedBy(analyzedType, mr.DeclaringType)) {
					yield return new AnalyzerHit(method, new AnalyzerSourceRef(method, instr.Offset, instr.Operand as IMDTokenProvider));
					break;
				}
			}
		}
	}

	public static bool CanShow(TypeDef type) => type.IsClass && !type.IsAbstract && !type.IsEnum;
}

/// <summary>
/// "Used By" for a type: every type, member and method body that names it — in a signature, a base type
/// or interface, an attribute, an instruction, a local or a catch clause — and the assemblies and modules
/// whose attributes or forwarders name it.
/// </summary>
sealed class TypeUsedBySearch(IAnalyzerHost host, TypeDef analyzedType) : ScopedSearch(host) {
	const int MaxRecursion = 20;

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() {
		var includeAllModules = CustomAttributesUtils.IsPseudoCustomAttributeType(analyzedType, Host) ||
			CustomAttributesUtils.IsPseudoCustomAttributeOtherType(analyzedType);
		return new ScopedWhereUsedAnalyzer(Host, analyzedType, includeAllModules ? ScopedWhereUsedAnalyzerOptions.IncludeAllModules : ScopedWhereUsedAnalyzerOptions.None);
	}

	readonly HashSet<IMemberRef> seen = [];

	// The analyzed type's own members are not uses of it, and a member found twice — a property through
	// both its getter and its setter — is listed once, with the place it was found first.
	public override bool Accept(AnalyzerHit hit) => hit.Member!.DeclaringType != analyzedType && seen.Add(hit.Member);

	public override void Finish(List<AnalyzerHit> hits) => hits.AddRange(FindGlobalUsage());

	IEnumerable<AnalyzerHit> FindGlobalUsage() {
		var analyzedAssemblies = new HashSet<AssemblyDef>();
		foreach (var module in AllModules) {
			var analyzedTypeIsExported = false;
			foreach (var et in module.ExportedTypes) {
				if (et.MovedToAnotherAssembly && et.Name == analyzedType.Name && et.Namespace == analyzedType.Namespace && Host.ResolveTypeDef(et.ToTypeRef()) == analyzedType) {
					analyzedTypeIsExported = true;
					break;
				}
			}
			if (module.Assembly is AssemblyDef asm && analyzedAssemblies.Add(asm)) {
				if (analyzedTypeIsExported || IsUsedInCustomAttributes(asm))
					yield return new AnalyzerHit(asm);
			}
			if (IsUsedInCustomAttributes(module))
				yield return new AnalyzerHit(module);
		}
	}

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (new SigComparer().Equals(type, analyzedType))
			yield break;

		if (IsUsedInTypeDef(type))
			yield return new AnalyzerHit(type);

		foreach (var field in type.Fields.Where(IsUsedInFieldDef))
			yield return new AnalyzerHit(field);

		foreach (var method in type.Methods) {
			AnalyzerSourceRef? sourceRef = null;
			if (IsUsedInMethodDef(method, ref sourceRef))
				yield return HandleSpecialMethodNode(method, sourceRef);
		}

		foreach (var property in type.Properties) {
			if (IsUsedInCustomAttributes(property))
				yield return new AnalyzerHit(property);
		}

		foreach (var @event in type.Events) {
			if (IsUsedInCustomAttributes(@event))
				yield return new AnalyzerHit(@event);
		}
	}

	/// <summary>An accessor is listed as the property or event it belongs to.</summary>
	static AnalyzerHit HandleSpecialMethodNode(MethodDef method, AnalyzerSourceRef? sourceRef) {
		var property = method.DeclaringType.Properties.FirstOrDefault(p => (object?)p.GetMethod == method || (object?)p.SetMethod == method);
		if (property is not null)
			return new AnalyzerHit(property, sourceRef);
		var @event = method.DeclaringType.Events.FirstOrDefault(p => (object?)p.AddMethod == method || (object?)p.RemoveMethod == method || (object?)p.InvokeMethod == method);
		if (@event is not null)
			return new AnalyzerHit(@event, sourceRef);
		return new AnalyzerHit(method, sourceRef);
	}

	bool IsUsedInTypeRefs(IEnumerable<ITypeDefOrRef> types) => types.Any(IsUsedInTypeRef);

	bool IsUsedInTypeRef(ITypeDefOrRef? type) {
		if (type is null)
			return false;
		return TypeMatches(type.DeclaringType) || TypeMatches(type);
	}

	bool IsUsedInTypeDef(TypeDef? type) {
		if (type is null)
			return false;
		return IsUsedInTypeRef(type)
			|| TypeMatches(type.BaseType)
			|| IsUsedInTypeRefs(type.Interfaces.Select(ii => ii.Interface))
			|| IsUsedInCustomAttributes(type);
	}

	bool IsUsedInCustomAttributes(IHasCustomAttribute? hca) {
		if (hca is null)
			return false;
		foreach (var ca in hca.GetCustomAttributes()) {
			if (IsUsedInMethodRef(ca.Constructor))
				return true;
			foreach (var arg in ca.ConstructorArguments) {
				if (IsUsed(arg, 0))
					return true;
			}
			foreach (var arg in ca.NamedArguments) {
				if (IsUsed(arg.Argument, 0))
					return true;
				if (TypeMatches(arg.Type))
					return true;
			}
		}
		return false;
	}

	bool IsUsed(CAArgument arg, int recursionCounter) {
		if (recursionCounter > MaxRecursion)
			return false;
		if (TypeMatches(arg.Type))
			return true;
		return ValueMatches(arg.Value, recursionCounter + 1);
	}

	bool ValueMatches(object? value, int recursionCounter) {
		if (recursionCounter > MaxRecursion)
			return false;
		return value switch {
			TypeSig ts => TypeMatches(ts),
			CAArgument arg => IsUsed(arg, recursionCounter + 1),
			IList<CAArgument> args => args.Any(a => IsUsed(a, recursionCounter + 1)),
			_ => false,
		};
	}

	bool IsUsedInFieldDef(FieldDef field) => IsUsedInFieldRef(field) || IsUsedInCustomAttributes(field);

	bool IsUsedInFieldRef(IField? field) {
		if (field is null || !field.IsField)
			return false;
		return TypeMatches(field.DeclaringType) || TypeMatches(field.FieldSig.GetFieldType());
	}

	bool IsUsedInMethodRef(IMethod? method) {
		if (method is null || !method.IsMethod)
			return false;
		if (method is MethodSpec ms && ms.Instantiation is GenericInstMethodSig gims) {
			foreach (var ga in gims.GenericArguments) {
				if (TypeMatches(ga))
					return true;
			}
		}
		return TypeMatches(method.DeclaringType)
			|| TypeMatches(method.MethodSig.GetRetType())
			|| IsUsedInMethodParameters(method.GetParameters());
	}

	bool IsUsedInMethodDef(MethodDef method, ref AnalyzerSourceRef? sourceRef) {
		if (IsUsedInMethodRef(method) || IsUsedInMethodBody(method, ref sourceRef) || IsUsedInCustomAttributes(method))
			return true;
		foreach (var pd in method.ParamDefs) {
			if (IsUsedInCustomAttributes(pd))
				return true;
		}
		return false;
	}

	bool IsUsedInMethodBody(MethodDef? method, ref AnalyzerSourceRef? sourceRef) {
		if (method?.Body is null)
			return false;
		foreach (var instruction in method.Body.Instructions) {
			if (IsUsedInTypeRef(instruction.Operand as ITypeDefOrRef)
				|| IsUsedInFieldRef(instruction.Operand as IField)
				|| IsUsedInMethodRef(instruction.Operand as IMethod)) {
				sourceRef = new AnalyzerSourceRef(method, instruction.Offset, instruction.Operand as IMDTokenProvider);
				return true;
			}
		}
		foreach (var local in method.Body.Variables) {
			if (TypeMatches(local.Type)) {
				sourceRef = new AnalyzerSourceRef(method, null, null);
				return true;
			}
		}
		foreach (var eh in method.Body.ExceptionHandlers) {
			if (TypeMatches(eh.CatchType)) {
				sourceRef = new AnalyzerSourceRef(method, null, null);
				return true;
			}
		}
		return false;
	}

	bool IsUsedInMethodParameters(IEnumerable<Parameter> parameters) => parameters.Any(IsUsedInMethodParameter);

	bool IsUsedInMethodParameter(Parameter parameter) => !parameter.IsHiddenThisParameter && TypeMatches(parameter.Type);

	bool TypeMatches(IType? tref) => TypeMatches(tref, 0);

	bool TypeMatches(IType? tref, int level) {
		if (level >= 100)
			return false;
		if (tref is null)
			return false;
		if (new SigComparer().Equals(analyzedType, tref.GetScopeType()))
			return true;
		if (tref is TypeSig ts) {
			switch (ts) {
			case TypeDefOrRefSig tdr:
				return TypeMatches(tdr.TypeDefOrRef, level + 1);
			case FnPtrSig fnptr:
				if (fnptr.MethodSig is MethodSig msig) {
					if (TypeMatches(msig.RetType, level + 1))
						return true;
					if (msig.Params.Any(p => TypeMatches(p, level + 1)))
						return true;
					if (msig.ParamsAfterSentinel is not null && msig.ParamsAfterSentinel.Any(p => TypeMatches(p, level + 1)))
						return true;
				}
				return false;
			case GenericInstSig gis:
				return TypeMatches(gis.GenericType, level + 1) || gis.GenericArguments.Any(ga => TypeMatches(ga, level + 1));
			case PtrSig ps:
				return TypeMatches(ps.Next, level + 1);
			case ByRefSig brs:
				return TypeMatches(brs.Next, level + 1);
			case ArraySigBase asb:
				return TypeMatches(asb.Next, level + 1);
			case ModifierSig ms:
				return TypeMatches(ms.Modifier, level + 1) || TypeMatches(ms.Next, level + 1);
			case PinnedSig ps:
				return TypeMatches(ps.Next, level + 1);
			}
		}
		else if (tref is TypeSpec typeSpec)
			return TypeMatches(typeSpec.TypeSig, level + 1);
		return false;
	}

	public static bool CanShow(TypeDef? type) => type is not null;
}

/// <summary>"Exposed By": the non-private members whose signatures hand out the analyzed type.</summary>
sealed class TypeExposedBySearch(IAnalyzerHost host, TypeDef analyzedType) : ScopedSearch(host) {
	const int MaxRecursion = 20;

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedType);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (analyzedType.IsEnum && new SigComparer().Equals(type, analyzedType))
			yield break;

		foreach (var field in type.Fields) {
			if (TypeIsExposedBy(field))
				yield return new AnalyzerHit(field);
		}

		foreach (var property in type.Properties) {
			if (TypeIsExposedBy(property))
				yield return new AnalyzerHit(property);
		}

		foreach (var eventDef in type.Events) {
			if (TypeIsExposedBy(eventDef))
				yield return new AnalyzerHit(eventDef);
		}

		foreach (var method in type.Methods) {
			if (TypeIsExposedBy(method))
				yield return new AnalyzerHit(method);
		}
	}

	bool CheckType(IType? type) => CheckType(type, 0);

	bool CheckType(IType? type, int recursionCounter) {
		if (recursionCounter > MaxRecursion)
			return false;
		if (type is TypeSig ts)
			return CheckType(ts, recursionCounter + 1);
		if (type is TypeSpec typeSpec)
			return CheckType(typeSpec.TypeSig, recursionCounter + 1);
		return new SigComparer().Equals(analyzedType, type);
	}

	bool CheckType(TypeSig? sig, int recursionCounter) {
		if (recursionCounter > MaxRecursion)
			return false;
		if (sig is null)
			return false;
		var corLibTypes = analyzedType.Module.CorLibTypes;
		switch (sig.ElementType) {
		case ElementType.Void: return new SigComparer().Equals(analyzedType, corLibTypes.Void);
		case ElementType.Boolean: return new SigComparer().Equals(analyzedType, corLibTypes.Boolean);
		case ElementType.Char: return new SigComparer().Equals(analyzedType, corLibTypes.Char);
		case ElementType.I1: return new SigComparer().Equals(analyzedType, corLibTypes.SByte);
		case ElementType.U1: return new SigComparer().Equals(analyzedType, corLibTypes.Byte);
		case ElementType.I2: return new SigComparer().Equals(analyzedType, corLibTypes.Int16);
		case ElementType.U2: return new SigComparer().Equals(analyzedType, corLibTypes.UInt16);
		case ElementType.I4: return new SigComparer().Equals(analyzedType, corLibTypes.Int32);
		case ElementType.U4: return new SigComparer().Equals(analyzedType, corLibTypes.UInt32);
		case ElementType.I8: return new SigComparer().Equals(analyzedType, corLibTypes.Int64);
		case ElementType.U8: return new SigComparer().Equals(analyzedType, corLibTypes.UInt64);
		case ElementType.R4: return new SigComparer().Equals(analyzedType, corLibTypes.Single);
		case ElementType.R8: return new SigComparer().Equals(analyzedType, corLibTypes.Double);
		case ElementType.String: return new SigComparer().Equals(analyzedType, corLibTypes.String);
		case ElementType.TypedByRef: return new SigComparer().Equals(analyzedType, corLibTypes.TypedReference);
		case ElementType.I: return new SigComparer().Equals(analyzedType, corLibTypes.IntPtr);
		case ElementType.U: return new SigComparer().Equals(analyzedType, corLibTypes.UIntPtr);
		case ElementType.Object: return new SigComparer().Equals(analyzedType, corLibTypes.Object);

		case ElementType.Ptr:
		case ElementType.ByRef:
		case ElementType.Array:
		case ElementType.SZArray:
		case ElementType.ValueArray:
		case ElementType.Module:
		case ElementType.Pinned:
			return CheckType(sig.Next, recursionCounter + 1);

		case ElementType.CModReqd:
		case ElementType.CModOpt:
			return CheckType(((ModifierSig)sig).Modifier, recursionCounter + 1) || CheckType(sig.Next, recursionCounter + 1);

		case ElementType.ValueType:
		case ElementType.Class:
			return CheckType(((TypeDefOrRefSig)sig).TypeDefOrRef, recursionCounter + 1);

		case ElementType.GenericInst:
			var gis = (GenericInstSig)sig;
			if (CheckType(gis.GenericType?.TypeDefOrRef, recursionCounter + 1))
				return true;
			return gis.GenericArguments.Any(genericArg => CheckType(genericArg, recursionCounter + 1));

		case ElementType.FnPtr:
			return TypeIsExposedBy(((FnPtrSig)sig).MethodSig, recursionCounter + 1);

		default:
			return false;
		}
	}

	bool TypeIsExposedBy(FieldDef field) => !field.IsPrivate && CheckType(field.FieldType);

	bool TypeIsExposedBy(PropertyDef property) => !IsPrivate(property) && TypeIsExposedBy(property.PropertySig, 0);

	bool TypeIsExposedBy(EventDef eventDef) => !IsPrivate(eventDef) && CheckType(eventDef.EventType);

	bool TypeIsExposedBy(MethodDef method) {
		// if the method has overrides, it is probably an explicit interface member
		// and should be considered part of the public API even though it is marked private.
		if (method.IsPrivate) {
			if (!method.HasOverrides)
				return false;
			var methDecl = method.Overrides[0].MethodDeclaration;
			var typeDef = Host.ResolveTypeDef(methDecl?.DeclaringType);
			if (typeDef is not null && !typeDef.IsInterface)
				return false;
		}

		// exclude methods with 'semantics'. for example, property getters & setters.
		// HACK: this is a potentially fragile implementation, as the MethodSemantics may be extended to other uses at a later date.
		if (method.SemanticsAttributes != MethodSemanticsAttributes.None)
			return false;

		return TypeIsExposedBy(method.MethodSig, 0);
	}

	bool TypeIsExposedBy(MethodBaseSig? methodSig, int recursionCounter) {
		if (recursionCounter > MaxRecursion)
			return false;
		if (methodSig is null)
			return false;
		if (CheckType(methodSig.RetType))
			return true;
		return methodSig.Params.Any(type => CheckType(type));
	}

	static bool IsPrivate(PropertyDef property) {
		var isGetterPublic = property.GetMethod is not null && !property.GetMethod.IsPrivate;
		var isSetterPublic = property.SetMethod is not null && !property.SetMethod.IsPrivate;
		return !(isGetterPublic || isSetterPublic);
	}

	static bool IsPrivate(EventDef eventDef) {
		var isAdderPublic = eventDef.AddMethod is not null && !eventDef.AddMethod.IsPrivate;
		var isRemoverPublic = eventDef.RemoveMethod is not null && !eventDef.RemoveMethod.IsPrivate;
		var isInvokerPublic = eventDef.InvokeMethod is not null && !eventDef.InvokeMethod.IsPrivate;
		return !(isAdderPublic || isRemoverPublic || isInvokerPublic);
	}

	public static bool CanShow(TypeDef type) => !(type.IsAbstract && type.IsSealed);
}

/// <summary>"Subtypes": every class that derives from the analyzed class, directly or not, or every type
/// that implements the analyzed interface somewhere in its hierarchy.</summary>
sealed class SubtypesSearch(IAnalyzerHost host, TypeDef analyzedType) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedType);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		var currentType = type;
		if (analyzedType.IsInterface) {
			while (currentType is not null) {
				foreach (var iface in currentType.Interfaces) {
					if (IsEqual(iface.Interface)) {
						yield return new AnalyzerHit(type);
						break;
					}
				}
				currentType = Host.ResolveTypeDef(currentType.BaseType);
			}
			yield break;
		}

		if (!type.IsClass)
			yield break;

		while (currentType is not null) {
			if (IsEqual(currentType.BaseType))
				yield return new AnalyzerHit(type);
			currentType = Host.ResolveTypeDef(currentType.BaseType);
		}
	}

	bool IsEqual(ITypeDefOrRef? itm) => CheckEquals(analyzedType, itm.GetScopeType());

	public static bool CanShow(TypeDef type) => !type.IsSealed && !type.IsValueType;
}

/// <summary>"Extension Methods": the extension methods whose first parameter is the analyzed type.</summary>
sealed class TypeExtensionMethodsSearch(IAnalyzerHost host, TypeDef analyzedType) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedType);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (!HasExtensionAttribute(type))
			yield break;
		foreach (var method in type.Methods) {
			if (method.IsStatic && HasExtensionAttribute(method)) {
				var skip = GetParametersSkip(method.Parameters);
				if (method.Parameters.Count <= skip)
					continue;
				var paramType = method.Parameters[skip].Type?.GetScopeType();
				if (new SigComparer().Equals(analyzedType, paramType))
					yield return new AnalyzerHit(method);
			}
		}
	}

	static int GetParametersSkip(IList<Parameter> parameters) {
		if (parameters is null || parameters.Count == 0)
			return 0;
		return parameters[0].IsHiddenThisParameter ? 1 : 0;
	}

	static bool HasExtensionAttribute(IHasCustomAttribute p) => p.CustomAttributes.Find("System.Runtime.CompilerServices.ExtensionAttribute") is not null;

	// show on all types except static classes
	public static bool CanShow(TypeDef type) => !(type.IsAbstract && type.IsSealed);
}
