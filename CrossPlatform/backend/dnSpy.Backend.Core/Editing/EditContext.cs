using dnlib.DotNet;

namespace dnSpy.Backend.Core.Editing;

/// <summary>
/// The state one edit operation shares across every codec that takes part in it: the module new rows are
/// written into, the resolver that turns a type name back into a reference, and the codecs themselves.
/// </summary>
/// <remarks>
/// The codecs are plain helpers over the same module, so they are created once per context and reused —
/// most importantly the resolver's importer, which caches the <c>TypeRef</c> and <c>AssemblyRef</c> rows
/// it creates so that a dialog referencing the same assembly from two places does not add two rows.
/// </remarks>
public sealed class EditContext {
	/// <param name="module">The module being edited.</param>
	/// <param name="modules">Other open modules a bare type name may be looked up in.</param>
	/// <param name="resolveNode">
	/// Looks up what the explorer tree holds for a node id — the dnlib object, whatever kind it is. The
	/// client can only name a row that already exists by its node id, so this is what turns "the method
	/// the user picked as a property getter" back into a <c>MethodDef</c>. It is optional because a
	/// caller that builds an <see cref="EditContext"/> on its own — a test, or a codec used directly —
	/// has no tree to ask.
	/// </param>
	public EditContext(ModuleDef module, IReadOnlyList<ModuleDef>? modules = null, Func<string, object?>? resolveNode = null) {
		Module = module;
		ResolveNode = resolveNode;
		Types = new TypeResolver(module, modules, resolveNode is null ? null : id => resolveNode(id) as ITypeDefOrRef);
		Signatures = new SignatureCodec(this);
		Constants = new ConstantCodec(this);
		MethodRefs = new MethodRefCodec(this);
		MemberRefs = new MemberRefCodec(this);
		Attributes = new CustomAttributeCodec(this);
		MarshalTypes = new MarshalTypeCodec(this);
		ImplMaps = new ImplMapCodec(this);
		DeclSecurities = new DeclSecurityCodec(this);
		GenericParams = new GenericParamCodec(this);
		ParamDefs = new ParamDefCodec(this);
		MethodOverrides = new MethodOverrideCodec(this);
		Accessors = new AccessorRefCodec(this);
		Options = new NodeOptionsFactory(this);
		TypeDefs = new TypeDefEditor(this);
		MethodDefs = new MethodDefEditor(this);
		FieldDefs = new FieldDefEditor(this);
		PropertyDefs = new PropertyDefEditor(this);
		EventDefs = new EventDefEditor(this);
	}

	public ModuleDef Module { get; }

	/// <summary>The workspace's node lookup, or null when this context was built without one.</summary>
	Func<string, object?>? ResolveNode { get; }

	/// <summary>
	/// The row a node id stands for, when it is of the expected kind. A node id that resolves to
	/// something else is treated the same as one that resolves to nothing at all, so a request that
	/// names an unrelated node cannot be made to act on it.
	/// </summary>
	public T? NodeOf<T>(string? nodeId) where T : class =>
		nodeId is { Length: > 0 } && ResolveNode?.Invoke(nodeId) is T value ? value : null;

	public TypeResolver Types { get; }
	public SignatureCodec Signatures { get; }
	public ConstantCodec Constants { get; }

	/// <summary>References to methods — a custom attribute's constructor, an override's two halves.</summary>
	public MethodRefCodec MethodRefs { get; }

	/// <summary>MemberRefs as the IL editor's MemberRef dialog builds them.</summary>
	public MemberRefCodec MemberRefs { get; }
	public CustomAttributeCodec Attributes { get; }
	public MarshalTypeCodec MarshalTypes { get; }
	public ImplMapCodec ImplMaps { get; }
	public DeclSecurityCodec DeclSecurities { get; }
	public GenericParamCodec GenericParams { get; }
	public ParamDefCodec ParamDefs { get; }
	public MethodOverrideCodec MethodOverrides { get; }
	public AccessorRefCodec Accessors { get; }

	/// <summary>The starting values a create- or edit-dialog is handed.</summary>
	public NodeOptionsFactory Options { get; }

	// The five editors, which read and write a whole definition the way dnSpy's options classes do.
	public TypeDefEditor TypeDefs { get; }
	public MethodDefEditor MethodDefs { get; }
	public FieldDefEditor FieldDefs { get; }
	public PropertyDefEditor PropertyDefs { get; }
	public EventDefEditor EventDefs { get; }
}
