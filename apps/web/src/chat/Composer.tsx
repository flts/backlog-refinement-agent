import React, { useRef } from 'react';
import type { MentionCandidate } from '../context/mentions';
import type { AgentCommandEntry } from '../palette/commands';
import { useComposerAssist } from '../palette/useComposerAssist';

export interface ComposerProps {
  value: string;
  /** The message cannot be sent right now (loading or running). */
  busy: boolean;
  /** A run is in progress: the box stays focusable (read-only) so Esc can stop it. */
  running?: boolean;
  /** Why the composer is not accepting a message; announced as the box's description. */
  reason?: string;
  /** An `ask_user` question is pending: typing here dismisses it and replies in your own words. */
  asking?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  /** `/` at the start of the message opens this menu (palette/). */
  slashCommands?: readonly AgentCommandEntry[];
  onSlashCommand?: (command: AgentCommandEntry) => void;
  /** `@` opens an item picker that inserts `@[Title](item:<id>)`. */
  mentionItems?: readonly MentionCandidate[];
}

export function Composer({ value, busy, running = false, reason, asking = false, onChange, onSubmit, onStop, slashCommands, onSlashCommand, mentionItems }: ComposerProps) {
  const reasonId = 'composer-reason';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const assist = useComposerAssist({ value, onChange, textareaRef, enabled: !busy && !running, slashCommands, onSlashCommand, mentionItems });
  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {assist.menu}
      <textarea ref={textareaRef} value={value} onChange={(event) => { assist.noteCaret(event.target.selectionStart); onChange(event.target.value); }} {...assist.textareaProps}
        onKeyDown={(event) => {
          if (assist.onKeyDown(event)) return;
          if (event.key === 'Escape' && running && onStop) {
            event.preventDefault();
            onStop();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (value.trim() && !busy) onSubmit();
          }
        }}
        placeholder={asking ? 'Answer above, or type to reply in your own words' : 'Share context, answer a question, or describe what you know…'} rows={3} aria-label="Message the refinement agent"
        aria-describedby={busy && reason ? reasonId : undefined} disabled={busy && !running} readOnly={running} />
      <div className="composer-bottom">
        <div className="composer-tip" id={reasonId}>{busy && reason ? reason : <><span aria-hidden="true">↗</span> Your structured item updates as you refine</>}</div>
        <button className="send-button" type="submit" disabled={busy || !value.trim()} aria-label="Send message"><span aria-hidden="true">{busy ? '…' : '↑'}</span></button>
      </div>
    </form>
  );
}
