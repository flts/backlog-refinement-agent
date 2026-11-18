import { NextActionSchema, type NextAction } from '../contracts';

export interface SuggestionChipsProps {
  /** `agentState.nextActions`; anything that is not a valid action is dropped and at most three are shown. */
  actions: readonly unknown[];
  disabled?: boolean;
  onSelect: (action: NextAction) => void;
}

export function validActions(actions: readonly unknown[]): NextAction[] {
  return actions.flatMap((action): NextAction[] => { const parsed = NextActionSchema.safeParse(action); return parsed.success ? [parsed.data] : []; }).slice(0, 3);
}

/** What a chip does: a `message` chip sends its prompt (or label); any other intent continues the run with that intent. */
export function suggestionMessage(action: NextAction): string | undefined {
  return action.intent === 'message' ? action.prompt ?? action.label : undefined;
}

/** Up to three next-step chips below the last assistant message of a finished run. */
export function SuggestionChips({ actions, disabled = false, onSelect }: SuggestionChipsProps) {
  const chips = validActions(actions);
  if (chips.length === 0) return null;
  return (
    <div className="suggestion-chips" role="group" aria-label="Suggested next steps">
      {chips.map((action) => (
        <button key={action.id} type="button" className="suggestion-chip" disabled={disabled} onClick={() => onSelect(action)}>
          <span aria-hidden="true">↳</span> {action.label}
        </button>
      ))}
    </div>
  );
}
