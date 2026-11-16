import { useEffect, useRef, useState } from 'react';
import { parseCitations, SEARCH_SOURCES_TOOL_NAME, type Citation } from '../run';
import { activityLabel, statusText, type ActivityRowEntry } from './activity';
import { formatDuration } from './time';

const glyph = { done: '✓', error: '!', cancelled: '■', skipped: '–', pending: '…' } as const;

function citationsOf(entry: ActivityRowEntry): Citation[] {
  return entry.kind === 'tool' && entry.toolName === SEARCH_SOURCES_TOOL_NAME && entry.status === 'done' && entry.result ? parseCitations(entry.result) : [];
}

export function CitationList({ citations }: { citations: Citation[] }) {
  return (
    <ul className="citation-list" aria-label="Sources used">
      {citations.map((citation, index) => (
        <li key={citation.citationId} className="citation">
          <span className="citation-index" aria-hidden="true">{index + 1}</span>
          <div>
            <span className="citation-source">{citation.sourceName}</span>
            {typeof citation.page === 'number' && <span className="citation-meta"> · page {citation.page}</span>}
            {citation.headingPath && <span className="citation-meta"> · {citation.headingPath}</span>}
            {citation.text && <details className="citation-passage"><summary>Show passage</summary><blockquote>{citation.text}</blockquote></details>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent's work for one run: steps and tool calls with friendly labels, source citations, and a "Worked for 12 s · 4 steps"
 * summary. Open while the agent works, collapsed afterwards unless the user toggled it. Hydrated groups have no duration.
 */
export function ActivityTimeline({ entries }: { entries: ActivityRowEntry[] }) {
  const running = entries.some((entry) => entry.status === 'running');
  const [toggled, setToggled] = useState<boolean>();
  const open = toggled ?? running;
  const startedAt = useRef<number | undefined>(running ? Date.now() : undefined);
  const [elapsed, setElapsed] = useState<number>();
  useEffect(() => {
    if (running && startedAt.current === undefined) startedAt.current = Date.now();
    if (!running && startedAt.current !== undefined && elapsed === undefined) setElapsed(Date.now() - startedAt.current);
  }, [running, elapsed]);

  const count = `${entries.length} ${entries.length === 1 ? 'step' : 'steps'}`;
  const summary = running ? `Working… · ${count}` : elapsed !== undefined ? `Worked for ${formatDuration(elapsed)} · ${count}` : `Worked · ${count}`;
  const listId = `activity-${entries[0].id}`;

  return (
    <div className="activity-timeline" data-running={running || undefined}>
      <button type="button" className="activity-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setToggled(!open)}>
        <span aria-hidden="true" className="activity-chevron">{open ? '▾' : '▸'}</span> {summary}
      </button>
      <ol id={listId} className="activity-list" hidden={!open}>
        {entries.map((entry) => {
          const citations = citationsOf(entry);
          return (
            <li key={entry.id} className="activity-row" data-status={entry.status}>
              <span className="activity-mark" aria-hidden="true">{entry.status === 'running' ? <i className="spinner" /> : glyph[entry.status]}</span>
              <div className="activity-body">
                <span>{activityLabel(entry)}</span>
                <span className="sr-only"> — {statusText[entry.status]}</span>
                {citations.length > 0 && <CitationList citations={citations} />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
