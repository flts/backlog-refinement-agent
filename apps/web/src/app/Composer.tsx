import React from 'react';

export function Composer({ value, busy, onChange, onSubmit }: {
  value: string; busy: boolean; onChange: (value: string) => void; onSubmit: () => void;
}) {
  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <textarea value={value} onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (value.trim() && !busy) onSubmit();
          }
        }}
        placeholder="Share context, answer a question, or describe what you know…" rows={3} aria-label="Message the refinement agent" disabled={busy} />
      <div className="composer-bottom"><div className="composer-tip"><span aria-hidden="true">↗</span> Your structured item updates as you refine</div><button className="send-button" type="submit" disabled={busy || !value.trim()} aria-label="Send message"><span aria-hidden="true">{busy ? '…' : '↑'}</span></button></div>
    </form>
  );
}
