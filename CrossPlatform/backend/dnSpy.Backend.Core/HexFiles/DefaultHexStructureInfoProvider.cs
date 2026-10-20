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
using System.Collections.Generic;
using System.Diagnostics;
using dnSpy.Backend.Core.HexFiles;

namespace dnSpy.Backend.Core.HexFiles {
	/// <summary>dnSpy's DefaultHexStructureInfoProvider, the one HexStructureInfoProvider the hex view's structure
	/// aggregator asks (HexStructureInfoAggregator), built over the model's services instead of a HexView's.</summary>
	sealed class DefaultHexStructureInfoProvider : HexStructureInfoProvider {
		readonly HexBufferFileService hexBufferFileService;
		readonly HexFileStructureInfoService hexFileStructureInfoService;

		public DefaultHexStructureInfoProvider(HexBufferFileService hexBufferFileService, HexFileStructureInfoService hexFileStructureInfoService) {
			this.hexBufferFileService = hexBufferFileService ?? throw new ArgumentNullException(nameof(hexBufferFileService));
			this.hexFileStructureInfoService = hexFileStructureInfoService ?? throw new ArgumentNullException(nameof(hexFileStructureInfoService));
		}

		public override IEnumerable<HexStructureField> GetFields(HexPosition position) {
			var info = hexBufferFileService.GetFileAndStructure(position);
			if (info is null)
				yield break;

			var structure = info.Value.Structure;
			var field = structure.GetSimpleField(position);
			Debug2.Assert(field is not null);
			if (field is null)
				yield break;
			yield return new HexStructureField(field.Data.Span, HexStructureFieldKind.CurrentField);

			var indexes = hexFileStructureInfoService.GetSubStructureIndexes(position);
			if (indexes is not null) {
				if (indexes.Length == 0) {
					for (int i = 0; i < structure.FieldCount; i++) {
						var span = structure.GetFieldByIndex(i).Data.Span;
						yield return new HexStructureField(span, HexStructureFieldKind.SubStructure);
					}
				}
				else {
					for (int i = 0; i < indexes.Length; i++) {
						var start = structure.GetFieldByIndex(indexes[i].Start).Data.Span.Start;
						var end = structure.GetFieldByIndex(indexes[i].End - 1).Data.Span.End;
						var span = HexBufferSpan.FromBounds(start, end);
						yield return new HexStructureField(span, HexStructureFieldKind.SubStructure);
					}
				}
			}
			else
				yield return new HexStructureField(structure.Span, HexStructureFieldKind.Structure);
		}

		public override object? GetToolTip(HexPosition position) => hexFileStructureInfoService.GetToolTip(position);
		public override object? GetReference(HexPosition position) => hexFileStructureInfoService.GetReference(position);
	}
}
