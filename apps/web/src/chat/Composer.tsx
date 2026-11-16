import React from 'react';

export interface ComposerProps {
  value: string;
  /** The message cannot be sent right now (loading or running). */
  busy: boolean;
  /** A run is in progress: the box stays focusable (read-only) so Esc can stop it. */
  running?: boolean;
  /** Why the composer is not accepting a message; announced as the box's description. */
  reason?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
}

export function Composer({ value, busy, running = false, reason, onChange, onSubmit, onStop }: ComposerProps) {
  const reasonId = 'composer-reason';
  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <textarea value={value} onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && running && onStop) {
            event.preventDefault();
            onStop();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (value.trim() && !busy) onSubmit();
          }
        }}
        placeholder="Share context, answer a question, or describe what you know…" rows={3} aria-label="Message the refinement agent"
        aria-describedby={busy && reason ? reasonId : undefined} disabled={busy && !running} readOnly={running} />
      <div className="composer-bottom">
        <div className="composer-tip" id={reasonId}>{busy && reason ? reason : <><span aria-hidden="true">↗</span> Your structured item updates as you refine</>}</div>
        <button className="send-button" type="submit" disabled={busy || !value.trim()} aria-label="Send message"><span aria-hidden="true">{busy ? '…' : '↑'}</span></button>
      </div>
    </form>
  );
}
