import type { RunPhase } from '../run';

const statuses: Record<RunPhase, { text: string; tone: 'idle' | 'working' | 'input' | 'review' | 'error' }> = {
  hydrating: { text: 'Idle', tone: 'idle' },
  idle: { text: 'Idle', tone: 'idle' },
  cancelled: { text: 'Idle', tone: 'idle' },
  running: { text: 'Working…', tone: 'working' },
  awaitingInput: { text: 'Needs your input', tone: 'input' },
  awaitingReview: { text: 'Review changes', tone: 'review' },
  error: { text: 'Run failed', tone: 'error' },
};

export const agentStatusText = (phase: RunPhase) => statuses[phase].text;

/** The agent's state for the open conversation. Visual only (not a live region): the chat announcer reads phase changes, so they are not announced twice. The state is always text, never colour alone. */
export function AgentStatusPill({ phase }: { phase: RunPhase }) {
  const { text, tone } = statuses[phase];
  return <span className={`agent-pill agent-${tone}`} data-phase={phase}>
    <i aria-hidden="true" /><span className="agent-pill-label">Agent</span><b>{text}</b>
  </span>;
}
