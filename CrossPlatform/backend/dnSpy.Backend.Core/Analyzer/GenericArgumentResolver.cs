using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// Substitutes generic arguments into a signature — dnSpy's <c>GenericArgumentResolver</c>, which the
/// hierarchy helpers use to compare a base type's member with the derived type's in the derived type's
/// terms ("T" in <c>Base&lt;T&gt;</c> read as the "int" <c>Derived : Base&lt;int&gt;</c> passes).
/// </summary>
struct GenericArgumentResolver {
	const int MaxRecursionCount = 100;
	readonly IList<TypeSig> typeGenArgs;
	readonly IList<TypeSig> methodGenArgs;
	int recursionCounter;

	GenericArgumentResolver(IList<TypeSig>? typeGenArgs, IList<TypeSig>? methodGenArgs) {
		this.typeGenArgs = typeGenArgs ?? Array.Empty<TypeSig>();
		this.methodGenArgs = methodGenArgs ?? Array.Empty<TypeSig>();
		recursionCounter = 0;
	}

	public static TypeSig? Resolve(TypeSig? typeSig, IList<TypeSig>? typeGenArgs, IList<TypeSig>? methodGenArgs) {
		if (typeSig is null)
			return typeSig;
		if ((typeGenArgs is null || typeGenArgs.Count == 0) && (methodGenArgs is null || methodGenArgs.Count == 0))
			return typeSig;
		var resolver = new GenericArgumentResolver(typeGenArgs, methodGenArgs);
		return resolver.ResolveGenericArgs(typeSig);
	}

	public static MethodBaseSig? Resolve(MethodBaseSig? methodSig, IList<TypeSig>? typeGenArgs, IList<TypeSig>? methodGenArgs) {
		if (methodSig is null)
			return null;
		if ((typeGenArgs is null || typeGenArgs.Count == 0) && (methodGenArgs is null || methodGenArgs.Count == 0))
			return methodSig;
		var resolver = new GenericArgumentResolver(typeGenArgs, methodGenArgs);
		return resolver.ResolveGenericArgs(methodSig);
	}

	bool Increment() {
		if (recursionCounter >= MaxRecursionCount)
			return false;
		recursionCounter++;
		return true;
	}

	void Decrement() => recursionCounter--;

	readonly bool ReplaceGenericArg(ref TypeSig typeSig) {
		if (typeSig is GenericMVar genericMVar) {
			var newSig = Read(methodGenArgs, genericMVar.Number);
			if (newSig is not null) {
				typeSig = newSig;
				return true;
			}
			return false;
		}
		if (typeSig is GenericVar genericVar) {
			var newSig = Read(typeGenArgs, genericVar.Number);
			if (newSig is not null) {
				typeSig = newSig;
				return true;
			}
			return false;
		}
		return false;
	}

	static TypeSig? Read(IList<TypeSig> sigs, uint index) =>
		index < (uint)sigs.Count ? sigs[(int)index] : null;

	MethodBaseSig? ResolveGenericArgs(MethodBaseSig? sig) {
		if (sig is null)
			return null;
		if (!Increment())
			return null;
		MethodBaseSig? result = sig switch {
			MethodSig msig => ResolveGenericArgs(msig),
			PropertySig psig => ResolveGenericArgs(psig),
			_ => null,
		};
		Decrement();
		return result;
	}

	TypeSig? ResolveGenericArgs(TypeSig? typeSig) {
		if (typeSig is null)
			return null;
		if (!Increment())
			return null;
		if (ReplaceGenericArg(ref typeSig)) {
			Decrement();
			return typeSig;
		}
		TypeSig result;
		switch (typeSig.ElementType) {
		case ElementType.Ptr:
			result = new PtrSig(ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.ByRef:
			result = new ByRefSig(ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.Var:
			result = new GenericVar(((GenericVar)typeSig).Number, ((GenericVar)typeSig).OwnerType);
			break;
		case ElementType.ValueArray:
			result = new ValueArraySig(ResolveGenericArgs(typeSig.Next), ((ValueArraySig)typeSig).Size);
			break;
		case ElementType.SZArray:
			result = new SZArraySig(ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.MVar:
			result = new GenericMVar(((GenericMVar)typeSig).Number, ((GenericMVar)typeSig).OwnerMethod);
			break;
		case ElementType.CModReqd:
			result = new CModReqdSig(((ModifierSig)typeSig).Modifier, ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.CModOpt:
			result = new CModOptSig(((ModifierSig)typeSig).Modifier, ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.Module:
			result = new ModuleSig(((ModuleSig)typeSig).Index, ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.Pinned:
			result = new PinnedSig(ResolveGenericArgs(typeSig.Next));
			break;
		case ElementType.FnPtr:
			result = new FnPtrSig(ResolveGenericArgs(((FnPtrSig)typeSig).Signature));
			break;
		case ElementType.Array:
			var arraySig = (ArraySig)typeSig;
			result = new ArraySig(ResolveGenericArgs(typeSig.Next), arraySig.Rank, arraySig.Sizes, arraySig.LowerBounds);
			break;
		case ElementType.GenericInst:
			var gis = (GenericInstSig)typeSig;
			var genArgs = new List<TypeSig?>(gis.GenericArguments.Count);
			for (int i = 0; i < gis.GenericArguments.Count; i++)
				genArgs.Add(ResolveGenericArgs(gis.GenericArguments[i]));
			result = new GenericInstSig(ResolveGenericArgs(gis.GenericType) as ClassOrValueTypeSig, genArgs);
			break;
		default:
			result = typeSig;
			break;
		}
		Decrement();
		return result;
	}

	CallingConventionSig? ResolveGenericArgs(CallingConventionSig sig) {
		if (!Increment())
			return null;
		CallingConventionSig? result = sig switch {
			MethodSig msig => ResolveGenericArgs(msig),
			FieldSig fsig => new FieldSig(ResolveGenericArgs(fsig.Type)),
			LocalSig lsig => ResolveGenericArgs(lsig),
			PropertySig psig => ResolveGenericArgs(psig),
			GenericInstMethodSig gsig => ResolveGenericArgs(gsig),
			_ => null,
		};
		Decrement();
		return result;
	}

	MethodSig ResolveGenericArgs(MethodSig sig) {
		var msig = ResolveGenericArgs2(new MethodSig(sig.CallingConvention), sig);
		msig.OriginalToken = sig.OriginalToken;
		return msig;
	}

	PropertySig ResolveGenericArgs(PropertySig sig) => ResolveGenericArgs2(new PropertySig(), sig);

	T ResolveGenericArgs2<T>(T outSig, T inSig) where T : MethodBaseSig {
		outSig.RetType = ResolveGenericArgs(inSig.RetType);
		outSig.GenParamCount = inSig.GenParamCount;
		UpdateSigList(outSig.Params, inSig.Params);
		if (inSig.ParamsAfterSentinel is not null) {
			outSig.ParamsAfterSentinel = new List<TypeSig>(inSig.ParamsAfterSentinel.Count);
			UpdateSigList(outSig.ParamsAfterSentinel, inSig.ParamsAfterSentinel);
		}
		return outSig;
	}

	void UpdateSigList(IList<TypeSig?> outList, IList<TypeSig> inList) {
		for (int i = 0; i < inList.Count; i++)
			outList.Add(ResolveGenericArgs(inList[i]));
	}

	LocalSig ResolveGenericArgs(LocalSig sig) {
		var lsig = new LocalSig();
		UpdateSigList(lsig.Locals, sig.Locals);
		return lsig;
	}

	GenericInstMethodSig ResolveGenericArgs(GenericInstMethodSig sig) {
		var gsig = new GenericInstMethodSig();
		UpdateSigList(gsig.GenericArguments, sig.GenericArguments);
		return gsig;
	}
}
