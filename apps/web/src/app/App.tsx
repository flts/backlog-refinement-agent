import { useEffect, useState, type ReactNode } from 'react';
import { MdContentCopy,MdControlPointDuplicate, MdDelete, MdDownload } from "react-icons/md";
import type { ItemType, Project } from '../api';
import { useAuth } from '../auth';
import { ChatPanel } from './ChatPanel';
import { NewItemModal } from './NewItemModal';
import { PreviewPanel } from './PreviewPanel';
import { SettingsModal } from './SettingsModal';
import { ProjectSettingsDialog } from '../settings/ProjectSettingsDialog';
import { SidebarPanel } from './SidebarPanel';
import { Toast } from './Toast';
import { downloadFile, markdownFilename, markdownFor } from './files';
import { useBacklog } from './useBacklog';
import { errorText, useNotifications } from './useNotifications';
import { useRefinementFlow } from './useRefinementFlow';

function initials(name: string): string {
  const letters = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  return letters || '?';
}

export default function App({ project, projectBusy, renderProjectPanel, onOpenShare }: { project: Project; projectBusy: boolean; renderProjectPanel: (busy: boolean) => ReactNode; onOpenShare?: () => void }) {
  const auth = useAuth();
  const notifications = useNotifications();
  const { setError, setNotice } = notifications;
  const backlog = useBacklog(notifications, project.id);
  const { selectedItem } = backlog;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [newItem, setNewItem] = useState<{ type: ItemType; title: string; parentId?: string }>();
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'refine' | 'preview'>('refine');

  const flow = useRefinementFlow(backlog, notifications);

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

  function switchSession(id: string) {
    if (backlog.switchSession(id)) flow.reset();
  }

  function deleteSession() {
    if (flow.busy) return;
    if (backlog.deleteCurrentSession()) flow.reset();
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

  if (backlog.loading) return <main className="loading-screen" aria-busy="true"><span className="brand-mark" aria-hidden="true">b.</span><p role="status">Opening your backlog…</p></main>;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to main content</a>
      <h1 className="sr-only">Backlog Studio – {project.name}</h1>
      <header className="topbar">
        <span className="brand"><span className="brand-mark" aria-hidden="true">b.</span><span>backlog<span className="brand-light">studio</span></span></span>
        <div className="topbar-center"><span className="workspace-dot" aria-hidden="true" /> {project.name} <span className="topbar-divider">/</span> Product backlog</div>
        <div className="topbar-actions"><span className="local-badge"><span aria-hidden="true" /> {backlog.saving ? 'Saving…' : 'Saved'}</span><button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">⚙</span></button><span className="avatar" role="img" aria-label={`Signed in as ${auth.user.name}`} title={auth.user.email}>{initials(auth.user.name)}</span></div>
      </header>

      {renderProjectPanel(flow.busy)}

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} aria-pressed={mobilePanel === 'tree'} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} aria-pressed={mobilePanel === 'refine'} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} aria-pressed={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <main id="main" tabIndex={-1} className="workspace-grid" inert={projectBusy}>
        <SidebarPanel
          className={`sidebar panel-${mobilePanel}`}
          items={backlog.items} selectedId={backlog.selectedId}
          onSelect={selectItem}
          onCreate={(parent) => setNewItem({ type: parent?.childType ?? 'capability', title: '', parentId: parent?.id })}
        />

        <ChatPanel
          className={`refinement-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} session={backlog.session} sessions={backlog.sessions} busy={flow.busy}
          canRetry={flow.retryState?.sessionId === backlog.session?.id} message={flow.message} reviewChanges={flow.reviewChanges}
          pending={flow.pending} proposal={flow.proposal} selectedProposals={flow.selectedProposals}
          onSelectItem={selectItem} onNewSession={() => { flow.reset(); backlog.startNewSession(); }} onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onMessageChange={flow.setMessage} onSubmit={() => void flow.submitMessage()} onContinue={() => void flow.submitMessage(true)}
          onCancel={flow.cancelRequest} onRetry={() => void flow.retryAssessment()} onToggleReview={flow.toggleReview}
          onApplyPending={() => void flow.applyPending()} onDiscardPending={() => void flow.discardPending()}
          onProposalChange={flow.setProposal} onSelectedProposalsChange={flow.setSelectedProposals}
          onAcceptProposals={() => void flow.acceptSelectedProposals()} onDismissProposal={() => flow.setProposal(undefined)}
          onCreateItem={() => setNewItem({ type: 'capability', title: '' })}
        />

        <PreviewPanel
          className={`preview-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} revisionCount={backlog.revisions.length} session={backlog.session} busy={flow.busy}
          menuActions={[
            { id: 'copy', label: <><MdContentCopy aria-hidden /> Copy Markdown</>, onSelect: () => void copyMarkdown() },
            { id: 'duplicate', label: <><MdControlPointDuplicate aria-hidden /> Duplicate item</>, onSelect: () => void backlog.duplicateSelected() },
            { id: 'download', label: <><MdDownload aria-hidden /> Download .md</>, onSelect: downloadMarkdown },
            { id: 'delete', label: <><MdDelete aria-hidden /> Delete item</>, danger: true, onSelect: () => void deleteSelected() },
          ]}
          onSelectItem={selectItem} onUpdate={backlog.editSelected}
          onResolveChecklist={(line, action, text) => void backlog.resolveChecklist(line, action, text)} onUndo={flow.undoLastChange}
          onChangeStatus={(status) => void flow.changeSelectedStatus(status)} onAssessQuality={() => void flow.assessQuality()}
          onProposeChildren={(type) => void flow.proposeChildren(type)}
        />
      </main>

      <Toast notifications={notifications} />

      {newItem && <NewItemModal type={newItem.type} title={newItem.title} onTypeChange={(type) => setNewItem({ ...newItem, type })} onTitleChange={(title) => setNewItem({ ...newItem, title })} onSubmit={() => void createItem()} onClose={() => setNewItem(undefined)} />}

      {settingsOpen && <SettingsModal projectName={project.name} onClose={() => setSettingsOpen(false)} onOpenProjectSettings={() => { setSettingsOpen(false); setProjectSettingsOpen(true); }} />}
      {projectSettingsOpen && <ProjectSettingsDialog project={project} onClose={() => setProjectSettingsOpen(false)} onOpenShare={onOpenShare && (() => { setProjectSettingsOpen(false); onOpenShare(); })} />}
    </div>
  );
}
