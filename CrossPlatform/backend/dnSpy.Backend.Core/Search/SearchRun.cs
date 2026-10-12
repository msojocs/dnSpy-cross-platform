using System.Diagnostics;

namespace dnSpy.Backend.Core.Search;

/// <summary>
/// A search in progress: the walk, advanced a slice at a time, and what it found so far. The results stop at
/// the limit the way dnSpy's DocumentSearcher stops — the first result past it ends the search, marked
/// <see cref="Truncated"/>.
/// </summary>
sealed class SearchRun(long epoch, int maxResults) {
	readonly List<SearchHit> hits = [];
	IEnumerator<bool>? steps;

	/// <summary>The workspace's model count the run started at; a slice that finds it moved on stops the run.</summary>
	public long Epoch { get; } = epoch;
	public bool Completed { get; private set; }
	public bool Truncated { get; private set; }
	public int Count => hits.Count;
	public SearchHit this[int index] => hits[index];

	public void Start(IEnumerable<bool> walk) => steps = walk.GetEnumerator();

	public void Add(SearchHit hit) {
		if (hits.Count >= maxResults)
			throw new TooManySearchResultsException();
		hits.Add(hit);
	}

	/// <summary>Walks on until the budget is spent — one step at least, however small the budget.</summary>
	public void RunSlice(TimeSpan budget) {
		var watch = Stopwatch.StartNew();
		try {
			do {
				if (!steps!.MoveNext()) {
					Complete();
					return;
				}
			} while (watch.Elapsed < budget);
		}
		catch (TooManySearchResultsException) {
			Truncated = true;
			Complete();
		}
	}

	void Complete() {
		Completed = true;
		steps?.Dispose();
	}
}
