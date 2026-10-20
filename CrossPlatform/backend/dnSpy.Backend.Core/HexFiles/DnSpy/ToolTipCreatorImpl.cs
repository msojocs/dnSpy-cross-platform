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
using dnSpy.Backend.Core.HexFiles.DnSpy;
using dnSpy.Backend.Core.HexFiles.ToolTips;

namespace dnSpy.Backend.Core.HexFiles.DnSpy {
	sealed class ToolTipCreatorFactoryImpl : ToolTipCreatorFactory {
		readonly HexToolTipContentCreatorFactory hexToolTipContentCreatorFactory = new HexToolTipContentCreatorFactoryImpl(new HexFieldFormatterFactoryImpl());

		public override ToolTipCreator Create() =>
			new ToolTipCreatorImpl(hexToolTipContentCreatorFactory.Create());
	}

	sealed class ToolTipCreatorImpl : ToolTipCreator {
		public override HexToolTipContentCreator ToolTipContentCreator { get; }

		public ToolTipCreatorImpl(HexToolTipContentCreator hexToolTipContentCreator) {
			ToolTipContentCreator = hexToolTipContentCreator ?? throw new ArgumentNullException(nameof(hexToolTipContentCreator));
		}

		// dnSpy hands the content to its ToolTipObjectFactory, which builds the WPF tooltip; the content itself is what
		// the RPC sends (HexStructureModel.ToToolTipDto does what ToolTipObjectFactoryImpl.GetColor did).
		public override object? Create() => ToolTipContentCreator.Create();
	}
}
