using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using ICSharpCode.Decompiler;
using ICSharpCode.Decompiler.CSharp;
using ICSharpCode.Decompiler.CSharp.Syntax;
using ICSharpCode.Decompiler.TypeSystem;

namespace dnSpy.Backend.Core;

/// <summary>
/// ForceShowAllMembers: the members ICSharpCode.Decompiler leaves out of a document are the ones its feature
/// switches hide (a lambda's method and closure type, a state machine, a backing field, …). The switches also
/// drive the transforms, so turning them off on the document itself would stop it decompiling lambdas and async
/// methods at all. Instead the same nodes are decompiled a second time with the hiding switches off, and only the
/// declarations the first tree does not have are moved into it — the way dnSpy's AstBuilder writes every member
/// whose <c>MemberIsHidden</c> is overridden by ForceShowAllMembers.
/// </summary>
static class HiddenMemberMerger {
	/// <summary>
	/// Adds the declarations <paramref name="source"/> has and <paramref name="target"/> lacks — recursively in
	/// the types both share — and puts every type's members in the order the second decompilation wrote them, which
	/// is the same member order the first one used. The namespaces the added members need are imported too.
	/// </summary>
	public static void Merge(SyntaxTree target, SyntaxTree source, bool sortSystemUsingStatementsFirst) {
		MergeUsings(target, source, sortSystemUsingStatementsFirst);
		var targetTypes = TypesByToken(target);
		foreach (var sourceType in source.DescendantsAndSelf.OfType<TypeDeclaration>().ToArray()) {
			if (TokenOf(sourceType) is int token && targetTypes.TryGetValue(token, out var targetType))
				MergeType(targetType, sourceType);
		}
	}

	static void MergeType(TypeDeclaration target, TypeDeclaration source) {
		var order = new Dictionary<int, int>();
		foreach (var member in source.Members) {
			if (TokenOf(member) is int token)
				order.TryAdd(token, order.Count);
		}
		var targetTypes = TypesByToken(target);
		var targetTokens = target.Members.Select(TokenOf).OfType<int>().ToHashSet();
		foreach (var member in source.Members.ToArray()) {
			if (TokenOf(member) is not int token)
				continue;
			if (targetTypes.TryGetValue(token, out var targetType)) {
				if (member is TypeDeclaration sourceType)
					MergeType(targetType, sourceType);
				continue;
			}
			if (targetTokens.Contains(token))
				continue;
			target.Members.Add(member.Detach());
			targetTokens.Add(token);
		}
		// The second tree's own order is the first one's: it was written with the same SortMembers,
		// UseSourceCodeOrder and decompilation order, over all the metadata's members rather than the visible ones.
		var members = target.Members.ToList();
		var sorted = members
			.Select((member, index) => (Member: member, Key: TokenOf(member) is int token ? order.GetValueOrDefault(token, int.MaxValue) : int.MaxValue, Index: index))
			.OrderBy(entry => entry.Key).ThenBy(entry => entry.Index)
			.Select(entry => entry.Member)
			.ToList();
		if (sorted.SequenceEqual(members))
			return;
		foreach (var member in members)
			member.Remove();
		foreach (var member in sorted)
			target.Members.Add(member);
	}

	static void MergeUsings(SyntaxTree target, SyntaxTree source, bool systemFirst) {
		var existing = target.Members.OfType<UsingDeclaration>().Select(declaration => declaration.Namespace).ToHashSet(StringComparer.Ordinal);
		var additions = source.Members.OfType<UsingDeclaration>()
			.Where(declaration => !existing.Contains(declaration.Namespace))
			.Select(declaration => (UsingDeclaration)declaration.Detach())
			.ToList();
		if (additions.Count == 0)
			return;
		var first = target.Members.FirstOrDefault();
		foreach (var declaration in additions) {
			if (first is null)
				target.Members.Add(declaration);
			else
				target.Members.InsertBefore(first, declaration);
		}
		DnSpyCSharpTransform.SortUsings(target, systemFirst);
	}

	static Dictionary<int, TypeDeclaration> TypesByToken(AstNode root) {
		var types = new Dictionary<int, TypeDeclaration>();
		foreach (var type in root.DescendantsAndSelf.OfType<TypeDeclaration>()) {
			if (TokenOf(type) is int token)
				types.TryAdd(token, type);
		}
		return types;
	}

	/// <summary>The metadata row a declaration is written for, or null for one that names no row of this module.</summary>
	static int? TokenOf(AstNode node) {
		ISymbol? symbol = node.GetSymbol();
		if (symbol is not IEntity) {
			symbol = node switch {
				FieldDeclaration field => field.Variables.Select(variable => variable.GetSymbol()).OfType<IEntity>().FirstOrDefault(),
				EventDeclaration @event => @event.Variables.Select(variable => variable.GetSymbol()).OfType<IEntity>().FirstOrDefault(),
				_ => symbol,
			};
		}
		if (symbol is not IEntity entity || entity.MetadataToken.IsNil)
			return null;
		return MetadataTokens.GetToken(entity.MetadataToken);
	}
}
