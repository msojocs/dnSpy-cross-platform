using System.Diagnostics;
using System.Runtime.ExceptionServices;
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
/// <see cref="Collect"/> looks at one of them, <see cref="Accept"/> decides which of what it found goes on
/// the list, and <see cref="Finish"/> adds what is only known once everything was seen (an attribute at
/// assembly level). The hits only ever grow at the end: what a search found is sent to the client while it
/// still runs, so no step may take back or reorder a hit already listed — a duplicate is dropped before it
/// is added, the way WPF's lazy Distinct() does.
/// </summary>
abstract class AnalyzerSearch(IAnalyzerHost host) {
	protected IAnalyzerHost Host { get; } = host;

	/// <summary>The stretches of types the search walks, in order. A search that reads a single method or
	/// walks a hierarchy instead answers with none and does its work in <see cref="Finish"/>.</summary>
	public abstract IReadOnlyList<AnalyzerScanUnit> Prepare(CancellationToken cancellationToken);

	public virtual void BeginUnit(AnalyzerScanUnit unit, List<AnalyzerHit> hits) {
	}

	/// <summary>
	/// What one type holds for the search. Several types may be looked at at once, on as many threads — the
	/// way dnSpy's PLINQ query runs a search — so this may only read the model and resolve through the
	/// host; whatever a search remembers from one type to the next is <see cref="Accept"/>'s to keep.
	/// </summary>
	public virtual IReadOnlyList<AnalyzerHit> Collect(TypeDef type, AnalyzerScanUnit unit) => FindReferencesInType(type).ToList();

	/// <summary>Whether a hit goes on the list. Asked one hit at a time, in the order the types are walked in
	/// and each type's hits were found in, so a search's result does not depend on the threads.</summary>
	public virtual bool Accept(AnalyzerHit hit) => true;

	protected virtual IEnumerable<AnalyzerHit> FindReferencesInType(TypeDef type) => [];

	public virtual void Finish(List<AnalyzerHit> hits) {
	}

	/// <summary>The method a result found in <paramref name="method"/> is listed as: the one a lambda or a state
	/// machine was written in when the host shows that, the method itself otherwise.</summary>
	protected MethodDef GetOriginalCodeLocation(MethodDef method) =>
		Host.ShowsOriginalCodeLocation ? AnalyzerHelpers.GetOriginalCodeLocation(Host, method) : method;

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
/// position in that list outlives a slice — no dnlib enumerator is held across the gap. Run on more than one
/// thread, a slice looks at the types a batch at a time, the batch spread over the threads.
/// </summary>
sealed class AnalyzerSearchRun {
	readonly AnalyzerSearch search;
	readonly IReadOnlyList<AnalyzerScanUnit> units;
	readonly int maxResults;
	readonly int parallelism;
	// Enough types per batch to keep every thread busy while the slice's clock is checked often.
	readonly int batchSize;
	readonly List<AnalyzerHit> hits = [];
	int unitIndex;
	List<TypeDef>? types;
	int typeIndex;

	public AnalyzerSearchRun(AnalyzerSearch search, long epoch, int maxResults, int parallelism, CancellationToken cancellationToken) {
		this.search = search;
		this.maxResults = maxResults;
		this.parallelism = Math.Max(1, parallelism);
		batchSize = this.parallelism == 1 ? 1 : this.parallelism * 4;
		Epoch = epoch;
		units = search.Prepare(cancellationToken);
	}

	/// <summary>The workspace's model generation the search was prepared against; a slice must not run
	/// against any other.</summary>
	public long Epoch { get; }

	/// <summary>Set once the search reached the limit and stopped looking.</summary>
	public bool Truncated { get; private set; }

	public bool Completed => Truncated || unitIndex >= units.Count;

	/// <summary>What the search found so far, as far as the limit lets it be listed: a type can bring several
	/// hits at once, and the ones past the limit are never shown.</summary>
	public int Count => Math.Min(hits.Count, maxResults);

	public AnalyzerHit this[int index] => hits[index];

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
				var found = Collect(types, typeIndex, Math.Min(batchSize, types.Count - typeIndex), unit, cancellationToken);
				typeIndex += found.Length;
				foreach (var typeHits in found) {
					foreach (var hit in typeHits) {
						if (!search.Accept(hit))
							continue;
						hits.Add(hit);
						if (hits.Count >= maxResults) {
							Truncated = true;
							return;
						}
					}
				}
				if (stopwatch.Elapsed >= budget)
					return;
			}
			types = null;
			unitIndex++;
		}
	}

	/// <summary>What a batch of types holds for the search, a list per type in the order of the types.</summary>
	IReadOnlyList<AnalyzerHit>[] Collect(List<TypeDef> batch, int start, int count, AnalyzerScanUnit unit, CancellationToken cancellationToken) {
		var found = new IReadOnlyList<AnalyzerHit>[count];
		if (count == 1) {
			found[0] = search.Collect(batch[start], unit);
			return found;
		}
		try {
			Parallel.For(0, count, new ParallelOptions { CancellationToken = cancellationToken, MaxDegreeOfParallelism = parallelism },
				index => found[index] = search.Collect(batch[start + index], unit));
		}
		catch (AggregateException ex) when (ex.InnerExceptions.Count == 1) {
			ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
		}
		return found;
	}

	/// <summary>Adds what the search only knows once every type was seen; <see cref="Count"/> covers it after.</summary>
	public void Finish() {
		search.Finish(hits);
		if (hits.Count > maxResults)
			Truncated = true;
	}
}
