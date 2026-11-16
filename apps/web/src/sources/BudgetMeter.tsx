export function BudgetMeter({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const percent = Math.round(ratio * 100);
  const state = ratio >= 1 ? 'full' : ratio >= 0.9 ? 'near' : 'ok';
  const text = `${used.toLocaleString()} of ${limit.toLocaleString()} characters pinned`;
  return <div className={`budget-meter budget-${state}`}>
    <div className="budget-meter-head">
      <span id="budget-meter-label">Pinned budget</span>
      <span>{text}{state === 'full' ? ' — full' : state === 'near' ? ' — nearly full' : ''}</span>
    </div>
    <div className="budget-meter-track" role="meter" aria-labelledby="budget-meter-label" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} aria-valuetext={`${text} (${percent}%)`}>
      <div className="budget-meter-fill" style={{ width: `${percent}%` }} />
    </div>
  </div>;
}
