import type { Item } from '../api';
import type { StateQuality } from '../contracts';
import { relativeTime } from '../chat/time';
import { areaText, levelText, overallText, pickAssessment, qualityDiagnostics, type Level, type Overall } from './assessment';

export interface QualityPanelProps {
  item: Pick<Item, 'documentHash' | 'quality'>;
  /** The latest assessment from the agent state; shown when it is newer than the stored one. */
  live?: StateQuality | null;
  /** The agent is working: assessing is disabled. */
  busy: boolean;
  onAssess: () => void;
}

const overallIcon: Record<Overall, string> = { ready: '✓', 'ready-with-open-questions': '◐', 'needs-clarification': '!' };
const levelIcon: Record<Level, string> = { clear: '✓', unclear: '?', missing: '✕', 'not-applicable': '–' };

/** The Quality tab: verdict, per-area table, flags, suggestions, freshness and the "Assess quality" action. */
export function QualityPanel({ item, live, busy, onAssess }: QualityPanelProps) {
  const shown = pickAssessment(item, live);
  const assess = <button type="button" className="button button-secondary button-small" disabled={busy} onClick={onAssess}>Assess quality</button>;
  if (!shown) {
    return (
      <section className="quality-panel" aria-label="Quality assessment">
        <p className="history-note">This item has not been assessed yet. The assessment checks problem, outcome, scope, acceptance criteria and more, and flags solution detail or speculative scope.</p>
        {assess}
      </section>
    );
  }
  const { assessment, assessedAt, stale } = shown;
  const flags = qualityDiagnostics(assessment);
  return (
    <section className="quality-panel" aria-label="Quality assessment">
      <div className="preview-section-head">
        <h3>Overall</h3>
        <span className={`quality-verdict quality-verdict-${assessment.overall}`}><span aria-hidden="true">{overallIcon[assessment.overall]}</span> {overallText[assessment.overall]}</span>
      </div>
      {assessment.summary && <p className="quality-summary">{assessment.summary}</p>}
      <p className="quality-meta">
        {assessedAt && <>Assessed <time dateTime={assessedAt}>{relativeTime(assessedAt)}</time></>}
      </p>
      {stale && <p className="quality-stale" role="status"><span aria-hidden="true">⟳</span> Stale — the document changed since this assessment.</p>}
      {assessment.areas.length > 0 && (
        <table className="quality-table">
          <caption className="sr-only">Quality areas</caption>
          <thead><tr><th scope="col">Area</th><th scope="col">Level</th><th scope="col">Note</th></tr></thead>
          <tbody>
            {assessment.areas.map((entry) => (
              <tr key={entry.area} className={`quality-${entry.level}`}>
                <th scope="row">{areaText(entry.area)}</th>
                <td><span className="quality-level"><span aria-hidden="true">{levelIcon[entry.level]}</span> {levelText[entry.level]}</span></td>
                <td>{entry.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {flags.length > 0 && (
        <>
          <h4 className="quality-subhead">Flags and suggestions</h4>
          <ul className="quality-flags">{flags.map((text) => <li key={text}>{text}</li>)}</ul>
        </>
      )}
      {assess}
    </section>
  );
}
