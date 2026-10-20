using System.Xml.Linq;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The workspace half of dnSpy's code breakpoint commands: what Add Method Breakpoint, Add Class Breakpoint and Break
/// When Thrown act on, and the breakpoint file the Breakpoints window exports and imports.
/// </summary>
public sealed class BreakpointCommandsTests : IDisposable {
	readonly WorkspaceManager manager = new();
	static readonly string DebugTargetPath = Path.Combine(AppContext.BaseDirectory, "DebugTarget.dll");

	static TypeDef FindType(ModuleDef module, string name) => module.Find(name, isReflectionName: true) ?? throw new InvalidOperationException($"No type {name}.");

	async Task<DebugCodeTargetsResponse> TargetsAsync(params DebugCodeReferenceDto[] references) =>
		await manager.GetDebugCodeTargetsAsync(new DebugCodeTargetsRequest(null, references), TestContext.Current.CancellationToken);

	[Fact]
	public async Task AMethodBreakpointGoesAtTheMethodAPropertyBreakpointAtItsAccessors() {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var program = FindType(module, "DebugTarget.Program");
		var shape = FindType(module, "DebugTarget.Program+Shape");
		var calculate = program.FindMethod("Calculate");
		var sides = shape.FindProperty("Sides");

		var method = await TargetsAsync(new DebugCodeReferenceDto(null, DebugTargetPath, unchecked((int)calculate.MDToken.Raw)));
		var target = Assert.Single(method.Methods);
		Assert.Equal(unchecked((int)calculate.MDToken.Raw), target.MetadataToken);
		Assert.Equal(DebugTargetPath, target.ModulePath);
		Assert.Equal(calculate.FullName, target.Description);
		// A method is no type: the class commands do not show.
		Assert.Null(method.TypeMethods);
		Assert.Null(method.ExceptionTypeName);

		var property = await TargetsAsync(new DebugCodeReferenceDto(null, DebugTargetPath, unchecked((int)sides.MDToken.Raw)));
		Assert.Equal(
			new[] { sides.GetMethod.MDToken.Raw, sides.SetMethod.MDToken.Raw }.Order(),
			property.Methods.Select(candidate => unchecked((uint)candidate.MetadataToken)).Order());
	}

	[Fact]
	public async Task AClassBreakpointGoesAtEveryMethodOfTheTypeWithCode() {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var shape = FindType(module, "DebugTarget.Program+Shape");
		var worker = FindType(module, "DebugTarget.Program+IWorker");

		var targets = await TargetsAsync(new DebugCodeReferenceDto(null, DebugTargetPath, unchecked((int)shape.MDToken.Raw)));
		Assert.NotNull(targets.TypeMethods);
		Assert.Equal(
			shape.Methods.Select(method => method.MDToken.Raw).Order(),
			targets.TypeMethods!.Select(method => unchecked((uint)method.MetadataToken)).Order());
		Assert.All(targets.TypeMethods!, method => Assert.True(method.HasBody));
		Assert.Equal(shape.FullName, targets.TypeName);
		// An interface's methods are collected, and have no code to break on.
		var abstractTargets = await TargetsAsync(new DebugCodeReferenceDto(null, DebugTargetPath, unchecked((int)worker.MDToken.Raw)));
		Assert.All(abstractTargets.TypeMethods!, method => Assert.False(method.HasBody));
	}

	[Fact]
	public async Task BreakWhenThrownIsOfferedOnAnExceptionTypeOnly() {
		var corelib = typeof(InvalidOperationException).Module.FullyQualifiedName;
		var exception = await TargetsAsync(new DebugCodeReferenceDto(null, corelib, typeof(InvalidOperationException).MetadataToken));
		Assert.Equal("System.InvalidOperationException", exception.ExceptionTypeName);
		var notException = await TargetsAsync(new DebugCodeReferenceDto(null, corelib, typeof(string).MetadataToken));
		Assert.Null(notException.ExceptionTypeName);
		// Two references are not one exception.
		var two = await TargetsAsync(
			new DebugCodeReferenceDto(null, corelib, typeof(InvalidOperationException).MetadataToken),
			new DebugCodeReferenceDto(null, corelib, typeof(ArgumentException).MetadataToken));
		Assert.Null(two.ExceptionTypeName);
	}

	[Fact]
	public async Task WritesAndReadsTheBreakpointFileTheWayDnSpyDoes() {
		using var module = ModuleDefMD.Load(DebugTargetPath);
		var calculate = FindType(module, "DebugTarget.Program").FindMethod("Calculate");
		var token = unchecked((int)calculate.MDToken.Raw);
		var settings = new BreakpointFileSettingsDto(
			new BreakpointFileConditionDto("whenChanged", "left > 1"),
			new BreakpointFileHitCountDto("multipleOf", 3),
			"ThreadId == 1",
			new BreakpointFileTraceDto("{left}", false),
			["one", "two"]);
		var xml = (await manager.ExportBreakpointsAsync(new ExportBreakpointsRequest(null, [
			new BreakpointFileEntryDto(DebugTargetPath, token, 7, true, settings),
			new BreakpointFileEntryDto(DebugTargetPath, token, 0, false, null),
		]), TestContext.Current.CancellationToken)).Xml;

		var root = XDocument.Parse(xml).Root!;
		var section = Assert.Single(root.Elements("section"));
		Assert.Equal("fbc6039c-8a7a-49dc-9c32-52c1b73de0a3", (string?)section.Attribute("_"));
		var first = section.Elements("section").First();
		Assert.Equal("Breakpoint", (string?)first.Attribute("_"));
		Assert.Equal("True", (string?)first.Attribute("IsEnabled"));
		Assert.Equal("one, two", (string?)first.Attribute("Labels"));
		var location = first.Elements("section").Single(child => (string?)child.Attribute("_") == "BPL");
		Assert.Equal("DotNet", (string?)location.Attribute("__BPT"));
		Assert.Equal(calculate.MDToken.Raw.ToString(System.Globalization.CultureInfo.InvariantCulture), (string?)location.Attribute("Token"));
		Assert.Equal("7", (string?)location.Attribute("Offset"));
		Assert.Equal(calculate.FullName, (string?)location.Attribute("Method"));
		// The sections come in the order XmlSettingsWriter sorts them, Continue only when it is false.
		Assert.Equal(["BPL", "Condition", "Filter", "HitCount", "Trace"], first.Elements("section").Select(child => (string)child.Attribute("_")!));
		Assert.Equal("WhenChanged", (string?)first.Elements("section").Single(child => (string?)child.Attribute("_") == "Condition").Attribute("Kind"));
		Assert.Equal("False", (string?)first.Elements("section").Single(child => (string?)child.Attribute("_") == "Trace").Attribute("Continue"));

		var read = await manager.ImportBreakpointsAsync(new ImportBreakpointsRequest(null, xml), TestContext.Current.CancellationToken);
		Assert.Equal(0, read.Skipped);
		Assert.Equal(2, read.Breakpoints.Count);
		var back = read.Breakpoints[0];
		Assert.Equal(DebugTargetPath, back.ModulePath);
		Assert.Equal(token, back.MetadataToken);
		Assert.Equal(7, back.IlOffset);
		Assert.True(back.Enabled);
		Assert.Equal(settings.Condition, back.Settings!.Condition);
		Assert.Equal(settings.HitCount, back.Settings.HitCount);
		Assert.Equal(settings.Filter, back.Settings.Filter);
		Assert.Equal(settings.Trace, back.Settings.Trace);
		Assert.Equal(settings.Labels, back.Settings.Labels);
		Assert.False(read.Breakpoints[1].Enabled);

		// A method that no longer has the name the file gave it is dropped, as dnSpy drops it.
		var stale = xml.Replace(calculate.FullName, "System.Int32 DebugTarget.Program::Gone(System.Int32,System.Int32)", StringComparison.Ordinal);
		var dropped = await manager.ImportBreakpointsAsync(new ImportBreakpointsRequest(null, stale), TestContext.Current.CancellationToken);
		Assert.Equal(2, dropped.Skipped);
		Assert.Empty(dropped.Breakpoints);
	}

	public void Dispose() => manager.Dispose();
}
