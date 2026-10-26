using System.Collections.Immutable;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Tags;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// What dnSpy's completion list shows for an item's tags: its image (<c>CompletionImageHelper</c>), the color of
/// its text (<c>CompletionKindTextColorHelper</c>, <c>CompletionClassifier</c>), and the filter buttons under the
/// list (<c>RoslynIntellisenseFilters</c>), all from the kind <c>CompletionKindUtilities.ToCompletionKind</c> reads.
/// </summary>
public static class CompletionKinds {
	/// <summary>dnSpy's filter buttons in the order they are shown: an id and the tags an item needs to pass it.</summary>
	public static readonly IReadOnlyList<(string Id, string[] Tags)> Filters = [
		("locals", [WellKnownTags.Local, WellKnownTags.Parameter]),
		("constants", [WellKnownTags.Constant]),
		("properties", [WellKnownTags.Property]),
		("events", [WellKnownTags.Event]),
		("fields", [WellKnownTags.Field]),
		("methods", [WellKnownTags.Method]),
		("extensionMethods", [WellKnownTags.ExtensionMethod]),
		("interfaces", [WellKnownTags.Interface]),
		("classes", [WellKnownTags.Class]),
		("modules", [WellKnownTags.Module]),
		("structures", [WellKnownTags.Structure]),
		("enums", [WellKnownTags.Enum]),
		("delegates", [WellKnownTags.Delegate]),
		("namespaces", [WellKnownTags.Namespace]),
		("keywords", [WellKnownTags.Keyword]),
		("snippets", [WellKnownTags.Snippet]),
	];

	/// <summary>The filters some item of the list matches — the buttons dnSpy's completion set is created with.</summary>
	public static IReadOnlyList<string> GetFilters(IEnumerable<CompletionItem> items) {
		var present = new bool[Filters.Count];
		foreach (var item in items) {
			if (string.IsNullOrEmpty(item.DisplayText))
				continue;
			for (var i = 0; i < Filters.Count; i++) {
				if (!present[i] && Filters[i].Tags.Any(item.Tags.Contains))
					present[i] = true;
			}
		}
		return Filters.Where((_, i) => present[i]).Select(f => f.Id).ToArray();
	}

	/// <summary>The kinds whose image and color depend on their accessibility, by their dnSpy image's name.</summary>
	static readonly (string Tag, string Image, string Color)[] accessibleKinds = [
		(WellKnownTags.Class, "Class", TextColors.Type),
		(WellKnownTags.Constant, "Constant", TextColors.LiteralField),
		(WellKnownTags.Delegate, "Delegate", TextColors.Delegate),
		(WellKnownTags.Enum, "Enumeration", TextColors.Enum),
		(WellKnownTags.Event, "Event", TextColors.InstanceEvent),
		(WellKnownTags.ExtensionMethod, "ExtensionMethod", TextColors.ExtensionMethod),
		(WellKnownTags.Field, "Field", TextColors.InstanceField),
		(WellKnownTags.Interface, "Interface", TextColors.Interface),
		(WellKnownTags.Method, "Method", TextColors.InstanceMethod),
		(WellKnownTags.Module, "Module", TextColors.Module),
		(WellKnownTags.Operator, "Operator", TextColors.Operator),
		(WellKnownTags.Property, "Property", TextColors.InstanceProperty),
		(WellKnownTags.Structure, "Structure", TextColors.ValueType),
	];

	/// <summary>
	/// The kind's image and color: the first tag that names a kind decides, the way <c>ToCompletionKind</c> walks
	/// them. Null when no tag names one (dnSpy's CompletionKind.Unknown, which has no image).
	/// </summary>
	static (string? Image, string Color)? GetKind(ImmutableArray<string> tags) {
		foreach (var tag in tags) {
			foreach (var (kindTag, image, color) in accessibleKinds) {
				if (tag != kindTag)
					continue;
				var access = tags.Contains(WellKnownTags.Public) ? "Public"
					: tags.Contains(WellKnownTags.Protected) ? "Protected"
					: tags.Contains(WellKnownTags.Internal) ? "Internal"
					: tags.Contains(WellKnownTags.Private) ? "Private"
					: "Public";
				return (ImageOf(image, access), color);
			}
			switch (tag) {
			case WellKnownTags.File:
				return tags.Contains(LanguageNames.CSharp) ? ("CSFileNode", TextColors.Text)
					: tags.Contains(LanguageNames.VisualBasic) ? ("VBFileNode", TextColors.Text)
					: null;
			case WellKnownTags.Project:
				return tags.Contains(LanguageNames.CSharp) ? ("CSProjectNode", TextColors.Text)
					: tags.Contains(LanguageNames.VisualBasic) ? ("VBProjectNode", TextColors.Text)
					: null;
			case WellKnownTags.EnumMember: return ("EnumerationItemPublic", TextColors.EnumField);
			case WellKnownTags.Assembly: return ("Assembly", TextColors.Assembly);
			case WellKnownTags.Parameter: return ("LocalVariable", TextColors.Parameter);
			case WellKnownTags.RangeVariable: return ("LocalVariable", TextColors.Parameter);
			case WellKnownTags.Intrinsic: return ("Type", TextColors.Keyword);
			case WellKnownTags.Keyword: return ("IntellisenseKeyword", TextColors.Keyword);
			case WellKnownTags.Label: return ("Label", TextColors.Label);
			case WellKnownTags.Local: return ("LocalVariable", TextColors.Local);
			case WellKnownTags.Namespace: return ("Namespace", TextColors.Namespace);
			case WellKnownTags.Folder: return ("FolderOpened", TextColors.Text);
			case WellKnownTags.Reference: return ("Reference", TextColors.Assembly);
			case WellKnownTags.TypeParameter: return ("Type", TextColors.TypeGenericParameter);
			case WellKnownTags.Snippet: return ("Snippet", TextColors.Text);
			case WellKnownTags.Error: return ("StatusError", TextColors.Error);
			case WellKnownTags.Warning: return ("StatusWarning", TextColors.Text);
			case "StatusInformation": return ("StatusInformation", TextColors.Text);
			}
		}
		return null;
	}

	/// <summary>
	/// The image of a kind and accessibility. An extension method has one image whatever its accessibility, and
	/// a public property has the plain property image — dnSpy has no "ExtensionMethodPublic" or "PropertyPublic".
	/// </summary>
	static string ImageOf(string kind, string access) => kind switch {
		"ExtensionMethod" => "ExtensionMethod",
		"Property" when access == "Public" => "Property",
		_ => kind + access,
	};

	/// <summary>The image dnSpy's completion list shows for the item's tags, or null for none.</summary>
	public static string? GetImage(ImmutableArray<string> tags) => GetKind(tags)?.Image;

	/// <summary>The color of the item's text in dnSpy's completion list.</summary>
	public static string GetTextColor(ImmutableArray<string> tags) => GetKind(tags)?.Color ?? TextColors.Text;

	static readonly char[] punctuationChars = ['<', '>', '(', ')'];

	/// <summary>
	/// The item's text in color — dnSpy's <c>CompletionClassifier</c>. An identifier is in its kind's color, as is the
	/// name of a "Name&lt;&gt;" or "Name()" with the brackets as punctuation, and Visual Basic's "Name(Of …)" with its
	/// keyword. Anything longer is colored the way the item's description colors the same text, which is only asked
	/// for then; what the description does not cover keeps the kind's color.
	/// </summary>
	public static IReadOnlyList<TextPartDto> GetDisplayParts(string text, ImmutableArray<string> tags, Func<CompletionDescription?> getDescription) {
		var color = GetTextColor(tags);
		if (text.Length == 0)
			return [];
		if (text.IndexOf('.', StringComparison.Ordinal) < 0) {
			var punctIndex = text.IndexOfAny(punctuationChars);
			if (punctIndex < 0)
				return [new TextPartDto(text, color)];
			if (punctIndex + 2 == text.Length && text.IndexOfAny(punctuationChars, punctIndex + 1) == punctIndex + 1)
				return [new TextPartDto(text[..punctIndex], color), new TextPartDto(text[punctIndex..], TextColors.Punctuation)];
			const string VBOf = "(Of …)";
			if (text.Length - VBOf.Length == punctIndex && text.EndsWith(VBOf, StringComparison.Ordinal)) {
				return [
					new TextPartDto(text[..punctIndex], color),
					new TextPartDto("(", TextColors.Punctuation),
					new TextPartDto("Of", TextColors.Keyword),
					new TextPartDto(text[(punctIndex + 3)..^1], TextColors.Text),
					new TextPartDto(")", TextColors.Punctuation),
				];
			}
		}

		var description = getDescription();
		if (description is not null && GetMatchIndexes(text, description.TaggedParts) is var (index, endIndex)) {
			var parts = new List<TextPartDto>();
			var position = 0;
			for (var i = index; i <= endIndex; i++) {
				var part = description.TaggedParts[i];
				if (part.Tag == TextTags.LineBreak)
					break;
				parts.Add(new TextPartDto(part.Text, RoslynTextParts.ToColor(part.Tag)));
				position += part.Text.Length;
			}
			if (position < text.Length)
				parts.Add(new TextPartDto(text[position..], color));
			return parts;
		}
		return [new TextPartDto(text, color)];
	}

	/// <summary>The description's parts that spell <paramref name="displayText"/> (or start it, for a generic written
	/// with its parameters where the text has its arguments).</summary>
	static (int Index, int EndIndex)? GetMatchIndexes(string displayText, ImmutableArray<TaggedText> parts) {
		var matched = new System.Text.StringBuilder();
		var matchIndex = -1;
		for (var index = 0; index < parts.Length; index++) {
			var part = parts[index];
			if (part.Tag == TextTags.LineBreak)
				break;
			if (matchIndex < 0) {
				if (!displayText.StartsWith(part.Text, StringComparison.Ordinal))
					continue;
				matchIndex = index;
			}
			else if (matched.Length + part.Text.Length > displayText.Length || string.CompareOrdinal(displayText, matched.Length, part.Text, 0, part.Text.Length) != 0)
				return (matchIndex, index - 1);
			matched.Append(part.Text);
			if (matched.Length == displayText.Length) {
				if (matched.ToString() == displayText)
					return (matchIndex, index);
				break;
			}
			if (matched.Length > displayText.Length)
				break;
		}
		return null;
	}
}
