import { useEffect, useRef, useState } from 'react';
import { agentErrorMessages } from '../agent';
import type { RunState } from '../run';

export interface Announcements { polite: string; assertive: string }

/**
 * Screen-reader messages for run phase changes, so streamed tokens are not read aloud (plan §6.6):
 * polite for working/replied/needs input/review, assertive for errors. Nothing is announced for a thread that opens idle.
 */
export function useRunAnnouncements(run: Pick<RunState, 'phase' | 'threadId' | 'lastError'>): Announcements {
  const [announcements, setAnnouncements] = useState<Announcements>({ polite: '', assertive: '' });
  const previous = useRef<{ threadId: string | null; phase: RunState['phase'] }>({ threadId: run.threadId, phase: 'idle' });
  const { phase, threadId, lastError } = run;

  useEffect(() => {
    const before = previous.current;
    previous.current = { threadId, phase };
    if (before.threadId !== threadId) {
      setAnnouncements({ polite: '', assertive: '' });
      if (phase === 'hydrating' || phase === 'idle') return;
    } else if (before.phase === phase) return;
    switch (phase) {
      case 'running': setAnnouncements({ polite: 'Agent is working', assertive: '' }); break;
      case 'idle': if (before.phase === 'running') setAnnouncements({ polite: 'Agent replied', assertive: '' }); break;
      case 'awaitingInput': setAnnouncements({ polite: 'Agent needs your input', assertive: '' }); break;
      case 'awaitingReview': setAnnouncements({ polite: 'Review proposed changes', assertive: '' }); break;
      case 'cancelled': setAnnouncements({ polite: 'Agent stopped', assertive: '' }); break;
      case 'error': setAnnouncements({ polite: '', assertive: `Error: ${lastError ? agentErrorMessages[lastError.key] : 'The agent could not finish.'}` }); break;
      default: break;
    }
  }, [phase, threadId, lastError]);

  return announcements;
}
