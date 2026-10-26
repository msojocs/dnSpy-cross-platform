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

using dnlib.DotNet;
using dnSpy.Backend.Contracts;
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core.Baml;

/// <summary>
/// dnSpy's <c>BamlDocumentViewerToolTipProvider</c>: what hovering one of the references the BAML
/// disassembler writes shows. A string gives its text, an assembly its full name, a type the name the
/// toolbar language writes it with, a member its type and name, a record its type and position, and a
/// resource its type and key. The type name is written in the document's language, as dnSpy writes it
/// with the tab's decompiler.
/// </summary>
sealed class BamlToolTipProvider(DecompilerLanguage language, Func<ITypeDefOrRef, string>? typeColor) {
	// dnSpy writes type names with the decompiler's own formatter, which qualifies a name with its namespace
	// but keeps the language's keywords for the built-in types.
	const CSharpMemberFormatter.Options TypeOptions =
		CSharpMemberFormatter.Options.Namespaces | CSharpMemberFormatter.Options.IntrinsicTypeKeywords;

	// dnSpy's DsImages.String, which its image set writes but DotNetImages (the tree's images) does not name.
	const string StringImage = "String";

	// A tooltip dnSpy draws without an image — a record's, a resource's. An empty name says so beside the
	// text; null would let the viewer fall back to the local-variable image.
	const string NoImage = "";

	public DocumentToolTip? Create(object? reference) {
		switch (reference) {
		case BamlStringReference stringRef:
			return ToolTip(output => output.Write(TextColors.String, stringRef.String), StringImage);
		case BamlAssemblyReference assemblyRef:
			return ToolTip(output => output.WriteAssembly(assemblyRef.Assembly), DotNetImages.Assembly);
		case BamlRecordReference recordRef:
			return ToolTip(output => WriteRecord(output, recordRef.Record), NoImage);
		case BamlResourceReference resourceRef:
			return ToolTip(output => WriteResource(output, resourceRef), NoImage);
		case BamlTypeReference typeRef:
			return ToolTip(output => WriteType(output, typeRef.Type), ImageOf(typeRef.Type));
		case BamlAttributeReference attributeRef:
			return ToolTip(output => WriteAttribute(output, attributeRef), DotNetImages.Property);
		default:
			return null;
		}
	}

	DocumentToolTip ToolTip(Action<TextPartsBuilder> write, string? image) {
		var output = new TextPartsBuilder();
		write(output);
		return new DocumentToolTip(output.ToParts(), image);
	}

	static void WriteRecord(TextPartsBuilder output, BamlRecord record) {
		output.Write(TextColors.Keyword, record.Type.ToString());
		output.Write(TextColors.Text, "\n");
		output.Write(TextColors.Text, "Position");
		output.Write(TextColors.Punctuation, ":");
		output.Write(TextColors.Text, " ");
		output.Write(TextColors.Number, $"0x{record.Position:x}");
	}

	static void WriteResource(TextPartsBuilder output, BamlResourceReference resource) {
		output.Write(TextColors.Type, resource.TypeName);
		output.Write(TextColors.Punctuation, ".");
		if (resource.KeyName is not null)
			output.Write(TextColors.Text, resource.KeyName);
		else
			output.Write(TextColors.InstanceProperty, resource.PropertyName);
	}

	void WriteType(TextPartsBuilder output, ITypeDefOrRef type) {
		switch (language) {
		case DecompilerLanguage.VisualBasic:
			VisualBasicMemberFormatter.WriteType(output, type, TypeOptions, typeColor);
			break;
		case DecompilerLanguage.IL or DecompilerLanguage.ILWithCSharp:
			// The IL decompiler's WriteType writes the signature: "class BamlTarget.SampleView".
			ILTypeName.Write(output, type, ILTypeName.Syntax.Signature, typeColor);
			break;
		default:
			CSharpMemberFormatter.WriteType(output, type, TypeOptions, typeColor);
			break;
		}
	}

	void WriteAttribute(TextPartsBuilder output, BamlAttributeReference attribute) {
		WriteType(output, attribute.Type);
		output.Write(TextColors.Punctuation, ".");
		output.Write(TextColors.InstanceProperty, IdentifierEscaper.Escape(attribute.MemberName));
	}

	// dnSpy's SetImage((ITypeDefOrRef)typeRef.Resolve() ?? typeRef): the type's own image when its definition
	// is at hand. A known WPF type has no definition on Linux — the assembly the BAML names is not installed —
	// so it wears the plain class image, the one dnSpy gives a type it cannot resolve either.
	static string ImageOf(ITypeDefOrRef type) {
		try {
			var definition = type is TypeRef typeRef ? typeRef.Resolve() ?? type : type;
			return definition is TypeDef typeDef ? DotNetImages.Of(typeDef) : DotNetImages.ClassPublic;
		}
		catch (Exception ex) when (ex is not OutOfMemoryException) {
			return DotNetImages.ClassPublic;
		}
	}
}
