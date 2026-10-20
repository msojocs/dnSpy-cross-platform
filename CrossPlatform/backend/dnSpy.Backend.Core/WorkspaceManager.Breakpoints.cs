using System.Globalization;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// dnSpy's breakpoint file: the Breakpoints window's Export and Import, written the way BreakpointsSerializer writes
/// its settings section, so a file made here opens in dnSpy and one dnSpy made opens here.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<ExportBreakpointsResponse> ExportBreakpointsAsync(ExportBreakpointsRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace =>
			new ExportBreakpointsResponse(BreakpointsXml.Write(request.Breakpoints, path => FindBookmarkModule(workspace, path)?.Module)), cancellationToken);

	public Task<ImportBreakpointsResponse> ImportBreakpointsAsync(ImportBreakpointsRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace =>
			BreakpointsXml.Read(request.Xml, path => FindBookmarkModule(workspace, path)?.Module), cancellationToken);
}

/// <summary>
/// BreakpointsSerializer's section of dnSpy's settings XML: a <c>Breakpoint</c> per breakpoint with its enabled state
/// and labels, the location (<c>BPL</c>) as DbgCodeLocationSerializerImpl writes a .NET one, and a section for each
/// of its condition, hit count, filter and trace.
/// </summary>
static class BreakpointsXml {
	const string BreakpointSectionName = "Breakpoint";
	const string LocationSectionName = "BPL";
	const string LocationTypeAttribute = "__BPT";
	const string DotNet = "DotNet";
	static readonly Guid SettingsGuid = new("FBC6039C-8A7A-49DC-9C32-52C1B73DE0A3");

	public static string Write(IReadOnlyList<BreakpointFileEntryDto> breakpoints, Func<string, ModuleDef?> findModule) {
		var root = BookmarksXml.Section(SettingsGuid.ToString(), []);
		foreach (var breakpoint in breakpoints) {
			var token = unchecked((uint)breakpoint.MetadataToken);
			var module = findModule(breakpoint.ModulePath);
			var location = new List<(string, string)> {
				(LocationTypeAttribute, DotNet),
				("Token", token.ToString(CultureInfo.InvariantCulture)),
				("Offset", unchecked((uint)breakpoint.IlOffset).ToString(CultureInfo.InvariantCulture)),
				("AssemblyFullName", module?.Assembly?.FullName ?? string.Empty),
				("ModuleName", breakpoint.ModulePath),
			};
			if (BookmarksXml.TokenString(module, token) is { } method)
				location.Add(("Method", method));
			var attributes = new List<(string, string)> { ("IsEnabled", breakpoint.Enabled ? "True" : "False") };
			var settings = breakpoint.Settings;
			var labels = (settings?.Labels ?? []).Select(label => label.Trim()).Where(label => label.Length > 0).ToArray();
			if (labels.Length > 0)
				attributes.Add(("Labels", string.Join(", ", labels)));
			var section = BookmarksXml.Section(BreakpointSectionName, attributes);
			section.Add(BookmarksXml.Section(LocationSectionName, location));
			if (settings?.Condition is { } condition)
				section.Add(BookmarksXml.Section("Condition", [("Kind", condition.Kind == "whenChanged" ? "WhenChanged" : "IsTrue"), ("Condition", condition.Expression)]));
			if (settings?.Filter is { } filter)
				section.Add(BookmarksXml.Section("Filter", [("Filter", filter)]));
			if (settings?.HitCount is { } hitCount)
				section.Add(BookmarksXml.Section("HitCount", [("Kind", HitCountKindName(hitCount.Kind)), ("Count", hitCount.Count.ToString(CultureInfo.InvariantCulture))]));
			if (settings?.Trace is { } trace) {
				var traceAttributes = new List<(string, string)> { ("Message", trace.Message) };
				// Continue is written only when it is not the default.
				if (!trace.Continue)
					traceAttributes.Add(("Continue", "False"));
				section.Add(BookmarksXml.Section("Trace", traceAttributes));
			}
			root.Add(section);
		}
		var document = new XDocument(new XElement(BookmarksXml.RootName, root));
		using var stream = new MemoryStream();
		using (var writer = XmlWriter.Create(stream, new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = true, IndentChars = "  " }))
			document.Save(writer);
		return Encoding.UTF8.GetString(stream.ToArray());
	}

	static string HitCountKindName(string kind) => kind switch {
		"multipleOf" => "MultipleOf",
		"greaterThanOrEquals" => "GreaterThanOrEquals",
		_ => "Equals",
	};

	public static ImportBreakpointsResponse Read(string xml, Func<string, ModuleDef?> findModule) {
		XDocument document;
		try {
			using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
			document = XDocument.Load(reader);
		}
		catch (XmlException ex) {
			throw new RpcException(ErrorCodes.InvalidParams, "The breakpoint file is not valid XML.", null, ex);
		}
		if (document.Root?.Name != BookmarksXml.RootName)
			throw new RpcException(ErrorCodes.InvalidParams, "The file is not a dnSpy settings file.");
		var breakpoints = new List<BreakpointFileEntryDto>();
		var skipped = 0;
		var sections = document.Root.Elements(BookmarksXml.SectionName)
			.Where(section => Guid.TryParse(BookmarksXml.Unescape(BookmarksXml.Attribute(section, BookmarksXml.SectionNameAttribute)), out var guid) && guid == SettingsGuid);
		foreach (var section in sections.SelectMany(section => BookmarksXml.Children(section, BreakpointSectionName))) {
			if (ReadBreakpoint(section, findModule) is { } breakpoint)
				breakpoints.Add(breakpoint);
			else
				skipped++;
		}
		return new ImportBreakpointsResponse(breakpoints, skipped);
	}

	/// <summary>
	/// One breakpoint, or nothing for a row BreakpointsSerializer drops: no IsEnabled, a location that does not
	/// read, a dynamic or in-memory module, or a Method that no longer names the member. A module that cannot be read
	/// here keeps its row — the file may come from another machine.
	/// </summary>
	static BreakpointFileEntryDto? ReadBreakpoint(XElement section, Func<string, ModuleDef?> findModule) {
		var isEnabled = BookmarksXml.ParseBool(BookmarksXml.Attribute(section, "IsEnabled"));
		var location = BookmarksXml.Children(section, LocationSectionName).FirstOrDefault();
		if (isEnabled is null || location is null)
			return null;
		var token = BookmarksXml.ParseUInt32(BookmarksXml.Attribute(location, "Token"));
		var offset = BookmarksXml.ParseUInt32(BookmarksXml.Attribute(location, "Offset"));
		var assemblyFullName = BookmarksXml.Attribute(location, "AssemblyFullName");
		var moduleName = BookmarksXml.Attribute(location, "ModuleName");
		if (BookmarksXml.Attribute(location, LocationTypeAttribute) != DotNet || token is null || offset is null || assemblyFullName is null || string.IsNullOrEmpty(moduleName))
			return null;
		if (BookmarksXml.ParseBool(BookmarksXml.Attribute(location, "IsDynamic")) == true || BookmarksXml.ParseBool(BookmarksXml.Attribute(location, "IsInMemory")) == true || BookmarksXml.ParseBool(BookmarksXml.Attribute(location, "ModuleNameOnly")) == true)
			return null;
		var method = BookmarksXml.Attribute(location, "Method");
		var module = findModule(moduleName);
		if (!string.IsNullOrEmpty(method) && module is not null && BookmarksXml.TokenString(module, token.Value) != method)
			return null;
		var labels = (BookmarksXml.Attribute(section, "Labels") ?? string.Empty)
			.Split(',', StringSplitOptions.RemoveEmptyEntries)
			.Select(label => label.Trim())
			.Where(label => label.Length > 0)
			.ToArray();
		BreakpointFileConditionDto? condition = null;
		if (BookmarksXml.Children(section, "Condition").FirstOrDefault() is { } conditionSection &&
			BookmarksXml.Attribute(conditionSection, "Kind") is { } conditionKind && BookmarksXml.Attribute(conditionSection, "Condition") is { } expression &&
			conditionKind is "IsTrue" or "WhenChanged")
			condition = new BreakpointFileConditionDto(conditionKind == "WhenChanged" ? "whenChanged" : "isTrue", expression);
		BreakpointFileHitCountDto? hitCount = null;
		if (BookmarksXml.Children(section, "HitCount").FirstOrDefault() is { } hitCountSection &&
			BookmarksXml.Attribute(hitCountSection, "Kind") is { } hitCountKind && int.TryParse(BookmarksXml.Attribute(hitCountSection, "Count"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)) {
			var kind = hitCountKind switch {
				"Equals" => "equals",
				"MultipleOf" => "multipleOf",
				"GreaterThanOrEquals" => "greaterThanOrEquals",
				_ => null,
			};
			if (kind is not null)
				hitCount = new BreakpointFileHitCountDto(kind, count);
		}
		var filter = BookmarksXml.Children(section, "Filter").FirstOrDefault() is { } filterSection ? BookmarksXml.Attribute(filterSection, "Filter") : null;
		BreakpointFileTraceDto? trace = null;
		if (BookmarksXml.Children(section, "Trace").FirstOrDefault() is { } traceSection && BookmarksXml.Attribute(traceSection, "Message") is { } message)
			trace = new BreakpointFileTraceDto(message, BookmarksXml.ParseBool(BookmarksXml.Attribute(traceSection, "Continue")) ?? true);
		return new BreakpointFileEntryDto(
			moduleName,
			unchecked((int)token.Value),
			unchecked((int)offset.Value),
			isEnabled.Value,
			new BreakpointFileSettingsDto(condition, hitCount, filter, trace, labels),
			string.IsNullOrEmpty(method) ? null : method);
	}
}
