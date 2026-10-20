using dnlib.DotNet;
using dnSpy.Backend.Contracts;

namespace dnSpy.Backend.Core;

/// <summary>
/// What dnSpy's debugger commands on a reference — a tree row, a reference in the code viewer, a search result or an
/// analyzer row — act on: the methods "Add Method Breakpoint" puts a breakpoint at the entry of
/// (ClassBreakpointCommands' GetMethods), the methods of the type "Add Class Breakpoint" does, and the exception type
/// "Break When Thrown" names. A reference into a module the workspace does not hold is read from its file.
/// </summary>
public sealed partial class WorkspaceManager {
	public Task<DebugCodeTargetsResponse> GetDebugCodeTargetsAsync(DebugCodeTargetsRequest request, CancellationToken cancellationToken) =>
		WithSymbolsAsync(request.WorkspaceId, workspace => {
			var resolved = new List<IMemberRef>();
			foreach (var reference in request.References) {
				cancellationToken.ThrowIfCancellationRequested();
				if (ResolveDebugReference(workspace, reference) is { } member)
					resolved.Add(member);
			}
			var methods = new List<DebugMethodTargetDto>();
			var seen = new HashSet<(string, uint)>();
			foreach (var member in resolved) {
				foreach (var method in MethodsOf(member))
					AddMethod(methods, seen, method);
			}
			// The class commands look at the first reference only, as dnSpy's do.
			var type = resolved.Count > 0 ? AsTypeDef(resolved[0]) : null;
			List<DebugMethodTargetDto>? typeMethods = null;
			if (type is not null) {
				typeMethods = [];
				var typeSeen = new HashSet<(string, uint)>();
				foreach (var method in type.Methods)
					AddMethod(typeMethods, typeSeen, method);
			}
			// "Break When Thrown" wants exactly one reference, and a type that is an exception.
			var exception = resolved.Count == 1 && type is not null && IsExceptionType(type) ? type.ReflectionFullName : null;
			return new DebugCodeTargetsResponse(methods, typeMethods, type?.FullName, exception);
		}, cancellationToken);

	/// <summary>The definition a reference names: a node of the workspace, or a module and a token.</summary>
	IMemberRef? ResolveDebugReference(Workspace? workspace, DebugCodeReferenceDto reference) {
		object? value = null;
		if (reference.NodeId is { } nodeId && workspace is not null)
			value = workspace.TryGetNodeValue(nodeId);
		if (value is null && reference.ModulePath is { Length: > 0 } path && reference.MetadataToken is { } token) {
			var module = FindBookmarkModule(workspace, path)?.Module;
			try {
				value = module?.ResolveToken(unchecked((uint)token));
			}
			catch (Exception) {
				// A token the module has no row for names nothing.
				value = null;
			}
		}
		return value switch {
			// A parameter stands for the method it belongs to, the way dnSpy maps a Parameter to its ParamDef.
			Parameter parameter => parameter.Method,
			ParamDef paramDef => paramDef.DeclaringMethod,
			IMemberRef member => member,
			_ => null,
		};
	}

	/// <summary>ClassBreakpointCommands' GetMethods: a method, or the accessors of a property or an event.</summary>
	static IEnumerable<MethodDef> MethodsOf(IMemberRef member) {
		switch (member) {
			case PropertyDef property:
				foreach (var method in property.GetMethods.Concat(property.SetMethods).Concat(property.OtherMethods))
					yield return method;
				break;
			case EventDef @event:
				foreach (var method in new[] { @event.AddMethod, @event.RemoveMethod, @event.InvokeMethod }.OfType<MethodDef>().Concat(@event.OtherMethods))
					yield return method;
				break;
			case IMethod { IsMethod: true } method when TryResolve(method) is { } definition:
				yield return definition;
				break;
		}
	}

	static MethodDef? TryResolve(IMethod method) {
		try {
			return method.ResolveMethodDef();
		}
		catch (Exception) {
			return null;
		}
	}

	static TypeDef? AsTypeDef(IMemberRef member) {
		if (member is not ITypeDefOrRef type)
			return null;
		try {
			return type.ResolveTypeDef();
		}
		catch (Exception) {
			return null;
		}
	}

	/// <summary>A method collected once; MethodBreakpointsService.Add skips the ones without code when it adds them.</summary>
	static void AddMethod(List<DebugMethodTargetDto> methods, HashSet<(string, uint)> seen, MethodDef method) {
		if (method.Module?.Location is not { Length: > 0 } path)
			return;
		if (!seen.Add((path, method.MDToken.Raw)))
			return;
		methods.Add(new DebugMethodTargetDto(path, unchecked((int)method.MDToken.Raw), method.FullName, !method.IsAbstract && method.HasBody));
	}

	/// <summary>BreakWhenThrownExceptionCommand.IsException: <c>System.Exception</c> of the core library, or a type that derives from it.</summary>
	static bool IsExceptionType(TypeDef type) {
		ITypeDefOrRef? current = type;
		for (var depth = 0; current is not null && depth < 1000; depth++) {
			if (current.DeclaringType is null && current.Namespace == "System" && current.Name == "Exception" && current.DefinitionAssembly.IsCorLib())
				return true;
			current = AsTypeDef(current)?.BaseType;
		}
		return false;
	}

	sealed partial class Workspace {
		/// <summary>
		/// The metadata row a node stands for — a base type or a type reference row the type it names, dnSpy's
		/// IMDTokenNode.Reference — or null for a node id the workspace does not know.
		/// </summary>
		internal object? TryGetNodeValue(string nodeId) => nodes.TryGetValue(nodeId, out var node)
			? node.Value switch {
				BaseTypeValue value => value.TypeDefOrRef,
				TypeReferenceValue value => value.Type,
				var value => value,
			}
			: null;
	}
}
