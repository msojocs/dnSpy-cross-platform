using System.Globalization;
using System.Text;
using dnSpy.Backend.Contracts;
using Microsoft.CodeAnalysis;

namespace dnSpy.Backend.Debugging.CorDebug.Evaluation;

/// <summary>Text in the colour classes dnSpy's debugger writes it in; runs of one colour are merged.</summary>
internal sealed class ColorTextWriter {
	readonly List<TextPartDto> parts = [];

	/// <summary>The debugger's own colours, beside the code colours of <see cref="TextColors"/>.</summary>
	public const string ToStringEval = "toStringEval";
	public const string DebuggerDisplayAttributeEval = "debuggerDisplayAttributeEval";
	public const string DebuggerNoStringQuotesEval = "debuggerNoStringQuotesEval";
	public const string DebugExceptionName = "debugExceptionName";
	public const string DebugStowedExceptionName = "debugStowedExceptionName";
	public const string DebugReturnValueName = "debugReturnValueName";
	public const string DebugVariableName = "debugVariableName";
	public const string DebugObjectIdName = "debugObjectIdName";
	public const string DebugViewPropertyName = "debugViewPropertyName";

	public ColorTextWriter Write(string color, string? text) {
		if (string.IsNullOrEmpty(text))
			return this;
		if (parts.Count > 0 && parts[^1].Color == color)
			parts[^1] = parts[^1] with { Text = parts[^1].Text + text };
		else
			parts.Add(new TextPartDto(text, color));
		return this;
	}

	public ColorTextWriter Write(IEnumerable<TextPartDto> more) {
		foreach (var part in more)
			Write(part.Color, part.Text);
		return this;
	}

	public IReadOnlyList<TextPartDto> Parts => parts;

	public List<TextPartDto> ToList() => [.. parts];

	public override string ToString() => string.Concat(parts.Select(part => part.Text));

	public static string ToText(IEnumerable<TextPartDto> parts) => string.Concat(parts.Select(part => part.Text));
}

/// <summary>
/// How values and types are written: the variables windows' options (hexadecimal, digit separators, the
/// Show... toggles) merged with the format specifiers an expression carries (<c>h</c>, <c>nq</c>, <c>raw</c>…).
/// The port of dnSpy's <c>DbgValueFormatterOptions</c> and <c>DbgValueNodeEvaluationOptions</c>.
/// </summary>
internal sealed record ValueFormatOptions {
	public EvalLanguage Language { get; init; }
	public bool Hexadecimal { get; init; } = true;
	public bool DigitSeparators { get; init; }
	public bool NoStringQuotes { get; init; }
	public bool ShowTokens { get; init; }
	public bool FullString { get; init; }
	public bool ShowNamespaces { get; init; } = true;
	public bool IntrinsicTypeKeywords { get; init; } = true;
	/// <summary>Property getters, ToString() and DebuggerDisplay may run.</summary>
	public bool FuncEval { get; init; } = true;
	public bool UseToString { get; init; } = true;
	public bool UseDebuggerDisplay { get; init; } = true;
	/// <summary>The text a value is edited as: a literal the language can read back.</summary>
	public bool Edit { get; init; }
	public bool ShowOnlyPublicMembers { get; init; }
	public bool HideCompilerGeneratedMembers { get; init; } = true;
	public bool RespectHideMemberAttributes { get; init; } = true;
	public bool HideDeprecatedError { get; init; }
	/// <summary>Show objects' raw structure, ignoring proxies and DebuggerBrowsable.</summary>
	public bool RawView { get; init; }
	public bool ResultsViewOnly { get; init; }
	public bool DynamicViewOnly { get; init; }

	/// <summary>Applies an expression's format specifiers — dnSpy's <c>PredefinedFormatSpecifiers</c>.</summary>
	public ValueFormatOptions WithSpecifiers(IEnumerable<string> specifiers) {
		var options = this;
		foreach (var specifier in specifiers) {
			options = specifier switch {
				"d" => options with { Hexadecimal = false },
				"h" => options with { Hexadecimal = true },
				"nq" => options with { NoStringQuotes = true },
				"ds" => options with { DigitSeparators = true },
				"nds" => options with { DigitSeparators = false },
				"raw" => options with { RawView = true },
				"results" => options with { ResultsViewOnly = true },
				"dynamic" => options with { DynamicViewOnly = true },
				"hidden" => options with { ShowOnlyPublicMembers = false, RespectHideMemberAttributes = false, HideCompilerGeneratedMembers = false },
				"nse" or "emulator" => options with { FuncEval = false },
				"ac" => options with { FuncEval = true },
				"ts" => options with { UseToString = true },
				"nts" => options with { UseToString = false },
				"dda" => options with { UseDebuggerDisplay = true },
				"ndda" => options with { UseDebuggerDisplay = false },
				"fs" => options with { FullString = true },
				"nfs" => options with { FullString = false },
				"ns" => options with { ShowNamespaces = true },
				"nns" => options with { ShowNamespaces = false },
				"intrinsics" => options with { IntrinsicTypeKeywords = true },
				"nointrinsics" => options with { IntrinsicTypeKeywords = false },
				"tokens" => options with { ShowTokens = true },
				"notokens" => options with { ShowTokens = false },
				"cgm" => options with { HideCompilerGeneratedMembers = false },
				"ncgm" => options with { HideCompilerGeneratedMembers = true },
				"hma" => options with { RespectHideMemberAttributes = true },
				"nhma" => options with { RespectHideMemberAttributes = false },
				"edit" => options with { Edit = true },
				_ => options,
			};
		}
		return options;
	}
}

/// <summary>
/// Writes values and types in C# or Visual Basic, the port of dnSpy's <c>CSharpValueFormatter</c>,
/// <c>CSharpPrimitiveValueFormatter</c> and <c>CSharpTypeFormatter</c> (and their Visual Basic twins):
/// numbers in hexadecimal unless asked for decimal, a char as its code and its literal, strings escaped,
/// enums by name, arrays and objects by type in braces — or by their DebuggerDisplay, or by ToString().
/// </summary>
internal sealed class ValueFormatter {
	public const int MaxStringLength = 256 * 1024;
	const int MaxRecursion = 200;

	readonly EvalRuntime runtime;
	readonly ValueFormatOptions options;
	readonly Func<string, EvalValue, Task<(EvalValue Value, IReadOnlyList<string> Specifiers)>>? evaluateInObject;
	int recursion;

	public ValueFormatter(EvalRuntime runtime, ValueFormatOptions options, Func<string, EvalValue, Task<(EvalValue Value, IReadOnlyList<string> Specifiers)>>? evaluateInObject) {
		this.runtime = runtime;
		this.options = options;
		this.evaluateInObject = evaluateInObject;
	}

	bool IsCSharp => options.Language == EvalLanguage.CSharp;

	ValueFormatter With(ValueFormatOptions other) => new(runtime, other, evaluateInObject);

	// ---------------------------------------------------------------- values

	public async Task<List<TextPartDto>> FormatValueAsync(EvalValue value) {
		var output = new ColorTextWriter();
		await FormatAsync(output, value).ConfigureAwait(false);
		return output.ToList();
	}

	public async Task FormatAsync(ColorTextWriter output, EvalValue value) {
		runtime.CancellationToken.ThrowIfCancellationRequested();
		if (recursion++ >= MaxRecursion) {
			output.Write(TextColors.Error, "???");
			recursion--;
			return;
		}
		try {
			if (value is ScalarValue scalar) {
				if (scalar.Type.SpecialType == SpecialType.System_Void) {
					output.Write(TextColors.Text, "Expression has been evaluated and has no value");
					return;
				}
				FormatScalar(output, scalar.Type, scalar.Value);
				return;
			}
			var remote = (RemoteValue)value;
			var type = remote.Type;
			if (TupleArity(type) > 0 && await TryFormatTupleAsync(output, remote).ConfigureAwait(false))
				return;
			if (IsKeyValuePair(type) && await TryFormatKeyValuePairAsync(output, remote, "key", "value").ConfigureAwait(false))
				return;
			if (IsDictionaryEntry(type) && await TryFormatKeyValuePairAsync(output, remote, "_key", "_value").ConfigureAwait(false))
				return;
			if (options.FuncEval && options.UseDebuggerDisplay && await TryFormatDebuggerDisplayAsync(output, remote, DisplayPart.Value).ConfigureAwait(false))
				return;
			if (options.FuncEval && options.UseToString && await TryFormatToStringAsync(output, remote).ConfigureAwait(false))
				return;
			output.Write(TextColors.Error, "{");
			output.Write(await FormatTypeAsync(type, remote, showArraySizes: true).ConfigureAwait(false));
			output.Write(TextColors.Error, "}");
		}
		finally {
			recursion--;
		}
	}

	async Task<bool> TryFormatToStringAsync(ColorTextWriter output, RemoteValue value) {
		var method = FindToStringOverride(value.Type);
		if (method is null)
			return false;
		try {
			var result = await runtime.CallAsync(method, value, [], "ToString").ConfigureAwait(false);
			if (result is not ScalarValue { Value: string text })
				return false;
			output.Write(ToStringEval, "{" + text + "}");
			return true;
		}
		catch (EvaluationException) {
			return false;
		}
		catch (EvaluationThrownException) {
			return false;
		}
	}

	const string ToStringEval = ColorTextWriter.ToStringEval;

	/// <summary>The type's own ToString(), unless it is the one object, ValueType or Enum provides.</summary>
	static IMethodSymbol? FindToStringOverride(ITypeSymbol type) {
		for (var current = type; current is not null; current = current.BaseType) {
			var method = current.GetMembers("ToString").OfType<IMethodSymbol>().FirstOrDefault(candidate => candidate.Parameters.Length == 0 && !candidate.IsStatic && candidate.ReturnType.SpecialType == SpecialType.System_String);
			if (method is null)
				continue;
			return current.SpecialType is SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum ? null : method;
		}
		return null;
	}

	// ---------------------------------------------------------------- tuples and pairs

	internal static int TupleArity(ITypeSymbol type) {
		var arity = 0;
		var current = type as INamedTypeSymbol;
		while (current is not null) {
			if (current.ContainingNamespace?.ToDisplayString() != "System" || current.ContainingType is not null || !current.IsValueType || !current.MetadataName.StartsWith("ValueTuple`", StringComparison.Ordinal))
				return -1;
			var count = current.TypeArguments.Length;
			if (count == 0 || count > 8)
				return -1;
			if (count != 8)
				return arity + count;
			arity += 7;
			current = current.TypeArguments[7] as INamedTypeSymbol;
		}
		return -1;
	}

	/// <summary>The fields a tuple's elements are stored in, Rest included, in element order.</summary>
	internal static IEnumerable<IFieldSymbol[]> TupleFields(INamedTypeSymbol type) {
		var path = new List<IFieldSymbol>();
		var current = type;
		while (current is not null) {
			var count = current.TypeArguments.Length;
			for (var index = 1; index <= Math.Min(count, 7); index++) {
				var field = current.GetMembers("Item" + index.ToString(CultureInfo.InvariantCulture)).OfType<IFieldSymbol>().FirstOrDefault();
				if (field is null)
					yield break;
				yield return [.. path, field];
			}
			if (count != 8)
				yield break;
			var rest = current.GetMembers("Rest").OfType<IFieldSymbol>().FirstOrDefault();
			if (rest is null)
				yield break;
			path.Add(rest);
			current = current.TypeArguments[7] as INamedTypeSymbol;
		}
	}

	async Task<bool> TryFormatTupleAsync(ColorTextWriter output, RemoteValue value) {
		if (value.Type is not INamedTypeSymbol named)
			return false;
		output.Write(TextColors.Punctuation, "(");
		var index = 0;
		foreach (var path in TupleFields(named)) {
			if (index++ > 0)
				output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
			EvalValue current = value;
			try {
				foreach (var field in path)
					current = await runtime.ReadFieldAsync(current, field).ConfigureAwait(false);
				await FormatAsync(output, current).ConfigureAwait(false);
			}
			catch (EvaluationException) {
				output.Write(TextColors.Error, "???");
			}
		}
		output.Write(TextColors.Punctuation, ")");
		return true;
	}

	internal static bool IsKeyValuePair(ITypeSymbol type) =>
		type is INamedTypeSymbol { MetadataName: "KeyValuePair`2", ContainingType: null } named && named.ContainingNamespace?.ToDisplayString() == "System.Collections.Generic";

	internal static bool IsDictionaryEntry(ITypeSymbol type) =>
		type is INamedTypeSymbol { MetadataName: "DictionaryEntry", ContainingType: null } named && named.ContainingNamespace?.ToDisplayString() == "System.Collections";

	async Task<bool> TryFormatKeyValuePairAsync(ColorTextWriter output, RemoteValue value, string keyName, string valueName) {
		var key = value.Type.GetMembers(keyName).OfType<IFieldSymbol>().FirstOrDefault();
		var item = value.Type.GetMembers(valueName).OfType<IFieldSymbol>().FirstOrDefault();
		if (key is null || item is null)
			return false;
		try {
			var keyValue = await runtime.ReadFieldAsync(value, key).ConfigureAwait(false);
			var itemValue = await runtime.ReadFieldAsync(value, item).ConfigureAwait(false);
			output.Write(TextColors.Punctuation, "[");
			await FormatAsync(output, keyValue).ConfigureAwait(false);
			output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
			await FormatAsync(output, itemValue).ConfigureAwait(false);
			output.Write(TextColors.Punctuation, "]");
			return true;
		}
		catch (EvaluationException) {
			return false;
		}
	}

	// ---------------------------------------------------------------- DebuggerDisplay

	public enum DisplayPart {
		Name,
		Value,
		Type,
	}

	/// <summary>
	/// <c>[DebuggerDisplay("Count = {Count}")]</c>: the text with each <c>{expression}</c> evaluated against
	/// the object. A type with none shows like Visual Studio shows <c>System.Type</c>.
	/// </summary>
	public async Task<bool> TryFormatDebuggerDisplayAsync(ColorTextWriter output, RemoteValue value, DisplayPart part) {
		if (evaluateInObject is null)
			return false;
		var text = GetDebuggerDisplayString(value.Type, part, runtime.Compilation);
		if (text is null)
			return false;
		foreach (var (isExpression, piece) in ParseDisplayString(text)) {
			if (!isExpression) {
				output.Write(ColorTextWriter.DebuggerDisplayAttributeEval, piece);
				continue;
			}
			try {
				var (result, specifiers) = await evaluateInObject(piece, value).ConfigureAwait(false);
				var nested = With((options with { UseDebuggerDisplay = false, NoStringQuotes = false }).WithSpecifiers(specifiers));
				await nested.FormatAsync(output, result).ConfigureAwait(false);
			}
			catch (EvaluationException ex) {
				output.Write(TextColors.Error, "<<<" + ex.Message + ">>>");
			}
			catch (EvaluationThrownException ex) {
				output.Write(TextColors.Error, "<<<" + DescribeThrown(ex) + ">>>");
			}
		}
		return true;
	}

	internal static string DescribeThrown(EvaluationThrownException ex) =>
		$"'{ex.Member ?? "expression"}' threw an exception of type '{ex.ExceptionValue.Type.ToDisplayString()}'";

	internal static string? GetDebuggerDisplayString(ITypeSymbol type, DisplayPart part, Compilation compilation) {
		// KeyValuePair and DictionaryEntry are formatted by the debugger itself.
		if (IsKeyValuePair(type) || IsDictionaryEntry(type))
			return null;
		for (var current = type; current is not null; current = current.BaseType) {
			foreach (var attribute in current.GetAttributes()) {
				if (attribute.AttributeClass?.ToDisplayString() != "System.Diagnostics.DebuggerDisplayAttribute")
					continue;
				return part switch {
					DisplayPart.Value => attribute.ConstructorArguments.Length == 1 ? attribute.ConstructorArguments[0].Value as string : null,
					DisplayPart.Name => attribute.NamedArguments.FirstOrDefault(argument => argument.Key == "Name").Value.Value as string,
					_ => attribute.NamedArguments.FirstOrDefault(argument => argument.Key == "Type").Value.Value as string,
				};
			}
		}
		if (part == DisplayPart.Value && IsSystemType(type, compilation))
			return @"\{Name = {Name} FullName = {FullName}\}";
		return null;
	}

	static bool IsSystemType(ITypeSymbol type, Compilation compilation) {
		var system = compilation.GetTypeByMetadataName("System.Type");
		for (var current = type; current is not null; current = current.BaseType) {
			if (SymbolEqualityComparer.Default.Equals(current, system))
				return true;
		}
		return false;
	}

	/// <summary>dnSpy's <c>CreateDisplayParts</c>: text and <c>{expression}</c> pieces, with <c>\{</c> escapes.</summary>
	internal static IEnumerable<(bool IsExpression, string Text)> ParseDisplayString(string text) {
		var position = 0;
		var builder = new StringBuilder();
		while (true) {
			builder.Clear();
			while (position < text.Length) {
				var c = text[position++];
				if (c == '{')
					break;
				if (c == '\\' && position < text.Length) {
					c = text[position++];
					if (c is not ('{' or '}' or '\\'))
						builder.Append('\\');
				}
				builder.Append(c);
			}
			if (builder.Length > 0)
				yield return (false, builder.ToString());
			builder.Clear();
			var braces = 1;
			var any = false;
			while (position < text.Length) {
				var c = text[position++];
				if (c == '}') {
					if (braces <= 1)
						break;
					braces--;
				}
				else if (c == '{')
					braces++;
				builder.Append(c);
				any = true;
			}
			if (any)
				yield return (true, builder.ToString());
			if (position >= text.Length)
				yield break;
		}
	}

	// ---------------------------------------------------------------- primitives

	const string CSharpHexPrefix = "0x";
	const string VisualBasicHexPrefix = "&H";

	string HexPrefix => IsCSharp ? CSharpHexPrefix : VisualBasicHexPrefix;

	public void FormatScalar(ColorTextWriter output, ITypeSymbol type, object? value) {
		if (value is null) {
			output.Write(TextColors.Keyword, IsCSharp ? "null" : "Nothing");
			return;
		}
		if (type.TypeKind == TypeKind.Enum && Arithmetic.IsIntegral(value)) {
			FormatEnum(output, (INamedTypeSymbol)type, value);
			return;
		}
		switch (value) {
			case bool b:
				output.Write(TextColors.Keyword, IsCSharp ? (b ? "true" : "false") : (b ? "True" : "False"));
				return;
			case char c:
				FormatChar(output, c);
				return;
			case string s:
				FormatString(output, s);
				return;
			case float f:
				FormatFloating(output, f, float.IsNaN(f), float.IsNegativeInfinity(f), float.IsPositiveInfinity(f), "Single", f.ToString(CultureInfo.InvariantCulture));
				return;
			case double d:
				FormatFloating(output, d, double.IsNaN(d), double.IsNegativeInfinity(d), double.IsPositiveInfinity(d), "Double", d.ToString(CultureInfo.InvariantCulture));
				return;
			case decimal m:
				output.Write(TextColors.Number, m.ToString(CultureInfo.InvariantCulture) + (options.Edit ? (IsCSharp ? "M" : "D") : string.Empty));
				return;
			case nint n:
				output.Write(TextColors.Number, HexNumber(IntPtr.Size == 8 ? ((long)n).ToString("X16", CultureInfo.InvariantCulture) : ((int)n).ToString("X8", CultureInfo.InvariantCulture)));
				return;
			case nuint n:
				output.Write(TextColors.Number, HexNumber(UIntPtr.Size == 8 ? ((ulong)n).ToString("X16", CultureInfo.InvariantCulture) : ((uint)n).ToString("X8", CultureInfo.InvariantCulture)));
				return;
			default:
				if (Arithmetic.IsIntegral(value)) {
					output.Write(TextColors.Number, FormatInteger(value));
					return;
				}
				output.Write(TextColors.Text, value.ToString());
				return;
		}
	}

	void FormatFloating(ColorTextWriter output, object _, bool isNaN, bool isNegativeInfinity, bool isPositiveInfinity, string typeName, string text) {
		string? literal = isNaN ? "NaN" : isNegativeInfinity ? "NegativeInfinity" : isPositiveInfinity ? "PositiveInfinity" : null;
		if (literal is null) {
			output.Write(TextColors.Number, text);
			return;
		}
		if (!options.Edit) {
			output.Write(TextColors.Number, isNaN ? "NaN" : isNegativeInfinity ? "-Infinity" : "Infinity");
			return;
		}
		output.Write(TextColors.ValueType, IsCSharp ? (typeName == "Single" ? "float" : "double") : typeName);
		output.Write(TextColors.Operator, ".");
		output.Write(TextColors.LiteralField, literal);
	}

	/// <summary>An integer in the window's base: hexadecimal padded to the type's width, or decimal.</summary>
	public string FormatInteger(object value) {
		if (!options.Hexadecimal)
			return DecimalNumber(Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty);
		var hex = value switch {
			sbyte v => v.ToString("X2", CultureInfo.InvariantCulture),
			byte v => v.ToString("X2", CultureInfo.InvariantCulture),
			short v => v.ToString("X4", CultureInfo.InvariantCulture),
			ushort v => v.ToString("X4", CultureInfo.InvariantCulture),
			char v => ((ushort)v).ToString("X4", CultureInfo.InvariantCulture),
			int v => v.ToString("X8", CultureInfo.InvariantCulture),
			uint v => v.ToString("X8", CultureInfo.InvariantCulture),
			long v => v.ToString("X16", CultureInfo.InvariantCulture),
			ulong v => v.ToString("X16", CultureInfo.InvariantCulture),
			_ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
		};
		return HexNumber(hex);
	}

	string HexNumber(string digits) => HexPrefix + (options.DigitSeparators ? AddSeparators(digits, 4) : digits);

	string DecimalNumber(string digits) => options.DigitSeparators ? AddSeparators(digits, 3) : digits;

	/// <summary>dnSpy's <c>ValueFormatterUtils.AddDigitSeparators</c>, with <c>_</c> as the separator.</summary>
	internal static string AddSeparators(string number, int groupSize) {
		if (number.Length <= groupSize)
			return number;
		var builder = new StringBuilder();
		for (var index = 0; index < number.Length; index++) {
			var remaining = number.Length - index;
			if (index != 0 && remaining % groupSize == 0 && number[index - 1] != '-')
				builder.Append('_');
			builder.Append(number[index]);
		}
		return builder.ToString();
	}

	void FormatEnum(ColorTextWriter output, INamedTypeSymbol type, object rawValue) {
		var value = unchecked((ulong)Convert.ToInt64(rawValue is ulong u ? unchecked((long)u) : rawValue, CultureInfo.InvariantCulture));
		var fields = type.GetMembers().OfType<IFieldSymbol>()
			.Where(field => field.IsConst && field.HasConstantValue)
			.Select(field => (Field: field, Value: unchecked((ulong)Convert.ToInt64(field.ConstantValue is ulong fu ? unchecked((long)fu) : field.ConstantValue, CultureInfo.InvariantCulture))))
			.ToArray();
		var isFlags = type.GetAttributes().Any(attribute => attribute.AttributeClass?.ToDisplayString() == "System.FlagsAttribute");
		if (isFlags && value != 0) {
			var remaining = value;
			var needSeparator = false;
			// dnSpy's EnumInfo keeps the fields in declaration order, and any field sharing a bit is written.
			foreach (var (field, flag) in fields) {
				if ((remaining & flag) == 0)
					continue;
				if (needSeparator)
					WriteEnumSeparator(output);
				needSeparator = true;
				WriteEnumField(output, type, field);
				remaining &= ~flag;
				if (remaining == 0)
					break;
			}
			if (remaining != 0) {
				if (needSeparator)
					WriteEnumSeparator(output);
				output.Write(TextColors.Number, FormatInteger(EnumRaw(type, remaining)));
			}
			return;
		}
		foreach (var (field, fieldValue) in fields) {
			if (fieldValue == value) {
				WriteEnumField(output, type, field);
				return;
			}
		}
		output.Write(TextColors.Number, FormatInteger(rawValue));
	}

	static object EnumRaw(INamedTypeSymbol type, ulong value) => type.EnumUnderlyingType?.SpecialType switch {
		SpecialType.System_SByte => unchecked((sbyte)value),
		SpecialType.System_Byte => unchecked((byte)value),
		SpecialType.System_Int16 => unchecked((short)value),
		SpecialType.System_UInt16 => unchecked((ushort)value),
		SpecialType.System_Int32 => unchecked((int)value),
		SpecialType.System_UInt32 => unchecked((uint)value),
		SpecialType.System_Int64 => unchecked((long)value),
		_ => value,
	};

	void WriteEnumSeparator(ColorTextWriter output) {
		output.Write(TextColors.Text, " ");
		if (IsCSharp)
			output.Write(TextColors.Operator, "|");
		else
			output.Write(TextColors.Keyword, "Or");
		output.Write(TextColors.Text, " ");
	}

	void WriteEnumField(ColorTextWriter output, INamedTypeSymbol type, IFieldSymbol field) {
		if (options.Edit) {
			output.Write(FormatTypeName(type));
			output.Write(TextColors.Operator, ".");
		}
		output.Write(TextColors.EnumField, EscapeIdentifier(field.Name));
	}

	void FormatChar(ColorTextWriter output, char value) {
		if (!options.Edit) {
			output.Write(TextColors.Number, FormatInteger((ushort)value));
			output.Write(TextColors.Text, " ");
		}
		if (IsCSharp) {
			output.Write(TextColors.Char, CSharpChar(value));
			return;
		}
		switch (value) {
			case '\r': output.Write(TextColors.LiteralField, "vbCr"); return;
			case '\n': output.Write(TextColors.LiteralField, "vbLf"); return;
			case '\b': output.Write(TextColors.LiteralField, "vbBack"); return;
			case '\f': output.Write(TextColors.LiteralField, "vbFormFeed"); return;
			case '\t': output.Write(TextColors.LiteralField, "vbTab"); return;
			case '\v': output.Write(TextColors.LiteralField, "vbVerticalTab"); return;
			case '\0': output.Write(TextColors.LiteralField, "vbNullChar"); return;
			case '"': output.Write(TextColors.Char, "\"\"\"\"c"); return;
		}
		if (char.IsControl(value)) {
			output.Write(TextColors.StaticMethod, "ChrW").Write(TextColors.Punctuation, "(").Write(TextColors.Number, FormatInteger((ushort)value)).Write(TextColors.Punctuation, ")");
			return;
		}
		output.Write(TextColors.Char, "\"" + value + "\"c");
	}

	static string CSharpChar(char value) {
		var escaped = value switch {
			'\a' => @"\a",
			'\b' => @"\b",
			'\f' => @"\f",
			'\n' => @"\n",
			'\r' => @"\r",
			'\t' => @"\t",
			'\v' => @"\v",
			'\\' => @"\\",
			'\0' => @"\0",
			'\'' => @"\'",
			_ => char.IsControl(value) ? @"\u" + ((ushort)value).ToString("X4", CultureInfo.InvariantCulture) : value.ToString(),
		};
		return "'" + escaped + "'";
	}

	void FormatString(ColorTextWriter output, string value) {
		var tooLong = !options.FullString && value.Length > MaxStringLength;
		if (tooLong)
			value = value[..MaxStringLength];
		if (options.NoStringQuotes) {
			output.Write(ColorTextWriter.DebuggerNoStringQuotesEval, value + (tooLong ? "[...]" : string.Empty));
			return;
		}
		if (IsCSharp) {
			if (CanUseVerbatimString(value)) {
				output.Write(TextColors.VerbatimString, "@\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + (tooLong ? "[...]" : string.Empty) + "\"");
				return;
			}
			var builder = new StringBuilder("\"");
			foreach (var c in value) {
				builder.Append(c switch {
					'\a' => @"\a",
					'\b' => @"\b",
					'\f' => @"\f",
					'\n' => @"\n",
					'\r' => @"\r",
					'\t' => @"\t",
					'\v' => @"\v",
					'\\' => @"\\",
					'\0' => @"\0",
					'"' => "\\\"",
					_ => char.IsControl(c) ? @"\u" + ((ushort)c).ToString("X4", CultureInfo.InvariantCulture) : c.ToString(),
				});
			}
			if (tooLong)
				builder.Append("[...]");
			builder.Append('"');
			output.Write(TextColors.String, builder.ToString());
			return;
		}
		FormatVisualBasicString(output, value, tooLong);
	}

	static bool CanUseVerbatimString(string value) {
		var foundBackslash = false;
		foreach (var c in value) {
			switch (c) {
				case '"':
					break;
				case '\\':
					foundBackslash = true;
					break;
				case '\a' or '\b' or '\f' or '\n' or '\r' or '\t' or '\v' or '\0' or '\u0085' or '\u2028' or '\u2029':
					return false;
				default:
					if (char.IsControl(c))
						return false;
					break;
			}
		}
		return foundBackslash;
	}

	void FormatVisualBasicString(ColorTextWriter output, string value, bool tooLong) {
		if (value.Length == 0) {
			output.Write(TextColors.String, "\"\"");
			return;
		}
		var index = 0;
		var needSeparator = false;
		void Separator() {
			if (needSeparator)
				output.Write(TextColors.Text, " ").Write(TextColors.Operator, "&").Write(TextColors.Text, " ");
			needSeparator = true;
		}
		while (index < value.Length) {
			var builder = new StringBuilder();
			while (index < value.Length) {
				var c = value[index];
				if (c is '\r' or '\n' or '\b' or '\f' or '\t' or '\v' or '\0' or '\u0085' or '\u2028' or '\u2029' || (char.IsControl(c) && c != '"'))
					break;
				builder.Append(c == '"' ? "\"\"" : c.ToString());
				index++;
			}
			if (builder.Length > 0) {
				Separator();
				output.Write(TextColors.String, "\"" + builder + "\"");
			}
			if (index >= value.Length)
				break;
			var special = value[index];
			Separator();
			switch (special) {
				case '\r' when index + 1 < value.Length && value[index + 1] == '\n':
					output.Write(TextColors.LiteralField, "vbCrLf");
					index++;
					break;
				case '\r': output.Write(TextColors.LiteralField, "vbCr"); break;
				case '\n': output.Write(TextColors.LiteralField, "vbLf"); break;
				case '\b': output.Write(TextColors.LiteralField, "vbBack"); break;
				case '\f': output.Write(TextColors.LiteralField, "vbFormFeed"); break;
				case '\t': output.Write(TextColors.LiteralField, "vbTab"); break;
				case '\v': output.Write(TextColors.LiteralField, "vbVerticalTab"); break;
				case '\0': output.Write(TextColors.LiteralField, "vbNullChar"); break;
				default:
					output.Write(TextColors.StaticMethod, "ChrW").Write(TextColors.Punctuation, "(").Write(TextColors.Number, FormatInteger((ushort)special)).Write(TextColors.Punctuation, ")");
					break;
			}
			index++;
		}
		if (tooLong) {
			Separator();
			output.Write(TextColors.String, "\"[...]\"");
		}
	}

	// ---------------------------------------------------------------- types

	/// <summary>A type name, with the sizes of the array value it is the type of (<c>int[3]</c>).</summary>
	public async Task<List<TextPartDto>> FormatTypeAsync(ITypeSymbol type, EvalValue? value, bool showArraySizes) {
		uint[]? dimensions = null;
		uint[]? lowerBounds = null;
		if (showArraySizes && type is IArrayTypeSymbol && value is RemoteValue remote) {
			try {
				(dimensions, lowerBounds) = await runtime.ReadArrayShapeAsync(remote).ConfigureAwait(false);
			}
			catch (EvaluationException) {
			}
		}
		var output = new ColorTextWriter();
		WriteType(output, type, dimensions, lowerBounds, 0);
		return output.ToList();
	}

	public List<TextPartDto> FormatTypeName(ITypeSymbol type) {
		var output = new ColorTextWriter();
		WriteType(output, type, null, null, 0);
		return output.ToList();
	}

	void WriteType(ColorTextWriter output, ITypeSymbol type, uint[]? sizes, uint[]? lowerBounds, int depth) {
		if (depth > MaxRecursion) {
			output.Write(TextColors.Error, "???");
			return;
		}
		switch (type) {
			case IArrayTypeSymbol array: {
				// Array types read innermost element first, then each rank from the outside in.
				var ranks = new List<IArrayTypeSymbol>();
				ITypeSymbol element = array;
				while (element is IArrayTypeSymbol nested) {
					ranks.Add(nested);
					element = nested.ElementType;
				}
				WriteType(output, element, null, null, depth + 1);
				for (var position = 0; position < ranks.Count; position++) {
					var rank = ranks[position];
					output.Write(TextColors.Punctuation, IsCSharp ? "[" : "(");
					if (position == 0 && sizes is not null) {
						for (var dimension = 0; dimension < sizes.Length; dimension++) {
							if (dimension > 0)
								output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
							var bound = lowerBounds is not null && dimension < lowerBounds.Length ? (int)lowerBounds[dimension] : 0;
							if (bound == 0)
								output.Write(TextColors.Number, FormatTypeNumber(sizes[dimension]));
							else
								output.Write(TextColors.Number, FormatTypeNumber((uint)bound)).Write(TextColors.Operator, "..").Write(TextColors.Number, FormatTypeNumber((uint)(bound + (int)sizes[dimension] - 1)));
						}
					}
					else if (!rank.IsSZArray) {
						if (rank.Rank == 1)
							output.Write(TextColors.Operator, "*");
						output.Write(TextColors.Punctuation, new string(',', Math.Max(rank.Rank - 1, 0)));
					}
					output.Write(TextColors.Punctuation, IsCSharp ? "]" : ")");
				}
				return;
			}
			case IPointerTypeSymbol pointer:
				WriteType(output, pointer.PointedAtType, null, null, depth + 1);
				output.Write(TextColors.Operator, "*");
				return;
			case ITypeParameterSymbol parameter:
				output.Write(parameter.TypeParameterKind == TypeParameterKind.Method ? TextColors.MethodGenericParameter : TextColors.TypeGenericParameter, EscapeIdentifier(parameter.Name));
				return;
			case IDynamicTypeSymbol:
				output.Write(TextColors.Keyword, IsCSharp ? "dynamic" : "Object");
				return;
			case INamedTypeSymbol named:
				WriteNamedType(output, named, depth);
				return;
			default:
				output.Write(TextColors.Text, type.ToDisplayString());
				return;
		}
	}

	string FormatTypeNumber(uint value) => options.Hexadecimal
		? HexNumber(value.ToString("X8", CultureInfo.InvariantCulture))
		: DecimalNumber(value.ToString(CultureInfo.InvariantCulture));

	void WriteNamedType(ColorTextWriter output, INamedTypeSymbol type, int depth) {
		if (type.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T && type.TypeArguments.Length == 1) {
			WriteType(output, type.TypeArguments[0], null, null, depth + 1);
			output.Write(TextColors.Operator, "?");
			return;
		}
		if (TupleArity(type) > 1) {
			output.Write(TextColors.Punctuation, "(");
			var arguments = new List<ITypeSymbol>();
			var current = type;
			while (current is not null) {
				var count = current.TypeArguments.Length;
				arguments.AddRange(current.TypeArguments.Take(Math.Min(count, 7)));
				current = count == 8 ? current.TypeArguments[7] as INamedTypeSymbol : null;
			}
			for (var index = 0; index < arguments.Count; index++) {
				if (index > 0)
					output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
				WriteType(output, arguments[index], null, null, depth + 1);
			}
			output.Write(TextColors.Punctuation, ")");
			return;
		}
		var chain = new List<INamedTypeSymbol>();
		for (var current = type; current is not null; current = current.ContainingType)
			chain.Add(current);
		chain.Reverse();
		var outermost = chain[0];
		var keyword = Keyword(outermost);
		if (keyword is null && options.ShowNamespaces && outermost.ContainingNamespace is { IsGlobalNamespace: false } ns) {
			foreach (var part in ns.ToDisplayString().Split('.')) {
				output.Write(TextColors.Namespace, EscapeIdentifier(part));
				output.Write(TextColors.Operator, ".");
			}
		}
		for (var index = 0; index < chain.Count; index++) {
			var current = chain[index];
			if (index == 0 && keyword is not null)
				output.Write(TextColors.Keyword, keyword);
			else {
				output.Write(ColorOf(current), EscapeIdentifier(RemoveGenericTick(current.MetadataName)));
				if (options.ShowTokens && current.OriginalDefinition.MetadataToken != 0)
					output.Write(TextColors.Comment, "/*" + HexNumber(current.OriginalDefinition.MetadataToken.ToString("X8", CultureInfo.InvariantCulture)) + "*/");
			}
			if (current.TypeArguments.Length > 0) {
				output.Write(TextColors.Punctuation, IsCSharp ? "<" : "(");
				if (!IsCSharp)
					output.Write(TextColors.Keyword, "Of").Write(TextColors.Text, " ");
				for (var argument = 0; argument < current.TypeArguments.Length; argument++) {
					if (argument > 0)
						output.Write(TextColors.Punctuation, ",").Write(TextColors.Text, " ");
					WriteType(output, current.TypeArguments[argument], null, null, depth + 1);
				}
				output.Write(TextColors.Punctuation, IsCSharp ? ">" : ")");
			}
			if (index + 1 < chain.Count)
				output.Write(TextColors.Operator, ".");
		}
	}

	static string RemoveGenericTick(string name) {
		var tick = name.LastIndexOf('`');
		return tick < 0 || name.StartsWith('<') ? name : name[..tick];
	}

	string? Keyword(INamedTypeSymbol type) {
		if (!options.IntrinsicTypeKeywords || type.ContainingType is not null)
			return null;
		if (IsCSharp) {
			return type.SpecialType switch {
				SpecialType.System_Void => "void",
				SpecialType.System_Boolean => "bool",
				SpecialType.System_Char => "char",
				SpecialType.System_SByte => "sbyte",
				SpecialType.System_Byte => "byte",
				SpecialType.System_Int16 => "short",
				SpecialType.System_UInt16 => "ushort",
				SpecialType.System_Int32 => "int",
				SpecialType.System_UInt32 => "uint",
				SpecialType.System_Int64 => "long",
				SpecialType.System_UInt64 => "ulong",
				SpecialType.System_Single => "float",
				SpecialType.System_Double => "double",
				SpecialType.System_Object => "object",
				SpecialType.System_Decimal => "decimal",
				SpecialType.System_String => "string",
				_ => null,
			};
		}
		return type.SpecialType switch {
			SpecialType.System_Boolean => "Boolean",
			SpecialType.System_Byte => "Byte",
			SpecialType.System_Char => "Char",
			SpecialType.System_DateTime => "Date",
			SpecialType.System_Decimal => "Decimal",
			SpecialType.System_Double => "Double",
			SpecialType.System_Int32 => "Integer",
			SpecialType.System_Int64 => "Long",
			SpecialType.System_Object => "Object",
			SpecialType.System_SByte => "SByte",
			SpecialType.System_Int16 => "Short",
			SpecialType.System_Single => "Single",
			SpecialType.System_String => "String",
			SpecialType.System_UInt32 => "UInteger",
			SpecialType.System_UInt64 => "ULong",
			SpecialType.System_UInt16 => "UShort",
			_ => null,
		};
	}

	/// <summary>dnSpy's <c>TypeFormatterUtils.GetColor</c>.</summary>
	internal static string ColorOf(INamedTypeSymbol type) {
		if (type.TypeKind == TypeKind.Interface)
			return TextColors.Interface;
		if (type.TypeKind == TypeKind.Enum)
			return TextColors.Enum;
		if (type.IsValueType)
			return TextColors.ValueType;
		if (type.TypeKind == TypeKind.Delegate)
			return TextColors.Delegate;
		if (type.IsStatic)
			return TextColors.StaticType;
		if (type.IsSealed)
			return TextColors.SealedType;
		return TextColors.Type;
	}

	static readonly HashSet<string> CSharpKeywords = new(StringComparer.Ordinal) {
		"abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue",
		"decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally",
		"fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int", "interface", "internal", "is", "lock",
		"long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private", "protected",
		"public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc", "static", "string",
		"struct", "switch", "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort",
		"using", "virtual", "void", "volatile", "while",
	};

	public string EscapeIdentifier(string name) {
		if (IsCSharp)
			return CSharpKeywords.Contains(name) ? "@" + name : name;
		return Microsoft.CodeAnalysis.VisualBasic.SyntaxFacts.GetKeywordKind(name) != Microsoft.CodeAnalysis.VisualBasic.SyntaxKind.None ? "[" + name + "]" : name;
	}

	/// <summary>The colour a member's name is written in: by kind, static or not.</summary>
	internal static string ColorOf(ISymbol member) => member switch {
		IFieldSymbol { IsConst: true } field => field.ContainingType.TypeKind == TypeKind.Enum ? TextColors.EnumField : TextColors.LiteralField,
		IFieldSymbol field => field.IsStatic ? TextColors.StaticField : TextColors.InstanceField,
		IPropertySymbol property => property.IsStatic ? TextColors.StaticProperty : TextColors.InstanceProperty,
		IMethodSymbol method => method.IsExtensionMethod ? TextColors.ExtensionMethod : method.IsStatic ? TextColors.StaticMethod : TextColors.InstanceMethod,
		IEventSymbol @event => @event.IsStatic ? TextColors.StaticEvent : TextColors.InstanceEvent,
		_ => TextColors.Text,
	};
}
