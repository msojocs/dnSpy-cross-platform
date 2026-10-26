/*
    Copyright (C) 2014-2019 de4dot@gmail.com

    This file is part of dnSpy

    dnSpy is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    dnSpy is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with dnSpy.  If not, see <http://www.gnu.org/licenses/>.
*/

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/: BuildAction.cs, IJob.cs, DecompileContext.cs, ProjectFile.cs,
// TypeProjectFile.cs, XamlTypeProjectFile.cs, WinFormsProjectFile.cs, SettingsTypeProjectFile.cs,
// AssemblyInfoProjectFile.cs, ResXProjectFile.cs, RawEmbeddedResourceProjectFile.cs, ResourceProjectFile.cs,
// SplashScreenProjectFile.cs, AppConfigProjectFile.cs, BamlResourceProjectFile.cs, ApplicationIcon.cs and
// ApplicationManifest.cs).

using System.Text;
using System.Xml;
using dnlib.DotNet;
using dnlib.DotNet.Emit;
using dnlib.DotNet.Resources;
using dnlib.IO;
using dnlib.W32Resources;

namespace dnSpy.Backend.Core.ProjectExport;

enum BuildAction {
	/// <summary>
	/// The created file isn't included in the project file. Can be used if the file turned out
	/// to be empty and no file was created.
	/// </summary>
	DontIncludeInProjectFile,
	None,
	Compile,
	EmbeddedResource,
	ApplicationDefinition,
	Page,
	Resource,
	SplashScreen,
}

/// <summary>What a job is told: the export's cancellation and where its errors go.</summary>
sealed record DecompileContext(CancellationToken CancellationToken, Action<string> Logger);

/// <summary>One unit of the export's work — a file written — which runs on any thread.</summary>
interface IJob {
	string Description { get; }
	Task CreateAsync(DecompileContext ctx);
}

interface IFileJob : IJob {
	string Filename { get; }
}

/// <summary>A file of the project, and what the project file says of it.</summary>
abstract class ProjectFile : IFileJob {
	public abstract string Description { get; }
	public abstract string Filename { get; }
	public abstract BuildAction BuildAction { get; }
	public ProjectFile? DependentUpon { get; set; }
	public string? SubType { get; set; }
	public string? Generator { get; set; }
	public ProjectFile? LastGenOutput { get; set; }
	public bool AutoGen { get; set; }
	public bool DesignTime { get; set; }
	public bool DesignTimeSharedInput { get; set; }

	/// <summary>Writes the file. A file that is not code is written by <see cref="Create"/>, on the job's thread.</summary>
	public virtual Task CreateAsync(DecompileContext ctx) {
		Create(ctx);
		return Task.CompletedTask;
	}

	protected virtual void Create(DecompileContext ctx) => throw new NotSupportedException();

	/// <summary>A code file, UTF-8 with a byte order mark as dnSpy writes them.</summary>
	protected static StreamWriter CreateText(string filename) => new(filename, false, Encoding.UTF8);
}

/// <summary>dnSpy's DecompilePartialType: the part of a type one file of a partial class holds.</summary>
sealed class PartialTypeRequest(TypeDef type) {
	public TypeDef Type { get; } = type;
	/// <summary>Whether the type is written partial.</summary>
	public bool AddPartialKeyword { get; set; } = true;
	/// <summary>The members this file leaves out — or, with <see cref="ShowDefinitions"/>, the only ones it writes.</summary>
	public HashSet<IMemberDef> Definitions { get; } = [];
	public bool ShowDefinitions { get; set; }
	public bool UseUsingDeclarations { get; set; } = true;
	/// <summary>The interfaces taken off the type's base list, by full name.</summary>
	public HashSet<string> InterfacesToRemove { get; } = new(StringComparer.Ordinal);
}

class TypeProjectFile(TypeDef type, string filename, ProjectDecompiler decompiler) : ProjectFile {
	public override string Description => $"Decompile type {Type.FullName}";
	public override BuildAction BuildAction => BuildAction.Compile;
	public override string Filename => filename;

	protected readonly ProjectDecompiler decompiler = decompiler;

	public TypeDef Type { get; } = type;

	public override async Task CreateAsync(DecompileContext ctx) {
		using var writer = CreateText(Filename);
		await DecompileAsync(ctx, writer).ConfigureAwait(false);
	}

	protected virtual Task DecompileAsync(DecompileContext ctx, TextWriter output) =>
		decompiler.DecompileTypeAsync(Type, output, Filename, ctx);
}

/// <summary>The code-behind of a XAML file: partial, without what the XAML build generates again.</summary>
sealed class XamlTypeProjectFile(TypeDef type, string filename, ProjectDecompiler projectDecompiler) : TypeProjectFile(type, filename, projectDecompiler) {
	protected override Task DecompileAsync(DecompileContext ctx, TextWriter output) {
		var opts = new PartialTypeRequest(Type);
		foreach (var d in GetDefsToRemove())
			opts.Definitions.Add(d);
		opts.InterfacesToRemove.Add("System.Windows.Markup.IComponentConnector");
		opts.InterfacesToRemove.Add("System.Windows.Markup.IStyleConnector");
		return decompiler.DecompilePartialTypeAsync(opts, output, Filename, ctx);
	}

	IEnumerable<IMemberDef> GetDefsToRemove() {
		var ep = Type.Module.EntryPoint;
		if (ep is not null && ep.DeclaringType == Type)
			yield return ep;

		var d = FindInitializeComponent();
		if (d is not null) {
			yield return d;
			foreach (var f in DotNetUtils.GetFields(d)) {
				if (f.FieldType.RemovePinnedAndModifiers().GetElementType() == ElementType.Boolean)
					yield return f;
			}
		}

		var connMeth = FindConnectMethod();
		if (connMeth is not null) {
			yield return connMeth;
			foreach (var f in DotNetUtils.GetFields(connMeth))
				yield return f;
		}

		var delMeth = FindCreateDelegateMethod();
		if (delMeth is not null)
			yield return delMeth;
	}

	MethodDef? FindInitializeComponent() {
		foreach (var md in Type.FindMethods("InitializeComponent")) {
			if (md.IsStatic || md.Parameters.Count != 1)
				continue;
			if (md.ReturnType.RemovePinnedAndModifiers().GetElementType() != ElementType.Void)
				continue;
			return md;
		}
		return null;
	}

	MethodDef? FindConnectMethod() => Type.Methods.FirstOrDefault(IsConnect);

	static bool IsConnect(MethodDef md) {
		if (md is null || md.IsStatic || md.Parameters.Count != 3)
			return false;
		if (md.ReturnType.RemovePinnedAndModifiers().GetElementType() != ElementType.Void)
			return false;
		var sig = md.MethodSig;
		if (sig is null || sig.Params.Count != 2)
			return false;
		if (sig.Params[0].RemovePinnedAndModifiers().GetElementType() != ElementType.I4)
			return false;
		if (sig.Params[1].RemovePinnedAndModifiers().GetElementType() != ElementType.Object)
			return false;
		foreach (var o in md.Overrides) {
			if (o.MethodDeclaration?.DeclaringType is null)
				continue;
			if (o.MethodDeclaration.DeclaringType.FullName != "System.Windows.Markup.IComponentConnector")
				continue;
			if (o.MethodDeclaration.Name != "Connect")
				continue;
			return true;
		}
		return md.Name == "Connect";
	}

	// Finds 'internal Delegate _CreateDelegate(Type delegateType, string handler)' which is
	// called by XamlGeneratedNamespace.GeneratedInternalTypeHelper.CreateDelegate()
	MethodDef? FindCreateDelegateMethod() {
		foreach (var m in Type.Methods) {
			if (m.Name != "_CreateDelegate")
				continue;
			if (m.IsStatic || !m.IsAssembly)
				continue;
			var sig = m.MethodSig;
			if (sig.GetParamCount() != 2)
				continue;
			if (sig.RetType.RemovePinnedAndModifiers()?.ToString() != "System.Delegate")
				continue;
			if (sig.Params[0].RemovePinnedAndModifiers()?.ToString() != "System.Type")
				continue;
			if (sig.Params[1].RemovePinnedAndModifiers()?.GetElementType() != ElementType.String)
				continue;
			return m;
		}
		return null;
	}
}

/// <summary>A form's own file: the form without what its Designer file holds.</summary>
sealed class WinFormsProjectFile : TypeProjectFile {
	public override string Description => "Create WinForms file";
	public ProjectDecompiler Decompiler => decompiler;

	public WinFormsProjectFile(TypeDef type, string filename, ProjectDecompiler decompiler) : base(type, filename, decompiler) => SubType = "Form";

	protected override Task DecompileAsync(DecompileContext ctx, TextWriter output) {
		var opts = new PartialTypeRequest(Type);
		foreach (var d in GetDefsToRemove())
			opts.Definitions.Add(d);
		return decompiler.DecompilePartialTypeAsync(opts, output, Filename, ctx);
	}

	public IMemberDef[] GetDefsToRemove() {
		if (defsToRemove is not null)
			return defsToRemove;
		lock (defsToRemoveLock)
			defsToRemove ??= CalculateDefsToRemove().Distinct().ToArray();
		return defsToRemove;
	}
	readonly object defsToRemoveLock = new();
	IMemberDef[]? defsToRemove;

	IEnumerable<IMemberDef> CalculateDefsToRemove() {
		var m = GetInitializeComponent();
		if (m is not null) {
			yield return m;
			foreach (var f in DotNetUtils.GetFields(m))
				yield return f;
		}

		m = GetDispose();
		if (m is not null) {
			yield return m;
			foreach (var f in DotNetUtils.GetFields(m))
				yield return f;
		}
	}

	MethodDef? GetInitializeComponent() {
		foreach (var m in Type.Methods) {
			if (m.Access != MethodAttributes.Private)
				continue;
			if (m.IsStatic || m.Parameters.Count != 1)
				continue;
			if (m.ReturnType.RemovePinnedAndModifiers().GetElementType() != ElementType.Void)
				continue;
			if (m.Name != "InitializeComponent")
				continue;
			if (m.Body is null)
				continue;
			return m;
		}
		return null;
	}

	MethodDef? GetDispose() {
		foreach (var m in Type.Methods) {
			if (m.Access != MethodAttributes.Family)
				continue;
			if (m.IsStatic || m.Parameters.Count != 2 || m.Parameters[1].Type.RemovePinnedAndModifiers().GetElementType() != ElementType.Boolean)
				continue;
			if (m.ReturnType.RemovePinnedAndModifiers().GetElementType() != ElementType.Void)
				continue;
			if (m.Name != "Dispose")
				continue;
			if (m.Body is null)
				continue;
			return m;
		}
		return null;
	}
}

/// <summary>A form's Designer file: InitializeComponent, Dispose and the fields they use, with full type names.</summary>
sealed class WinFormsDesignerProjectFile(WinFormsProjectFile winFormsFile, string filename) : ProjectFile {
	public override string Description => "Create WinForms Designer file";
	public override BuildAction BuildAction => BuildAction.Compile;
	public override string Filename => filename;

	public override async Task CreateAsync(DecompileContext ctx) {
		using var writer = CreateText(Filename);
		var opts = new PartialTypeRequest(winFormsFile.Type);
		foreach (var d in winFormsFile.GetDefsToRemove())
			opts.Definitions.Add(d);
		opts.ShowDefinitions = true;
		opts.UseUsingDeclarations = false;
		await winFormsFile.Decompiler.DecompilePartialTypeAsync(opts, writer, Filename, ctx).ConfigureAwait(false);
	}
}

/// <summary>A settings class's own file: what the settings designer did not generate, if anything is left.</summary>
sealed class SettingsTypeProjectFile(TypeDef type, string filename, ProjectDecompiler projectDecompiler) : TypeProjectFile(type, filename, projectDecompiler) {
	public override string Description => "Create settings file";
	public ProjectDecompiler Decompiler => decompiler;
	public override BuildAction BuildAction => isEmpty ? BuildAction.DontIncludeInProjectFile : base.BuildAction;
	bool isEmpty;

	public override Task CreateAsync(DecompileContext ctx) {
		InitializeIsEmpty();
		return isEmpty ? Task.CompletedTask : base.CreateAsync(ctx);
	}

	protected override Task DecompileAsync(DecompileContext ctx, TextWriter output) {
		var opts = new PartialTypeRequest(Type);
		foreach (var d in GetDefsToRemove())
			opts.Definitions.Add(d);
		return decompiler.DecompilePartialTypeAsync(opts, output, Filename, ctx);
	}

	void InitializeIsEmpty() {
		var allDefs = new HashSet<object>();
		foreach (var m in Type.Methods) allDefs.Add(m);
		foreach (var f in Type.Fields) allDefs.Add(f);
		foreach (var p in Type.Properties) allDefs.Add(p);
		foreach (var e in Type.Events) allDefs.Add(e);
		foreach (var t in Type.NestedTypes) allDefs.Add(t);
		foreach (var d in GetDefsToRemove()) {
			allDefs.Remove(d);
			if (d is PropertyDef property) {
				foreach (var def in DotNetUtils.GetMethodsAndSelf(property))
					allDefs.Remove(def);
			}
		}
		if (Type.FindStaticConstructor() is { } cctor)
			allDefs.Remove(cctor);
		if (Type.FindDefaultConstructor() is { } ctor)
			allDefs.Remove(ctor);
		isEmpty = allDefs.Count == 0;
	}

	public IMemberDef[] GetDefsToRemove() {
		if (defsToRemove is not null)
			return defsToRemove;
		lock (defsToRemoveLock)
			defsToRemove ??= CalculateDefsToRemove().Distinct().ToArray();
		return defsToRemove;
	}
	readonly object defsToRemoveLock = new();
	IMemberDef[]? defsToRemove;

	IEnumerable<IMemberDef> CalculateDefsToRemove() {
		var defaultProp = FindDefaultProperty();
		if (defaultProp is not null) {
			foreach (var d in DotNetUtils.GetMethodsAndSelf(defaultProp))
				yield return d;
			foreach (var d in DotNetUtils.GetDefs(defaultProp))
				yield return d;
		}

		foreach (var p in Type.Properties) {
			if (p.CustomAttributes.IsDefined("System.Configuration.DefaultSettingValueAttribute")) {
				foreach (var d in DotNetUtils.GetMethodsAndSelf(p))
					yield return d;
			}
		}
	}

	PropertyDef? FindDefaultProperty() {
		foreach (var p in Type.Properties) {
			if (p.Name != "Default")
				continue;
			var g = p.GetMethod;
			if (g is null || !g.IsStatic || p.SetMethod is not null || p.OtherMethods.Count != 0)
				continue;
			if (g.MethodSig.GetParamCount() != 0)
				continue;
			if (g.ReturnType.RemovePinnedAndModifiers().TryGetTypeDef() != Type)
				continue;
			if (g.Body is null)
				continue;
			return p;
		}
		return null;
	}
}

/// <summary>A settings class's Designer file: Default and the properties the .settings file describes.</summary>
sealed class SettingsDesignerTypeProjectFile(SettingsTypeProjectFile typeFile, string filename) : ProjectFile {
	public override string Description => "Create settings designer file";
	public override BuildAction BuildAction => BuildAction.Compile;
	public override string Filename => filename;

	public override async Task CreateAsync(DecompileContext ctx) {
		using var writer = CreateText(Filename);
		var opts = new PartialTypeRequest(typeFile.Type);
		foreach (var d in typeFile.GetDefsToRemove())
			opts.Definitions.Add(d);
		opts.ShowDefinitions = true;
		await typeFile.Decompiler.DecompilePartialTypeAsync(opts, writer, Filename, ctx).ConfigureAwait(false);
	}
}

/// <summary>Properties/AssemblyInfo: the assembly's and the module's attributes.</summary>
sealed class AssemblyInfoProjectFile(string filename, ProjectDecompiler decompiler) : ProjectFile {
	public override string Description => $"Decompile AssemblyInfo{decompiler.FileExtension}";
	public override BuildAction BuildAction => BuildAction.Compile;
	public override string Filename => filename;

	public override async Task CreateAsync(DecompileContext ctx) {
		using var writer = CreateText(Filename);
		await decompiler.DecompileAssemblyInfoAsync(writer, ctx).ConfigureAwait(false);
	}
}

sealed class ResXProjectFile(ModuleDef module, string filename, string typeFullName, ResourceElementSet resourceElementSet) : ProjectFile {
	public override string Description => "Create ResX file";
	public override BuildAction BuildAction => BuildAction.EmbeddedResource;
	public override string Filename => filename;
	public string TypeFullName { get; } = typeFullName;
	public bool IsSatelliteFile { get; set; }

	protected override void Create(DecompileContext ctx) {
		using (var writer = new ResXResourceFileWriter(Filename, module)) {
			foreach (var resourceElement in resourceElementSet.ResourceElements) {
				ctx.CancellationToken.ThrowIfCancellationRequested();
				writer.AddResourceData(resourceElement);
			}
		}
	}
}

sealed class RawEmbeddedResourceProjectFile(string filename, EmbeddedResource er) : ProjectFile {
	public override string Description => $"Create embedded resource {er.Name}";
	public override BuildAction BuildAction => BuildAction.EmbeddedResource;
	public override string Filename => filename;

	protected override void Create(DecompileContext ctx) {
		using (var stream = File.Create(Filename))
			er.CreateReader().CopyTo(stream);
	}
}

sealed class ResourceProjectFile(string filename, byte[] data, string rsrcName) : ProjectFile {
	public override string Description => $"Create resource {rsrcName}";
	public override BuildAction BuildAction => BuildAction.Resource;
	public override string Filename => filename;

	protected override void Create(DecompileContext ctx) {
		File.WriteAllBytes(Filename, data);
	}
}

sealed class SplashScreenProjectFile(string filename, byte[] data, string rsrcName) : ProjectFile {
	public override string Description => $"Create splash screen resource {rsrcName}";
	public override BuildAction BuildAction => BuildAction.SplashScreen;
	public override string Filename => filename;

	protected override void Create(DecompileContext ctx) {
		File.WriteAllBytes(Filename, data);
	}
}

sealed class AppConfigProjectFile(string filename, string existingName) : ProjectFile {
	public override string Description => $"Copy app.config ({existingName})";
	public override BuildAction BuildAction => BuildAction.None;
	public override string Filename => filename;

	protected override void Create(DecompileContext ctx) {
		File.Copy(existingName, Filename, true);
	}
}

/// <summary>A BAML resource decompiled to XAML: a page, or the application definition.</summary>
sealed class BamlResourceProjectFile : ProjectFile {
	public override string Description => "Decompile BAML";
	public bool IsAppDef { get; set; }
	public override BuildAction BuildAction => IsAppDef ? BuildAction.ApplicationDefinition : BuildAction.Page;
	public override string Filename { get; }
	public string TypeFullName { get; }
	public bool IsSatelliteFile { get; set; }

	readonly byte[] bamlData;
	readonly Func<byte[], Stream, CancellationToken, IList<string>> decompileBaml;
	readonly HashSet<IAssembly> asmRefs = new(AssemblyNameComparer.CompareAll);

	/// <summary>The assemblies the XAML names, which the project references besides the module's own.</summary>
	public IEnumerable<IAssembly> AssemblyReferences => asmRefs;

	public BamlResourceProjectFile(string filename, byte[] bamlData, string typeFullName, Func<byte[], Stream, CancellationToken, IList<string>> decompileBaml) {
		Filename = filename;
		this.bamlData = bamlData;
		TypeFullName = typeFullName;
		SubType = "Designer";
		Generator = "MSBuild:Compile";
		this.decompileBaml = decompileBaml;
	}

	protected override void Create(DecompileContext ctx) {
		IList<string> refs;
		using (var stream = File.Create(Filename))
			refs = decompileBaml(bamlData, stream, ctx.CancellationToken);
		lock (asmRefs) {
			foreach (var asmRef in refs) {
				var a = new AssemblyNameInfo(asmRef);
				if (!UTF8String.IsNullOrEmpty(a.Name))
					asmRefs.Add(a);
			}
		}
	}
}

/// <summary>App.xaml isn't always created, so it's recreated from the info found in the application class.</summary>
sealed class AppBamlResourceProjectFile : ProjectFile {
	public override string Description => "Create App.xaml";
	public override BuildAction BuildAction { get; }
	public override string Filename { get; }

	readonly TypeDef type;
	readonly ProjectDecompiler decompiler;

	public AppBamlResourceProjectFile(string filename, TypeDef type, ProjectDecompiler decompiler) {
		Filename = filename;
		this.type = type;
		SubType = "Designer";
		Generator = "MSBuild:Compile";
		BuildAction = DotNetUtils.IsStartUpClass(type) ? BuildAction.ApplicationDefinition : BuildAction.Page;
		this.decompiler = decompiler;
	}

	CilBody? GetInitializeComponentBody() =>
		type.FindMethods("InitializeComponent").FirstOrDefault(a => a.Parameters.Count == 1 && !a.IsStatic)?.Body;

	static string? GetStartupUri(CilBody body) =>
		body.Instructions.Select(a => a.Operand).OfType<string>().FirstOrDefault(s => s.EndsWith(".xaml", StringComparison.OrdinalIgnoreCase));

	protected override void Create(DecompileContext ctx) {
		var settings = new XmlWriterSettings {
			Encoding = Encoding.UTF8,
			Indent = true,
			OmitXmlDeclaration = true,
		};
		using (var writer = XmlWriter.Create(Filename, settings)) {
			writer.WriteStartDocument();
			writer.WriteStartElement("Application", "http://schemas.microsoft.com/winfx/2006/xaml/presentation");
			writer.WriteAttributeString("x", "Class", "http://schemas.microsoft.com/winfx/2006/xaml", type.ReflectionFullName);
			if (type.IsNotPublic)
				writer.WriteAttributeString("x", "ClassModifier", "http://schemas.microsoft.com/winfx/2006/xaml", decompiler.InternalClassModifier);
			var body = GetInitializeComponentBody();
			if (body is not null) {
				var startupUri = GetStartupUri(body);
				if (startupUri is not null)
					writer.WriteAttributeString("StartupUri", startupUri);
				foreach (var (name, handler) in GetEvents(body))
					writer.WriteAttributeString(name, handler);
			}
			writer.WriteElementString("Application.Resources", "\r\n");
			writer.WriteEndElement();
			writer.WriteEndDocument();
		}
	}

	static IEnumerable<(string, string)> GetEvents(CilBody body) {
		var instrs = body.Instructions;
		for (var i = 0; i + 2 < instrs.Count; i++) {
			if (instrs[i].OpCode.Code != Code.Ldftn && instrs[i].OpCode.Code != Code.Ldvirtftn)
				continue;
			if (instrs[i].Operand is not MethodDef m)
				continue;
			if (instrs[i + 1].OpCode.Code != Code.Newobj)
				continue;
			if (instrs[i + 2].OpCode.Code != Code.Call)
				continue;
			if (instrs[i + 2].Operand is not IMethod addMethod || addMethod.MethodSig.GetParamCount() != 1)
				continue;
			if (!addMethod.Name.StartsWith("add_"))
				continue;
			yield return (addMethod.Name.String[4..], m.Name.String);
		}
	}
}

/// <summary>The application icon, rebuilt as an .ico from the module's Win32 icon group resource.</summary>
sealed class ApplicationIcon : IFileJob {
	const int RT_ICON = 3;
	const int RT_GROUP_ICON = 14;

	public string Description => "Create application icon";
	public string Filename { get; }
	readonly byte[] data;

	ApplicationIcon(string filename, byte[] data) {
		Filename = filename;
		this.data = data;
	}

	public static ApplicationIcon? TryCreate(Win32Resources? resources, string filenameNoExt, FilenameCreator filenameCreator) {
		if (resources is null)
			return null;
		var dir = resources.Find(new ResourceName(RT_GROUP_ICON));
		if (dir is null || dir.Directories.Count == 0)
			return null;
		dir = dir.Directories[0];
		if (dir.Data.Count == 0)
			return null;
		var iconDir = resources.Find(new ResourceName(RT_ICON));
		if (iconDir is null)
			return null;
		var reader = dir.Data[0].CreateReader();
		var iconData = TryCreateIcon(ref reader, iconDir);
		if (iconData is null)
			return null;
		return new ApplicationIcon(filenameCreator.CreateName(filenameNoExt + ".ico"), iconData);
	}

	static byte[]? TryCreateIcon(ref DataReader reader, ResourceDirectory iconDir) {
		try {
			reader.Position = 0;
			var outStream = new MemoryStream();
			var writer = new BinaryWriter(outStream);
			// Write GRPICONDIR
			writer.Write(reader.ReadUInt16());
			writer.Write(reader.ReadUInt16());
			ushort numImages;
			writer.Write(numImages = reader.ReadUInt16());

			var entries = new List<GrpIconDirEntry>();
			for (var i = 0; i < numImages; i++) {
				var e = new GrpIconDirEntry();
				entries.Add(e);
				e.bWidth = reader.ReadByte();
				e.bHeight = reader.ReadByte();
				e.bColorCount = reader.ReadByte();
				e.bReserved = reader.ReadByte();
				e.wPlanes = reader.ReadUInt16();
				e.wBitCount = reader.ReadUInt16();
				e.dwBytesInRes = reader.ReadUInt32();
				e.nID = reader.ReadUInt16();
			}

			var dataOffset = 2 * 3 + (uint)entries.Count * 0x10;
			foreach (var e in entries) {
				writer.Write(e.bWidth);
				writer.Write(e.bHeight);
				writer.Write(e.bColorCount);
				writer.Write(e.bReserved);
				writer.Write(e.wPlanes);
				writer.Write(e.wBitCount);
				writer.Write(e.dwBytesInRes);
				writer.Write(dataOffset);
				dataOffset += e.dwBytesInRes;
			}

			foreach (var e in entries) {
				var d = iconDir.Directories.FirstOrDefault(a => a.Name == new ResourceName(e.nID));
				if (d is null || d.Data.Count == 0)
					return null;
				var r = d.Data[0].CreateReader();
				if (r.Length < e.dwBytesInRes)
					return null;
				writer.Write(r.ReadBytes((int)e.dwBytesInRes), 0, (int)e.dwBytesInRes);
			}

			return outStream.ToArray();
		}
		catch (IOException) {
		}
		return null;
	}

	sealed class GrpIconDirEntry {
		public byte bWidth;
		public byte bHeight;
		public byte bColorCount;
		public byte bReserved;
		public ushort wPlanes;
		public ushort wBitCount;
		public uint dwBytesInRes;
		public ushort nID;
	}

	public Task CreateAsync(DecompileContext ctx) => File.WriteAllBytesAsync(Filename, data, ctx.CancellationToken);
}

/// <summary>The module's Win32 manifest resource, written as app.manifest.</summary>
sealed class ApplicationManifest : IFileJob {
	const int RT_MANIFEST = 24;

	public string Description => "Create app.manifest";
	public string Filename { get; }
	readonly byte[] data;

	ApplicationManifest(string filename, byte[] data) {
		Filename = filename;
		this.data = data;
	}

	public static ApplicationManifest? TryCreate(Win32Resources? resources, FilenameCreator filenameCreator) {
		if (resources is null)
			return null;
		var dir = resources.Find(new ResourceName(RT_MANIFEST));
		if (dir is null || dir.Directories.Count == 0)
			return null;
		dir = dir.Directories[0];
		if (dir.Data.Count == 0)
			return null;
		var reader = dir.Data[0].CreateReader();
		return new ApplicationManifest(filenameCreator.CreateName("app.manifest"), reader.ToArray());
	}

	public Task CreateAsync(DecompileContext ctx) => File.WriteAllBytesAsync(Filename, data, ctx.CancellationToken);
}

/// <summary>The project's entry for app.manifest; <see cref="ApplicationManifest"/> writes the file.</summary>
sealed class ApplicationManifestProjectFile(string filename) : ProjectFile {
	public override BuildAction BuildAction => BuildAction.None;
	public override string Description => "Create app.manifest";
	public override string Filename => filename;
	protected override void Create(DecompileContext ctx) {
		// ApplicationManifest writes the file
	}
}
