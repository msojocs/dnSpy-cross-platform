using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Analyzer.Searches;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// The rows an analyzed member expands to, in the order dnSpy's entity nodes create them: the searches
/// that apply to it — the <c>CanShow</c> rules of each search node — and, under a property or an event,
/// the rows of its accessors. dnSpy shows them sorted by their text, which is the client's business.
/// </summary>
static class AnalyzerEntityChildren {
	/// <summary>A search row, or an accessor row when <see cref="Accessor"/> is set. <see cref="Keyword"/> is
	/// the word an accessor row is written as; an accessor without one is written as the method it is.</summary>
	public readonly record struct Child(string? Search, bool IsSetter = false, MethodDef? Accessor = null, string? Keyword = null);

	public static IReadOnlyList<Child> Of(IAnalyzerHost host, object entity, bool isSetter) {
		var children = new List<Child>();
		switch (entity) {
		case TypeDef type:
			if (AttributeAppliedToSearch.CanShow(type, host))
				children.Add(new(AnalyzerSearchKinds.AppliedTo));
			if (TypeInstantiationsSearch.CanShow(type))
				children.Add(new(AnalyzerSearchKinds.InstantiatedBy));
			if (TypeUsedBySearch.CanShow(type))
				children.Add(new(AnalyzerSearchKinds.UsedBy));
			if (TypeExposedBySearch.CanShow(type))
				children.Add(new(AnalyzerSearchKinds.ExposedBy));
			if (SubtypesSearch.CanShow(type))
				children.Add(new(AnalyzerSearchKinds.Subtypes));
			if (TypeExtensionMethodsSearch.CanShow(type))
				children.Add(new(AnalyzerSearchKinds.ExtensionMethods));
			break;

		case MethodDef method:
			if (method.HasBody)
				children.Add(new(AnalyzerSearchKinds.Uses, isSetter));
			children.Add(new(AnalyzerSearchKinds.UsedBy, isSetter));
			if (MethodOverriddenSearch.CanShow(method))
				children.Add(new(AnalyzerSearchKinds.Overrides, isSetter));
			if (MethodOverridesSearch.CanShow(method))
				children.Add(new(AnalyzerSearchKinds.OverriddenBy, isSetter));
			if (InterfaceMethodImplementedBySearch.CanShow(method))
				children.Add(new(AnalyzerSearchKinds.ImplementedBy, isSetter));
			break;

		case FieldDef field:
			children.Add(new(AnalyzerSearchKinds.ReadBy));
			if (!field.IsLiteral)
				children.Add(new(AnalyzerSearchKinds.AssignedBy));
			break;

		case PropertyDef property:
			if (property.GetMethod is { } getter)
				children.Add(new(null, Accessor: getter, Keyword: "get"));
			if (property.SetMethod is { } setter)
				children.Add(new(null, IsSetter: true, Accessor: setter, Keyword: "set"));
			foreach (var accessor in property.OtherMethods)
				children.Add(new(null, Accessor: accessor));
			if (PropertyOverriddenSearch.CanShow(property))
				children.Add(new(AnalyzerSearchKinds.Overrides));
			if (PropertyOverridesSearch.CanShow(property))
				children.Add(new(AnalyzerSearchKinds.OverriddenBy));
			if (InterfacePropertyImplementedBySearch.CanShow(property))
				children.Add(new(AnalyzerSearchKinds.ImplementedBy));
			break;

		case EventDef @event:
			if (@event.AddMethod is { } add)
				children.Add(new(null, Accessor: add, Keyword: "add"));
			if (@event.RemoveMethod is { } remove)
				children.Add(new(null, Accessor: remove, Keyword: "remove"));
			if (@event.InvokeMethod is { } invoke)
				children.Add(new(null, Accessor: invoke, Keyword: "raise"));
			foreach (var accessor in @event.OtherMethods)
				children.Add(new(null, Accessor: accessor));
			if (EventFiredBySearch.CanShow(@event))
				children.Add(new(AnalyzerSearchKinds.RaisedBy));
			if (EventOverriddenSearch.CanShow(@event))
				children.Add(new(AnalyzerSearchKinds.Overrides));
			if (EventOverridesSearch.CanShow(@event))
				children.Add(new(AnalyzerSearchKinds.OverriddenBy));
			if (InterfaceEventImplementedBySearch.CanShow(@event))
				children.Add(new(AnalyzerSearchKinds.ImplementedBy));
			break;
		}
		return children;
	}

	/// <summary>
	/// The search a search row runs. A row the member does not have — a key that does not apply to its
	/// kind, or a search its <c>CanShow</c> rule leaves out — is refused rather than run, since several of
	/// them assume what the rule checked (a body to read, a backing field to look for).
	/// </summary>
	public static AnalyzerSearch CreateSearch(IAnalyzerHost host, object entity, string search, bool isSetter) {
		if (!Of(host, entity, isSetter).Any(child => child.Search == search))
			throw new RpcException(ErrorCodes.InvalidParams, $"The member has no \"{search}\" search.");
		return (entity, search) switch {
			(TypeDef type, AnalyzerSearchKinds.AppliedTo) => new AttributeAppliedToSearch(host, type),
			(TypeDef type, AnalyzerSearchKinds.InstantiatedBy) => new TypeInstantiationsSearch(host, type),
			(TypeDef type, AnalyzerSearchKinds.UsedBy) => new TypeUsedBySearch(host, type),
			(TypeDef type, AnalyzerSearchKinds.ExposedBy) => new TypeExposedBySearch(host, type),
			(TypeDef type, AnalyzerSearchKinds.Subtypes) => new SubtypesSearch(host, type),
			(TypeDef type, AnalyzerSearchKinds.ExtensionMethods) => new TypeExtensionMethodsSearch(host, type),
			(MethodDef method, AnalyzerSearchKinds.Uses) => new MethodUsesSearch(host, method),
			// A virtual method is used through the method that introduced its slot as well; a method that is
			// newslot final is an implicit interface implementation nothing overrides.
			(MethodDef method, AnalyzerSearchKinds.UsedBy) => (method.IsVirtual || method.IsAbstract) && !(method.IsNewSlot && method.IsFinal)
				? new VirtualMethodUsedBySearch(host, method, isSetter)
				: new MethodUsedBySearch(host, method, isSetter),
			(MethodDef method, AnalyzerSearchKinds.Overrides) => new MethodOverriddenSearch(host, method),
			(MethodDef method, AnalyzerSearchKinds.OverriddenBy) => new MethodOverridesSearch(host, method),
			(MethodDef method, AnalyzerSearchKinds.ImplementedBy) => new InterfaceMethodImplementedBySearch(host, method),
			(FieldDef field, AnalyzerSearchKinds.ReadBy) => new FieldAccessSearch(host, field, showWrites: false),
			(FieldDef field, AnalyzerSearchKinds.AssignedBy) => new FieldAccessSearch(host, field, showWrites: true),
			(PropertyDef property, AnalyzerSearchKinds.Overrides) => new PropertyOverriddenSearch(host, property),
			(PropertyDef property, AnalyzerSearchKinds.OverriddenBy) => new PropertyOverridesSearch(host, property),
			(PropertyDef property, AnalyzerSearchKinds.ImplementedBy) => new InterfacePropertyImplementedBySearch(host, property),
			(EventDef @event, AnalyzerSearchKinds.RaisedBy) => new EventFiredBySearch(host, @event),
			(EventDef @event, AnalyzerSearchKinds.Overrides) => new EventOverriddenSearch(host, @event),
			(EventDef @event, AnalyzerSearchKinds.OverriddenBy) => new EventOverridesSearch(host, @event),
			(EventDef @event, AnalyzerSearchKinds.ImplementedBy) => new InterfaceEventImplementedBySearch(host, @event),
			_ => throw new RpcException(ErrorCodes.InvalidParams, $"The member has no \"{search}\" search."),
		};
	}

	/// <summary>The English header a search row wears; the client translates it.</summary>
	public static string Header(string search) => search switch {
		AnalyzerSearchKinds.Uses => "Uses",
		AnalyzerSearchKinds.UsedBy => "Used By",
		AnalyzerSearchKinds.Overrides => "Overrides",
		AnalyzerSearchKinds.OverriddenBy => "Overridden By",
		AnalyzerSearchKinds.ImplementedBy => "Implemented By",
		AnalyzerSearchKinds.ReadBy => "Read By",
		AnalyzerSearchKinds.AssignedBy => "Assigned By",
		AnalyzerSearchKinds.RaisedBy => "Raised By",
		AnalyzerSearchKinds.AppliedTo => "Applied To",
		AnalyzerSearchKinds.InstantiatedBy => "Instantiated By",
		AnalyzerSearchKinds.ExposedBy => "Exposed By",
		AnalyzerSearchKinds.Subtypes => "Subtypes",
		AnalyzerSearchKinds.ExtensionMethods => "Extension Methods",
		_ => search,
	};
}
