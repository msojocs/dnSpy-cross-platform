using System.Diagnostics;
using dnlib.DotNet;

namespace dnSpy.Backend.Core.Analyzer;

/// <summary>
/// A stretch of types one search walks: a whole module, or the types nested in one type when the member
/// is too private to be seen from further away. <see cref="State"/> is whatever the search wants to carry
/// with the unit — Applied To searches each module for the reference that module has to the attribute.
/// </summary>
sealed class AnalyzerScanUnit(ModuleDef module, Func<IEnumerable<TypeDef>> types, object? state = null) {
	public ModuleDef Module { get; } = module;
	public object? State { get; } = state;
	public IEnumerable<TypeDef> Types() => types();

	public static AnalyzerScanUnit ForModule(ModuleDef module, object? state = null) =>
		new(module, () => AnalyzerHelpers.PreOrder(module.Types, t => t.NestedTypes), state);

	public static AnalyzerScanUnit ForType(TypeDef type) =>
		new(type.Module, () => AnalyzerHelpers.PreOrder(type, t => t.NestedTypes));
}

/// <summary>
/// One of dnSpy's analyzer searches — what a <c>SearchNode</c>'s FetchChildren does, split into the
/// steps a time-sliced run can stop between: <see cref="Prepare"/> works out which types to look at,
/// <see cref="ScanType"/> looks at one of them, and <see cref="Finish"/> adds what is only known once
/// everything was seen (an attribute at assembly level, the duplicates a whole search leaves).
/// </summary>
abstract class AnalyzerSearch(IAnalyzerHost host) {
	protected IAnalyzerHost Host { get; } = host;

	/// <summary>The stretches of types the search walks, in order. A search that reads a single method or
	/// walks a hierarchy instead answers with none and does its work in <see cref="Finish"/>.</summary>
	public abstract IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken);

	public virtual void BeginUnit(AnalyzerScanUnit unit, List<AnalyzerHit> hits) {
	}

	public virtual void ScanType(TypeDef type, AnalyzerScanUnit unit, List<AnalyzerHit> hits) =>
		hits.AddRange(FindReferencesInType(type));

	protected virtual IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) => [];

	public virtual List<AnalyzerHit> Finish(List<AnalyzerHit> hits) => hits;

	protected MethodDef GetOriginalCodeLocation(MethodDef method) => AnalyzerHelpers.GetOriginalCodeLocation(Host, method);

	protected static bool CheckEquals(IMemberRef? mr1, IMemberRef? mr2) => AnalyzerHelpers.CheckEquals(mr1, mr2);
}

/// <summary>
/// A search over the scope dnSpy's <c>ScopedWhereUsedAnalyzer</c> works out from the member's
/// accessibility. <see cref="AllModules"/> is the module list that scope came to, which the searches that
/// look at assembly and module attributes walk once the types are done.
/// </summary>
abstract class ScopedSearch(IAnalyzerHost host) : AnalyzerSearch(host) {
	ScopedWhereUsedAnalyzer? analyzer;

	protected IReadOnlyList<ModuleDef> AllModules => analyzer?.AllModules ?? [];

	protected abstract ScopedWhereUsedAnalyzer CreateAnalyzer();

	public override IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken) {
		analyzer = CreateAnalyzer();
		return analyzer.GetUnits(cancellationToken);
	}
}

/// <summary>
/// Runs a search a slice at a time. Every slice runs while the caller holds the workspace gate, so dnlib's
/// objects are only ever touched under it, and the gate is let go between slices so a long search does not
/// keep the tree and the documents waiting. A unit's types are listed when the unit starts, and only the
/// position in that list outlives a slice — no dnlib enumerator is held across the gap.
/// </summary>
sealed class AnalyzerSearchRun {
	readonly AnalyzerSearch search;
	readonly IReadOnlyList<AnalyzerScanUnit> units;
	readonly int maxResults;
	List<AnalyzerHit> hits = [];
	int unitIndex;
	List<TypeDef>? types;
	int typeIndex;

	public AnalyzerSearchRun(AnalyzerSearch search, long epoch, int maxResults, CancellationToken cancellationToken) {
		this.search = search;
		this.maxResults = maxResults;
		Epoch = epoch;
		units = search.Prepare(cancellationToken);
	}

	/// <summary>The workspace's model generation the search was prepared against; a slice must not run
	/// against any other.</summary>
	public long Epoch { get; }

	/// <summary>Set once the search reached the limit and stopped looking.</summary>
	public bool Truncated { get; private set; }

	public bool Completed => Truncated || unitIndex >= units.Count;

	public void RunSlice(TimeSpan budget, CancellationToken cancellationToken) {
		var stopwatch = Stopwatch.StartNew();
		while (!Completed) {
			var unit = units[unitIndex];
			if (types is null) {
				types = unit.Types().ToList();
				typeIndex = 0;
				search.BeginUnit(unit, hits);
			}
			while (typeIndex < types.Count) {
				cancellationToken.ThrowIfCancellationRequested();
				search.ScanType(types[typeIndex++], unit, hits);
				if (hits.Count >= maxResults) {
					Truncated = true;
					return;
				}
				if (stopwatch.Elapsed >= budget)
					return;
			}
			types = null;
			unitIndex++;
		}
	}

	public IReadOnlyList<AnalyzerHit> Finish() {
		hits = search.Finish(hits);
		if (hits.Count > maxResults) {
			Truncated = true;
			hits.RemoveRange(maxResults, hits.Count - maxResults);
		}
		return hits;
	}
}
