using System.Text;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Resources;
using IModuleEntry = dnSpy.Backend.Core.WorkspaceManager.IModuleEntry;

namespace dnSpy.Backend.Core.Search;

/// <summary>A namespace a search found, or the one a type it found lives in.</summary>
sealed record SearchNamespace(string Name);

/// <summary>An entry of a .resources file a search found, and the resource it is in.</summary>
sealed record SearchResourceElement(EmbeddedResource Owner, ResourceElement Element);

/// <summary>A file a search walks: a .NET module, or — with no <see cref="Module"/> — a file that is not one.</summary>
sealed record SearchDocument(IModuleEntry Entry, ModuleDef? Module);

/// <summary>The instruction a match in a method body is — dnSpy's BodyResult.</summary>
readonly record struct SearchBodyResult(uint ILOffset, OpCode OpCode, object? Operand);

/// <summary>
/// One thing a search found — dnSpy's SearchResult before it is written. <see cref="Object"/> is what following
/// it goes to, <see cref="NameObject"/> what the row is written as — the method a parameter, a local or a
/// literal was found in, for one — and <see cref="LocationObject"/> where it lives.
/// </summary>
sealed record SearchHit(object Object, object NameObject, object? LocationObject, IModuleEntry Document, SearchBodyResult? Body = null);

/// <summary>A search that found more than it may list stops with this, the way dnSpy's does.</summary>
sealed class TooManySearchResultsException : Exception;

sealed record FilterSearcherOptions(
	ISearchComparer Comparer,
	SearchFilter Filter,
	bool SearchDecompiledData,
	bool SearchCompilerGeneratedMembers,
	Action<SearchHit> OnMatch,
	// The XAML a BAML entry decompiles to, for "Decompile Resources"; null when it does not decompile.
	Func<IModuleEntry, byte[], CancellationToken, string?> DecompileBaml,
	CancellationToken CancellationToken);

/// <summary>
/// dnSpy's FilterSearcher: walks the documents, or the types, the search covers and offers every name, constant
/// and literal on the way to the comparer; the filter says which kinds of node it looks for and which it only
/// looks inside. The walk is an iterator that stops after each type, each resource and each part of a document
/// that is not a type, which is what lets the search run a slice at a time with the workspace let go between.
/// </summary>
sealed class FilterSearcher(FilterSearcherOptions options) {
	readonly StringBuilder sb = new();

	CancellationToken CancellationToken => options.CancellationToken;

	bool IsMatch(string? text, object? obj) => options.Comparer.IsMatch(text, obj);

	bool IsCompilerGenerated(IMemberDef member) => !options.SearchCompilerGeneratedMembers && CompilerGeneratedMembers.IsHidden(member);

	void OnMatch(SearchHit hit) {
		CancellationToken.ThrowIfCancellationRequested();
		options.OnMatch(hit);
	}

	public IEnumerable<bool> SearchDocuments(IEnumerable<SearchDocument> documents) {
		foreach (var document in documents) {
			CancellationToken.ThrowIfCancellationRequested();
			var steps = document.Module switch {
				{ Assembly: not null } => SearchAssembly(document),
				not null => SearchModule(document),
				null => SearchNonNetFile(document),
			};
			foreach (var step in steps)
				yield return step;
		}
	}

	/// <summary>The types the tree's selection is in, each with its nested types when it is a top-level one.</summary>
	public IEnumerable<bool> SearchTypes(IEnumerable<(SearchDocument Document, TypeDef Type)> types) {
		foreach (var (document, type) in types) {
			CancellationToken.ThrowIfCancellationRequested();
			if (type.DeclaringType is null) {
				foreach (var step in Search(document, type.Namespace.String, type))
					yield return step;
			}
			else {
				Search(document, type);
				yield return true;
			}
		}
	}

	void CheckCustomAttributes(SearchDocument document, IHasCustomAttribute hca, object? parent) {
		if (!options.Filter.GetResultAttributes(hca).IsMatch)
			return;
		foreach (var ca in hca.CustomAttributes) {
			CancellationToken.ThrowIfCancellationRequested();
			foreach (var argument in ca.ConstructorArguments) {
				if (CheckCA(document, hca, parent, argument))
					return;
			}
			foreach (var argument in ca.NamedArguments) {
				if (CheckCA(document, hca, parent, argument.Argument))
					return;
			}
		}
	}

	bool CheckCA(SearchDocument document, IHasCustomAttribute hca, object? parent, CAArgument argument) {
		var value = argument.Value;
		if (value is IList<CAArgument> array) {
			foreach (var element in array) {
				if (CheckCA(document, hca, parent, element))
					return true;
			}
		}
		else if (value is CAArgument boxed) {
			if (CheckCA(document, hca, parent, boxed))
				return true;
		}
		else if (value is UTF8String utf8)
			value = utf8.String;
		if (!IsMatch(null, value))
			return false;
		OnMatch(new SearchHit(hca, hca, parent is string ns ? new SearchNamespace(ns) : parent, document.Entry));
		return true;
	}

	IEnumerable<bool> SearchAssembly(SearchDocument document) {
		var assembly = document.Module!.Assembly!;
		var res = options.Filter.GetResult(assembly);
		if (res.FilterType == FilterType.Hide)
			yield break;
		CheckCustomAttributes(document, assembly, null);
		if (res.IsMatch && (IsMatch(assembly.FullName, document) || IsMatch(assembly.Name, null)))
			OnMatch(new SearchHit(assembly, assembly, null, document.Entry));
		// The workspace holds an assembly as its manifest module: that is the one module its tree shows.
		foreach (var step in SearchModule(document))
			yield return step;
	}

	IEnumerable<bool> SearchModule(SearchDocument document) {
		var module = document.Module!;
		var res = options.Filter.GetResult(module);
		if (res.FilterType == FilterType.Hide)
			yield break;
		CheckCustomAttributes(document, module, module.Assembly);
		if (res.IsMatch && IsMatch(module.FullName, document))
			OnMatch(new SearchHit(module, module, module.Assembly, document.Entry));

		SearchModAsmReferences(document);
		yield return true;

		foreach (var step in SearchResources(document))
			yield return step;

		foreach (var (ns, types) in GetNamespaces(module)) {
			CancellationToken.ThrowIfCancellationRequested();
			foreach (var step in Search(document, ns, types))
				yield return step;
		}
	}

	void SearchModAsmReferences(SearchDocument document) {
		if (options.Filter.GetResultReferencesFolder().FilterType == FilterType.Hide)
			return;
		var module = document.Module!;
		foreach (var assemblyRef in module.GetAssemblyRefs()) {
			CancellationToken.ThrowIfCancellationRequested();
			var res = options.Filter.GetResult(assemblyRef);
			if (res.FilterType == FilterType.Hide)
				continue;
			if (res.IsMatch && (IsMatch(assemblyRef.FullName, assemblyRef) || IsMatch(assemblyRef.Name, null)))
				OnMatch(new SearchHit(assemblyRef, assemblyRef, module, document.Entry));
		}
		foreach (var moduleRef in module.GetModuleRefs()) {
			CancellationToken.ThrowIfCancellationRequested();
			var res = options.Filter.GetResult(moduleRef);
			if (res.FilterType == FilterType.Hide)
				continue;
			if (res.IsMatch && IsMatch(moduleRef.FullName, moduleRef))
				OnMatch(new SearchHit(moduleRef, moduleRef, module, document.Entry));
		}
	}

	IEnumerable<bool> SearchResources(SearchDocument document) {
		if (options.Filter.GetResultResourcesFolder().FilterType == FilterType.Hide)
			yield break;
		if (options.Filter.GetResultResource().FilterType == FilterType.Hide)
			yield break;
		foreach (var resource in document.Module!.Resources) {
			CancellationToken.ThrowIfCancellationRequested();
			foreach (var step in SearchResource(document, resource))
				yield return step;
		}
	}

	/// <summary>A resource's text the way dnSpy's resource nodes give it: the content of an embedded file that
	/// is text, and nothing for the rest.</summary>
	static string? ResourceText(Resource resource) {
		if (resource is not EmbeddedResource embedded || IsResourcesFile(embedded))
			return null;
		try {
			return ResourceTexts.TryGetString(embedded.CreateReader().ToArray());
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			return string.Empty;
		}
	}

	static bool IsResourcesFile(EmbeddedResource resource) =>
		resource.Name.EndsWith(".resources", StringComparison.OrdinalIgnoreCase) && ResourceReader.CouldBeResourcesFile(resource.CreateReader());

	IEnumerable<bool> SearchResource(SearchDocument document, Resource resource) {
		var res = options.Filter.GetResultResource();
		if (res.FilterType == FilterType.Hide)
			yield break;
		if (res.IsMatch && (IsMatch(resource.Name, resource) || IsMatch(ResourceText(resource), null)))
			OnMatch(new SearchHit(resource, resource, document.Module, document.Entry));
		yield return true;

		if (options.Filter.GetResultResourceElement().FilterType == FilterType.Hide)
			yield break;
		if (resource is not EmbeddedResource embedded || !IsResourcesFile(embedded))
			yield break;
		ResourceElementSet elements;
		try {
			elements = ResourceReader.Read(document.Module!, embedded.CreateReader());
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			yield break;
		}
		foreach (var element in elements.ResourceElements) {
			CancellationToken.ThrowIfCancellationRequested();
			SearchResourceElement(document, embedded, element);
			yield return true;
		}
	}

	void SearchResourceElement(SearchDocument document, EmbeddedResource owner, ResourceElement element) {
		var res = options.Filter.GetResultResourceElement();
		if (res.FilterType == FilterType.Hide || !res.IsMatch)
			return;
		var found = new SearchResourceElement(owner, element);
		var isMatch = IsMatch(element.Name, found) || IsMatch(UnescapeDataString(element.Name), found);
		if (!isMatch && element.ResourceData is BuiltInResourceData builtin) {
			var value = builtin.Data;
			if (builtin.Code == ResourceTypeCode.TimeSpan)
				value = ((TimeSpan)value).Ticks;
			else if (builtin.Code == ResourceTypeCode.DateTime)
				value = ((DateTime)value).Ticks;
			isMatch = IsMatch(value as string, value);
		}
		if (!isMatch)
			isMatch = IsMatch(ResourceElementText(document, element), null);
		if (isMatch)
			OnMatch(new SearchHit(found, found, owner, document.Entry));
	}

	static string UnescapeDataString(string name) {
		try {
			return Uri.UnescapeDataString(name);
		}
		catch (UriFormatException) {
			return name;
		}
	}

	/// <summary>An entry's text: a BAML entry's XAML when the search decompiles resources, and the content of a
	/// byte array or a stream that is text.</summary>
	string? ResourceElementText(SearchDocument document, ResourceElement element) {
		if (element.ResourceData is not BuiltInResourceData { Code: ResourceTypeCode.ByteArray or ResourceTypeCode.Stream, Data: byte[] data })
			return null;
		try {
			if (element.Name.EndsWith(".baml", StringComparison.OrdinalIgnoreCase))
				return options.SearchDecompiledData ? options.DecompileBaml(document.Entry, data, CancellationToken) : null;
			return ResourceTexts.TryGetString(data);
		}
		catch (Exception ex) when (ex is not OperationCanceledException) {
			return string.Empty;
		}
	}

	/// <summary>The module's top-level types by namespace, including the global type for its members.</summary>
	static Dictionary<string, List<TypeDef>> GetNamespaces(ModuleDef module) {
		var namespaces = new Dictionary<string, List<TypeDef>>(StringComparer.Ordinal);
		foreach (var type in module.Types) {
			// Include the global type so its members (global functions and fields) can be searched.
			if (!namespaces.TryGetValue(type.Namespace, out var list))
				namespaces.Add(type.Namespace, list = []);
			list.Add(type);
		}
		return namespaces;
	}

	IEnumerable<bool> SearchNonNetFile(SearchDocument document) {
		var res = options.Filter.GetResultNonNetFile();
		if (res.FilterType == FilterType.Hide)
			yield break;
		if (res.IsMatch && IsMatch(ResourceTexts.ShortName(document.Entry.Path), document.Entry))
			OnMatch(new SearchHit(document.Entry, document.Entry, null, document.Entry));
		yield return true;
	}

	IEnumerable<bool> Search(SearchDocument document, string ns, List<TypeDef> types) {
		var res = options.Filter.GetResult(ns);
		if (res.FilterType == FilterType.Hide)
			yield break;
		if (res.IsMatch && IsMatch(ns, ns))
			OnMatch(new SearchHit(new SearchNamespace(ns), new SearchNamespace(ns), document.Module, document.Entry));
		foreach (var type in types) {
			CancellationToken.ThrowIfCancellationRequested();
			foreach (var step in Search(document, ns, type))
				yield return step;
		}
	}

	IEnumerable<bool> Search(SearchDocument document, string nsOwner, TypeDef type) {
		CheckCustomAttributes(document, type, nsOwner);
		var res = options.Filter.GetResult(type);
		if (res.FilterType == FilterType.Hide)
			yield break;
		if (IsCompilerGenerated(type))
			yield break;
		if (res.IsMatch && CheckMatch(type))
			OnMatch(new SearchHit(type, type, new SearchNamespace(nsOwner), document.Entry));
		SearchMembers(document, type);
		yield return true;

		foreach (var nested in type.GetTypes()) {
			CancellationToken.ThrowIfCancellationRequested();
			Search(document, nested);
			yield return true;
		}
	}

	void Search(SearchDocument document, TypeDef type) {
		CheckCustomAttributes(document, type, type.DeclaringType);
		var res = options.Filter.GetResult(type);
		if (res.FilterType == FilterType.Hide)
			return;
		if (IsCompilerGenerated(type))
			return;
		if (res.IsMatch && CheckMatch(type))
			OnMatch(new SearchHit(type, type, type.DeclaringType, document.Entry));
		SearchMembers(document, type);
	}

	bool CheckMatch(TypeDef type) {
		sb.Clear();
		return IsMatch(FixTypeNameSB(FullNameFactory.FullNameSB(type, false, null, sb)), type) || IsMatch(FixTypeName(type.Name), type);
	}

	/// <summary>A type name the way C# reads it: nested types after a dot, no generic arity.</summary>
	string FixTypeName(string name) {
		int index;
		for (index = 0; index < name.Length; index++) {
			if (name[index] is '/' or '`')
				break;
		}
		if (index == name.Length)
			return name;
		sb.Clear();
		sb.Append(name, 0, index);
		for (; index < name.Length; index++) {
			var c = name[index];
			switch (c) {
			case '/':
				sb.Append('.');
				break;
			case '`':
				while (++index < name.Length && char.IsDigit(name[index]))
					;
				// The loop stopped on the character after the digits, which the next round reads.
				index--;
				break;
			default:
				sb.Append(c);
				break;
			}
		}
		return sb.ToString();
	}

	static string FixTypeNameSB(StringBuilder nameBuilder) {
		for (var index = 0; index < nameBuilder.Length; index++) {
			switch (nameBuilder[index]) {
			case '/':
				nameBuilder[index] = '.';
				break;
			case '`':
				var startIndex = index;
				while (++index < nameBuilder.Length && char.IsDigit(nameBuilder[index]))
					;
				nameBuilder.Remove(startIndex, index - startIndex);
				index = startIndex - 1;
				break;
			}
		}
		return nameBuilder.ToString();
	}

	void SearchMembers(SearchDocument document, TypeDef type) {
		foreach (var method in type.Methods) {
			CancellationToken.ThrowIfCancellationRequested();
			Search(document, type, method);
		}
		foreach (var field in type.Fields) {
			CancellationToken.ThrowIfCancellationRequested();
			Search(document, type, field);
		}
		foreach (var property in type.Properties) {
			CancellationToken.ThrowIfCancellationRequested();
			Search(document, type, property);
		}
		foreach (var @event in type.Events) {
			CancellationToken.ThrowIfCancellationRequested();
			Search(document, type, @event);
		}
	}

	/// <summary>A member's name, its name after its type's — with a dot or with "::" — and its full name.</summary>
	bool CheckMemberName(IMemberDef member, string fullName) {
		if (IsMatch(member.Name, member))
			return true;
		var fixedTypeName = FixTypeName(member.DeclaringType.FullName);
		return IsMatch(fixedTypeName + "." + member.Name.String, member)
			|| IsMatch(fixedTypeName + "::" + member.Name.String, member)
			|| IsMatch(fullName, member);
	}

	bool CheckMatch(MethodDef method) {
		if (CheckMemberName(method, method.FullName))
			return true;
		return method.ImplMap is { } implMap && (IsMatch(implMap.Name, implMap) || IsMatch(implMap.Module?.Name, null));
	}

	void Search(SearchDocument document, TypeDef type, MethodDef method) {
		var res = options.Filter.GetResult(method);
		if (res.FilterType == FilterType.Hide)
			return;
		if (IsCompilerGenerated(method))
			return;
		CheckCustomAttributes(document, method, type);
		if (res.IsMatch && CheckMatch(method)) {
			OnMatch(new SearchHit(method, method, type, document.Entry));
			return;
		}

		res = options.Filter.GetResultParamDefs(method);
		if (res.FilterType != FilterType.Hide) {
			foreach (var paramDef in method.ParamDefs) {
				CancellationToken.ThrowIfCancellationRequested();
				CheckCustomAttributes(document, paramDef, method);
				res = options.Filter.GetResult(method, paramDef);
				if (res.FilterType == FilterType.Hide)
					continue;
				if (res.IsMatch && IsMatch(paramDef.Name, paramDef)) {
					OnMatch(new SearchHit(method, method, type, document.Entry));
					return;
				}
			}
		}

		SearchBody(document, type, method);
	}

	void SearchBody(SearchDocument document, TypeDef type, MethodDef method) {
		CilBody? body;
		var res = options.Filter.GetResultLocals(method);
		if (res.FilterType != FilterType.Hide) {
			body = method.Body;
			// Everything below reads the body.
			if (body is null)
				return;
			foreach (var local in body.Variables) {
				CancellationToken.ThrowIfCancellationRequested();
				res = options.Filter.GetResult(method, local);
				if (res.FilterType == FilterType.Hide)
					continue;
				if (res.IsMatch && IsMatch(local.Name, local)) {
					OnMatch(new SearchHit(method, method, type, document.Entry));
					return;
				}
			}
		}

		res = options.Filter.GetResultBody(method);
		if (res.FilterType == FilterType.Hide || !res.IsMatch)
			return;
		body = method.Body;
		if (body is null)
			return;
		var counter = 0;
		foreach (var instruction in body.Instructions) {
			if (counter++ > 1000) {
				CancellationToken.ThrowIfCancellationRequested();
				counter = 0;
			}
			// Only numbers and strings: no other operand is offered to the comparer.
			object? operand = instruction.OpCode.Code switch {
				Code.Ldc_I4_M1 => -1,
				Code.Ldc_I4_0 => 0,
				Code.Ldc_I4_1 => 1,
				Code.Ldc_I4_2 => 2,
				Code.Ldc_I4_3 => 3,
				Code.Ldc_I4_4 => 4,
				Code.Ldc_I4_5 => 5,
				Code.Ldc_I4_6 => 6,
				Code.Ldc_I4_7 => 7,
				Code.Ldc_I4_8 => 8,
				Code.Ldc_I4 or Code.Ldc_I4_S or Code.Ldc_R4 or Code.Ldc_R8 or Code.Ldstr => instruction.Operand,
				_ => null,
			};
			if (operand is not null && IsMatch(null, operand)) {
				OnMatch(new SearchHit(method, method, type, document.Entry, new SearchBodyResult(instruction.Offset, instruction.OpCode, instruction.Operand)));
				break;
			}
		}
	}

	bool CheckMatch(FieldDef field) {
		if (CheckMemberName(field, field.FullName))
			return true;
		if (field.ImplMap is { } implMap && (IsMatch(implMap.Name, implMap) || IsMatch(implMap.Module?.Name, null)))
			return true;
		return field.Constant is not null && IsMatch(null, field.Constant.Value);
	}

	void Search(SearchDocument document, TypeDef type, FieldDef field) {
		var res = options.Filter.GetResult(field);
		if (res.FilterType == FilterType.Hide)
			return;
		if (IsCompilerGenerated(field))
			return;
		CheckCustomAttributes(document, field, type);
		if (res.IsMatch && CheckMatch(field))
			OnMatch(new SearchHit(field, field, type, document.Entry));
	}

	bool CheckMatch(PropertyDef property) =>
		CheckMemberName(property, property.FullName) || (property.Constant is not null && IsMatch(null, property.Constant.Value));

	void Search(SearchDocument document, TypeDef type, PropertyDef property) {
		var res = options.Filter.GetResult(property);
		if (res.FilterType == FilterType.Hide)
			return;
		if (IsCompilerGenerated(property))
			return;
		CheckCustomAttributes(document, property, type);
		if (res.IsMatch && CheckMatch(property))
			OnMatch(new SearchHit(property, property, type, document.Entry));
	}

	void Search(SearchDocument document, TypeDef type, EventDef @event) {
		var res = options.Filter.GetResult(@event);
		if (res.FilterType == FilterType.Hide)
			return;
		if (IsCompilerGenerated(@event))
			return;
		CheckCustomAttributes(document, @event, type);
		if (res.IsMatch && CheckMemberName(@event, @event.FullName))
			OnMatch(new SearchHit(@event, @event, type, document.Entry));
	}
}
