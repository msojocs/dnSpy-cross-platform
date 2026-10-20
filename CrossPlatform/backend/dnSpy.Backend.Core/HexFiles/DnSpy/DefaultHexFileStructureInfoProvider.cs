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
using System.Linq;
using dnSpy.Backend.Core.HexFiles;
using dnSpy.Backend.Core.HexFiles.DnSpy;

namespace dnSpy.Backend.Core.HexFiles.DnSpy {

	sealed class DefaultHexFileStructureInfoProvider : HexFileStructureInfoProvider {
		readonly ToolTipCreatorFactory toolTipCreatorFactory;
		readonly HexFileImageReferenceProvider[] hexFileImageReferenceProviders;

		public DefaultHexFileStructureInfoProvider(ToolTipCreatorFactory toolTipCreatorFactory, HexFileImageReferenceProvider[] hexFileImageReferenceProviders) {
			this.toolTipCreatorFactory = toolTipCreatorFactory ?? throw new ArgumentNullException(nameof(toolTipCreatorFactory));
			this.hexFileImageReferenceProviders = hexFileImageReferenceProviders ?? throw new ArgumentNullException(nameof(hexFileImageReferenceProviders));
		}

		public override object? GetToolTip(HexBufferFile file, ComplexData structure, HexPosition position) {
			var toolTipCreator = toolTipCreatorFactory.Create();
			var contentCreator = toolTipCreator.ToolTipContentCreator;

			contentCreator.Image = GetImage(structure, position);
			contentCreator.Writer.WriteFieldAndValue(structure, position);

			return toolTipCreator.Create();
		}

		ImageReference GetImage(ComplexData structure, HexPosition position) {
			foreach (var lz in hexFileImageReferenceProviders) {
				var imgRef = lz.GetImage(structure, position);
				if (imgRef is not null)
					return imgRef.Value;
			}
			return DsImages.FieldPublic;
		}
	}
}
