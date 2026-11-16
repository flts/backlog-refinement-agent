import { useCallback, useState } from 'react';

export type Decision = 'pending' | 'accepted' | 'rejected';

/** Per-entry accept/reject/edit state of a proposal (sections or children). Entries start `pending`. */
export function useReviewState<E>(ids: readonly string[]) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [edits, setEdits] = useState<Record<string, E | undefined>>({});
  const decisionOf = useCallback((id: string): Decision => decisions[id] ?? 'pending', [decisions]);

  const set = useCallback((id: string, decision: Decision, edit?: E) => {
    setDecisions((current) => ({ ...current, [id]: decision }));
    setEdits((current) => ({ ...current, [id]: decision === 'accepted' ? edit : undefined }));
  }, []);

  const resolved = useCallback((override?: Record<string, Decision>) => Object.fromEntries(ids.map((id) => [id, (override ?? decisions)[id] ?? 'pending'])) as Record<string, Decision>, [ids, decisions]);

  const acceptAll = useCallback(() => setDecisions(Object.fromEntries(ids.map((id) => [id, 'accepted' as const]))), [ids]);
  const rejectAll = useCallback(() => {
    setDecisions(Object.fromEntries(ids.map((id) => [id, 'rejected' as const])));
    setEdits({});
  }, [ids]);
  /** Accepts every undecided entry; returns the resulting decisions so the caller can submit them without waiting for a render. */
  const acceptRemaining = useCallback((): Record<string, Decision> => {
    const next = Object.fromEntries(ids.map((id) => [id, decisions[id] && decisions[id] !== 'pending' ? decisions[id] : 'accepted'])) as Record<string, Decision>;
    setDecisions(next);
    return next;
  }, [ids, decisions]);

  return {
    decisionOf, set, resolved, acceptAll, rejectAll, acceptRemaining, edits,
    pending: ids.filter((id) => decisionOf(id) === 'pending').length,
    accepted: ids.filter((id) => decisionOf(id) === 'accepted').length,
  };
}
