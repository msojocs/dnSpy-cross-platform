// Copyright (c) 2011 AlphaSierraPapa for the SharpDevelop Team
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
// to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
// PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

using System.Globalization;
using dnlib.DotNet;
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core.IL;

// Security declarations, marshalling, parameters and constants.
sealed partial class ReflectionDisassembler {
	#region Write Security Declarations
	void WriteSecurityDeclarations(IHasDeclSecurity secDeclProvider) {
		if (!secDeclProvider.HasDeclSecurities)
			return;

		for (int i = 0; i < secDeclProvider.DeclSecurities.Count; i++) {
			var secdecl = secDeclProvider.DeclSecurities[i];
			output.Write(".permissionset", BoxedTextColor.ILDirective);
			output.Write(" ", BoxedTextColor.Text);
			switch (secdecl.Action) {
				case SecurityAction.Request:
					output.Write("request", BoxedTextColor.Keyword);
					break;
				case SecurityAction.Demand:
					output.Write("demand", BoxedTextColor.Keyword);
					break;
				case SecurityAction.Assert:
					output.Write("assert", BoxedTextColor.Keyword);
					break;
				case SecurityAction.Deny:
					output.Write("deny", BoxedTextColor.Keyword);
					break;
				case SecurityAction.PermitOnly:
					output.Write("permitonly", BoxedTextColor.Keyword);
					break;
				case SecurityAction.LinkDemand:
					output.Write("linkcheck", BoxedTextColor.Keyword);
					break;
				case SecurityAction.InheritDemand:
					output.Write("inheritcheck", BoxedTextColor.Keyword);
					break;
				case SecurityAction.RequestMinimum:
					output.Write("reqmin", BoxedTextColor.Keyword);
					break;
				case SecurityAction.RequestOptional:
					output.Write("reqopt", BoxedTextColor.Keyword);
					break;
				case SecurityAction.RequestRefuse:
					output.Write("reqrefuse", BoxedTextColor.Keyword);
					break;
				case SecurityAction.PreJitGrant:
					output.Write("prejitgrant", BoxedTextColor.Keyword);
					break;
				case SecurityAction.PreJitDeny:
					output.Write("prejitdeny", BoxedTextColor.Keyword);
					break;
				case SecurityAction.NonCasDemand:
					output.Write("noncasdemand", BoxedTextColor.Keyword);
					break;
				case SecurityAction.NonCasLinkDemand:
					output.Write("noncaslinkdemand", BoxedTextColor.Keyword);
					break;
				case SecurityAction.NonCasInheritance:
					output.Write("noncasinheritance", BoxedTextColor.Keyword);
					break;
				default:
					output.Write(secdecl.Action.ToString(), BoxedTextColor.Keyword);
					break;
			}

			var blob = secdecl.GetBlob();
			if (blob is not null && (char)blob[0] != '.') {
				output.WriteLine();
				output.IncreaseIndent();
				output.Write("bytearray", BoxedTextColor.Keyword);
				WriteBlob(blob);
				output.WriteLine();
				output.DecreaseIndent();
			}
			else {
				output.Write(" ", BoxedTextColor.Text);
				output.Write("=", BoxedTextColor.Operator);
				output.Write(" ", BoxedTextColor.Text);
				var bh1 = BracePairHelper.Create(output, "{", CodeBracesRangeFlags.OtherBlockBraces);
				output.WriteLine();
				output.IncreaseIndent();

				for (int j = 0; j < secdecl.SecurityAttributes.Count; j++) {
					SecurityAttribute sa = secdecl.SecurityAttributes[j];
					if (sa.AttributeType != null && sa.AttributeType.Scope == sa.AttributeType.Module) {
						output.Write("class", BoxedTextColor.Keyword);
						output.Write(" ", BoxedTextColor.Text);
						sb.Clear();
						output.Write(DisassemblerHelpers.Escape(FullNameFactory.AssemblyQualifiedName(sa.AttributeType, null, sb)), BoxedTextColor.Text);
					} else {
						sa.AttributeType.WriteTo(output, sb, ILNameSyntax.TypeName);
					}
					output.Write(" ", BoxedTextColor.Text);
					output.Write("=", BoxedTextColor.Operator);
					output.Write(" ", BoxedTextColor.Text);
					var bh2 = BracePairHelper.Create(output, "{", CodeBracesRangeFlags.OtherBlockBraces);
					if (sa.HasNamedArguments) {
						output.WriteLine();
						output.IncreaseIndent();

						var attrType = sa.AttributeType.ResolveTypeDef();
						foreach (var na in sa.Fields) {
							output.Write("field", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							WriteSecurityDeclarationArgument(attrType, na);
							output.WriteLine();
						}

						foreach (var na in sa.Properties) {
							output.Write("property", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							WriteSecurityDeclarationArgument(attrType, na);
							output.WriteLine();
						}

						output.DecreaseIndent();
					}
					bh2.Write("}");

					if (j + 1 < secdecl.SecurityAttributes.Count)
						output.Write(",", BoxedTextColor.Punctuation);
					output.WriteLine();
				}

				output.DecreaseIndent();
				bh1.Write("}");
				output.WriteLine();
			}
		}
	}

	void WriteSecurityDeclarationArgument(TypeDef? attrType, CANamedArgument na)
	{
		object? reference = null;
		if (attrType != null) {
			if (na.IsField)
				reference = attrType.FindField(na.Name, new FieldSig(na.Type));
			else
				reference = attrType.FindProperty(na.Name, PropertySig.CreateInstance(na.Type));
		}

		TypeSig? type = na.Argument.Type;
		if (type != null && (type.ElementType == ElementType.Class || type.ElementType == ElementType.ValueType)) {
			output.Write("enum", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
			if (type.Scope != type.Module) {
				output.Write("class", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				sb.Clear();
				output.Write(DisassemblerHelpers.Escape(FullNameFactory.AssemblyQualifiedName(type, null, sb)), BoxedTextColor.Text);
			} else {
				type.WriteTo(output, sb, ILNameSyntax.TypeName);
			}
		} else {
			type.WriteTo(output, sb);
		}
		output.Write(" ", BoxedTextColor.Text);
		output.Write(DisassemblerHelpers.Escape(na.Name), reference, DecompilerReferenceFlags.None, na.IsField ? BoxedTextColor.InstanceField : BoxedTextColor.InstanceProperty);
		output.Write(" ", BoxedTextColor.Text);
		output.Write("=", BoxedTextColor.Operator);
		output.Write(" ", BoxedTextColor.Text);
		if (na.Argument.Value is UTF8String) {
			// secdecls use special syntax for strings
			output.Write("string", BoxedTextColor.Keyword);
			var bh1 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
			output.Write(string.Format("'{0}'", TextWriterTokenWriter.ConvertStringMaxLength((UTF8String)na.Argument.Value, options.MaxStringLength).Replace("'", "\'")), BoxedTextColor.String);
			bh1.Write(")");
		} else {
			WriteConstant(na.Argument.Value);
		}
	}

	#endregion

	#region WriteMarshalInfo
	void WriteMarshalInfo(MarshalType? marshalInfo)
	{
		output.Write("marshal", BoxedTextColor.Keyword);
		var bh1 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
		if (marshalInfo != null)
			WriteNativeType(marshalInfo.NativeType, marshalInfo);
		bh1.Write(")");
		output.Write(" ", BoxedTextColor.Text);
	}

	void WriteNativeType(NativeType nativeType, MarshalType? marshalInfo = null)
	{
		switch (nativeType) {
			case NativeType.NotInitialized:
				break;
			case NativeType.Boolean:
				output.Write("bool", BoxedTextColor.Keyword);
				break;
			case NativeType.I1:
				output.Write("int8", BoxedTextColor.Keyword);
				break;
			case NativeType.U1:
				output.Write("unsigned", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("int8", BoxedTextColor.Keyword);
				break;
			case NativeType.I2:
				output.Write("int16", BoxedTextColor.Keyword);
				break;
			case NativeType.U2:
				output.Write("unsigned", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("int16", BoxedTextColor.Keyword);
				break;
			case NativeType.I4:
				output.Write("int32", BoxedTextColor.Keyword);
				break;
			case NativeType.U4:
				output.Write("unsigned", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("int32", BoxedTextColor.Keyword);
				break;
			case NativeType.I8:
				output.Write("int64", BoxedTextColor.Keyword);
				break;
			case NativeType.U8:
				output.Write("unsigned", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("int64", BoxedTextColor.Keyword);
				break;
			case NativeType.R4:
				output.Write("float32", BoxedTextColor.Keyword);
				break;
			case NativeType.R8:
				output.Write("float64", BoxedTextColor.Keyword);
				break;
			case NativeType.LPStr:
				output.Write("lpstr", BoxedTextColor.Keyword);
				break;
			case NativeType.Int:
				output.Write("int", BoxedTextColor.Keyword);
				break;
			case NativeType.UInt:
				output.Write("unsigned", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("int", BoxedTextColor.Keyword);
				break;
			case NativeType.Func:
				output.Write("method", BoxedTextColor.Keyword);
				break;
			case NativeType.Array:
				var ami = marshalInfo as ArrayMarshalType;
				if (ami == null)
					goto default;
				if (ami.ElementType != NativeType.Max)
					WriteNativeType(ami.ElementType);
				var bh1 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
				if (ami.Size >= 0) {
					output.Write(numberFormatter.Format(ami.Size), ami.Size, numberFlags, BoxedTextColor.Number);
				}
				if (ami.Flags != 0 && ami.ParamNumber >= 0) {
					output.Write(" ", BoxedTextColor.Text);
					output.Write("+", BoxedTextColor.Operator);
					output.Write(" ", BoxedTextColor.Text);
					output.Write(numberFormatter.Format(ami.ParamNumber), ami.ParamNumber, numberFlags, BoxedTextColor.Number);
				}
				bh1.Write("]");
				break;
			case NativeType.Currency:
				output.Write("currency", BoxedTextColor.Keyword);
				break;
			case NativeType.BStr:
				output.Write("bstr", BoxedTextColor.Keyword);
				break;
			case NativeType.LPWStr:
				output.Write("lpwstr", BoxedTextColor.Keyword);
				break;
			case NativeType.LPTStr:
				output.Write("lptstr", BoxedTextColor.Keyword);
				break;
			case NativeType.FixedSysString:
				var fsmi = marshalInfo as FixedSysStringMarshalType;
				output.Write("fixed", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("sysstring", BoxedTextColor.Keyword);
				if (fsmi != null && fsmi.IsSizeValid) {
					var bh2 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
					output.Write(numberFormatter.Format(fsmi.Size), fsmi.Size, numberFlags, BoxedTextColor.Number);
					bh2.Write("]");
				}
				break;
			case NativeType.IUnknown:
			case NativeType.IDispatch:
			case NativeType.IntF:
				if (nativeType == NativeType.IUnknown)
					output.Write("iunknown", BoxedTextColor.Keyword);
				else if (nativeType == NativeType.IDispatch)
					output.Write("idispatch", BoxedTextColor.Keyword);
				else
					output.Write("interface", BoxedTextColor.Keyword);
				var imti = marshalInfo as InterfaceMarshalType;
				if (imti != null && imti.IsIidParamIndexValid) {
					var bh2 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
					output.Write("iidparam", BoxedTextColor.Keyword);
					output.Write(" ", BoxedTextColor.Text);
					output.Write("=", BoxedTextColor.Operator);
					output.Write(" ", BoxedTextColor.Text);
					output.Write(numberFormatter.Format(imti.IidParamIndex), imti.IsIidParamIndexValid, numberFlags, BoxedTextColor.Number);
					bh2.Write(")");
				}
				break;
			case NativeType.Struct:
				output.Write("struct", BoxedTextColor.Keyword);
				break;
			case NativeType.SafeArray:
				output.Write("safearray", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				var sami = marshalInfo as SafeArrayMarshalType;
				if (sami != null && sami.IsVariantTypeValid) {
					switch (sami.VariantType & VariantType.TypeMask) {
						case VariantType.None:
							break;
						case VariantType.Null:
							output.Write("null", BoxedTextColor.Keyword);
							break;
						case VariantType.I2:
							output.Write("int16", BoxedTextColor.Keyword);
							break;
						case VariantType.I4:
							output.Write("int32", BoxedTextColor.Keyword);
							break;
						case VariantType.R4:
							output.Write("float32", BoxedTextColor.Keyword);
							break;
						case VariantType.R8:
							output.Write("float64", BoxedTextColor.Keyword);
							break;
						case VariantType.CY:
							output.Write("currency", BoxedTextColor.Keyword);
							break;
						case VariantType.Date:
							output.Write("date", BoxedTextColor.Keyword);
							break;
						case VariantType.BStr:
							output.Write("bstr", BoxedTextColor.Keyword);
							break;
						case VariantType.Dispatch:
							output.Write("idispatch", BoxedTextColor.Keyword);
							break;
						case VariantType.Error:
							output.Write("error", BoxedTextColor.Keyword);
							break;
						case VariantType.Bool:
							output.Write("bool", BoxedTextColor.Keyword);
							break;
						case VariantType.Variant:
							output.Write("variant", BoxedTextColor.Keyword);
							break;
						case VariantType.Unknown:
							output.Write("iunknown", BoxedTextColor.Keyword);
							break;
						case VariantType.Decimal:
							output.Write("decimal", BoxedTextColor.Keyword);
							break;
						case VariantType.I1:
							output.Write("int8", BoxedTextColor.Keyword);
							break;
						case VariantType.UI1:
							output.Write("unsigned", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							output.Write("int8", BoxedTextColor.Keyword);
							break;
						case VariantType.UI2:
							output.Write("unsigned", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							output.Write("int16", BoxedTextColor.Keyword);
							break;
						case VariantType.UI4:
							output.Write("unsigned", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							output.Write("int32", BoxedTextColor.Keyword);
							break;
						case VariantType.I8:
							output.Write("int64", BoxedTextColor.Keyword);
							break;
						case VariantType.UI8:
							output.Write("unsigned", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							output.Write("int64", BoxedTextColor.Keyword);
							break;
						case VariantType.Int:
							output.Write("int", BoxedTextColor.Keyword);
							break;
						case VariantType.UInt:
							output.Write("unsigned", BoxedTextColor.Keyword);
							output.Write(" ", BoxedTextColor.Text);
							output.Write("int", BoxedTextColor.Keyword);
							break;
						case VariantType.Void:
							output.Write("void", BoxedTextColor.Keyword);
							break;
						case VariantType.HResult:
							output.Write("hresult", BoxedTextColor.Keyword);
							break;
						case VariantType.Ptr:
							output.Write("*", BoxedTextColor.Operator);
							break;
						case VariantType.SafeArray:
							output.Write("safearray", BoxedTextColor.Keyword);
							break;
						case VariantType.CArray:
							output.Write("carray", BoxedTextColor.Keyword);
							break;
						case VariantType.UserDefined:
							output.Write("userdefined", BoxedTextColor.Keyword);
							break;
						case VariantType.LPStr:
							output.Write("lpstr", BoxedTextColor.Keyword);
							break;
						case VariantType.LPWStr:
							output.Write("lpwstr", BoxedTextColor.Keyword);
							break;
						case VariantType.Record:
							output.Write("record", BoxedTextColor.Keyword);
							break;
						case VariantType.FileTime:
							output.Write("filetime", BoxedTextColor.Keyword);
							break;
						case VariantType.Blob:
							output.Write("blob", BoxedTextColor.Keyword);
							break;
						case VariantType.Stream:
							output.Write("stream", BoxedTextColor.Keyword);
							break;
						case VariantType.Storage:
							output.Write("storage", BoxedTextColor.Keyword);
							break;
						case VariantType.StreamedObject:
							output.Write("streamed_object", BoxedTextColor.Keyword);
							break;
						case VariantType.StoredObject:
							output.Write("stored_object", BoxedTextColor.Keyword);
							break;
						case VariantType.BlobObject:
							output.Write("blob_object", BoxedTextColor.Keyword);
							break;
						case VariantType.CF:
							output.Write("cf", BoxedTextColor.Keyword);
							break;
						case VariantType.CLSID:
							output.Write("clsid", BoxedTextColor.Keyword);
							break;
						case VariantType.IntPtr:
						case VariantType.UIntPtr:
						case VariantType.VersionedStream:
						case VariantType.BStrBlob:
						default:
							output.Write((sami.VariantType & VariantType.TypeMask).ToString(), BoxedTextColor.Keyword);
							break;
					}
					if ((sami.VariantType & VariantType.ByRef) != 0)
						output.Write("&", BoxedTextColor.Operator);
					if ((sami.VariantType & VariantType.Array) != 0) {
						var bh = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
						bh.Write("]");
					}
					if ((sami.VariantType & VariantType.Vector) != 0) {
						output.Write(" ", BoxedTextColor.Text);
						output.Write("vector", BoxedTextColor.Keyword);
					}
					if (sami.IsUserDefinedSubTypeValid) {
						output.Write(",", BoxedTextColor.Punctuation);
						output.Write(" ", BoxedTextColor.Text);
						sb.Clear();
						output.Write("\"" + TextWriterTokenWriter.ConvertStringMaxLength(FullNameFactory.FullName(sami.UserDefinedSubType, false, null, sb), options.MaxStringLength) + "\"", BoxedTextColor.String);
					}
				}
				break;
			case NativeType.FixedArray:
				output.Write("fixed", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("array", BoxedTextColor.Keyword);
				var fami = marshalInfo as FixedArrayMarshalType;
				if (fami != null) {
					if (fami.IsSizeValid) {
						var bh2 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
						output.Write(numberFormatter.Format(fami.Size), fami.Size, numberFlags, BoxedTextColor.Number);
						bh2.Write("]");
					}
					if (fami.IsElementTypeValid) {
						output.Write(" ", BoxedTextColor.Text);
						WriteNativeType(fami.ElementType);
					}
				}
				break;
			case NativeType.ByValStr:
				output.Write("byvalstr", BoxedTextColor.Keyword);
				break;
			case NativeType.ANSIBStr:
				output.Write("ansi", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("bstr", BoxedTextColor.Keyword);
				break;
			case NativeType.TBStr:
				output.Write("tbstr", BoxedTextColor.Keyword);
				break;
			case NativeType.VariantBool:
				output.Write("variant", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("bool", BoxedTextColor.Keyword);
				break;
			case NativeType.ASAny:
				output.Write("as", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("any", BoxedTextColor.Keyword);
				break;
			case NativeType.LPStruct:
				output.Write("lpstruct", BoxedTextColor.Keyword);
				break;
			case NativeType.CustomMarshaler:
				var cmi = marshalInfo as CustomMarshalType;
				if (cmi == null)
					goto default;
				output.Write("custom", BoxedTextColor.Keyword);
				var bh3 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
				string customMarshalerFullName;
				if (cmi.CustomMarshaler is null)
					customMarshalerFullName = string.Empty;
				else {
					sb.Clear();
					customMarshalerFullName = FullNameFactory.FullName(cmi.CustomMarshaler, false, null, sb);
				}
				output.Write(string.Format("\"{0}\"", TextWriterTokenWriter.ConvertStringMaxLength(customMarshalerFullName, options.MaxStringLength)), BoxedTextColor.String);
				output.Write(",", BoxedTextColor.Punctuation);
				output.Write(" ", BoxedTextColor.Text);
				output.Write(string.Format("\"{0}\"", TextWriterTokenWriter.ConvertStringMaxLength(cmi.Cookie, options.MaxStringLength)), BoxedTextColor.String);
				if (!UTF8String.IsNullOrEmpty(cmi.Guid) || !UTF8String.IsNullOrEmpty(cmi.NativeTypeName)) {
					output.Write(",", BoxedTextColor.Punctuation);
					output.Write(" ", BoxedTextColor.Text);
					output.Write(string.Format("\"{0}\"", TextWriterTokenWriter.ConvertStringMaxLength(cmi.Guid, options.MaxStringLength)), BoxedTextColor.String);
					output.Write(",", BoxedTextColor.Punctuation);
					output.Write(" ", BoxedTextColor.Text);
					output.Write(string.Format("\"{0}\"", TextWriterTokenWriter.ConvertStringMaxLength(cmi.NativeTypeName, options.MaxStringLength)), BoxedTextColor.String);
				}
				bh3.Write(")");
				break;
			case NativeType.Error:
				output.Write("error", BoxedTextColor.Keyword);
				break;
			case NativeType.Void:
				output.Write("void", BoxedTextColor.Keyword);
				break;
			case NativeType.SysChar:
				output.Write("syschar", BoxedTextColor.Keyword);
				break;
			case NativeType.Variant:
				output.Write("variant", BoxedTextColor.Keyword);
				break;
			case NativeType.Decimal:
				output.Write("decimal", BoxedTextColor.Keyword);
				break;
			case NativeType.Date:
				output.Write("date", BoxedTextColor.Keyword);
				break;
			case NativeType.ObjectRef:
				output.Write("objectref", BoxedTextColor.Keyword);
				break;
			case NativeType.NestedStruct:
				output.Write("nested", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("struct", BoxedTextColor.Keyword);
				break;
			case NativeType.Ptr:
			case NativeType.IInspectable:
			case NativeType.HString:
			case NativeType.LPUTF8Str:
			default:
				output.Write(nativeType.ToString(), BoxedTextColor.Keyword);
				break;
		}
	}
	#endregion

	void WriteParameters(IList<Parameter> parameters)
	{
		for (int i = 0; i < parameters.Count; i++) {
			var p = parameters[i];
			if (p.IsHiddenThisParameter)
				continue;
			var paramDef = p.ParamDef;
			if (paramDef != null) {
				if (paramDef.IsIn) {
					var bh1 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
					output.Write("in", BoxedTextColor.Keyword);
					bh1.Write("]");
					output.Write(" ", BoxedTextColor.Text);
				}
				if (paramDef.IsOut) {
					var bh1 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
					output.Write("out", BoxedTextColor.Keyword);
					bh1.Write("]");
					output.Write(" ", BoxedTextColor.Text);
				}
				if (paramDef.IsOptional) {
					var bh1 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
					output.Write("opt", BoxedTextColor.Keyword);
					bh1.Write("]");
					output.Write(" ", BoxedTextColor.Text);
				}
			}
			p.Type.WriteTo(output, sb);
			output.Write(" ", BoxedTextColor.Text);
			if (paramDef != null && paramDef.MarshalType != null) {
				WriteMarshalInfo(paramDef.MarshalType);
			}
			output.Write(DisassemblerHelpers.Escape(p.Name), p, DecompilerReferenceFlags.Local | DecompilerReferenceFlags.Definition, BoxedTextColor.Parameter);
			if (i < parameters.Count - 1)
				output.Write(",", BoxedTextColor.Punctuation);
			output.WriteLine();
		}
	}

	bool HasParameterAttributes(Parameter p)
	{
		return p.ParamDef != null && (p.ParamDef.HasConstant || p.ParamDef.CustomAttributes.Count > 0);
	}

	void WriteGenericParameterAttributes(GenericParam p) {
		if (p.HasCustomAttributes) {
			output.Write(".param", BoxedTextColor.ILDirective);
			output.Write(" ", BoxedTextColor.Text);
			output.Write("type", BoxedTextColor.Keyword);
			output.Write(" ", BoxedTextColor.Text);
			output.Write(DisassemblerHelpers.Escape(p.Name), CSharpMetadataTextColorProvider.Instance.GetColor(p));
			output.WriteLine();
			output.IncreaseIndent();
			WriteAttributes(p.CustomAttributes);
			output.DecreaseIndent();
		}
		for (int i = 0; i < p.GenericParamConstraints.Count; i++) {
			var constraint = p.GenericParamConstraints[i];
			if (constraint.HasCustomAttributes) {
				output.Write(".param", BoxedTextColor.ILDirective);
				output.Write(" ", BoxedTextColor.Text);
				output.Write("constraint", BoxedTextColor.Keyword);
				output.Write(" ", BoxedTextColor.Text);
				output.Write(DisassemblerHelpers.Escape(p.Name), CSharpMetadataTextColorProvider.Instance.GetColor(p));
				output.Write(",", BoxedTextColor.Punctuation);
				output.Write(" ", BoxedTextColor.Text);
				constraint.Constraint.WriteTo(output, sb, ILNameSyntax.TypeName);
				output.WriteLine();
				output.IncreaseIndent();
				WriteAttributes(constraint.CustomAttributes);
				output.DecreaseIndent();
			}
		}
	}

	void WriteParameterAttributes(int index, Parameter p)
	{
		if (!HasParameterAttributes(p))
			return;
		output.Write(".param", BoxedTextColor.ILDirective);
		output.Write(" ", BoxedTextColor.Text);
		var bh1 = BracePairHelper.Create(output, "[", CodeBracesRangeFlags.SquareBrackets);
		output.Write(numberFormatter.Format(index), index, numberFlags, BoxedTextColor.Number);
		bh1.Write("]");
		if (p.HasParamDef && p.ParamDef.HasConstant) {
			output.Write(" ", BoxedTextColor.Text);
			output.Write("=", BoxedTextColor.Operator);
			output.Write(" ", BoxedTextColor.Text);
			WriteConstant(p.ParamDef.Constant.Value);
		}
		output.WriteLine();
		output.IncreaseIndent();
		if (p.HasParamDef)
			WriteAttributes(p.ParamDef.CustomAttributes);
		output.DecreaseIndent();
	}

	void WriteConstant(object? constant)
	{
		if (constant == null) {
			output.Write("nullref", BoxedTextColor.Keyword);
		} else {
			string? typeName = DisassemblerHelpers.PrimitiveTypeName(constant.GetType().FullName ?? string.Empty, options.OwnerModule, out var typeSig);
			if (typeName != null && typeName != "string") {
				DisassemblerHelpers.WriteKeyword(output, typeName, typeSig.ToTypeDefOrRef());
				var bh1 = BracePairHelper.Create(output, "(", CodeBracesRangeFlags.Parentheses);
				if (constant is float cf && (float.IsNaN(cf) || float.IsInfinity(cf))) {
					uint asUint32 = BitConverter.ToUInt32(BitConverter.GetBytes(cf), 0);
					output.Write(numberFormatter.Format(asUint32), asUint32, numberFlags, BoxedTextColor.Number);
				}
				else if (constant is double cd && (double.IsNaN(cd) || double.IsInfinity(cd))) {
					ulong asUlong = (ulong)BitConverter.DoubleToInt64Bits(cd);
					output.Write(numberFormatter.Format(asUlong), asUlong, numberFlags, BoxedTextColor.Number);
				}
				else {
					DisassemblerHelpers.WriteOperand(output, constant, options.MaxStringLength, numberFormatter, sb);
				}
				bh1.Write(")");
			} else {
				DisassemblerHelpers.WriteOperand(output, constant, options.MaxStringLength, numberFormatter, sb);
			}
		}
	}
}
