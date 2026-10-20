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

// The references the BAML disassembler writes (dnSpy's BamlToolTipProvider.cs, without the tool tip provider
// itself) and DummyAssemblyRefFinder.cs. They are classes rather than strings so that a viewer can tell a
// reference written by the BAML disassembler from any other.
namespace dnSpy.Backend.Core.Baml;

// Don't use a string since it should only show tooltips if it's from the baml disassembler
sealed class BamlStringReference {
	public static object? Create(string? s) => string.IsNullOrEmpty(s) ? null : new BamlStringReference(s);
	public string String { get; }

	BamlStringReference(string s) => String = s;
}

sealed class BamlRecordReference {
	public BamlRecord Record { get; }

	BamlRecordReference(BamlRecord record) => Record = record;

	public static object? Create(BamlRecord? record) {
		if (record is null)
			return null;
		return new BamlRecordReference(record);
	}
}

sealed class BamlAssemblyReference {
	public AssemblyNameInfo Assembly { get; }

	BamlAssemblyReference(AssemblyNameInfo assemblyName) => Assembly = assemblyName;

	public static object? Create(string? assemblyFullName) {
		if (string.IsNullOrEmpty(assemblyFullName))
			return null;
		return new BamlAssemblyReference(new AssemblyNameInfo(assemblyFullName));
	}
}

sealed class BamlResourceReference {
	public string TypeName { get; }

	public string? KeyName { get; }

	public string? PropertyName { get; }

	BamlResourceReference(string typeName, string? keyName, string? propertyName) {
		TypeName = typeName;
		KeyName = keyName;
		PropertyName = propertyName;
	}

	public static object? CreateKey(string? typeName, string? keyName) {
		if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(keyName))
			return null;
		return new BamlResourceReference(typeName, keyName, null);
	}

	public static object? CreateProperty(string? typeName, string? propertyName) {
		if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(propertyName))
			return null;
		return new BamlResourceReference(typeName, null, propertyName);
	}
}

sealed class BamlTypeReference {
	public ITypeDefOrRef Type { get; }

	BamlTypeReference(ITypeDefOrRef type) => Type = type;

	public static object? Create(ITypeDefOrRef? type) {
		if (type is null)
			return null;
		return new BamlTypeReference(type);
	}
}

sealed class BamlAttributeReference {
	public ITypeDefOrRef Type { get; }

	public string MemberName { get; }

	BamlAttributeReference(ITypeDefOrRef type, string memberName) {
		Type = type;
		MemberName = memberName;
	}

	public static object? Create(ITypeDefOrRef? type, string? memberName) {
		if (type is null || string.IsNullOrEmpty(memberName))
			return null;
		return new BamlAttributeReference(type, memberName);
	}
}

sealed class DummyAssemblyRefFinder : IAssemblyRefFinder {
	readonly IAssembly assemblyDef;

	public DummyAssemblyRefFinder(IAssembly assemblyDef) => this.assemblyDef = assemblyDef;

	public AssemblyRef FindAssemblyRef(TypeRef nonNestedTypeRef) => assemblyDef.ToAssemblyRef();
}
