using System.Globalization;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// The backend half of dnSpy's Bookmarks window: the Location column, and the bookmark file WPF dnSpy reads
/// and writes. A bookmark is named by module path and token, so both answer whether or not the module is
/// open — one the workspace holds is read through it (with the user's edits), any other from its file.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<FormatBookmarkLocationsResponse> FormatBookmarkLocationsAsync(FormatBookmarkLocationsRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace => {
			var options = BookmarkLocations.ToOptions(request.Format);
			var texts = new List<BookmarkLocationTextDto>(request.Locations.Count);
			foreach (var location in request.Locations) {
				cancellationToken.ThrowIfCancellationRequested();
				var entry = FindBookmarkModule(workspace, location.ModulePath);
				texts.Add(BookmarkLocations.Format(entry?.Module, location, request.Format.ShowTokens, options, TypeColorOf(workspace, entry)));
			}
			return new FormatBookmarkLocationsResponse(texts);
		}, cancellationToken);

	public Task<ExportBookmarksResponse> ExportBookmarksAsync(ExportBookmarksRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace =>
			new ExportBookmarksResponse(BookmarksXml.Write(request.Bookmarks, path => FindBookmarkModule(workspace, path)?.Module)), cancellationToken);

	public Task<ImportBookmarksResponse> ImportBookmarksAsync(ImportBookmarksRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace =>
			BookmarksXml.Read(request.Xml, path => FindBookmarkModule(workspace, path)?.Module), cancellationToken);

	/// <summary>The module a bookmark names, or nothing when the path is not a readable managed file here — a
	/// bookmark from another machine names a path this one may not have, or cannot even spell.</summary>
	Workspace.ModuleEntry? FindBookmarkModule(Workspace? workspace, string? path) {
		if (string.IsNullOrEmpty(path))
			return null;
		try {
			return symbols.FindModule(workspace, path);
		}
		catch (Exception ex) when (ex is ArgumentException or NotSupportedException or IOException or UnauthorizedAccessException) {
			return null;
		}
	}

	/// <summary>A type's color the way the tree picks it for a module the workspace holds; any other module colors
	/// only what it defines itself.</summary>
	static Func<ITypeDefOrRef, string>? TypeColorOf(Workspace? workspace, Workspace.ModuleEntry? entry) =>
		workspace is not null && entry is { IsExternal: false } ? workspace.TypeColorProvider : null;

	sealed partial class Workspace {
		internal Func<ITypeDefOrRef, string> TypeColorProvider => TypeColor;
	}
}

/// <summary>
/// The Location column of dnSpy's Bookmarks window (DotNetBookmarkLocationFormatter): the token when tokens are
/// shown, the member through the C# formatter, and for a spot in a method body " + 0x0007" after it.
/// </summary>
static class BookmarkLocations {
	public static CSharpMemberFormatter.Options ToOptions(BookmarkLocationFormatDto format) {
		var options = CSharpMemberFormatter.Options.None;
		if (format.ShowModuleNames)
			options |= CSharpMemberFormatter.Options.ModuleNames;
		if (format.ShowParameterTypes)
			options |= CSharpMemberFormatter.Options.ParameterTypes;
		if (format.ShowParameterNames)
			options |= CSharpMemberFormatter.Options.ParameterNames;
		if (format.ShowDeclaringTypes)
			options |= CSharpMemberFormatter.Options.DeclaringTypes;
		if (format.ShowReturnTypes)
			options |= CSharpMemberFormatter.Options.ReturnTypes;
		if (format.ShowNamespaces)
			options |= CSharpMemberFormatter.Options.Namespaces;
		if (format.ShowIntrinsicTypeKeywords)
			options |= CSharpMemberFormatter.Options.IntrinsicTypeKeywords;
		return options;
	}

	public static BookmarkLocationTextDto Format(ModuleDef? module, BookmarkLocationDto location, bool showTokens, CSharpMemberFormatter.Options options, Func<ITypeDefOrRef, string>? typeColor) {
		var output = new TextPartsBuilder();
		var token = unchecked((uint)location.MetadataToken);
		if (showTokens)
			output.Write(TextColors.Number, FormatToken(token)).WriteSpace();
		// A body location names a method; a token location any member the tree shows.
		var member = Resolve(module, token);
		if (location.IlOffset is not null && member is not MethodDef)
			member = null;
		if (member is null) {
			if (showTokens)
				output.Write(TextColors.Error, "???");
			else
				output.Write(TextColors.Number, FormatToken(token));
			return new BookmarkLocationTextDto(output.ToParts(), false);
		}
		CSharpMemberFormatter.Write(output, member, options, typeColor);
		if (location.IlOffset is { } offset) {
			output.WriteSpace().Write(TextColors.Operator, "+").WriteSpace();
			// Offsets are always in hex, four digits unless they need eight.
			var value = unchecked((uint)offset);
			output.Write(TextColors.Number, value <= ushort.MaxValue ? $"0x{value:X4}" : $"0x{value:X8}");
		}
		return new BookmarkLocationTextDto(output.ToParts(), true);
	}

	static string FormatToken(uint token) => $"0x{token:X8}";

	/// <summary>The definition a token names in a module, if the module has a row for it.</summary>
	public static IMemberDef? Resolve(ModuleDef? module, uint token) {
		if (module is null)
			return null;
		try {
			return module.ResolveToken(token) as IMemberDef;
		}
		catch (Exception) {
			// A token the module has no row for is a bookmark whose assembly changed underneath it.
			return null;
		}
	}
}

/// <summary>
/// WPF dnSpy's bookmark file: its XML settings format (XmlSettingsWriter/Reader) holding the section
/// BookmarksSerializer writes, with each location the way BookmarkLocationSerializerService writes it. The
/// same section lives in dnSpy's own settings file, so that file reads as a bookmark file too.
/// </summary>
static class BookmarksXml {
	internal const string RootName = "settings";
	internal const string SectionName = "section";
	internal const string SectionNameAttribute = "_";
	const string BookmarkSectionName = "Bookmark";
	const string LocationSectionName = "BML";
	const string LocationTypeAttribute = "__BMT";
	const string DotNetBody = "DotNetBody";
	const string DotNetToken = "DotNetToken";
	const char EscapeChar = '©';
	static readonly Guid SettingsGuid = new("EAA1BE38-7A55-44AF-AD93-5B7EE2327EDD");

	public static string Write(IReadOnlyList<BookmarkFileEntryDto> bookmarks, Func<string, ModuleDef?> findModule) {
		var bookmarksSection = Section(SettingsGuid.ToString(), []);
		foreach (var bookmark in bookmarks) {
			var token = unchecked((uint)bookmark.MetadataToken);
			var module = findModule(bookmark.ModulePath);
			var location = new List<(string, string)> {
				(LocationTypeAttribute, bookmark.IlOffset is null ? DotNetToken : DotNetBody),
				("Token", token.ToString(CultureInfo.InvariantCulture)),
				("AssemblyFullName", module?.Assembly?.FullName ?? string.Empty),
				("ModuleName", bookmark.ModulePath),
			};
			if (bookmark.IlOffset is { } offset)
				location.Add(("Offset", unchecked((uint)offset).ToString(CultureInfo.InvariantCulture)));
			if (TokenString(module, token) is { } tokenString)
				location.Add(("TokenString", tokenString));
			var attributes = new List<(string, string)> {
				("IsEnabled", bookmark.Enabled ? "True" : "False"),
				("Name", bookmark.Name),
			};
			var labels = bookmark.Labels.Select(label => label.Trim()).Where(label => label.Length > 0).ToArray();
			if (labels.Length > 0)
				attributes.Add(("Labels", string.Join(", ", labels)));
			var bookmarkSection = Section(BookmarkSectionName, attributes);
			bookmarkSection.Add(Section(LocationSectionName, location));
			bookmarksSection.Add(bookmarkSection);
		}
		var document = new XDocument(new XElement(RootName, bookmarksSection));
		using var stream = new MemoryStream();
		using (var writer = XmlWriter.Create(stream, new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = true, IndentChars = "  " }))
			document.Save(writer);
		return Encoding.UTF8.GetString(stream.ToArray());
	}

	/// <summary>
	/// A section the way XmlSettingsWriter writes one: its name first, then its attributes sorted by their
	/// upper-cased names with the default (culture) comparer — which puts "__BMT" ahead of the letters.
	/// </summary>
	internal static XElement Section(string name, IEnumerable<(string Key, string Value)> attributes) {
		var section = new XElement(SectionName);
		section.SetAttributeValue(SectionNameAttribute, Escape(name));
		foreach (var (key, value) in attributes.OrderBy(attribute => attribute.Key.ToUpperInvariant(), StringComparer.InvariantCulture))
			section.SetAttributeValue(key, Escape(value));
		return section;
	}

	public static ImportBookmarksResponse Read(string xml, Func<string, ModuleDef?> findModule) {
		XDocument document;
		try {
			using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
			document = XDocument.Load(reader);
		}
		catch (XmlException ex) {
			throw new RpcException(ErrorCodes.InvalidParams, "The bookmark file is not valid XML.", null, ex);
		}
		if (document.Root?.Name != RootName)
			throw new RpcException(ErrorCodes.InvalidParams, "The file is not a dnSpy settings file.");

		var bookmarks = new List<BookmarkFileEntryDto>();
		var skipped = 0;
		// XmlSettingsReader merges every section whose name parses as the same GUID.
		var sections = document.Root.Elements(SectionName)
			.Where(section => Guid.TryParse(Unescape(Attribute(section, SectionNameAttribute)), out var guid) && guid == SettingsGuid);
		foreach (var bookmarkSection in sections.SelectMany(section => Children(section, BookmarkSectionName))) {
			if (ReadBookmark(bookmarkSection, findModule) is { } bookmark)
				bookmarks.Add(bookmark);
			else
				skipped++;
		}
		return new ImportBookmarksResponse(bookmarks, skipped);
	}

	/// <summary>
	/// One bookmark, or nothing for a row this port cannot take: BookmarksSerializer drops a row without
	/// IsEnabled or a readable location, and the location serializer one whose TokenString no longer names
	/// the member. Unlike WPF, a module that cannot be read here is no reason to drop the row — a file from
	/// another machine names paths this one does not have, and the bookmark is still worth listing.
	/// </summary>
	static BookmarkFileEntryDto? ReadBookmark(XElement section, Func<string, ModuleDef?> findModule) {
		var isEnabled = ParseBool(Attribute(section, "IsEnabled"));
		var location = Children(section, LocationSectionName).FirstOrDefault();
		if (isEnabled is null || location is null)
			return null;
		var type = Attribute(location, LocationTypeAttribute);
		var token = ParseUInt32(Attribute(location, "Token"));
		var assemblyFullName = Attribute(location, "AssemblyFullName");
		var moduleName = Attribute(location, "ModuleName");
		if (type is not (DotNetBody or DotNetToken) || token is null || assemblyFullName is null || string.IsNullOrEmpty(moduleName))
			return null;
		// An in-memory or dynamic module, or one named without its file, has no path to find it again by.
		if (ParseBool(Attribute(location, "IsDynamic")) == true || ParseBool(Attribute(location, "IsInMemory")) == true || ParseBool(Attribute(location, "ModuleNameOnly")) == true)
			return null;
		int? offset = null;
		if (type == DotNetBody) {
			if (ParseUInt32(Attribute(location, "Offset")) is not { } bodyOffset)
				return null;
			offset = unchecked((int)bodyOffset);
		}
		var tokenString = Attribute(location, "TokenString");
		if (!string.IsNullOrEmpty(tokenString) && findModule(moduleName) is { } module && TokenString(module, token.Value) != tokenString)
			return null;
		var labels = (Attribute(section, "Labels") ?? string.Empty)
			.Split(',', StringSplitOptions.RemoveEmptyEntries)
			.Select(label => label.Trim())
			.Where(label => label.Length > 0)
			.ToArray();
		return new BookmarkFileEntryDto(
			moduleName,
			unchecked((int)token.Value),
			offset,
			Attribute(section, "Name") ?? string.Empty,
			labels,
			isEnabled.Value,
			string.IsNullOrEmpty(tokenString) ? null : tokenString);
	}

	/// <summary>What the location serializer checks a token against: the member's dnlib full name.</summary>
	internal static string? TokenString(ModuleDef? module, uint token) => BookmarkLocations.Resolve(module, token)?.ToString();

	internal static IEnumerable<XElement> Children(XElement section, string name) =>
		section.Elements(SectionName).Where(child => Unescape(Attribute(child, SectionNameAttribute)) == name);

	internal static string? Attribute(XElement section, string name) {
		var value = (string?)section.Attribute(name);
		return name == SectionNameAttribute ? value : Unescape(value);
	}

	// The TypeConverters the settings sections read values with: a bool is "True"/"False" in any case, a uint
	// decimal or (BaseNumberConverter) hex with a 0x prefix.
	internal static bool? ParseBool(string? value) => bool.TryParse(value?.Trim(), out var result) ? result : null;

	internal static uint? ParseUInt32(string? value) {
		value = value?.Trim();
		if (string.IsNullOrEmpty(value))
			return null;
		if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
			return uint.TryParse(value[2..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var hex) ? hex : null;
		return uint.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : null;
	}

	/// <summary>XmlUtils.EscapeAttributeValue: a control character, or the escape character itself, as ©XXXX.</summary>
	internal static string Escape(string value) {
		var escaped = new StringBuilder(value.Length);
		foreach (var ch in value) {
			if (ch < ' ' || ch == EscapeChar)
				escaped.Append(EscapeChar).Append(((int)ch).ToString("X4", CultureInfo.InvariantCulture));
			else
				escaped.Append(ch);
		}
		return escaped.ToString();
	}

	/// <summary>XmlUtils.UnescapeAttributeValue.</summary>
	internal static string? Unescape(string? value) {
		if (value is null || value.IndexOf(EscapeChar, StringComparison.Ordinal) < 0)
			return value;
		var parts = value.Split(EscapeChar);
		var unescaped = new StringBuilder(value.Length);
		for (var index = 0; index < parts.Length; index++) {
			var part = parts[index];
			if (index == 0 || part.Length < 4) {
				unescaped.Append(part);
				continue;
			}
			var hex = part[..4];
			if (hex.All(Uri.IsHexDigit) && int.TryParse(hex, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var code))
				unescaped.Append((char)code);
			else
				unescaped.Append(hex);
			unescaped.Append(part[4..]);
		}
		return unescaped.ToString();
	}
}
