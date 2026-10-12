using dnlib.DotNet;
using dnlib.DotNet.Emit;

namespace dnSpy.Backend.Core.Analyzer.Searches;

/// <summary>
/// "Raised By": the methods that raise the analyzed event. In lieu of flow analysis this is dnSpy's
/// heuristic — a method that reads the event's backing field and then calls Invoke on a delegate of the
/// event's type most likely raises it.
/// </summary>
sealed class EventFiredBySearch : BodySearch {
	readonly EventDef analyzedEvent;
	readonly FieldDef? eventBackingField;
	MethodDef? eventFiringMethod;

	public EventFiredBySearch(IAnalyzerHost host, EventDef analyzedEvent) : base(host) {
		this.analyzedEvent = analyzedEvent;
		eventBackingField = GetBackingField(analyzedEvent);
	}

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() {
		eventFiringMethod = Host.ResolveTypeDef(analyzedEvent.EventType)?.Methods.FirstOrDefault(md => md.Name == "Invoke");
		return new ScopedWhereUsedAnalyzer(Host, analyzedEvent);
	}

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		foreach (var method in type.Methods) {
			if (!method.HasBody)
				continue;
			Instruction? foundInstr = null;
			var readBackingField = false;
			foreach (var instr in method.Body.Instructions) {
				var code = instr.OpCode.Code;
				if ((code == Code.Ldfld || code == Code.Ldflda || code == Code.Ldsfld || code == Code.Ldsflda || code == Code.Ldtoken) && instr.Operand is IField fr && fr.IsField) {
					// A field of another name cannot be the backing field, and is not worth resolving.
					if (eventBackingField is not null && fr.Name == eventBackingField.Name && CheckEquals(Host.ResolveFieldDef(fr), eventBackingField))
						readBackingField = true;
				}
				else if (readBackingField && (code == Code.Callvirt || code == Code.Call)) {
					if (instr.Operand is IMethod mr && eventFiringMethod is not null && mr.Name == eventFiringMethod.Name && CheckEquals(Host.ResolveMethodDef(mr), eventFiringMethod)) {
						foundInstr = instr;
						break;
					}
				}
			}
			if (foundInstr is not null)
				yield return BodyHit(method, foundInstr);
		}
	}

	// HACK: we should probably examine add/remove methods to determine this
	static FieldDef? GetBackingField(EventDef ev) {
		var fieldName = ev.Name;
		var vbStyleFieldName = fieldName + "Event";
		var fieldType = ev.EventType;
		if (fieldType is null)
			return null;
		foreach (var fd in ev.DeclaringType.Fields) {
			if (fd.Name == fieldName || fd.Name == vbStyleFieldName)
				if (new SigComparer().Equals(fd.FieldType, fieldType))
					return fd;
		}
		return null;
	}

	public static bool CanShow(EventDef ev) => GetBackingField(ev) is not null;
}

/// <summary>"Overrides" for an event: the base event it overrides.</summary>
sealed class EventOverriddenSearch(IAnalyzerHost host, EventDef analyzedEvent) : AnalyzerSearch(host) {
	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) => [];

	public override void Finish(List<AnalyzerHit> hits) {
		var analyzedAccessor = GetVirtualAccessor(analyzedEvent.AddMethod) ?? GetVirtualAccessor(analyzedEvent.RemoveMethod) ?? GetVirtualAccessor(analyzedEvent.InvokeMethod);
		if (analyzedAccessor is not null) {
			foreach (var o in analyzedAccessor.Overrides) {
				if (Host.ResolveMethodDef(o.MethodDeclaration) is MethodDef method && (method.IsVirtual || method.IsAbstract)) {
					if (method.DeclaringType.Events.FirstOrDefault(a => (object?)a.AddMethod == method || (object?)a.RemoveMethod == method || (object?)a.InvokeMethod == method) is EventDef eventDef)
						hits.Add(new AnalyzerHit(eventDef));
				}
			}
			if (hits.Count > 0)
				return;
		}
		foreach (var eventDef in TypesHierarchyHelpers.FindBaseEvents(Host, analyzedEvent, analyzedEvent.DeclaringType)) {
			var anyAccessor = GetVirtualAccessor(eventDef.AddMethod) ?? GetVirtualAccessor(eventDef.RemoveMethod) ?? GetVirtualAccessor(eventDef.InvokeMethod);
			if (anyAccessor is null || !(anyAccessor.IsVirtual || anyAccessor.IsAbstract))
				continue;
			hits.Add(new AnalyzerHit(eventDef));
			break;
		}
	}

	public static bool CanShow(EventDef @event) =>
		(GetAccessor(@event.AddMethod) ?? GetAccessor(@event.RemoveMethod) ?? GetAccessor(@event.InvokeMethod)) is not null;

	static MethodDef? GetAccessor(MethodDef? accessor) =>
		accessor is not null && accessor.DeclaringType.BaseType is not null &&
		(accessor.IsVirtual || accessor.IsAbstract) && accessor.IsReuseSlot ? accessor : null;

	static MethodDef? GetVirtualAccessor(MethodDef? accessor) =>
		accessor is not null && (accessor.IsVirtual || accessor.IsAbstract) ? accessor : null;
}

/// <summary>"Overridden By" for an event: the events of derived types that override or hide it.</summary>
sealed class EventOverridesSearch(IAnalyzerHost host, EventDef analyzedEvent) : ScopedSearch(host) {
	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedEvent);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (!TypesHierarchyHelpers.IsBaseType(Host, analyzedEvent.DeclaringType, type, resolveTypeArguments: false))
			yield break;
		foreach (var eventDef in type.Events) {
			if (TypesHierarchyHelpers.IsBaseEvent(Host, analyzedEvent, eventDef)) {
				var anyAccessor = eventDef.AddMethod ?? eventDef.RemoveMethod ?? eventDef.InvokeMethod;
				if (anyAccessor is null)
					continue;
				var hidesParent = !anyAccessor.IsVirtual ^ anyAccessor.IsNewSlot;
				yield return new AnalyzerHit(eventDef, HidesParent: hidesParent);
			}
		}
	}

	public static bool CanShow(EventDef @event) {
		var accessor = @event.AddMethod ?? @event.RemoveMethod ?? @event.InvokeMethod;
		return accessor is not null && accessor.IsVirtual && !accessor.IsFinal && !accessor.DeclaringType.IsInterface;
	}
}

/// <summary>"Implemented By" for an interface event, matched through its first accessor.</summary>
sealed class InterfaceEventImplementedBySearch : ScopedSearch {
	readonly EventDef analyzedEvent;
	readonly MethodDef? analyzedMethod;
	readonly AccessorKind accessorKind;

	enum AccessorKind {
		Adder,
		Remover,
		Invoker,
	}

	public InterfaceEventImplementedBySearch(IAnalyzerHost host, EventDef analyzedEvent) : base(host) {
		this.analyzedEvent = analyzedEvent;
		if (analyzedEvent.AddMethod is not null) {
			analyzedMethod = analyzedEvent.AddMethod;
			accessorKind = AccessorKind.Adder;
		}
		else if (analyzedEvent.RemoveMethod is not null) {
			analyzedMethod = analyzedEvent.RemoveMethod;
			accessorKind = AccessorKind.Remover;
		}
		else {
			analyzedMethod = analyzedEvent.InvokeMethod;
			accessorKind = AccessorKind.Invoker;
		}
	}

	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) =>
		analyzedMethod is null ? [] : base.Prepare(cancellationToken);

	protected override ScopedWhereUsedAnalyzer CreateAnalyzer() => new(Host, analyzedMethod!);

	protected override IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) {
		if (analyzedMethod is null || type.IsInterface)
			yield break;
		var implementedInterfaceRef = InterfaceMethodImplementedBySearch.GetInterface(Host, type, analyzedMethod.DeclaringType);
		if (implementedInterfaceRef is null)
			yield break;

		foreach (var ev in type.Events.Where(e => e.Name.EndsWith(analyzedEvent.Name))) {
			var accessor = GetAccessor(ev);
			// Don't include abstract accessors, they don't implement anything
			if (accessor is null || (!accessor.IsVirtual && !accessor.IsStatic) || accessor.IsAbstract)
				continue;
			if (accessor.HasOverrides && accessor.Overrides.Any(m => CheckEquals(Host.ResolveMethodDef(m.MethodDeclaration), analyzedMethod))) {
				yield return new AnalyzerHit(ev);
				yield break;
			}
		}

		foreach (var ev in type.Events.Where(e => e.Name == analyzedEvent.Name)) {
			var accessor = GetAccessor(ev);
			// Don't include abstract accessors, they don't implement anything
			if (accessor is null || (!accessor.IsVirtual && !accessor.IsStatic) || accessor.IsAbstract)
				continue;
			if (TypesHierarchyHelpers.MatchInterfaceMethod(accessor, analyzedMethod, implementedInterfaceRef)) {
				yield return new AnalyzerHit(ev);
				yield break;
			}
		}
	}

	MethodDef? GetAccessor(EventDef ev) => accessorKind switch {
		AccessorKind.Adder => ev.AddMethod,
		AccessorKind.Remover => ev.RemoveMethod,
		AccessorKind.Invoker => ev.InvokeMethod,
		_ => null,
	};

	public static bool CanShow(EventDef ev) =>
		ev.DeclaringType.IsInterface && (ev.AddMethod ?? ev.RemoveMethod ?? ev.InvokeMethod) is MethodDef accessor && (accessor.IsVirtual || accessor.IsAbstract);
}
