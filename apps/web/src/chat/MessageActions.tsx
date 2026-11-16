import { useEffect, useId, useRef, useState } from 'react';
import type { FeedbackRating } from '../agent';

export interface MessageActionsProps {
  text: string;
  /** Sends the rating (and an optional comment) to the agent service; without it only the copy button is shown. */
  onFeedback?: (rating: FeedbackRating, comment?: string) => Promise<unknown>;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Copy button plus thumbs up/down (toggle buttons) with an optional comment popover for thumbs down. */
export function MessageActions({ text, onFeedback }: MessageActionsProps) {
  const [rating, setRating] = useState<FeedbackRating>();
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [thanks, setThanks] = useState('');
  const [error, setError] = useState('');
  const [copy, setCopy] = useState<CopyState>('idle');
  const popoverId = useId();
  const down = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function submit(next: FeedbackRating, note?: string): Promise<boolean> {
    setError('');
    try {
      await onFeedback?.(next, note);
      return true;
    } catch {
      setError('Could not send your feedback.');
      return false;
    }
  }

  async function rate(next: FeedbackRating) {
    if (rating === next) {
      // The service has no way to withdraw a rating; the toggle only clears the local state.
      setRating(undefined);
      setCommenting(false);
      setThanks('');
      return;
    }
    const previous = rating;
    setRating(next);
    setThanks('');
    setCommenting(next === 'down');
    if (next === 'up') setComment('');
    if (!(await submit(next))) { setRating(previous); setCommenting(false); }
  }

  async function sendComment() {
    const note = comment.trim();
    if (!note) return;
    if (await submit('down', note)) { setCommenting(false); setThanks('Thanks for the feedback.'); }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch { setCopy('failed'); }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy('idle'), 2500);
  }

  return (
    <div className="message-actions">
      <div className="message-action-buttons" role="group" aria-label="Message actions">
        <button type="button" className="message-action" onClick={() => void copyText()}><span aria-hidden="true">⧉</span> Copy</button>
        {onFeedback && <>
          <button type="button" className="message-action" aria-pressed={rating === 'up'} aria-label="Helpful" title="Helpful" onClick={() => void rate('up')}><span aria-hidden="true">👍</span></button>
          <button ref={down} type="button" className="message-action" aria-pressed={rating === 'down'} aria-label="Not helpful" title="Not helpful" aria-expanded={commenting} aria-controls={commenting ? popoverId : undefined} onClick={() => void rate('down')}><span aria-hidden="true">👎</span></button>
        </>}
      </div>
      <span className="message-action-status" role="status">{copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Could not copy' : thanks}</span>
      {error && <span className="message-action-error" role="alert">{error}</span>}
      {commenting && (
        <form id={popoverId} className="feedback-popover" aria-label="Tell us what went wrong"
          onSubmit={(event) => { event.preventDefault(); void sendComment(); }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setCommenting(false); down.current?.focus(); } }}>
          <label htmlFor={`${popoverId}-comment`}>What went wrong? <span className="muted-copy">(optional)</span></label>
          <textarea id={`${popoverId}-comment`} autoFocus rows={2} maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} />
          <div className="feedback-popover-actions">
            <button type="submit" className="button button-primary button-small" disabled={!comment.trim()}>Send</button>
            <button type="button" className="button button-secondary button-small" onClick={() => { setCommenting(false); down.current?.focus(); }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
