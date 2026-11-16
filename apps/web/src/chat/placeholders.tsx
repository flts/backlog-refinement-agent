import type { RunState } from '../run';

/** Placeholder: the real card is built by fe-review-ui. */
export function ReviewPlaceholder({ run, disabled, onDecideAll }: { run: RunState; disabled: boolean; onDecideAll: (approved: boolean) => void }) {
  const live = run.interrupts.filter((interrupt) => !interrupt.expired);
  if (live.length === 0) return null;
  return (
    <div className="proposal-panel" role="region" aria-label="Review the agent’s proposal">
      <div className="proposal-heading"><div><span className="eyebrow">Agent proposes changes</span></div></div>
      {live.map((interrupt) => <p key={interrupt.id} className="proposal-rationale">{String(interrupt.args.summary ?? interrupt.args.rationale ?? interrupt.message ?? interrupt.toolName)}</p>)}
      <div className="proposal-actions">
        <button className="button button-secondary button-small" disabled={disabled} onClick={() => onDecideAll(false)}>Reject all</button>
        <button className="button button-primary button-small" disabled={disabled} onClick={() => onDecideAll(true)}>Approve all</button>
      </div>
    </div>
  );
}
