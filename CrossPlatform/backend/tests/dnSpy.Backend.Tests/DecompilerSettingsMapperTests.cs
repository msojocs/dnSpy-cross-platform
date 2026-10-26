using System.Reflection;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core;
using Xunit;

namespace dnSpy.Backend.Tests;

/// <summary>
/// The DTO decompiler settings to ICSharpCode.Decompiler's <c>DecompilerSettings</c>: the options the NuGet package
/// has on it, the ones only dnSpy's fork of ILSpy has on <see cref="DnSpyDecompilerSettings"/>.
/// </summary>
public sealed class DecompilerSettingsMapperTests {
	static CSharpDecompilerSettingsDto AllOn() => new(
		AnonymousMethods: true,
		YieldReturn: true,
		AsyncAwait: true,
		QueryExpressions: true,
		ExpressionTrees: true,
		UseDebugSymbols: true,
		ShowXmlDocumentation: true,
		SortCustomAttributes: true);

	static CSharpDecompilerSettingsDto AllOff() => new(
		AnonymousMethods: false,
		YieldReturn: false,
		AsyncAwait: false,
		QueryExpressions: false,
		ExpressionTrees: false,
		UseDebugSymbols: false,
		ShowXmlDocumentation: false,
		SortCustomAttributes: false);

	[Fact]
	public void MapsEveryCSharpOptionThePackageHas() {
		var settings = new DecompilerSettingsDto(CSharp: AllOn()).ToDecompilerSettings();

		Assert.True(settings.AnonymousMethods);
		Assert.True(settings.YieldReturn);
		Assert.True(settings.AsyncAwait);
		Assert.True(settings.QueryExpressions);
		Assert.True(settings.ExpressionTrees);
		Assert.True(settings.UseDebugSymbols);
		Assert.True(settings.ShowXmlDocumentation);
		Assert.True(settings.SortCustomAttributes);

		var off = new DecompilerSettingsDto(CSharp: AllOff()).ToDecompilerSettings();
		Assert.False(off.AnonymousMethods);
		Assert.False(off.YieldReturn);
		Assert.False(off.AsyncAwait);
		Assert.False(off.QueryExpressions);
		Assert.False(off.ExpressionTrees);
		Assert.False(off.UseDebugSymbols);
		Assert.False(off.ShowXmlDocumentation);
		Assert.False(off.SortCustomAttributes);
	}

	[Fact]
	public void SettingsWithoutTheCSharpPageAreThePagesDefaults() {
		// An IL-only or BAML-only request gets the page's defaults, which are the package's for its own options.
		var settings = new DecompilerSettingsDto().ToDecompilerSettings();

		Assert.Equal(new ICSharpCode.Decompiler.DecompilerSettings().AnonymousMethods, settings.AnonymousMethods);
		Assert.Equal(new ICSharpCode.Decompiler.DecompilerSettings().AsyncAwait, settings.AsyncAwait);
		Assert.Equal(new ICSharpCode.Decompiler.DecompilerSettings().ShowXmlDocumentation, settings.ShowXmlDocumentation);
	}

	/// <summary>
	/// Every option on the C# page reaches the decompiler: on the package's settings where it has the option, on
	/// <see cref="DnSpyDecompilerSettings"/> where only dnSpy's fork has it.
	/// </summary>
	[Fact]
	public void EveryOptionOfThePageReachesTheDecompiler() {
		var package = typeof(ICSharpCode.Decompiler.DecompilerSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
		var fork = typeof(DnSpyDecompilerSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly).Select(property => property.Name).ToHashSet(StringComparer.Ordinal);
		foreach (var name in typeof(CSharpDecompilerSettingsDto).GetProperties().Select(property => property.Name))
			Assert.True(package.Contains(name) || fork.Contains(name), $"{name} reaches nothing.");
	}

	[Fact]
	public void CarriesTheForkOnlyOptionsAndItsDefaults() {
		var defaults = Assert.IsType<DnSpyDecompilerSettings>(((DecompilerSettingsDto?)null).ToDecompilerSettings());
		// dnSpy's ILSpy fork's defaults (DecompilerSettings.cs).
		Assert.True(defaults.ShowTokenAndRvaComments);
		Assert.True(defaults.UseSourceCodeOrder);
		Assert.True(defaults.OneCustomAttributePerLine);
		Assert.True(defaults.TypeAddInternalModifier);
		Assert.True(defaults.MemberAddPrivateModifier);
		Assert.False(defaults.HexadecimalNumbers);
		Assert.True(defaults.SortSystemUsingStatementsFirst);
		Assert.True(defaults.RemoveEmptyDefaultConstructors);
		Assert.True(defaults.InsertParenthesesForReadability);
		Assert.Equal(DnSpyDecompilerSettings.DefaultDecompilationOrder, defaults.DecompilationOrder);

		var set = Assert.IsType<DnSpyDecompilerSettings>(new DecompilerSettingsDto(CSharp: new CSharpDecompilerSettingsDto(
			ShowTokenAndRvaComments: false, SortMembers: true, FullyQualifyAllTypes: true, ForceShowAllMembers: true,
			DecompilationOrder: ["methods", "fields", "nestedTypes", "events", "properties"])).ToDecompilerSettings());
		Assert.False(set.ShowTokenAndRvaComments);
		Assert.True(set.SortMembers);
		Assert.True(set.FullyQualifyAllTypes);
		Assert.False(set.UsingDeclarations);
		Assert.False(set.AutomaticProperties);
		Assert.False(set.RemoveEmptyDefaultConstructors);
		Assert.Equal("methods", set.DecompilationOrder[0]);

		var forkOnly = Assert.IsType<DnSpyDecompilerSettings>(new DecompilerSettingsDto(CSharp: new CSharpDecompilerSettingsDto(
			FullyQualifyAmbiguousTypeNames: false, AllowFieldInitializers: false, EmitCalliAsInvocationExpression: true, ForceShowAllMembers: true)).ToDecompilerSettings());
		Assert.False(forkOnly.FullyQualifyAmbiguousTypeNames);
		Assert.False(forkOnly.AllowFieldInitializers);
		Assert.True(forkOnly.EmitCalliAsInvocationExpression);
		Assert.True(forkOnly.ForceShowAllMembers);
		// The second pass ForceShowAllMembers runs: every hiding switch off, the page's own options unchanged.
		var showAll = forkOnly.ForShowAllMembers();
		Assert.False(showAll.AnonymousMethods);
		Assert.False(showAll.AsyncAwait);
		Assert.False(showAll.YieldReturn);
		Assert.False(showAll.LocalFunctions);
		Assert.False(showAll.AutomaticProperties);
		Assert.False(showAll.AutomaticEvents);
		Assert.True(showAll.ForceShowAllMembers);
		Assert.False(showAll.FullyQualifyAmbiguousTypeNames);

		// A clone keeps them: the package clones its settings before it uses them.
		Assert.IsType<DnSpyDecompilerSettings>(set.Clone());
		Assert.True(((DnSpyDecompilerSettings)set.Clone()).SortMembers);

		// VBDecompiler writes every access modifier whatever the page says.
		var visualBasic = Assert.IsType<DnSpyDecompilerSettings>(new DecompilerSettingsDto(CSharp: new CSharpDecompilerSettingsDto(TypeAddInternalModifier: false, MemberAddPrivateModifier: false)).ToVisualBasicSettings());
		Assert.True(visualBasic.TypeAddInternalModifier);
		Assert.True(visualBasic.MemberAddPrivateModifier);
	}
}
