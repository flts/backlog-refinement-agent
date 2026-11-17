import { useEffect, useState } from 'react';
import { agentErrorMessages, type AgentError } from '../agent';

export interface RunErrorCardProps {
  error: AgentError;
  /** Offer Retry. Only the latest error is retryable. */
  canRetry?: boolean;
  /** Another run is already starting. */
  busy?: boolean;
  onRetry?: () => void;
}

/** Seconds left of the server's Retry-After, ticking once a second. */
function useCountdown(seconds: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil(seconds - (Date.now() - started) / 1000));
      setLeft(remaining);
      if (remaining === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);
  return left;
}

export const errorDetails = (error: AgentError) =>
  [`Code: ${error.code}`, error.runId ? `Run ID: ${error.runId}` : undefined, `Message: ${agentErrorMessages[error.key]}`, error.serverMessage ? `Server message: ${error.serverMessage}` : undefined]
    .filter(Boolean).join('\n');

/**
 * Inline run error (plan §6.7). Not a live region itself: `ChatPanel` announces the error assertively once, so the
 * card does not read twice. Retry stays disabled while the rate limit's Retry-After runs.
 */
export function RunErrorCard({ error, canRetry = false, busy = false, onRetry }: RunErrorCardProps) {
  const countdown = useCountdown(error.key === 'rateLimited' ? error.retryAfterSeconds : undefined);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const expired = error.proposalExpired;
  // The recovery card (review/ExpiredProposal) shows the heading, the reason and the actions; this row keeps the code and run ID.
  const message = expired ? 'Your decision on the proposal could not be applied.' : agentErrorMessages[error.key];

  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(errorDetails(error));
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <div className="run-error" role="group" aria-label="Run error" data-variant={expired ? 'expired' : error.key}>
      <p className="run-error-message"><span aria-hidden="true">⚠ </span>{message}</p>
      {countdown > 0 && <p className="run-error-hint">You can try again in {countdown} s.</p>}
      <p className="run-error-meta">
        <span>Code <code>{error.code}</code></span>
        {error.runId && <span>Run ID <code>{error.runId}</code></span>}
      </p>
      <div className="run-error-actions">
        <button type="button" className="button button-secondary button-small" onClick={() => void copyDetails()}>
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy details'}
        </button>
        {onRetry && !expired && (
          <button type="button" className="button button-primary button-small" disabled={!canRetry || busy || countdown > 0} onClick={onRetry}>
            <span aria-hidden="true">↻</span> Retry
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">{copy === 'copied' ? 'Error details copied' : copy === 'failed' ? 'Could not copy the error details' : ''}</span>
    </div>
  );
}
