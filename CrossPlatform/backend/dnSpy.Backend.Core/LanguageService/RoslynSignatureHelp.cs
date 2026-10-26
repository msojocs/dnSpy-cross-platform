using System.Collections;
using System.Reflection;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Host.Mef;
using Microsoft.CodeAnalysis.Text;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// Signature help from Roslyn's own providers, the way dnSpy gets it: <c>dnSpy.Roslyn.Internal</c> compiles against
/// Roslyn with its internals made public and runs every <c>ISignatureHelpProvider</c> of the language, then picks the
/// overload and parameter with Roslyn's <c>DefaultSignatureHelpSelector</c>. The providers are internal to
/// Microsoft.CodeAnalysis.Features here as well, so this reaches the same <c>SignatureHelpService</c> through
/// reflection — invocations, object creation, attributes, indexers, generic names, tuples, initializers, and Visual
/// Basic's casts, AddHandler/RaiseEvent, GetType, NameOf and If all come from the code Visual Studio runs.
/// </summary>
static class RoslynSignatureHelp {
	const BindingFlags Members = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
	static readonly Assembly features = typeof(CompletionService).Assembly;
	static readonly Type serviceType = FeatureType("Microsoft.CodeAnalysis.SignatureHelp.SignatureHelpService");
	static readonly Type triggerInfoType = FeatureType("Microsoft.CodeAnalysis.SignatureHelp.SignatureHelpTriggerInfo");
	static readonly Type triggerReasonType = FeatureType("Microsoft.CodeAnalysis.SignatureHelp.SignatureHelpTriggerReason");
	static readonly Lazy<object> service = new(CreateService);
	static readonly Dictionary<string, (string Trigger, string Retrigger)> characters = new(StringComparer.Ordinal);

	static Type FeatureType(string name) =>
		features.GetType(name, throwOnError: true)!;

	/// <summary>The MEF part Roslyn exports the service as, from the host the workspaces are created with.</summary>
	static object CreateService() {
		var exportProvider = typeof(MefHostServices).Assembly.GetType("Microsoft.CodeAnalysis.Host.Mef.IMefHostExportProvider", throwOnError: true)!;
		var getExports = exportProvider.GetMethods().Single(m => m.Name == "GetExports" && m.GetGenericArguments().Length == 1).MakeGenericMethod(serviceType);
		foreach (var export in (IEnumerable)getExports.Invoke(LanguageServiceHost.Services, null)!)
			return export.GetType().GetProperty("Value")!.GetValue(export)!;
		throw new InvalidOperationException("Roslyn exports no signature help service.");
	}

	static object? Get(object instance, string property) =>
		instance.GetType().GetProperty(property, Members)!.GetValue(instance);

	/// <summary>Tagged text as colored parts; an item's description is a default array when it has none.</summary>
	static IReadOnlyList<TextPartDto> Parts(object? taggedText) => taggedText switch {
		System.Collections.Immutable.ImmutableArray<TaggedText> array => RoslynTextParts.ToParts(array),
		IEnumerable<TaggedText> parts => RoslynTextParts.ToParts(parts),
		_ => [],
	};

	/// <summary>
	/// The characters a language's providers start a session on and the ones they update it on — dnSpy's
	/// <c>SignatureHelpService.IsTriggerCharacter</c>/<c>IsRetriggerCharacter</c> asked of every printable character.
	/// </summary>
	public static (string Trigger, string Retrigger) GetTriggerCharacters(string language) {
		lock (characters) {
			if (characters.TryGetValue(language, out var known))
				return known;
			var providers = (IEnumerable)serviceType.GetMethod("GetProviders", Members)!.Invoke(service.Value, [language])!;
			var trigger = new System.Text.StringBuilder();
			var retrigger = new System.Text.StringBuilder();
			foreach (var provider in providers) {
				var providerType = provider.GetType().GetInterfaces().Single(i => i.Name == "ISignatureHelpProvider");
				var isTrigger = providerType.GetMethod("IsTriggerCharacter")!;
				var isRetrigger = providerType.GetMethod("IsRetriggerCharacter")!;
				for (var ch = ' '; ch <= '~'; ch++) {
					if (!trigger.ToString().Contains(ch) && (bool)isTrigger.Invoke(provider, [ch])!)
						trigger.Append(ch);
					if (!retrigger.ToString().Contains(ch) && (bool)isRetrigger.Invoke(provider, [ch])!)
						retrigger.Append(ch);
				}
			}
			return characters[language] = (trigger.ToString(), retrigger.ToString());
		}
	}

	public static async Task<CodeSignatureHelpDto?> GetAsync(Document document, int position, string? triggerCharacter, string? triggerReason, CancellationToken cancellationToken) {
		var character = triggerCharacter is { Length: > 0 } ? triggerCharacter[0] : (char?)null;
		var reason = (triggerReason ?? (character is null ? "invoke" : "typeChar")) switch {
			"typeChar" when character is not null => "TypeCharCommand",
			"retrigger" => "RetriggerCommand",
			_ => "InvokeSignatureHelpCommand",
		};
		var triggerInfo = triggerInfoType.GetConstructor(Members, [triggerReasonType, typeof(char?)])!
			.Invoke([Enum.Parse(triggerReasonType, reason), reason == "InvokeSignatureHelpCommand" ? null : character]);
		var getSignatureHelp = serviceType.GetMethod("GetSignatureHelpAsync", Members, [typeof(Document), typeof(int), triggerInfoType, typeof(CancellationToken)])!;
		var task = (Task)getSignatureHelp.Invoke(service.Value, [document, position, triggerInfo, cancellationToken])!;
		await task.ConfigureAwait(false);
		var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
		var items = result.GetType().GetField("Item2")!.GetValue(result);
		if (items is null)
			return null;
		return Create(items, document.Project.Language != LanguageNames.VisualBasic, cancellationToken);
	}

	sealed record Item(object Value, IReadOnlyList<object> Parameters, bool IsVariadic) {
		public IEnumerable<string> ParameterNames => Parameters.Select(p => (string)Get(p, "Name")!);
	}

	static CodeSignatureHelpDto? Create(object items, bool isCaseSensitive, CancellationToken cancellationToken) {
		var list = ((IEnumerable)Get(items, "Items")!).Cast<object>()
			.Select(item => new Item(item, ((IEnumerable)Get(item, "Parameters")!).Cast<object>().ToArray(), (bool)Get(item, "IsVariadic")!))
			.ToArray();
		if (list.Length == 0)
			return null;
		var span = (TextSpan)Get(items, "ApplicableSpan")!;
		var argumentIndex = (int)Get(items, "SemanticParameterIndex")!;
		var argumentCount = (int)Get(items, "SyntacticArgumentCount")!;
		var argumentName = (string?)Get(items, "ArgumentName");
		var selectedIndex = (int?)Get(items, "SelectedItemIndex");

		// dnSpy's GetSelectedItem: the provider's pick, else the first item.
		var current = list[selectedIndex ?? 0];
		var best = GetBestItem(current, list, argumentCount, argumentName, isCaseSensitive);
		var selectedParameter = GetSelectedParameter(best, argumentIndex, argumentName, isCaseSensitive);
		// dnSpy's Signature: a parameter past the last one is the last one of a params signature.
		int? currentParameter = (uint)selectedParameter < (uint)best.Parameters.Count ? selectedParameter
			: best.IsVariadic && best.Parameters.Count > 0 ? best.Parameters.Count - 1
			: null;

		return new CodeSignatureHelpDto(
			new CodeSpanDto(span.Start, span.Length),
			argumentIndex,
			argumentCount,
			argumentName,
			Array.IndexOf(list, best),
			list.Select(item => ToDto(item, cancellationToken)).ToArray(),
			currentParameter);
	}

	static CodeSignatureDto ToDto(Item item, CancellationToken cancellationToken) {
		var parameters = item.Parameters.Select(parameter => new CodeSignatureParameterDto(
			(string)Get(parameter, "Name")!,
			Parts(Get(parameter, "DisplayParts")),
			RoslynTextParts.ToParts(((Func<CancellationToken, IEnumerable<TaggedText>>)Get(parameter, "DocumentationFactory")!)(cancellationToken)),
			(bool)Get(parameter, "IsOptional")!,
			Parts(Get(parameter, "PrefixDisplayParts")),
			Parts(Get(parameter, "SuffixDisplayParts")),
			Parts(Get(parameter, "SelectedDisplayParts")))).ToArray();
		return new CodeSignatureDto(
			Parts(Get(item.Value, "PrefixDisplayParts")),
			Parts(Get(item.Value, "SeparatorDisplayParts")),
			Parts(Get(item.Value, "SuffixDisplayParts")),
			parameters,
			RoslynTextParts.ToParts(((Func<CancellationToken, IEnumerable<TaggedText>>)Get(item.Value, "DocumentationFactory")!)(cancellationToken)),
			item.IsVariadic,
			Parts(Get(item.Value, "DescriptionParts")));
	}

	// Roslyn's DefaultSignatureHelpSelector, as dnSpy's SignatureHelpService copies it.

	static int GetSelectedParameter(Item bestItem, int parameterIndex, string? parameterName, bool isCaseSensitive) {
		if (!string.IsNullOrEmpty(parameterName)) {
			var comparer = isCaseSensitive ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase;
			var index = bestItem.ParameterNames.ToList().FindIndex(name => comparer.Equals(name, parameterName));
			if (index >= 0)
				return index;
		}
		return parameterIndex;
	}

	static Item GetBestItem(Item currentItem, IReadOnlyList<Item> filteredItems, int argumentCount, string? name, bool isCaseSensitive) {
		// If the current item is still applicable, then just keep it.
		if (filteredItems.Contains(currentItem) && IsApplicable(currentItem, argumentCount, name, isCaseSensitive))
			return currentItem;

		// The first applicable item; if there is none, the selected parameter is past every overload's last one.
		var result = filteredItems.FirstOrDefault(i => IsApplicable(i, argumentCount, name, isCaseSensitive));
		if (result is not null)
			return result;

		// Without a match for the name, try again without it.
		if (name is not null)
			return GetBestItem(currentItem, filteredItems, argumentCount, null, isCaseSensitive);

		// The last item is the closest in parameter count, unless the current one is no worse.
		var lastItem = filteredItems[^1];
		if (currentItem.IsVariadic || currentItem.Parameters.Count == lastItem.Parameters.Count)
			return currentItem;
		return lastItem;
	}

	static bool IsApplicable(Item item, int argumentCount, string? name, bool isCaseSensitive) {
		// A named argument needs a parameter of that name.
		if (name is not null) {
			var comparer = isCaseSensitive ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase;
			return item.ParameterNames.Any(p => comparer.Equals(p, name));
		}
		// Room for the arguments, any number of them, or "Goo(" with no argument yet.
		return item.Parameters.Count >= argumentCount || item.IsVariadic || argumentCount == 0;
	}
}
