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

// Ported from dnSpy (dnSpy/dnSpy.Decompiler/MSBuild/ResXResourceFileWriter.cs).

using System.Globalization;
using System.Text;
using System.Xml;
using dnlib.DotNet;
using dnlib.DotNet.Resources;
using dnlib.DotNet.Writer;

namespace dnSpy.Backend.Core.ProjectExport;

/// <summary>
/// Writes a .resources file's entries as a .resx, the way dnSpy's writer does it after WinForms' ResXResourceWriter
/// and ResXDataNode: the schema and the four headers, then one data element per entry, typed with the names of the
/// assemblies the module itself references. WinForms is no part of the runtime here, so its own names — the reader,
/// the writer, ResXNullRef — are those of the .NET Framework's System.Windows.Forms unless the module references
/// another version.
/// </summary>
sealed class ResXResourceFileWriter : IDisposable {
	readonly record struct ResXResourceInfo(string ValueString, string? TypeName = null, string? MimeType = null);

	const string ResMimeType = "text/microsoft-resx";
	const string Version = "2.0";
	const string BinSerializedObjectMimeType = "application/x-microsoft.net.object.binary.base64";
	const string ByteArraySerializedObjectMimeType = "application/x-microsoft.net.object.bytearray.base64";
	const string WindowsFormsAssembly = "System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";

	const int LengthPropertyOffset = 196;
	const int CapacityPropertyOffset = 200;
	const int BufferLengthOffset = 214;
	const int BufferOffset = 219;
	static readonly byte[] memoryStreamBinaryFormatterTemplate = [
		0x00, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x16, 0x53,
		0x79, 0x73, 0x74, 0x65, 0x6D, 0x2E, 0x49, 0x4F, 0x2E, 0x4D, 0x65, 0x6D,
		0x6F, 0x72, 0x79, 0x53, 0x74, 0x72, 0x65, 0x61, 0x6D, 0x0A, 0x00, 0x00,
		0x00, 0x07, 0x5F, 0x62, 0x75, 0x66, 0x66, 0x65, 0x72, 0x07, 0x5F, 0x6F,
		0x72, 0x69, 0x67, 0x69, 0x6E, 0x09, 0x5F, 0x70, 0x6F, 0x73, 0x69, 0x74,
		0x69, 0x6F, 0x6E, 0x07, 0x5F, 0x6C, 0x65, 0x6E, 0x67, 0x74, 0x68, 0x09,
		0x5F, 0x63, 0x61, 0x70, 0x61, 0x63, 0x69, 0x74, 0x79, 0x0B, 0x5F, 0x65,
		0x78, 0x70, 0x61, 0x6E, 0x64, 0x61, 0x62, 0x6C, 0x65, 0x09, 0x5F, 0x77,
		0x72, 0x69, 0x74, 0x61, 0x62, 0x6C, 0x65, 0x0A, 0x5F, 0x65, 0x78, 0x70,
		0x6F, 0x73, 0x61, 0x62, 0x6C, 0x65, 0x07, 0x5F, 0x69, 0x73, 0x4F, 0x70,
		0x65, 0x6E, 0x1D, 0x4D, 0x61, 0x72, 0x73, 0x68, 0x61, 0x6C, 0x42, 0x79,
		0x52, 0x65, 0x66, 0x4F, 0x62, 0x6A, 0x65, 0x63, 0x74, 0x2B, 0x5F, 0x5F,
		0x69, 0x64, 0x65, 0x6E, 0x74, 0x69, 0x74, 0x79, 0x07, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x02, 0x08, 0x08, 0x08, 0x08, 0x01,
		0x01, 0x01, 0x01, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00,
		0x05, 0x00, 0x00, 0x00, // Length
		0x05, 0x00, 0x00, 0x00, // Capacity
		0x00, 0x01, 0x00, 0x01, 0x0A, 0x0F, 0x02, 0x00, 0x00, 0x00,
		0x05, 0x00, 0x00, 0x00, // buffer length
		0x02,
		// buffer
		// 0x0B
	];

	readonly ModuleDef module;
	readonly Dictionary<IAssembly, IAssembly> newToOldAsm;
	readonly XmlTextWriter writer;
	bool written;

	public ResXResourceFileWriter(string fileName, ModuleDef module) {
		this.module = module;
		newToOldAsm = new Dictionary<IAssembly, IAssembly>(new AssemblyNameComparer(AssemblyNameComparerFlags.All & ~AssemblyNameComparerFlags.Version));
		foreach (var asmRef in module.GetAssemblyRefs())
			newToOldAsm[asmRef] = asmRef;

		writer = new XmlTextWriter(fileName, Encoding.UTF8) {
			Formatting = Formatting.Indented,
			Indentation = 2,
		};
		InitializeWriter();
	}

	void InitializeWriter() {
		writer.WriteStartDocument();
		writer.WriteStartElement("root");
		using (var reader = new XmlTextReader(new StringReader(ResourceSchema)) { WhitespaceHandling = WhitespaceHandling.None, DtdProcessing = DtdProcessing.Prohibit })
			writer.WriteNode(reader, true);
		WriteHeader("resmimetype", ResMimeType);
		WriteHeader("version", Version);
		WriteHeader("reader", WindowsFormsTypeName("System.Resources.ResXResourceReader"));
		WriteHeader("writer", WindowsFormsTypeName("System.Resources.ResXResourceWriter"));
	}

	void WriteHeader(string name, string value) {
		writer.WriteStartElement("resheader");
		writer.WriteAttributeString("name", name);
		writer.WriteStartElement("value");
		writer.WriteString(value);
		writer.WriteEndElement();
		writer.WriteEndElement();
	}

	public void AddResourceData(ResourceElement resourceElement) {
		var nodeInfo = GetNodeInfo(resourceElement.ResourceData);

		writer.WriteStartElement("data");
		writer.WriteAttributeString("name", resourceElement.Name);

		if (nodeInfo.TypeName is not null)
			writer.WriteAttributeString("type", nodeInfo.TypeName);

		if (nodeInfo.MimeType is not null)
			writer.WriteAttributeString("mimetype", nodeInfo.MimeType);

		if (nodeInfo.TypeName is null && nodeInfo.MimeType is null || nodeInfo.TypeName is not null &&
			nodeInfo.TypeName.StartsWith("System.Char", StringComparison.Ordinal))
			writer.WriteAttributeString("xml", "space", null, "preserve");

		writer.WriteStartElement("value");
		if (!string.IsNullOrEmpty(nodeInfo.ValueString))
			writer.WriteString(nodeInfo.ValueString);
		writer.WriteEndElement();

		writer.WriteEndElement();
	}

	ResXResourceInfo GetNodeInfo(IResourceData resourceData) {
		if (resourceData is BuiltInResourceData builtInResourceData) {
			// Mimic formatting used in ResXDataNode and TypeConverter implementations
			switch (builtInResourceData.Code) {
			case ResourceTypeCode.Null:
				return new ResXResourceInfo("", GetTypeName(ResourceTypeCode.Null));
			case ResourceTypeCode.String:
				return new ResXResourceInfo((string)builtInResourceData.Data);
			case ResourceTypeCode.Boolean:
				return new ResXResourceInfo(((bool)builtInResourceData.Data).ToString(), GetTypeName(ResourceTypeCode.Boolean));
			case ResourceTypeCode.Char:
				var c = (char)builtInResourceData.Data;
				return new ResXResourceInfo(c == '\0' ? "" : c.ToString(), GetTypeName(ResourceTypeCode.Char));
			case ResourceTypeCode.Byte:
			case ResourceTypeCode.SByte:
			case ResourceTypeCode.Int16:
			case ResourceTypeCode.UInt16:
			case ResourceTypeCode.Int32:
			case ResourceTypeCode.UInt32:
			case ResourceTypeCode.Int64:
			case ResourceTypeCode.UInt64:
			case ResourceTypeCode.Decimal: {
				var data = (IFormattable)builtInResourceData.Data;
				return new ResXResourceInfo(data.ToString("G", CultureInfo.InvariantCulture.NumberFormat), GetTypeName(builtInResourceData.Code));
			}
			case ResourceTypeCode.Single:
			case ResourceTypeCode.Double: {
				var data = (IFormattable)builtInResourceData.Data;
				return new ResXResourceInfo(data.ToString("R", CultureInfo.InvariantCulture.NumberFormat), GetTypeName(builtInResourceData.Code));
			}
			case ResourceTypeCode.TimeSpan:
				return new ResXResourceInfo(((IFormattable)builtInResourceData.Data).ToString(null, CultureInfo.CurrentCulture), GetTypeName(ResourceTypeCode.TimeSpan));
			case ResourceTypeCode.DateTime:
				var dateTime = (DateTime)builtInResourceData.Data;
				string str;
				if (dateTime == DateTime.MinValue)
					str = string.Empty;
				else if (dateTime.TimeOfDay.TotalSeconds == 0.0)
					str = dateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
				else
					str = dateTime.ToString(CultureInfo.InvariantCulture);
				return new ResXResourceInfo(str, GetTypeName(ResourceTypeCode.DateTime));
			case ResourceTypeCode.ByteArray:
				return new ResXResourceInfo(ToBase64WrappedString((byte[])builtInResourceData.Data), GetTypeName(ResourceTypeCode.ByteArray));
			case ResourceTypeCode.Stream: {
				var data = (byte[])builtInResourceData.Data;
				var finalBuffer = new byte[memoryStreamBinaryFormatterTemplate.Length + data.Length + 1];
				var bufWriter = new ArrayWriter(finalBuffer);
				bufWriter.WriteBytes(memoryStreamBinaryFormatterTemplate);
				bufWriter.Position = LengthPropertyOffset;
				bufWriter.WriteInt32(data.Length);
				bufWriter.Position = CapacityPropertyOffset;
				bufWriter.WriteInt32(data.Length);
				bufWriter.Position = BufferLengthOffset;
				bufWriter.WriteInt32(data.Length);
				bufWriter.Position = BufferOffset;
				bufWriter.WriteBytes(data);
				bufWriter.WriteByte(0x0B);
				return new ResXResourceInfo(ToBase64WrappedString(finalBuffer), null, BinSerializedObjectMimeType);
			}
			default:
				throw new ArgumentOutOfRangeException(nameof(resourceData));
			}
		}

		if (resourceData is BinaryResourceData binaryResourceData) {
			switch (binaryResourceData.Format) {
			case SerializationFormat.BinaryFormatter:
				return new ResXResourceInfo(ToBase64WrappedString(binaryResourceData.Data), binaryResourceData.TypeName, BinSerializedObjectMimeType);
			case SerializationFormat.TypeConverterByteArray:
			case SerializationFormat.ActivatorStream:
				// RESX does not have a way to represent creation of an object using Activator.CreateInstance,
				// so we fall back to the same representation as data passed into TypeConverter.
				return new ResXResourceInfo(ToBase64WrappedString(binaryResourceData.Data), binaryResourceData.TypeName, ByteArraySerializedObjectMimeType);
			case SerializationFormat.TypeConverterString:
				return new ResXResourceInfo(Encoding.UTF8.GetString(binaryResourceData.Data), binaryResourceData.TypeName);
			}
		}

		throw new ArgumentOutOfRangeException(nameof(resourceData));
	}

	static string ToBase64WrappedString(byte[] data) {
		const int lineWrap = 80;
		const string crlf = "\r\n";
		const string prefix = "        ";
		var raw = Convert.ToBase64String(data);
		if (raw.Length > lineWrap) {
			var output = new StringBuilder(raw.Length + (raw.Length / lineWrap) * 3); // word wrap on lineWrap chars, \r\n
			var current = 0;
			for (; current < raw.Length - lineWrap; current += lineWrap) {
				output.Append(crlf);
				output.Append(prefix);
				output.Append(raw, current, lineWrap);
			}
			output.Append(crlf);
			output.Append(prefix);
			output.Append(raw, current, raw.Length - current);
			output.Append(crlf);
			return output.ToString();
		}
		return raw;
	}

	/// <summary>
	/// GetTypeName(Type) for a WinForms type: the module's own reference to System.Windows.Forms names its version,
	/// the .NET Framework's is the one used otherwise.
	/// </summary>
	string WindowsFormsTypeName(string typeFullName) {
		IAssembly newAsm = new AssemblyNameInfo(WindowsFormsAssembly);
		if (!newToOldAsm.TryGetValue(newAsm, out var oldAsm) || AssemblyNameComparer.CompareAll.Equals(oldAsm, newAsm))
			return typeFullName + ", " + WindowsFormsAssembly;
		return $"{typeFullName}, {oldAsm.FullName}";
	}

	string GetTypeName(ResourceTypeCode typeCode) {
		if (typeCode == ResourceTypeCode.Null) {
			var asmRef = GetAssemblyRef("System.Windows.Forms");
			if (asmRef is not null)
				return new TypeRefUser(module, "System.Resources", "ResXNullRef", asmRef).AssemblyQualifiedName;
			return WindowsFormsTypeName("System.Resources.ResXNullRef");
		}
		return typeCode switch {
			ResourceTypeCode.String => module.CorLibTypes.String.AssemblyQualifiedName,
			ResourceTypeCode.Boolean => module.CorLibTypes.Boolean.AssemblyQualifiedName,
			ResourceTypeCode.Char => module.CorLibTypes.Char.AssemblyQualifiedName,
			ResourceTypeCode.Byte => module.CorLibTypes.Byte.AssemblyQualifiedName,
			ResourceTypeCode.SByte => module.CorLibTypes.SByte.AssemblyQualifiedName,
			ResourceTypeCode.Int16 => module.CorLibTypes.Int16.AssemblyQualifiedName,
			ResourceTypeCode.UInt16 => module.CorLibTypes.UInt16.AssemblyQualifiedName,
			ResourceTypeCode.Int32 => module.CorLibTypes.Int32.AssemblyQualifiedName,
			ResourceTypeCode.UInt32 => module.CorLibTypes.UInt32.AssemblyQualifiedName,
			ResourceTypeCode.Int64 => module.CorLibTypes.Int64.AssemblyQualifiedName,
			ResourceTypeCode.UInt64 => module.CorLibTypes.UInt64.AssemblyQualifiedName,
			ResourceTypeCode.Single => module.CorLibTypes.Single.AssemblyQualifiedName,
			ResourceTypeCode.Double => module.CorLibTypes.Double.AssemblyQualifiedName,
			ResourceTypeCode.Decimal => module.CorLibTypes.GetTypeRef("System", "Decimal").AssemblyQualifiedName,
			ResourceTypeCode.DateTime => module.CorLibTypes.GetTypeRef("System", "DateTime").AssemblyQualifiedName,
			ResourceTypeCode.TimeSpan => module.CorLibTypes.GetTypeRef("System", "TimeSpan").AssemblyQualifiedName,
			ResourceTypeCode.ByteArray => new SZArraySig(module.CorLibTypes.Byte).AssemblyQualifiedName,
			ResourceTypeCode.Stream => module.CorLibTypes.GetTypeRef("System.IO", "MemoryStream").AssemblyQualifiedName,
			_ => throw new ArgumentOutOfRangeException(nameof(typeCode), typeCode, null),
		};
	}

	AssemblyRef? GetAssemblyRef(string name) {
		foreach (var asmRef in module.GetAssemblyRefs()) {
			if (asmRef.Name == name)
				return asmRef;
		}
		return null;
	}

	public void Dispose() {
		if (!written) {
			written = true;
			writer.WriteEndElement();
			writer.Flush();
		}
		writer.Close();
	}

	/// <summary>WinForms' ResXResourceWriter.ResourceSchema: the comment every .resx starts with, and its schema.</summary>
	const string ResourceSchema = """
<!-- 
  Microsoft ResX Schema 
  
  Version 2.0
  
  The primary goals of this format is to allow a simple XML format 
  that is mostly human readable. The generation and parsing of the 
  various data types are done through the TypeConverter classes 
  associated with the data types.
  
  Example:
  
  ... ado.net/XML headers & schema ...
  <resheader name="resmimetype">text/microsoft-resx</resheader>
  <resheader name="version">2.0</resheader>
  <resheader name="reader">System.Resources.ResXResourceReader, System.Windows.Forms, ...</resheader>
  <resheader name="writer">System.Resources.ResXResourceWriter, System.Windows.Forms, ...</resheader>
  <data name="Name1"><value>this is my long string</value><comment>this is a comment</comment></data>
  <data name="Color1" type="System.Drawing.Color, System.Drawing">Blue</data>
  <data name="Bitmap1" mimetype="application/x-microsoft.net.object.binary.base64">
      <value>[base64 mime encoded serialized .NET Framework object]</value>
  </data>
  <data name="Icon1" type="System.Drawing.Icon, System.Drawing" mimetype="application/x-microsoft.net.object.bytearray.base64">
      <value>[base64 mime encoded string representing a byte array form of the .NET Framework object]</value>
      <comment>This is a comment</comment>
  </data>
              
  There are any number of "resheader" rows that contain simple 
  name/value pairs.
  
  Each data row contains a name, and value. The row also contains a 
  type or mimetype. Type corresponds to a .NET class that support 
  text/value conversion through the TypeConverter architecture. 
  Classes that don't support this are serialized and stored with the 
  mimetype set.
  
  The mimetype is used for serialized objects, and tells the 
  ResXResourceReader how to depersist the object. This is currently not 
  extensible. For a given mimetype the value must be set accordingly:
  
  Note - application/x-microsoft.net.object.binary.base64 is the format 
  that the ResXResourceWriter will generate, however the reader can 
  read any of the formats listed below.
  
  mimetype: application/x-microsoft.net.object.binary.base64
  value   : The object must be serialized with 
          : System.Runtime.Serialization.Formatters.Binary.BinaryFormatter
          : and then encoded with base64 encoding.
  
  mimetype: application/x-microsoft.net.object.soap.base64
  value   : The object must be serialized with 
          : System.Runtime.Serialization.Formatters.Soap.SoapFormatter
          : and then encoded with base64 encoding.

  mimetype: application/x-microsoft.net.object.bytearray.base64
  value   : The object must be serialized into a byte array 
          : using a System.ComponentModel.TypeConverter
          : and then encoded with base64 encoding.
  -->
<xsd:schema id="root" xmlns="" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:msdata="urn:schemas-microsoft-com:xml-msdata">
  <xsd:import namespace="http://www.w3.org/XML/1998/namespace" />
  <xsd:element name="root" msdata:IsDataSet="true">
    <xsd:complexType>
      <xsd:choice maxOccurs="unbounded">
        <xsd:element name="metadata">
          <xsd:complexType>
            <xsd:sequence>
              <xsd:element name="value" type="xsd:string" minOccurs="0" />
            </xsd:sequence>
            <xsd:attribute name="name" use="required" type="xsd:string" />
            <xsd:attribute name="type" type="xsd:string" />
            <xsd:attribute name="mimetype" type="xsd:string" />
            <xsd:attribute ref="xml:space" />
          </xsd:complexType>
        </xsd:element>
        <xsd:element name="assembly">
          <xsd:complexType>
            <xsd:attribute name="alias" type="xsd:string" />
            <xsd:attribute name="name" type="xsd:string" />
          </xsd:complexType>
        </xsd:element>
        <xsd:element name="data">
          <xsd:complexType>
            <xsd:sequence>
              <xsd:element name="value" type="xsd:string" minOccurs="0" msdata:Ordinal="1" />
              <xsd:element name="comment" type="xsd:string" minOccurs="0" msdata:Ordinal="2" />
            </xsd:sequence>
            <xsd:attribute name="name" type="xsd:string" use="required" msdata:Ordinal="1" />
            <xsd:attribute name="type" type="xsd:string" msdata:Ordinal="3" />
            <xsd:attribute name="mimetype" type="xsd:string" msdata:Ordinal="4" />
            <xsd:attribute ref="xml:space" />
          </xsd:complexType>
        </xsd:element>
        <xsd:element name="resheader">
          <xsd:complexType>
            <xsd:sequence>
              <xsd:element name="value" type="xsd:string" minOccurs="0" msdata:Ordinal="1" />
            </xsd:sequence>
            <xsd:attribute name="name" type="xsd:string" use="required" />
          </xsd:complexType>
        </xsd:element>
      </xsd:choice>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>
""";
}
