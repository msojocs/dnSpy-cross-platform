using System.Collections.Generic;

namespace dnSpy.AsmEditor {
	/// <summary>
	/// dnSpy.AsmEditor's own <c>AddRange</c>: the options classes rebuild dnlib's collections from lists,
	/// and the framework has no such extension for an <see cref="ICollection{T}"/>.
	/// </summary>
	static class ExtensionMethods {
		public static void AddRange<T>(this ICollection<T> coll, IEnumerable<T> data) {
			foreach (var item in data)
				coll.Add(item);
		}
	}
}
