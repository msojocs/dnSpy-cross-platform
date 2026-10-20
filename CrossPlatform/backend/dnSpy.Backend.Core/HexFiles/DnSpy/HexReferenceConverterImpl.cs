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

using System;

namespace dnSpy.Backend.Core.HexFiles.DnSpy {
	/// <summary>
	/// What the dnSpy-DotNet provider's GetReference answers for a method body: the method's token and the IL offset
	/// under the position. dnSpy's HexReferenceConverterImpl turns it into a MethodStatementReference over the module
	/// of the document the buffer is the file of; here <see cref="HexStructureModel"/> turns it into the RPC's method
	/// reference the same way.
	/// </summary>
	sealed class HexMethodReference {
		public HexBufferFile File { get; }
		public uint Token { get; }
		public uint? Offset { get; }

		public HexMethodReference(HexBufferFile file, uint token, uint? offset) {
			File = file ?? throw new ArgumentNullException(nameof(file));
			Token = token;
			Offset = offset;
		}
	}
}
