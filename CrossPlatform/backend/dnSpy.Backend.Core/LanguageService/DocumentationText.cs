using System.Text;
using System.Xml.Linq;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.LanguageService;

/// <summary>
/// Reads the parts of a symbol's XML documentation that signature help shows — the summary and the text of
/// one <c>param</c> or <c>typeparam</c> — as colored text, with references written as the names they refer to.
/// </summary>
static class DocumentationText {
	public static IReadOnlyList<TextPartDto> Summary(string? xml) => Read(xml, root => root.Element("summary"));

	public static IReadOnlyList<TextPartDto> Parameter(string? xml, string name) =>
		Read(xml, root => root.Elements("param").FirstOrDefault(e => (string?)e.Attribute("name") == name));

	public static IReadOnlyList<TextPartDto> TypeParameter(string? xml, string name) =>
		Read(xml, root => root.Elements("typeparam").FirstOrDefault(e => (string?)e.Attribute("name") == name));

	static IReadOnlyList<TextPartDto> Read(string? xml, Func<XElement, XElement?> select) {
		if (string.IsNullOrWhiteSpace(xml))
			return [];
		XElement root;
		try {
			// A member's documentation is a <member> element; a fragment from a source comment has no root.
			root = XElement.Parse(xml.TrimStart().StartsWith("<member", StringComparison.Ordinal) ? xml : $"<member>{xml}</member>", LoadOptions.PreserveWhitespace);
		}
		catch (System.Xml.XmlException) {
			return [];
		}
		var element = select(root);
		if (element is null)
			return [];
		var parts = new List<TextPartDto>();
		Append(parts, element);
		return Normalize(parts);
	}

	static void Append(List<TextPartDto> parts, XElement element) {
		foreach (var node in element.Nodes()) {
			switch (node) {
			case XText text:
				parts.Add(new TextPartDto(text.Value, TextColors.Text));
				break;
			case XElement child:
				switch (child.Name.LocalName) {
				case "see":
				case "seealso":
					if ((string?)child.Attribute("langword") is { } langword)
						parts.Add(new TextPartDto(langword, TextColors.Keyword));
					else if ((string?)child.Attribute("cref") is { } cref)
						parts.Add(new TextPartDto(child.IsEmpty ? CrefName(cref) : child.Value, TextColors.Text));
					else if ((string?)child.Attribute("href") is { } href)
						parts.Add(new TextPartDto(child.IsEmpty ? href : child.Value, TextColors.Text));
					else
						Append(parts, child);
					break;
				case "paramref":
					parts.Add(new TextPartDto((string?)child.Attribute("name") ?? string.Empty, TextColors.Parameter));
					break;
				case "typeparamref":
					parts.Add(new TextPartDto((string?)child.Attribute("name") ?? string.Empty, TextColors.TypeGenericParameter));
					break;
				case "para":
				case "br":
					parts.Add(new TextPartDto("\n", TextColors.Text));
					Append(parts, child);
					parts.Add(new TextPartDto("\n", TextColors.Text));
					break;
				default:
					Append(parts, child);
					break;
				}
				break;
			}
		}
	}

	/// <summary><c>M:System.String.Join(System.String,System.String[])</c> → <c>String.Join</c>.</summary>
	static string CrefName(string cref) {
		var name = cref.Length > 2 && cref[1] == ':' ? cref[2..] : cref;
		var paren = name.IndexOf('(');
		if (paren >= 0)
			name = name[..paren];
		var segments = name.Split('.');
		// A member is written with its type, the way Roslyn writes a cref it cannot bind minimally.
		var result = segments.Length >= 2 && !cref.StartsWith("T:", StringComparison.Ordinal)
			? $"{segments[^2]}.{segments[^1]}"
			: segments[^1];
		var tick = result.IndexOf('`');
		return tick >= 0 ? result[..tick] : result;
	}

	/// <summary>Collapses the comment's own line breaks and indentation, keeping the paragraph breaks.</summary>
	static IReadOnlyList<TextPartDto> Normalize(List<TextPartDto> parts) {
		var result = new List<TextPartDto>();
		var pendingSpace = false;
		var pendingBreak = false;
		foreach (var part in parts) {
			if (part.Text == "\n") {
				pendingBreak = result.Count > 0;
				pendingSpace = false;
				continue;
			}
			var sb = new StringBuilder();
			foreach (var ch in part.Text) {
				if (char.IsWhiteSpace(ch)) {
					pendingSpace = true;
					continue;
				}
				if (pendingBreak) {
					sb.Append('\n');
					pendingBreak = false;
					pendingSpace = false;
				}
				else if (pendingSpace && (sb.Length > 0 || result.Count > 0))
					sb.Append(' ');
				pendingSpace = false;
				sb.Append(ch);
			}
			if (sb.Length > 0)
				result.Add(part with { Text = sb.ToString() });
		}
		return result;
	}
}
