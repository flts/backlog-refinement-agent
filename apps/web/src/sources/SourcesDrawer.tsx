import { useEffect, useRef } from 'react';
import { useSources } from '../api';
import { useModalDialog } from '../app/useModalDialog';
import { useRuntimeConfig } from '../config/RuntimeConfigProvider';
import { AddSource } from './AddSource';
import { BudgetMeter } from './BudgetMeter';
import { DataDisclosure } from './DataDisclosure';
import { SourceItem } from './SourceItem';

export interface SourcesDrawerProps {
  projectId: string;
  projectName?: string;
  onClose: () => void;
}

/** Right-hand modal drawer for a project's sources. The list refreshes through query invalidation (SSE `source.*` events) and polls while sources are indexing. */
export function SourcesDrawer({ projectId, projectName, onClose }: SourcesDrawerProps) {
  const dialog = useModalDialog(onClose);
  const sources = useSources(projectId);
  const config = useOptionalAgentEndpoint();
  const items = sources.data?.items ?? [];
  const closeButton = useRef<HTMLButtonElement>(null);
  // Native dialogs focus `autofocus` themselves; focusing explicitly keeps this working where showModal is polyfilled.
  useEffect(() => { closeButton.current?.focus(); }, []);

  return <dialog className="sources-drawer" aria-labelledby="sources-title" {...dialog}>
    <div className="sources-panel">
      <div className="sources-header">
        <div>
          <h2 id="sources-title">Sources</h2>
          {projectName && <p className="sources-hint">{projectName}</p>}
        </div>
        <button ref={closeButton} type="button" className="close-button" onClick={onClose} aria-label="Close sources" autoFocus><span aria-hidden="true">×</span></button>
      </div>
      {sources.data && <BudgetMeter used={sources.data.pinnedBudget.used} limit={sources.data.pinnedBudget.limit} />}
      <DataDisclosure agentEndpoint={config} />
      <AddSource projectId={projectId} />
      <section aria-labelledby="sources-list-title" aria-busy={sources.isLoading}>
        <h3 id="sources-list-title">Project sources ({items.length})</h3>
        {sources.isLoading && <p role="status">Loading sources…</p>}
        {sources.isError && <p role="alert" className="sources-error">Sources could not be loaded: {sources.error.message} <button type="button" className="button button-secondary button-small" onClick={() => void sources.refetch()}>Retry</button></p>}
        {sources.isSuccess && items.length === 0 && <p className="sources-hint">No sources yet. New sources are searchable by default.</p>}
        <ul className="source-list">{items.map((source) => <SourceItem key={source.id} projectId={projectId} source={source} />)}</ul>
      </section>
    </div>
  </dialog>;
}

function useOptionalAgentEndpoint(): string | undefined {
  try { return useRuntimeConfig().api.agent; } catch { return undefined; }
}
