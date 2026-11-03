import React, { useMemo, useState } from 'react';
import type { BacklogItemType } from '../domain/backlog-item';
import { getLlmConfiguration } from '../infrastructure/llm/llmConfig';
import { ChatPanel } from './ChatPanel';
import { PreviewPanel } from './PreviewPanel';
import { SettingsModal } from './SettingsModal';
import { SidebarPanel } from './SidebarPanel';
import { NewItemModal } from './NewItemModal';
import { downloadFile, markdownFilename, markdownFor } from './config-io';
import { makeRefinementService } from './services';
import { useSettings } from './useSettings';
import { errorText, useNotifications } from './useNotifications';
import { useBacklog } from './useBacklog';
import { useRefinementFlow } from './useRefinementFlow';

export default function App() {
  const notifications = useNotifications();
  const { error, notice, setError, setNotice, clear } = notifications;
  const backlog = useBacklog(notifications);
  const { selectedItem } = backlog;
  const config = useSettings(notifications);
  const { settings } = config;
  const [newItem, setNewItem] = useState<{ type: BacklogItemType; title: string; parentId?: string }>();
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'refine' | 'preview'>('refine');

  const refinement = useMemo(() => makeRefinementService(settings), [settings]);
  const flow = useRefinementFlow(backlog, refinement, notifications);
  const llmConfiguration = useMemo(() => getLlmConfiguration(), []);
  const llmReady = Boolean(llmConfiguration.endpoint && llmConfiguration.model);

  function selectItem(id: string) {
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

  if (backlog.loading || !config.loaded) return <main className="loading-screen"><span className="brand-mark">b.</span><p>Opening your local backlog…</p></main>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Backlog Studio home" onClick={(event) => event.preventDefault()}><span className="brand-mark">b.</span><span>backlog<span className="brand-light">studio</span></span></a>
        <div className="topbar-center"><span className="workspace-dot" /> Personal workspace <span className="topbar-divider">/</span> Product backlog</div>
        <div className="topbar-actions"><span className="local-badge"><span /> Saved locally</span><button className="icon-button" aria-label="Open settings" onClick={() => config.setOpen(true)}>⚙</button><button className="avatar" aria-label="Local workspace profile">F</button></div>
      </header>

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <main className="workspace-grid">
        <SidebarPanel
          className={`sidebar panel-${mobilePanel}`}
          items={backlog.items} relationships={backlog.relationships} selectedId={backlog.selectedId}
          onSelect={selectItem}
          onCreate={(parent) => setNewItem({ type: parent?.childType ?? 'capability', title: '', parentId: parent?.id })}
          onOpenSettings={() => config.setOpen(true)}
          onExport={config.exportConfig}
          onImport={(file) => void config.importConfig(file)}
        />

        <ChatPanel
          className={`refinement-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} session={backlog.session} sessions={backlog.sessions} busy={flow.busy}
          canRetry={flow.retryState?.sessionId === backlog.session?.id} message={flow.message} reviewChanges={flow.reviewChanges}
          pending={flow.pending} proposal={flow.proposal} selectedProposals={flow.selectedProposals}
          menuActions={[
            { id: 'copy', label: '▣ Copy Markdown', onSelect: () => void copyMarkdown() },
            { id: 'duplicate', label: 'Duplicate item', onSelect: () => void backlog.duplicateSelected() },
            { id: 'download', label: '↓ Download .md', onSelect: downloadMarkdown },
            { id: 'delete', label: '🗑 Delete item', danger: true, onSelect: () => void deleteSelected() },
          ]}
          onSelectItem={selectItem} onNewSession={() => void backlog.startNewSession()} onSwitchSession={(id) => void switchSession(id)}
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
          onSelectItem={selectItem} onCopy={() => void copyMarkdown()} onUpdate={(changes) => void backlog.updateSelected(changes)}
          onResolveChecklist={(line, action, text) => void backlog.resolveChecklist(line, action, text)} onUndo={() => void flow.undoLastChange()}
          onChangeStatus={(status) => void flow.changeSelectedStatus(status)} onAssessQuality={() => void flow.assessQuality()}
          onProposeChildren={(type) => void flow.proposeChildren(type)}
        />
      </main>

      {(error || notice) && <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error ? '!' : '✓'}</span><p>{error || notice}</p><button onClick={clear} aria-label="Dismiss notification">×</button></div>}

      {newItem && <NewItemModal type={newItem.type} title={newItem.title} onTypeChange={(type) => setNewItem({ ...newItem, type })} onTitleChange={(title) => setNewItem({ ...newItem, title })} onSubmit={() => void createItem()} onClose={() => setNewItem(undefined)} />}

      {config.open && <SettingsModal settings={settings} llmReady={llmReady} onClose={() => config.setOpen(false)} onSave={(values) => void config.save(values)} onRestore={() => void config.restore()} />}
    </div>
  );
}
