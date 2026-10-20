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
using dnSpy.Backend.Core.Output;

namespace dnSpy.Backend.Core.IL;

/// <summary>
/// How the disassembler finds the definition a reference names, which picks the color of the name. dnSpy asks
/// dnlib's resolver, which loads the referenced assembly; the workspace answers from what it has loaded, the way
/// the rest of a document is drawn, so drawing a method does not load the assemblies its calls go to.
/// </summary>
interface IMetadataResolver {
	TypeDef? ResolveTypeDef(ITypeDefOrRef type);
	MethodDef? ResolveMethodDef(IMethod method);
	FieldDef? ResolveFieldDef(IField field);
}

/// <summary>
/// dnSpy's <c>MetadataTextColorProvider</c> (dnSpy.Contracts.Logic/Decompiler/MetadataTextColorProvider.cs): the
/// color a member, a type or a constant is written in. The resolver the colors are looked up with is the one
/// <see cref="UseResolver"/> installed for the document being written; dnlib's own otherwise.
/// </summary>
abstract class MetadataTextColorProvider {
	static readonly AsyncLocal<IMetadataResolver?> currentResolver = new();

	/// <summary>Installs the resolver the colors of the document being written are looked up with, until disposed.</summary>
	public static IDisposable UseResolver(IMetadataResolver resolver) {
		var previous = currentResolver.Value;
		currentResolver.Value = resolver;
		return new ResolverScope(previous);
	}

	sealed class ResolverScope(IMetadataResolver? previous) : IDisposable {
		public void Dispose() => currentResolver.Value = previous;
	}

	static TypeDef? Resolve(TypeRef type) => currentResolver.Value is { } resolver ? resolver.ResolveTypeDef(type) : type.Resolve();
	static FieldDef? Resolve(IField field) => currentResolver.Value is { } resolver ? resolver.ResolveFieldDef(field) : field.ResolveFieldDef();
	static MethodDef? Resolve(IMethod method) => currentResolver.Value is { } resolver ? resolver.ResolveMethodDef(method) : method.ResolveMethodDef();

	public virtual object GetColor(TypeDef? type) {
		if (type is null)
			return BoxedTextColor.Text;

		if (type.IsInterface)
			return BoxedTextColor.Interface;
		if (type.IsEnum)
			return BoxedTextColor.Enum;
		if (type.IsValueType)
			return BoxedTextColor.ValueType;

		if (type.IsDelegate)
			return BoxedTextColor.Delegate;

		if (type.IsSealed && type.IsAbstract) {
			var bt = type.BaseType;
			if (bt is not null && bt.DefinitionAssembly.IsCorLib()) {
				if (bt is TypeRef baseTr) {
					if (baseTr.Namespace == systemString && baseTr.Name == objectString)
						return BoxedTextColor.StaticType;
				}
				else {
					var baseTd = bt as TypeDef;
					if (baseTd is not null && baseTd.Namespace == systemString && baseTd.Name == objectString)
						return BoxedTextColor.StaticType;
				}
			}
		}

		if (type.IsSealed)
			return BoxedTextColor.SealedType;
		return BoxedTextColor.Type;
	}
	static readonly UTF8String systemString = new("System");
	static readonly UTF8String objectString = new("Object");

	public virtual object GetColor(TypeRef? type) {
		if (type is null)
			return BoxedTextColor.Text;

		var td = Resolve(type);
		if (td is not null)
			return GetColor(td);

		return BoxedTextColor.Type;
	}

	static readonly UTF8String systemRuntimeCompilerServicesString = new("System.Runtime.CompilerServices");
	static readonly UTF8String extensionAttributeString = new("ExtensionAttribute");

	public virtual object GetColor(IMemberRef? memberRef) {
		if (memberRef is null)
			return BoxedTextColor.Text;

		if (memberRef.IsField) {
			var fd = Resolve((IField)memberRef);
			if (fd is null)
				return BoxedTextColor.InstanceField;
			if (fd.DeclaringType?.IsEnum == true)
				return BoxedTextColor.EnumField;
			if (fd.IsLiteral)
				return BoxedTextColor.LiteralField;
			if (fd.IsStatic)
				return BoxedTextColor.StaticField;
			return BoxedTextColor.InstanceField;
		}
		if (memberRef.IsMethod) {
			var mr = (IMethod)memberRef;
			if (mr.MethodSig is null)
				return BoxedTextColor.InstanceMethod;
			var md = Resolve(mr);
			if (md is not null && md.IsConstructor)
				return GetColor(md.DeclaringType);
			if (!mr.MethodSig.HasThis) {
				if (md is not null && IsDefined(md, systemRuntimeCompilerServicesString, extensionAttributeString))
					return BoxedTextColor.ExtensionMethod;
				return BoxedTextColor.StaticMethod;
			}
			return BoxedTextColor.InstanceMethod;
		}
		if (memberRef.IsPropertyDef) {
			var p = (PropertyDef)memberRef;
			return GetColor(p.GetMethod ?? p.SetMethod, BoxedTextColor.StaticProperty, BoxedTextColor.InstanceProperty);
		}
		if (memberRef.IsEventDef) {
			var e = (EventDef)memberRef;
			return GetColor(e.AddMethod ?? e.RemoveMethod ?? e.InvokeMethod, BoxedTextColor.StaticEvent, BoxedTextColor.InstanceEvent);
		}

		if (memberRef is TypeDef td)
			return GetColor(td);

		if (memberRef is TypeRef tr)
			return GetColor(tr);

		if (memberRef is TypeSpec ts) {
			if (ts.TypeSig is GenericSig gsig)
				return GetColor(gsig);
			return BoxedTextColor.Type;
		}

		if (memberRef is GenericParam gp)
			return GetColor(gp);

		// It can be a MemberRef if it doesn't have a field or method sig (invalid metadata)
		return BoxedTextColor.Text;
	}

	public virtual object GetColor(GenericSig? genericSig) {
		if (genericSig is null)
			return BoxedTextColor.Text;

		return genericSig.IsMethodVar ? BoxedTextColor.MethodGenericParameter : BoxedTextColor.TypeGenericParameter;
	}

	public virtual object GetColor(GenericParam? genericParam) {
		if (genericParam is null)
			return BoxedTextColor.Text;

		if (genericParam.DeclaringType is not null)
			return BoxedTextColor.TypeGenericParameter;

		if (genericParam.DeclaringMethod is not null)
			return BoxedTextColor.MethodGenericParameter;

		return BoxedTextColor.TypeGenericParameter;
	}

	static object GetColor(MethodDef? method, object staticValue, object instanceValue) {
		if (method is null)
			return instanceValue;
		if (method.IsStatic)
			return staticValue;
		return instanceValue;
	}

	public virtual object GetColor(ExportedType? exportedType) {
		if (exportedType is null)
			return BoxedTextColor.Text;

		return GetColor(exportedType.ToTypeRef());
	}

	public virtual object GetColor(TypeSig? typeSig) {
		typeSig = typeSig.RemovePinnedAndModifiers();
		if (typeSig is null)
			return BoxedTextColor.Text;

		if (typeSig is TypeDefOrRefSig tdr)
			return GetColor(tdr.TypeDefOrRef);

		if (typeSig is GenericSig gsig)
			return GetColor(gsig);

		return BoxedTextColor.Text;
	}

	public virtual object GetColor(object? obj) {
		if (obj is null)
			return BoxedTextColor.Text;

		if (obj is byte || obj is sbyte ||
			obj is ushort || obj is short ||
			obj is uint || obj is int ||
			obj is ulong || obj is long ||
			obj is UIntPtr || obj is IntPtr)
			return BoxedTextColor.Number;

		if (obj is IMemberRef r)
			return GetColor(r);

		if (obj is ExportedType et)
			return GetColor(et);

		if (obj is TypeSig ts)
			return GetColor(ts);

		if (obj is GenericParam gp)
			return GetColor(gp);

		if (obj is Parameter)
			return BoxedTextColor.Parameter;

		if (obj is dnlib.DotNet.Emit.Local)
			return BoxedTextColor.Local;

		if (obj is MethodSig)
			return BoxedTextColor.Text;

		if (obj is string)
			return BoxedTextColor.String;

		return BoxedTextColor.Text;
	}

	static bool IsDefined(IHasCustomAttribute provider, UTF8String @namespace, UTF8String name) {
		foreach (var ca in provider.CustomAttributes) {
			if (ca.AttributeType is TypeRef tr) {
				if (tr.Namespace == @namespace && tr.Name == name)
					return true;
			}
			else if (ca.AttributeType is TypeDef td) {
				if (td.Namespace == @namespace && td.Name == name)
					return true;
			}
		}
		return false;
	}
}

sealed class CSharpMetadataTextColorProvider : MetadataTextColorProvider {
	public static readonly CSharpMetadataTextColorProvider Instance = new();

	CSharpMetadataTextColorProvider() { }
}
