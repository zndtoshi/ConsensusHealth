/**
 * Compact dual-handle year range for the Options "X join date" control.
 */

export function XJoinDateRangeSlider({
  boundMin,
  boundMax,
  minYear,
  maxYear,
  onChange,
  showingCount,
  totalCount,
}) {
  const span = Math.max(1, boundMax - boundMin);

  function setMin(next) {
    const n = Math.trunc(Number(next));
    if (!Number.isFinite(n)) return;
    onChange({ minYear: Math.min(n, maxYear), maxYear });
  }

  function setMax(next) {
    const n = Math.trunc(Number(next));
    if (!Number.isFinite(n)) return;
    onChange({ minYear, maxYear: Math.max(n, minYear) });
  }

  const minPct = ((minYear - boundMin) / span) * 100;
  const maxPct = ((maxYear - boundMin) / span) * 100;

  return (
    <div className="xJoinDateFilter" role="group" aria-label="X join date year range">
      <div className="xJoinDateFilter__years" aria-hidden="true">
        <span>{minYear}</span>
        <span>{maxYear}</span>
      </div>
      <div className="xJoinDateFilter__trackWrap">
        <div className="xJoinDateFilter__rail" aria-hidden="true" />
        <div
          className="xJoinDateFilter__fill"
          aria-hidden="true"
          style={{ left: `${minPct}%`, width: `${Math.max(0, maxPct - minPct)}%` }}
        />
        <input
          type="range"
          className="xJoinDateFilter__input xJoinDateFilter__input--min"
          min={boundMin}
          max={boundMax}
          step={1}
          value={minYear}
          onChange={(e) => setMin(e.target.value)}
          aria-label="Minimum X join year"
          aria-valuemin={boundMin}
          aria-valuemax={boundMax}
          aria-valuenow={minYear}
        />
        <input
          type="range"
          className="xJoinDateFilter__input xJoinDateFilter__input--max"
          min={boundMin}
          max={boundMax}
          step={1}
          value={maxYear}
          onChange={(e) => setMax(e.target.value)}
          aria-label="Maximum X join year"
          aria-valuemin={boundMin}
          aria-valuemax={boundMax}
          aria-valuenow={maxYear}
        />
      </div>
      <div className="xJoinDateFilter__bounds" aria-hidden="true">
        <span>{boundMin}</span>
        <span>{boundMax}</span>
      </div>
      {typeof showingCount === "number" && typeof totalCount === "number" ? (
        <div className="xJoinDateFilter__meta">
          <span>
            Showing {showingCount} of {totalCount} accounts
          </span>
        </div>
      ) : null}
    </div>
  );
}
