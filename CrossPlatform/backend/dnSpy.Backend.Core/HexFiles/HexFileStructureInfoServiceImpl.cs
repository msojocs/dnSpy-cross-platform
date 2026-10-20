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
	sealed class HexFileStructureInfoServiceImpl : HexFileStructureInfoService {
		readonly HexBufferFileService hexBufferFileService;

		// dnSpy creates its providers from the MEF-ordered HexFileStructureInfoProviderFactory exports of the hex view;
		// here the caller hands them over already created, in that order (HexStructureModel.CreateProviders).
		HexFileStructureInfoProvider[] HexFileStructureInfoProviders { get; }

		public HexFileStructureInfoServiceImpl(HexBufferFileService hexBufferFileService, HexFileStructureInfoProvider[] hexFileStructureInfoProviders) {
			this.hexBufferFileService = hexBufferFileService ?? throw new ArgumentNullException(nameof(hexBufferFileService));
			HexFileStructureInfoProviders = hexFileStructureInfoProviders ?? throw new ArgumentNullException(nameof(hexFileStructureInfoProviders));
		}

		public override HexIndexes[]? GetSubStructureIndexes(HexPosition position) {
			var info = hexBufferFileService.GetFileAndStructure(position);
			if (info is null)
				return null;

			var file = info.Value.File;
			var structure = info.Value.Structure;
			foreach (var provider in HexFileStructureInfoProviders) {
				var indexes = provider.GetSubStructureIndexes(file, structure, position);
				if (indexes is null)
					continue;
				bool b = IsValidIndexes(indexes, structure);
				Debug2.Assert(b);
				if (b)
					return indexes;
			}
			return null;
		}

		static bool IsValidIndexes(HexIndexes[] indexes, ComplexData structure) {
			if (indexes is null)
				return false;
			if (indexes.Length == 0)
				return true;
			if ((uint)indexes[0].End > (uint)structure.FieldCount)
				return false;
			if (indexes[0].IsEmpty)
				return false;
			for (int i = 1; i < indexes.Length; i++) {
				if (indexes[i - 1].End > indexes[i].Start)
					return false;
				if ((uint)indexes[i].End > (uint)structure.FieldCount)
					return false;
				if (indexes[i].IsEmpty)
					return false;
			}
			return true;
		}

		public override object? GetToolTip(HexPosition position) {
			var info = hexBufferFileService.GetFileAndStructure(position);
			if (info is null)
				return null;

			var file = info.Value.File;
			var structure = info.Value.Structure;
			foreach (var provider in HexFileStructureInfoProviders) {
				var toolTip = provider.GetToolTip(file, structure, position);
				if (toolTip is not null)
					return toolTip;
			}

			return null;
		}

		public override object? GetReference(HexPosition position) {
			var info = hexBufferFileService.GetFileAndStructure(position);
			if (info is null)
				return null;

			var file = info.Value.File;
			var structure = info.Value.Structure;
			foreach (var provider in HexFileStructureInfoProviders) {
				var toolTip = provider.GetReference(file, structure, position);
				if (toolTip is not null)
					return toolTip;
			}

			return null;
		}

		public override HexSpan? GetFieldReferenceSpan(HexPosition position) {
			var info = hexBufferFileService.GetFileAndStructure(position);
			if (info is null)
				return null;

			var file = info.Value.File;
			var structure = info.Value.Structure;

			HexSpan? span;
			foreach (var provider in HexFileStructureInfoProviders) {
				span = provider.GetFieldReferenceSpan(file, structure, position);
				if (span is not null)
					return span;
			}

			var field = structure.GetSimpleField(position);
			span = (field?.Data as SimpleData)?.GetFieldReferenceSpan(file);
			if (span is not null)
				return span;

			return null;
		}
	}
}
