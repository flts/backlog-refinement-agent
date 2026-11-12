import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { MdContentCopy,MdControlPointDuplicate, MdDelete, MdDownload } from "react-icons/md";
import type { BacklogItemType } from '../domain/backlog-item';
import { ChatPanel } from './ChatPanel';
import { PreviewPanel } from './PreviewPanel';
import { SettingsModal } from './SettingsModal';
import { SidebarPanel } from './SidebarPanel';
import { NewItemModal } from './NewItemModal';
import { downloadFile, markdownFilename, markdownFor } from './config-io';
import { makeRefinementService, makeWorkspace } from './services';
import type { Project } from '../domain/project';
import { getLlmConfiguration } from '../infrastructure/llm/llmConfig';
import { useSettings } from './useSettings';
import { errorText, useNotifications } from './useNotifications';
import { useBacklog } from './useBacklog';
import { useRefinementFlow } from './useRefinementFlow';

export default function App({ project, projectBusy, renderProjectPanel }: { project: Project; projectBusy: boolean; renderProjectPanel: (busy: boolean, endpoint: string) => ReactNode }) {
  const notifications = useNotifications();
  const { error, notice, setError, setNotice, clear } = notifications;
  const workspace = useMemo(() => makeWorkspace(project.id), [project.id]);
  const backlog = useBacklog(notifications, workspace);
  const { selectedItem } = backlog;
  const config = useSettings(notifications);
  const { settings } = config;
  const [newItem, setNewItem] = useState<{ type: BacklogItemType; title: string; parentId?: string }>();
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'refine' | 'preview'>('refine');

  const refinement = useMemo(() => makeRefinementService(settings, config.llm, config.llmEnvironment, project.id), [settings, config.llm, config.llmEnvironment, project.id]);
  const flow = useRefinementFlow(backlog, refinement, notifications);

  function selectItem(id: string) {
    if (flow.busy) return;
    flow.reset();
    backlog.selectItem(id);
    setMobilePanel('refine');
  }

  async function createItem() {
    if (!newItem) return;
    if (await backlog.createItem(newItem.type, newItem.title, newItem.parentId)) setNewItem(undefined);
  }

  async function switchSession(id: string) {
    if (await backlog.switchSession(id)) flow.reset();
  }

  async function deleteSession() {
    if (flow.busy) return;
    if (await backlog.deleteCurrentSession()) flow.reset();
  }

  async function deleteSelected() {
    if (await backlog.deleteSelected()) flow.reset();
  }

  async function copyMarkdown() {
    if (!selectedItem) return;
    try {
      await navigator.clipboard.writeText(markdownFor(selectedItem));
      setNotice('Markdown copied to clipboard.');
    } catch (cause) { setError(`Could not copy Markdown: ${errorText(cause)}`); }
  }

  function downloadMarkdown() {
    if (selectedItem) downloadFile(markdownFilename(selectedItem), markdownFor(selectedItem), 'text/markdown');
  }

  useEffect(() => {
    document.title = selectedItem ? `${selectedItem.title || 'Untitled item'} – ${project.name} – Backlog Studio` : `${project.name} – Backlog Studio`;
  }, [selectedItem, project.name]);

  if (backlog.loading || !config.loaded) return <main className="loading-screen" aria-busy="true"><span className="brand-mark" aria-hidden="true">b.</span><p role="status">Opening your local backlog…</p></main>;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to main content</a>
      <h1 className="sr-only">Backlog Studio – {project.name}</h1>
      <header className="topbar">
        <span className="brand"><span className="brand-mark" aria-hidden="true">b.</span><span>backlog<span className="brand-light">studio</span></span></span>
        <div className="topbar-center"><span className="workspace-dot" aria-hidden="true" /> {project.name} <span className="topbar-divider">/</span> Product backlog</div>
        <div className="topbar-actions"><span className="local-badge"><span aria-hidden="true" /> Saved locally</span><button className="icon-button" aria-label="Open settings" onClick={() => config.setOpen(true)}><span aria-hidden="true">⚙</span></button><span className="avatar" aria-hidden="true">;-)</span></div>
      </header>

      {renderProjectPanel(flow.busy, getLlmConfiguration(config.llm, config.llmEnvironment).endpoint)}

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} aria-pressed={mobilePanel === 'tree'} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} aria-pressed={mobilePanel === 'refine'} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} aria-pressed={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <main id="main" tabIndex={-1} className="workspace-grid" inert={projectBusy}>
        <SidebarPanel
          className={`sidebar panel-${mobilePanel}`}
          items={backlog.items} relationships={backlog.relationships} selectedId={backlog.selectedId}
          onSelect={selectItem}
          onCreate={(parent) => setNewItem({ type: parent?.childType ?? 'capability', title: '', parentId: parent?.id })}
        />

        <ChatPanel
          className={`refinement-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} session={backlog.session} sessions={backlog.sessions} busy={flow.busy}
          canRetry={flow.retryState?.sessionId === backlog.session?.id} message={flow.message} reviewChanges={flow.reviewChanges}
          pending={flow.pending} proposal={flow.proposal} selectedProposals={flow.selectedProposals}
          onSelectItem={selectItem} onNewSession={() => { flow.reset(); void backlog.startNewSession(); }} onSwitchSession={(id) => void switchSession(id)}
          onDeleteSession={() => void deleteSession()}
          onMessageChange={flow.setMessage} onSubmit={() => void flow.submitMessage()} onContinue={() => void flow.submitMessage(true)}
          onCancel={flow.cancelRequest} onRetry={() => void flow.retryAssessment()} onToggleReview={flow.toggleReview}
          onApplyPending={() => void flow.applyPending()} onDiscardPending={() => void flow.discardPending()}
          onProposalChange={flow.setProposal} onSelectedProposalsChange={flow.setSelectedProposals}
          onAcceptProposals={() => void flow.acceptSelectedProposals()} onDismissProposal={() => flow.setProposal(undefined)}
          onCreateItem={() => setNewItem({ type: 'capability', title: '' })}
        />

        <PreviewPanel
          className={`preview-column panel-${mobilePanel}`}
          item={selectedItem} items={backlog.items} relationships={backlog.relationships} parentItem={backlog.parentItem} session={backlog.session} busy={flow.busy}
          menuActions={[
            { id: 'copy', label: <><MdContentCopy aria-hidden /> Copy Markdown</>, onSelect: () => void copyMarkdown() },
            { id: 'duplicate', label: <><MdControlPointDuplicate aria-hidden /> Duplicate item</>, onSelect: () => void backlog.duplicateSelected() },
            { id: 'download', label: <><MdDownload aria-hidden /> Download .md</>, onSelect: downloadMarkdown },
            { id: 'delete', label: <><MdDelete aria-hidden /> Delete item</>, danger: true, onSelect: () => void deleteSelected() },
          ]}
          onSelectItem={selectItem} onCopy={() => void copyMarkdown()} onUpdate={(changes) => void backlog.updateSelected(changes)}
          onResolveChecklist={(line, action, text) => void backlog.resolveChecklist(line, action, text)} onUndo={() => void flow.undoLastChange()}
          onChangeStatus={(status) => void flow.changeSelectedStatus(status)} onAssessQuality={() => void flow.assessQuality()}
          onProposeChildren={(type) => void flow.proposeChildren(type)}
        />
      </main>

      {(error || notice) && <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}><span aria-hidden="true">{error ? '!' : '✓'}</span><p>{error || notice}</p><button onClick={clear} aria-label="Dismiss notification"><span aria-hidden="true">×</span></button></div>}

      {newItem && <NewItemModal type={newItem.type} title={newItem.title} onTypeChange={(type) => setNewItem({ ...newItem, type })} onTitleChange={(title) => setNewItem({ ...newItem, title })} onSubmit={() => void createItem()} onClose={() => setNewItem(undefined)} />}

      {config.open && <SettingsModal settings={settings} llmReady={config.llmReady} llm={config.llm} llmEnvironment={config.llmEnvironment} onClearLlm={config.clearLlm} onClose={() => config.setOpen(false)} onSave={(values, llmValues) => void config.save(values, llmValues)} onRestore={() => void config.restore()} onExport={config.exportConfig} onImport={config.importConfig} />}
    </div>
  );
}
