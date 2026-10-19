using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core.Editing;

/// <summary>
/// Converts a MemberRef to and from the model dnSpy's MemberRefDlg edits: its class — a type, a TypeSpec, one of
/// the module's own methods or a module reference — its name, a method's or a field's signature, and its custom
/// attributes.
/// </summary>
public sealed class MemberRefCodec {
	readonly EditContext context;

	internal MemberRefCodec(EditContext context) => this.context = context;

	public MemberRefDto ToDto(MemberRef reference) => new(
		reference.IsFieldRef,
		ParentToDto(reference.Class),
		reference.Name.String,
		reference.MethodSig is { } methodSig ? context.Signatures.MethodToDto(methodSig) : null,
		reference.FieldSig is { } fieldSig ? context.Signatures.ToDto(fieldSig.Type) : null,
		context.Attributes.ToDtoList(reference.CustomAttributes),
		reference.FullName);

	MemberRefParentDto? ParentToDto(IMemberRefParent? parent) => parent switch {
		null => null,
		TypeSpec spec => new MemberRefParentDto(MemberRefParentKinds.TypeSpec, context.Signatures.ToDto(spec.TypeSig), Display: spec.FullName),
		ITypeDefOrRef type => new MemberRefParentDto(MemberRefParentKinds.Type, context.Signatures.ToDto(type), Display: type.FullName),
		MethodDef method => new MemberRefParentDto(MemberRefParentKinds.MethodDef, Token: method.MDToken.Raw.ToString("X8", CultureInfo.InvariantCulture), Display: method.FullName),
		ModuleRef module => new MemberRefParentDto(MemberRefParentKinds.ModuleRef, ModuleName: module.Name.String, Display: module.FullName),
		_ => null,
	};

	/// <summary>
	/// The MemberRef the dialog describes, given a row of its own in the module the way dnSpy's InstructionOperandVM
	/// does with UpdateRowId once the dialog is accepted. The class and the signature are what MemberRefVM.HasError
	/// asks for; a name may be empty.
	/// </summary>
	public MemberRef FromDto(MemberRefDto dto) {
		var parent = ParentFromDto(dto.Class) ?? throw SignatureCodec.Invalid("A member reference needs a class.");
		var reference = dto.IsField
			? new MemberRefUser(context.Module, dto.Name ?? string.Empty, new FieldSig(context.Signatures.FromDto(dto.FieldType) ?? throw SignatureCodec.Invalid("A field reference needs a field type.")), parent)
			: new MemberRefUser(context.Module, dto.Name ?? string.Empty, context.Signatures.MethodFromDto(dto.MethodSignature ?? throw SignatureCodec.Invalid("A method reference needs a signature.")), parent);
		foreach (var attribute in context.Attributes.FromDtoList(dto.CustomAttributes))
			reference.CustomAttributes.Add(attribute);
		return context.Module.UpdateRowId(reference);
	}

	IMemberRefParent? ParentFromDto(MemberRefParentDto? dto) {
		if (dto is null)
			return null;
		switch (dto.Kind) {
			case MemberRefParentKinds.Type:
				return context.Signatures.FromDtoRequired(dto.Type).ToTypeDefOrRef();
			case MemberRefParentKinds.TypeSpec: {
				var signature = context.Signatures.FromDtoRequired(dto.Type);
				return context.Module.UpdateRowId(new TypeSpecUser(signature));
			}
			case MemberRefParentKinds.MethodDef: {
				var method = context.NodeOf<MethodDef>(dto.NodeId)
					?? (uint.TryParse(dto.Token, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var token) ? context.Module.ResolveToken(token) as MethodDef : null);
				if (method is null || method.Module != context.Module)
					throw SignatureCodec.Invalid("The class of a member reference may only be a method of the module it is in.");
				return method;
			}
			case MemberRefParentKinds.ModuleRef:
				if (string.IsNullOrEmpty(dto.ModuleName))
					throw SignatureCodec.Invalid("A module reference needs a module name.");
				return context.Module.UpdateRowId(new ModuleRefUser(context.Module, dto.ModuleName));
			default:
				throw SignatureCodec.Invalid($"Unknown member reference class '{dto.Kind}'.");
		}
	}
}
