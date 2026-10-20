using System.Diagnostics.CodeAnalysis;

// What the ported dnSpy.Hex.Files code took from the WPF application and its MEF host, cut down to the members it
// uses: dnSpy's nullable-flow assert, the Visual Studio PropertyCollection, the DsImages image references and the
// two resource strings of the tooltips.
namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>
	/// dnSpy's <c>Debug2</c> (NRT_Helpers.cs): an assert the nullable analysis trusts. dnSpy asserts on malformed
	/// files all over its readers and then carries on; a failed <c>Debug.Assert</c> ends a .NET process, so here
	/// the asserts only tell the compiler what dnSpy assumed and never stop a read of a broken file.
	/// </summary>
	static class Debug2 {
		public static void Assert([DoesNotReturnIf(false)] bool condition) {
			_ = condition;
		}

		public static void Assert([DoesNotReturnIf(false)] bool condition, string? message) {
			_ = condition;
			_ = message;
		}

		public static void Fail(string? message) => _ = message;
	}

	/// <summary>Microsoft.VisualStudio.Utilities.PropertyCollection, the members dnSpy's hex files code calls.</summary>
	sealed class PropertyCollection {
		readonly Dictionary<object, object?> properties = [];

		public bool TryGetProperty<T>(object key, [MaybeNullWhen(false)] out T property) {
			if (properties.TryGetValue(key, out var value) && value is T typed) {
				property = typed;
				return true;
			}
			property = default;
			return false;
		}

		public void AddProperty(object key, object? property) => properties.Add(key, property);

		public T GetOrCreateSingletonProperty<T>(object key, Func<T> creator) where T : class {
			if (properties.TryGetValue(key, out var value) && value is T typed)
				return typed;
			var created = creator();
			properties[key] = created;
			return created;
		}
	}

	/// <summary>
	/// dnSpy's <c>ImageReference</c>, reduced to the name of the <c>DsImages</c> member it stands for — the name the
	/// client draws, the way the tree's images are sent (<see cref="DotNetImages"/>).
	/// </summary>
	readonly record struct ImageReference(string Name);

	/// <summary>The <c>DsImages</c> members the hex structure tooltips use, each named after itself.</summary>
	static class DsImages {
		public static readonly ImageReference Assembly = new(nameof(Assembly));
		public static readonly ImageReference Binary = new(nameof(Binary));
		public static readonly ImageReference ClassPublic = new(nameof(ClassPublic));
		public static readonly ImageReference ConstantPublic = new(nameof(ConstantPublic));
		public static readonly ImageReference CSFileNode = new(nameof(CSFileNode));
		public static readonly ImageReference Cursor = new(nameof(Cursor));
		public static readonly ImageReference Dialog = new(nameof(Dialog));
		public static readonly ImageReference EventPublic = new(nameof(EventPublic));
		public static readonly ImageReference FieldPublic = new(nameof(FieldPublic));
		public static readonly ImageReference Image = new(nameof(Image));
		public static readonly ImageReference InterfacePublic = new(nameof(InterfacePublic));
		public static readonly ImageReference LocalVariable = new(nameof(LocalVariable));
		public static readonly ImageReference Metadata = new(nameof(Metadata));
		public static readonly ImageReference MethodPublic = new(nameof(MethodPublic));
		public static readonly ImageReference ModuleFile = new(nameof(ModuleFile));
		public static readonly ImageReference ModulePublic = new(nameof(ModulePublic));
		public static readonly ImageReference Parameter = new(nameof(Parameter));
		public static readonly ImageReference Property = new(nameof(Property));
		public static readonly ImageReference SourceFileGroup = new(nameof(SourceFileGroup));
		public static readonly ImageReference String = new(nameof(String));
		public static readonly ImageReference StructurePublic = new(nameof(StructurePublic));
		public static readonly ImageReference Template = new(nameof(Template));
		public static readonly ImageReference TextFile = new(nameof(TextFile));
		public static readonly ImageReference UserDefinedDataType = new(nameof(UserDefinedDataType));
		public static readonly ImageReference VBFileNode = new(nameof(VBFileNode));
		public static readonly ImageReference WPFFile = new(nameof(WPFFile));
		public static readonly ImageReference XMLFile = new(nameof(XMLFile));
		public static readonly ImageReference XMLSchema = new(nameof(XMLSchema));
		public static readonly ImageReference XSLTransform = new(nameof(XSLTransform));
	}

	/// <summary>The English text of the dnSpy resources the tooltips write (dnSpy.Resources.resx).</summary>
	static class dnSpy_Resources {
		public const string HexToolTipIndex = "index";
		public const string HexToolTipOffset = "offset";
	}
}
