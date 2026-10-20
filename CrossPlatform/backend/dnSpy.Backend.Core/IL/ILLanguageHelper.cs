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

using dnlib.DotNet.Emit;

namespace dnSpy.Backend.Core.IL;

/// <summary>
/// dnSpy.Decompiler/IL/ILLanguageHelper.cs: the text "Show IL comments" writes after an instruction — the summary the
/// framework's XML documentation gives the <c>OpCodes</c> field of the same name. dnSpy reads it from mscorlib's
/// documentation; <paramref name="getDocumentation"/> answers a documentation id the way the workspace finds one.
/// </summary>
static class ILLanguageHelper {
	static readonly string?[] cachedOpCodeDocs = new string?[0x200];
	static readonly bool[] looked = new bool[0x200];
	static readonly Lock sync = new();

	public static string? GetOpCodeDocumentation(OpCode code, Func<string, string?> getDocumentation) {
		int index = (int)code.Code;
		int hi = index >> 8;
		if (hi == 0xFE)
			index -= 0xFD00;
		else if (hi != 0)
			return null;
		lock (sync) {
			if (looked[index])
				return cachedOpCodeDocs[index];
		}
		// XmlDocRenderer writes the summary as one run of text: its own line breaks and spaces collapse.
		var doc = getDocumentation("F:System.Reflection.Emit.OpCodes." + code.Code.ToString());
		if (doc is not null)
			doc = string.Join(' ', doc.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
		lock (sync) {
			cachedOpCodeDocs[index] = doc;
			looked[index] = true;
		}
		return doc;
	}
}
