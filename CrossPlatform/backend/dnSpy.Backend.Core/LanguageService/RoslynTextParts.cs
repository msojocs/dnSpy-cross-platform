using System.Collections.Immutable;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Tags;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// Turns Roslyn's tagged text and symbol display parts into the colored parts dnSpy's tooltips show, and
/// completion tags into the dnSpy image of the symbol.
/// </summary>
public static class RoslynTextParts {
	/// <summary>dnSpy's <c>TextTagsHelper.ToTextColor</c>.</summary>
	public static string ToColor(string? textTag) => textTag switch {
		TextTags.Alias => TextColors.Namespace,
		TextTags.Assembly => TextColors.Assembly,
		TextTags.Class => TextColors.Type,
		TextTags.Constant => TextColors.LiteralField,
		TextTags.Delegate => TextColors.Delegate,
		TextTags.Enum => TextColors.Enum,
		TextTags.EnumMember => TextColors.EnumField,
		TextTags.ErrorType => TextColors.Error,
		TextTags.Event => TextColors.InstanceEvent,
		TextTags.ExtensionMethod => TextColors.ExtensionMethod,
		TextTags.Field => TextColors.InstanceField,
		TextTags.Interface => TextColors.Interface,
		TextTags.Keyword => TextColors.Keyword,
		TextTags.Label => TextColors.Label,
		TextTags.Local => TextColors.Local,
		TextTags.Method => TextColors.InstanceMethod,
		TextTags.Module => TextColors.Module,
		TextTags.Namespace => TextColors.Namespace,
		TextTags.NumericLiteral => TextColors.Number,
		TextTags.Operator => TextColors.Operator,
		TextTags.Parameter => TextColors.Parameter,
		TextTags.Property => TextColors.InstanceProperty,
		TextTags.Punctuation => TextColors.Punctuation,
		TextTags.RangeVariable => TextColors.Local,
		TextTags.Record => TextColors.Type,
		TextTags.RecordStruct => TextColors.ValueType,
		TextTags.StringLiteral => TextColors.String,
		TextTags.Struct => TextColors.ValueType,
		TextTags.TypeParameter => TextColors.TypeGenericParameter,
		// Text, Space, LineBreak, AnonymousTypeIndicator and the container and code block markers.
		_ => TextColors.Text,
	};

	public static IReadOnlyList<TextPartDto> ToParts(ImmutableArray<TaggedText> taggedText) =>
		taggedText.IsDefaultOrEmpty ? [] : ToParts((IEnumerable<TaggedText>)taggedText);

	public static IReadOnlyList<TextPartDto> ToParts(IEnumerable<TaggedText>? taggedText) {
		if (taggedText is null)
			return [];
		var parts = new List<TextPartDto>();
		foreach (var part in taggedText) {
			// Roslyn marks where a block of documentation starts and ends with empty parts.
			if (part.Text.Length == 0)
				continue;
			parts.Add(new TextPartDto(part.Text, ToColor(part.Tag)));
		}
		return parts;
	}

	/// <summary>The color of a symbol display part — what Roslyn's own conversion to tagged text would tag it.</summary>
	public static string ToColor(SymbolDisplayPartKind kind) => kind switch {
		SymbolDisplayPartKind.AliasName => TextColors.Namespace,
		SymbolDisplayPartKind.AssemblyName => TextColors.Assembly,
		SymbolDisplayPartKind.ClassName => TextColors.Type,
		SymbolDisplayPartKind.RecordClassName => TextColors.Type,
		SymbolDisplayPartKind.ConstantName => TextColors.LiteralField,
		SymbolDisplayPartKind.DelegateName => TextColors.Delegate,
		SymbolDisplayPartKind.EnumName => TextColors.Enum,
		SymbolDisplayPartKind.EnumMemberName => TextColors.EnumField,
		SymbolDisplayPartKind.ErrorTypeName => TextColors.Error,
		SymbolDisplayPartKind.EventName => TextColors.InstanceEvent,
		SymbolDisplayPartKind.ExtensionMethodName => TextColors.ExtensionMethod,
		SymbolDisplayPartKind.FieldName => TextColors.InstanceField,
		SymbolDisplayPartKind.InterfaceName => TextColors.Interface,
		SymbolDisplayPartKind.Keyword => TextColors.Keyword,
		SymbolDisplayPartKind.LabelName => TextColors.Label,
		SymbolDisplayPartKind.LocalName => TextColors.Local,
		SymbolDisplayPartKind.MethodName => TextColors.InstanceMethod,
		SymbolDisplayPartKind.ModuleName => TextColors.Module,
		SymbolDisplayPartKind.NamespaceName => TextColors.Namespace,
		SymbolDisplayPartKind.NumericLiteral => TextColors.Number,
		SymbolDisplayPartKind.Operator => TextColors.Operator,
		SymbolDisplayPartKind.ParameterName => TextColors.Parameter,
		SymbolDisplayPartKind.PropertyName => TextColors.InstanceProperty,
		SymbolDisplayPartKind.Punctuation => TextColors.Punctuation,
		SymbolDisplayPartKind.RangeVariableName => TextColors.Local,
		SymbolDisplayPartKind.RecordStructName => TextColors.ValueType,
		SymbolDisplayPartKind.StringLiteral => TextColors.String,
		SymbolDisplayPartKind.StructName => TextColors.ValueType,
		SymbolDisplayPartKind.TypeParameterName => TextColors.TypeGenericParameter,
		_ => TextColors.Text,
	};

	public static void Add(List<TextPartDto> parts, ImmutableArray<SymbolDisplayPart> displayParts) {
		foreach (var part in displayParts)
			parts.Add(new TextPartDto(part.ToString(), ToColor(part.Kind)));
	}

	public static IReadOnlyList<TextPartDto> ToParts(ImmutableArray<SymbolDisplayPart> displayParts) {
		var parts = new List<TextPartDto>(displayParts.Length);
		Add(parts, displayParts);
		return parts;
	}

	/// <summary>
	/// The dnSpy image Roslyn's tags stand for — dnSpy's <c>GlyphHelper</c> over Roslyn's tags-to-glyph mapping:
	/// a kind ("Class") and an accessibility ("Protected"), or one of the images that have no accessibility.
	/// </summary>
	public static string? GetGlyph(ImmutableArray<string> tags) {
		if (tags.IsDefaultOrEmpty)
			return null;
		foreach (var tag in tags) {
			var image = tag switch {
				WellKnownTags.Class => Accessible("Class"),
				WellKnownTags.Constant => Accessible("Constant"),
				WellKnownTags.Delegate => Accessible("Delegate"),
				WellKnownTags.Enum => Accessible("Enumeration"),
				WellKnownTags.EnumMember => Accessible("EnumerationItem"),
				WellKnownTags.Event => Accessible("Event"),
				WellKnownTags.Field => Accessible("Field"),
				WellKnownTags.Interface => Accessible("Interface"),
				WellKnownTags.Method => Accessible("Method"),
				WellKnownTags.Module => Accessible("Module"),
				WellKnownTags.Operator => Accessible("Operator"),
				WellKnownTags.Structure => Accessible("Structure"),
				// dnSpy has no "PropertyPublic" image; a public property uses the plain one.
				WellKnownTags.Property => Accessible("Property") is "PropertyPublic" ? "Property" : Accessible("Property"),
				WellKnownTags.ExtensionMethod => "ExtensionMethod",
				WellKnownTags.Intrinsic => "Type",
				WellKnownTags.TypeParameter => "Type",
				WellKnownTags.Keyword => "IntellisenseKeyword",
				WellKnownTags.Label => "Label",
				// Visual Studio shows a parameter with the local's image, and so does dnSpy.
				WellKnownTags.Local or WellKnownTags.Parameter or WellKnownTags.RangeVariable => "LocalVariable",
				WellKnownTags.Namespace => "Namespace",
				WellKnownTags.Reference => "Reference",
				WellKnownTags.Snippet => "Snippet",
				WellKnownTags.Assembly => "Assembly",
				WellKnownTags.Error => "StatusError",
				_ => null,
			};
			if (image is not null)
				return image;
		}
		return null;

		string Accessible(string kind) {
			if (tags.Contains(WellKnownTags.Private))
				return kind + "Private";
			if (tags.Contains(WellKnownTags.Protected))
				return kind + "Protected";
			if (tags.Contains(WellKnownTags.Internal))
				return kind + "Internal";
			return kind + "Public";
		}
	}
}
