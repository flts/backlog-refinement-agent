import { useState } from 'react';
import type { AskUserResult } from '../contracts';
import type { RunState } from '../run';

/** Placeholder: the real card is built by fe-ask-user. One free-text answer per question. */
export function AskUserPlaceholder({ run, disabled, onAnswer }: { run: RunState; disabled: boolean; onAnswer: (result: AskUserResult) => void }) {
  const questions = run.pendingAskUser?.args?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form className="proposal-panel" aria-label="The agent asks" onSubmit={(event) => {
      event.preventDefault();
      onAnswer({ status: 'answered', answers: questions.map((question) => {
        const freeform = answers[question.id]?.trim();
        return { questionId: question.id, selected: [], ...(freeform ? { freeform } : {}), skipped: !freeform };
      }) });
    }}>
      <div className="proposal-heading"><div><span className="eyebrow">Agent asks</span></div></div>
      {questions.map((question) => (
        <label key={question.id} className="proposal-copy">
          <span>{question.question}</span>
          <input value={answers[question.id] ?? ''} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} disabled={disabled} />
        </label>
      ))}
      <div className="proposal-actions">
        <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => onAnswer({ status: 'skipped', answers: questions.map((question) => ({ questionId: question.id, selected: [], skipped: true })) })}>Skip</button>
        <button type="submit" className="button button-primary button-small" disabled={disabled}>Answer</button>
      </div>
    </form>
  );
}
