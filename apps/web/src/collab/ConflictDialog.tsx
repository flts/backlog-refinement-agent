import { useId, useMemo, useState } from 'react';
import { useModalDialog } from '../app/useModalDialog';
import { applyMerge, type MergeInput, type MergePlan, type SectionChoice } from './merge';

export interface ConflictDialogProps {
  plan: MergePlan;
  /** Who saved the other version (display name or email). */
  theirAuthor: string;
  busy?: boolean;
  onResolve: (merged: MergeInput) => void;
  /** Decide later: the edits stay unsaved. */
  onClose: () => void;
}

const choiceLabel: Record<SectionChoice, string> = { mine: 'Mine', theirs: 'Theirs', both: 'Both' };

function Preview({ label, text }: { label: string; text?: string }) {
  return <div className="conflict-side">
    <strong>{label}</strong>
    {text === undefined ? <em>Section removed</em> : text === '' ? <em>Empty</em> : <pre>{text}</pre>}
  </div>;
}

/**
 * Per-section conflict resolution after a 409: only sections changed on both sides ask for Mine / Theirs / Both
 * (Both = mine, then theirs). Everything else was merged automatically and is applied as shown in the summary.
 */
export function ConflictDialog({ plan, theirAuthor, busy = false, onResolve, onClose }: ConflictDialogProps) {
  const dialog = useModalDialog(onClose, () => !busy);
  const titleId = useId();
  const conflicts = useMemo(() => plan.sections.filter((section) => section.conflict), [plan]);
  const [choices, setChoices] = useState<Record<string, SectionChoice>>({});
  const [titleChoice, setTitleChoice] = useState<Exclude<SectionChoice, 'both'>>('mine');
  const automatic = plan.sections.filter((section) => !section.conflict && section.key !== '' && section.mine !== section.theirs);

  return <dialog className="modal-dialog conflict-dialog" aria-labelledby={titleId} {...dialog}>
    <form className="modal conflict-modal" onSubmit={(event) => { event.preventDefault(); onResolve(applyMerge(plan, choices, titleChoice)); }}>
      <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Decide later" disabled={busy}><span aria-hidden="true">×</span></button>
      <span className="eyebrow">Edit conflict</span>
      <h2 id={titleId}>{theirAuthor} changed this item too</h2>
      <p>Your edits and theirs overlap in {conflicts.length + (plan.title.conflict ? 1 : 0)} place{conflicts.length + (plan.title.conflict ? 1 : 0) === 1 ? '' : 's'}. Choose what to keep for each. Other changes from both of you are combined automatically.</p>
      {plan.title.conflict && <fieldset className="conflict-section">
        <legend>Title</legend>
        <div className="conflict-sides"><Preview label="Mine" text={plan.title.mine} /><Preview label="Theirs" text={plan.title.theirs} /></div>
        <div className="conflict-choices" role="radiogroup" aria-label="Keep which title?">
          {(['mine', 'theirs'] as const).map((choice) => <label key={choice} className="conflict-choice"><input type="radio" name="choice-title" value={choice} checked={titleChoice === choice} onChange={() => setTitleChoice(choice)} /> {choiceLabel[choice]}</label>)}
        </div>
      </fieldset>}
      {conflicts.map((section) => {
        const name = section.heading || 'Introduction';
        const value = choices[section.key] ?? 'mine';
        return <fieldset className="conflict-section" key={section.key}>
          <legend>{name}</legend>
          <div className="conflict-sides"><Preview label="Mine" text={section.mine} /><Preview label="Theirs" text={section.theirs} /></div>
          <div className="conflict-choices" role="radiogroup" aria-label={`Keep which version of ${name}?`}>
            {(['mine', 'theirs', 'both'] as const).map((choice) => <label key={choice} className="conflict-choice">
              <input type="radio" name={`choice-${section.key || 'intro'}`} value={choice} checked={value === choice} onChange={() => setChoices((current) => ({ ...current, [section.key]: choice }))} /> {choiceLabel[choice]}
            </label>)}
          </div>
        </fieldset>;
      })}
      {automatic.length > 0 && <p className="conflict-auto">Combined automatically: {automatic.map((section) => section.heading).join(', ')}.</p>}
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Decide later</button>
        <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save resolved version'}</button>
      </div>
    </form>
  </dialog>;
}
