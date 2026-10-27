using System.Buffers.Binary;
using System.Formats.Nrbf;
using System.IO.Compression;
using System.Runtime.Serialization;
using System.Text;
using BitMiracle.LibTiff.Classic;
using dnlib.DotNet;
using dnlib.DotNet.Resources;

namespace dnSpy.Backend.Core;

/// <summary>
/// The image resources dnSpy's resource editor knows: a <c>System.Drawing.Bitmap</c> or <c>Icon</c> serialized into a
/// .resources file, a <c>System.Windows.Forms.ImageListStreamer</c>, and a byte array or stream that holds an image
/// file — dnSpy's SerializedImageUtilities, SerializedImageListStreamerUtilities and ImageResourceNodeProvider.
/// The serialized forms are BinaryFormatter streams dnSpy writes by hand, so neither System.Drawing nor WinForms is
/// needed to read or write them.
/// </summary>
internal static class ImageResources {
	const string SystemDrawing = "System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a";
	const string SystemWindowsForms = "System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089";
	public const string BitmapTypeName = "System.Drawing.Bitmap, " + SystemDrawing;
	public const string IconTypeName = "System.Drawing.Icon, " + SystemDrawing;
	public const string ImageListStreamerTypeName = "System.Windows.Forms.ImageListStreamer, " + SystemWindowsForms;

	static readonly string[] imageExtensions = [".png", ".gif", ".bmp", ".dib", ".jpg", ".jpeg", ".jpe", ".jif", ".jfif", ".jfi", ".ico", ".cur"];

	/// <summary>dnSpy's ImageResourceNodeProvider.CouldBeImage: an image file's extension, or a BMP's header.</summary>
	public static bool CouldBeImage(string name, byte[] data) {
		if (imageExtensions.Any(extension => name.EndsWith(extension, StringComparison.OrdinalIgnoreCase)))
			return true;
		if (data.Length < 0x16 || BitConverter.ToUInt16(data, 0) != 0x4D42)
			return false;
		var size = BitConverter.ToUInt32(data, 2);
		if (size > data.Length)
			return false;
		var offset = BitConverter.ToUInt32(data, 10);
		return offset < size;
	}

	/// <summary>
	/// dnSpy's CheckType: the type a resource names is the expected one, its assembly compared by name, culture and
	/// public key token but not by version.
	/// </summary>
	static bool IsType(string typeName, string expected) {
		var module = new ModuleDefUser();
		ITypeDefOrRef? actualType, expectedType;
		try {
			actualType = TypeNameParser.ParseReflection(module, typeName, null);
			expectedType = TypeNameParser.ParseReflection(module, expected, null);
		}
		catch (TypeNameParserException) {
			return false;
		}
		if (actualType is null || expectedType is null)
			return false;
		var flags = AssemblyNameComparerFlags.All & ~AssemblyNameComparerFlags.Version;
		return new AssemblyNameComparer(flags).Equals(actualType.DefinitionAssembly, expectedType.DefinitionAssembly)
			&& new SigComparer().Equals(actualType, expectedType);
	}

	public static bool IsBitmap(string typeName) => IsType(typeName, BitmapTypeName);
	public static bool IsIcon(string typeName) => IsType(typeName, IconTypeName);
	public static bool IsImageListStreamer(string typeName) => IsType(typeName, ImageListStreamerTypeName);

	/// <summary>
	/// dnSpy's SerializedImageUtilities.GetImageData: the image file a serialized Bitmap or Icon holds — the field of the
	/// BinaryFormatter stream, the stream itself for ActivatorStream, and for a Bitmap's TypeConverter bytes the file with
	/// the OLE "PBrush" wrapper taken off when there is one.
	/// </summary>
	public static byte[]? GetImageData(BinaryResourceData data) {
		if (IsBitmap(data.TypeName)) {
			return data.Format switch {
				SerializationFormat.BinaryFormatter => DeserializeByteArray(data.Data, "System.Drawing.Bitmap", "Data", ignoreCase: true),
				SerializationFormat.ActivatorStream => data.Data,
				SerializationFormat.TypeConverterByteArray => StripPBrush(data.Data) ?? data.Data,
				_ => null,
			};
		}
		if (IsIcon(data.TypeName)) {
			return data.Format switch {
				SerializationFormat.BinaryFormatter => DeserializeByteArray(data.Data, "System.Drawing.Icon", "IconData", ignoreCase: false),
				SerializationFormat.ActivatorStream or SerializationFormat.TypeConverterByteArray => data.Data,
				_ => null,
			};
		}
		return null;
	}

	/// <summary>The "Data" bytes of a serialized ImageListStreamer — what WinForms' ImageListStreamer serializes itself as.</summary>
	public static byte[]? GetImageListStreamerData(BinaryResourceData data) =>
		data.Format == SerializationFormat.BinaryFormatter && IsImageListStreamer(data.TypeName)
			? DeserializeByteArray(data.Data, "System.Windows.Forms.ImageListStreamer", "Data", ignoreCase: false)
			: null;

	/// <summary>ImageConverter.GetBitmapStream: a Bitmap the OLE way, its file after a 78-byte "PBrush" header.</summary>
	static byte[]? StripPBrush(byte[] data) {
		if (data.Length <= 18 || BitConverter.ToInt16(data, 0) != 0x1C15)
			return null;
		var headerSize = BitConverter.ToInt16(data, 2);
		if (data.Length <= headerSize + 18 || Encoding.ASCII.GetString(data, headerSize + 12, 6) != "PBrush")
			return null;
		return data[78..];
	}

	/// <summary>dnSpy's SerializationUtilities.DeserializeToByteArray: one byte array field of a serialized object.</summary>
	static byte[]? DeserializeByteArray(byte[] data, string typeName, string fieldName, bool ignoreCase) {
		try {
			if (NrbfDecoder.Decode(new MemoryStream(data)) is not ClassRecord record || record.TypeName.FullName != typeName)
				return null;
			if (ignoreCase)
				fieldName = record.MemberNames.FirstOrDefault(name => name.Equals(fieldName, StringComparison.OrdinalIgnoreCase)) ?? fieldName;
			var array = record.GetArrayRecord(fieldName);
			return array is not null && array.TypeName.FullName == "System.Byte[]" ? (byte[])array.GetArray(typeof(byte[])) : null;
		}
		catch (Exception ex) when (ex is SerializationException or NotSupportedException or InvalidOperationException or ArgumentException or KeyNotFoundException or IOException or InvalidCastException or FormatException or OverflowException) {
			return null;
		}
	}

	/// <summary>
	/// dnSpy's SerializedImageUtilities.Serialize: an image file as the resource it was — an icon (whose file starts
	/// 00 00 01 00) or a bitmap — in the serialization format the resource had. The BinaryFormatter stream is written by
	/// hand; the TypeConverter and Activator forms of an image are its file.
	/// </summary>
	public static ResourceElement Serialize(string name, byte[] image, SerializationFormat format) {
		var isIcon = image.Length >= 4 && BitConverter.ToUInt32(image, 0) == 0x00010000;
		var serialized = format == SerializationFormat.BinaryFormatter
			? isIcon ? SerializeIcon(image) : SerializeBitmap(image)
			: image;
		return new ResourceElement {
			Name = name,
			ResourceData = new BinaryResourceData(new UserResourceType(isIcon ? IconTypeName : BitmapTypeName, ResourceTypeCode.UserTypes), serialized, format),
		};
	}

	/// <summary>dnSpy's CreateSerializedImage: a file of a ".ico" name is an Icon, any other a Bitmap.</summary>
	public static ResourceElement CreateSerializedImage(string fileName, byte[] image) {
		var isIcon = fileName.EndsWith(".ico", StringComparison.OrdinalIgnoreCase);
		return new ResourceElement {
			Name = Path.GetFileName(fileName),
			ResourceData = new BinaryResourceData(
				new UserResourceType(isIcon ? IconTypeName : BitmapTypeName, ResourceTypeCode.UserTypes),
				isIcon ? SerializeIcon(image) : SerializeBitmap(image),
				SerializationFormat.BinaryFormatter),
		};
	}

	/// <summary>dnSpy's SerializedImageListStreamerUtilities.Serialize, the "Data" bytes having been made by the client.</summary>
	public static ResourceElement SerializeImageListStreamer(string name, byte[] data) => new() {
		Name = name,
		ResourceData = new BinaryResourceData(
			new UserResourceType(ImageListStreamerTypeName, ResourceTypeCode.UserTypes),
			WriteSingleByteArrayObject("System.Windows.Forms.ImageListStreamer", "Data", data, SystemWindowsForms),
			SerializationFormat.BinaryFormatter),
	};

	static byte[] SerializeBitmap(byte[] data) => WriteSingleByteArrayObject("System.Drawing.Bitmap", "Data", data, SystemDrawing);

	// The BinaryFormatter records dnSpy's SerializationUtilities writes (MS-NRBF): the header, the library, the class
	// with its member types, a reference to the byte array, the array, and the end.
	const byte ClassWithMembersAndTypes = 0x05;
	const byte MemberReference = 0x09;
	const byte MessageEnd = 0x0B;
	const byte BinaryLibrary = 0x0C;
	const byte ArraySinglePrimitive = 0x0F;
	const byte BinaryTypePrimitive = 0;
	const byte BinaryTypeClass = 4;
	const byte BinaryTypePrimitiveArray = 7;
	const byte PrimitiveByte = 2;
	const byte PrimitiveInt32 = 8;
	const int LibraryId = 2;
	const int ArrayId = 3;

	static byte[] WriteSingleByteArrayObject(string className, string fieldName, byte[] data, string assemblyName) {
		using var stream = new MemoryStream();
		using var writer = new BinaryWriter(stream);
		WriteHeader(writer, assemblyName);
		writer.Write(ClassWithMembersAndTypes);
		writer.Write(1);
		writer.Write(className);
		writer.Write(1);
		writer.Write(fieldName);
		writer.Write(BinaryTypePrimitiveArray);
		writer.Write(PrimitiveByte);
		writer.Write(LibraryId);
		writer.Write(MemberReference);
		writer.Write(ArrayId);
		WriteByteArray(writer, data);
		writer.Write(MessageEnd);
		return stream.ToArray();
	}

	/// <summary>dnSpy's SerializeIcon: IconData, and an IconSize of 0×0 — dnSpy writes the default size.</summary>
	static byte[] SerializeIcon(byte[] data) {
		using var stream = new MemoryStream();
		using var writer = new BinaryWriter(stream);
		WriteHeader(writer, SystemDrawing);
		writer.Write(ClassWithMembersAndTypes);
		writer.Write(1);
		writer.Write("System.Drawing.Icon");
		writer.Write(2);
		writer.Write("IconData");
		writer.Write("IconSize");
		writer.Write(BinaryTypePrimitiveArray);
		writer.Write(BinaryTypeClass);
		writer.Write(PrimitiveByte);
		writer.Write("System.Drawing.Size");
		writer.Write(LibraryId);
		writer.Write(LibraryId);
		writer.Write(MemberReference);
		writer.Write(ArrayId);
		writer.Write(ClassWithMembersAndTypes);
		writer.Write(-4);
		writer.Write("System.Drawing.Size");
		writer.Write(2);
		writer.Write("width");
		writer.Write("height");
		writer.Write(BinaryTypePrimitive);
		writer.Write(BinaryTypePrimitive);
		writer.Write(PrimitiveInt32);
		writer.Write(PrimitiveInt32);
		writer.Write(LibraryId);
		writer.Write(0);
		writer.Write(0);
		WriteByteArray(writer, data);
		writer.Write(MessageEnd);
		return stream.ToArray();
	}

	/// <summary>Larger pictures are not converted: the decoded raster alone would be 64 MB.</summary>
	const long MaxConvertedPixels = 4096 * 4096;

	/// <summary>
	/// A TIFF file as PNG. WPF's Image decodes TIFF through WIC; a browser does not, so the viewer gets the
	/// picture converted. Null when the file is not a TIFF LibTiff.NET can read.
	/// </summary>
	public static byte[]? TryConvertToPng(byte[] data) {
		// "II" or "MM": the byte order every TIFF and BigTIFF header starts with.
		if (data.Length < 8 || data[0] != data[1] || (data[0] != 'I' && data[0] != 'M'))
			return null;
		try {
			using var input = new MemoryStream(data, writable: false);
			using var tiff = Tiff.ClientOpen("resource", "r", input, new TiffStream());
			if (tiff is null)
				return null;
			var width = tiff.GetField(TiffTag.IMAGEWIDTH)?[0].ToInt() ?? 0;
			var height = tiff.GetField(TiffTag.IMAGELENGTH)?[0].ToInt() ?? 0;
			if (width <= 0 || height <= 0 || (long)width * height > MaxConvertedPixels)
				return null;
			// Each pixel is packed ABGR, whatever the file's photometric, bit depth and compression are.
			var raster = new int[width * height];
			if (!tiff.ReadRGBAImageOriented(width, height, raster, Orientation.TOPLEFT))
				return null;
			return EncodePng(width, height, raster);
		}
		catch (Exception ex) when (ex is not OutOfMemoryException) {
			return null;
		}
	}

	/// <summary>LibTiff.NET reports to the console by default; a picture that does not convert is just not shown.</summary>
	sealed class SilentTiffErrorHandler : TiffErrorHandler {
		public override void ErrorHandler(Tiff tif, string method, string format, params object[] args) { }
		public override void ErrorHandlerExt(Tiff tif, object clientData, string method, string format, params object[] args) { }
		public override void WarningHandler(Tiff tif, string method, string format, params object[] args) { }
		public override void WarningHandlerExt(Tiff tif, object clientData, string method, string format, params object[] args) { }
	}

	static ImageResources() => Tiff.SetErrorHandler(new SilentTiffErrorHandler());

	/// <summary>An 8-bit RGBA PNG of packed ABGR pixels, rows top to bottom, no filtering.</summary>
	static byte[] EncodePng(int width, int height, int[] abgr) {
		using var output = new MemoryStream();
		output.Write([0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A]);

		var header = new byte[13];
		BinaryPrimitives.WriteInt32BigEndian(header, width);
		BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
		header[8] = 8;	// bit depth
		header[9] = 6;	// color type: truecolor with alpha
		WritePngChunk(output, "IHDR", header);

		using var pixels = new MemoryStream();
		using (var zlib = new ZLibStream(pixels, CompressionLevel.Optimal, leaveOpen: true)) {
			var row = new byte[1 + width * 4];
			for (var y = 0; y < height; y++) {
				for (var x = 0; x < width; x++) {
					var pixel = abgr[y * width + x];
					var i = 1 + x * 4;
					row[i] = (byte)Tiff.GetR(pixel);
					row[i + 1] = (byte)Tiff.GetG(pixel);
					row[i + 2] = (byte)Tiff.GetB(pixel);
					row[i + 3] = (byte)Tiff.GetA(pixel);
				}
				zlib.Write(row);
			}
		}
		WritePngChunk(output, "IDAT", pixels.ToArray());
		WritePngChunk(output, "IEND", []);
		return output.ToArray();
	}

	static void WritePngChunk(Stream output, string type, byte[] data) {
		Span<byte> buffer = stackalloc byte[4];
		BinaryPrimitives.WriteInt32BigEndian(buffer, data.Length);
		output.Write(buffer);
		var typeBytes = Encoding.ASCII.GetBytes(type);
		output.Write(typeBytes);
		output.Write(data);
		BinaryPrimitives.WriteUInt32BigEndian(buffer, Crc32(Crc32(0xFFFFFFFF, typeBytes), data) ^ 0xFFFFFFFF);
		output.Write(buffer);
	}

	static readonly uint[] crcTable = Enumerable.Range(0, 256).Select(n => {
		var c = (uint)n;
		for (var k = 0; k < 8; k++)
			c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
		return c;
	}).ToArray();

	/// <summary>The PNG specification's CRC-32 update, without the final inversion.</summary>
	static uint Crc32(uint crc, ReadOnlySpan<byte> data) {
		foreach (var b in data)
			crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
		return crc;
	}

	static void WriteHeader(BinaryWriter writer, string assemblyName) {
		writer.Write((byte)0);
		writer.Write(1);
		writer.Write(-1);
		writer.Write(1);
		writer.Write(0);
		writer.Write(BinaryLibrary);
		writer.Write(LibraryId);
		writer.Write(assemblyName);
	}

	static void WriteByteArray(BinaryWriter writer, byte[] data) {
		writer.Write(ArraySinglePrimitive);
		writer.Write(ArrayId);
		writer.Write(data.Length);
		writer.Write(PrimitiveByte);
		writer.Write(data);
	}
}
