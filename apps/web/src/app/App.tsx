import { useEffect, useState, type ReactNode } from 'react';
import { MdContentCopy,MdControlPointDuplicate, MdDelete, MdDownload } from "react-icons/md";
import type { ItemType, Project } from '../api';
import type { AgentIntent } from '../contracts';
import { useAuth } from '../auth';
import {
  ConflictDialog, PresenceAvatars, RemoteChangeNotice, closeReasonText, useMemberDirectory, usePresence, useProjectEvents, useProjectPresence,
  type RemoteItemChange,
} from '../collab';
import type { FinalCloseReason } from '../collab/projectEvents';
import { ChatPanel } from '../chat';
import { NewItemModal } from './NewItemModal';
import { PreviewPanel } from './PreviewPanel';
import { SettingsModal } from './SettingsModal';
import { ProjectSettingsDialog } from '../settings/ProjectSettingsDialog';
import { SidebarPanel } from './SidebarPanel';
import { Toast } from './Toast';
import { downloadFile, markdownFilename, markdownFor } from './files';
import { SaveStatus } from './SaveStatus';
import { useBacklog } from './useBacklog';
import { errorText, useNotifications } from './useNotifications';
import { useAgentRun, useThreads } from '../run';
import { changeSelectedStatus } from './statusActions';
import { useProjectThreadStatuses } from '../backlog';
import { toMentionCandidates } from '../context/mentions';
import { CommandPalette, PALETTE_EVENTS, agentCommandsFor, runAgentCommand, usePaletteEvent, type AgentCommandEntry } from '../palette';
import { itemTypeLabel } from './labels';

function initials(name: string): string {
  const letters = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  return letters || '?';
}

export default function App({ project, projectBusy, renderProjectPanel, onOpenShare, onProjectGone }: { project: Project; projectBusy: boolean; renderProjectPanel: (busy: boolean) => ReactNode; onOpenShare?: () => void; onProjectGone?: (reason: FinalCloseReason, message: string) => void }) {
  const auth = useAuth();
  const notifications = useNotifications();
  const { setError, setNotice } = notifications;
  const backlog = useBacklog(notifications, project.id);
  const { selectedItem } = backlog;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [newItem, setNewItem] = useState<{ type: ItemType; title: string; parentId?: string }>();
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'refine' | 'preview'>('refine');

  const [message, setMessage] = useState('');
  const threadStatuses = useProjectThreadStatuses(project.id);
  const threads = useThreads(project.id, selectedItem?.id);
  const run = useAgentRun(threads.activeThreadId, { projectId: project.id, itemId: selectedItem?.id ?? '', itemType: selectedItem?.type, ensureThread: threads.ensureThread });
  const agentBusy = run.busy;

  async function submit(action: () => Promise<{ status: string }>, failure = 'The agent could not start') {
    try {
      const result = await action();
      if (result.status === 'busy') setNotice('The agent is still working. Stop it first or wait for it to finish.');
    } catch (cause) { setError(`${failure}: ${errorText(cause)}`); }
  }

  function sendMessage() {
    const text = message.trim();
    if (!text) return;
    setMessage('');
    void submit(() => run.send(text));
  }

  const { nameOf } = useMemberDirectory(project.id);

  const paletteHandlers = {
    onRunIntent: (intent: AgentIntent, childType?: ItemType) => void submit(() => run.continue(intent, childType)),
    onNewSession: () => void newThread(),
  };
  const slashCommands = agentCommandsFor(selectedItem?.type);
  const mentionItems = toMentionCandidates(backlog.items, itemTypeLabel, selectedItem?.id);
  function runSlashCommand(command: AgentCommandEntry) {
    if (agentBusy) { setNotice('The agent is still working. Stop it first or wait for it to finish.'); return; }
    runAgentCommand(command, paletteHandlers);
  }
  usePaletteEvent(PALETTE_EVENTS.newItem, () => setNewItem({ type: 'capability', title: '' }));
  usePaletteEvent(PALETTE_EVENTS.openSettings, () => setProjectSettingsOpen(true));
  usePaletteEvent(PALETTE_EVENTS.share, () => onOpenShare?.());
  const [remoteChange, setRemoteChange] = useState<RemoteItemChange & { key: number }>();
  useProjectEvents(project.id, {
    itemId: backlog.selectedId,
    onRemoteItemChange: (change) => setRemoteChange((current) => ({ ...change, key: (current?.key ?? 0) + 1 })),
    onProjectGone: (reason) => onProjectGone?.(reason, closeReasonText[reason]),
  });
  usePresence(project.id, backlog.selectedId, backlog.hasDraft ? 'editing' : 'viewing');
  const presence = useProjectPresence(project.id);
  const conflict = backlog.autosave.openConflict(backlog.selectedId);

  function selectItem(id: string) {
    if (agentBusy) return;
    setMessage('');
    backlog.selectItem(id);
    setMobilePanel('refine');
  }

  async function createItem() {
    if (!newItem) return;
    if (await backlog.createItem(newItem.type, newItem.title, newItem.parentId)) setNewItem(undefined);
  }

  async function newThread() {
    try { await threads.create(); setMessage(''); setNotice('A new refinement session has started.'); }
    catch (cause) { setError(`Could not start a session: ${errorText(cause)}`); }
  }

  async function deleteThread(id: string) {
    await threads.remove(id);
    setNotice('Refinement session deleted.');
  }

  async function deleteSelected() {
    await backlog.deleteSelected();
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
        <div className="topbar-actions"><PresenceAvatars people={presence.people} label="People in this project right now" /><SaveStatus status={backlog.saveStatus} onResolve={() => backlog.selectedId && backlog.autosave.reopenConflict(backlog.selectedId)} /><button className="icon-button" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">⚙</span></button><span className="avatar" role="img" aria-label={`Signed in as ${auth.user.name}`} title={auth.user.email}>{initials(auth.user.name)}</span></div>
      </header>

      {renderProjectPanel(agentBusy)}

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} aria-pressed={mobilePanel === 'tree'} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} aria-pressed={mobilePanel === 'refine'} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} aria-pressed={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <main id="main" tabIndex={-1} className="workspace-grid" inert={projectBusy}>
        <SidebarPanel
          className={`sidebar panel-${mobilePanel}`}
          items={backlog.items} selectedId={backlog.selectedId}
          onSelect={selectItem} presenceFor={presence.forItem} projectId={project.id} threadStatuses={threadStatuses.statuses}
          onCreate={(parent) => setNewItem({ type: parent?.childType ?? 'capability', title: '', parentId: parent?.id })}
        />

        <ChatPanel
          className={`refinement-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} threads={threads.threads} activeThreadId={threads.activeThreadId}
          run={run.state} busy={agentBusy} canRetry={run.canRetry} message={message}
          onSelectItem={selectItem} onNewThread={() => void newThread()} onSelectThread={threads.selectThread} onRenameThread={threads.rename} onDeleteThread={deleteThread}
          onMessageChange={setMessage} onSubmit={sendMessage} onContinue={() => void submit(() => run.continue('continue'))}
          onStop={run.stop} onRetry={() => void submit(() => run.retry())}
          onAnswer={(result) => void submit(() => run.answer(result))} onDecideAll={(approved) => void submit(() => run.decideAll(approved))}
          onCreateItem={() => setNewItem({ type: 'capability', title: '' })}
          projectId={project.id} slashCommands={slashCommands} onSlashCommand={runSlashCommand} mentionItems={mentionItems}
        />

        <PreviewPanel
          className={`preview-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} projectId={project.id} revisions={backlog.revisions} revisionsLoading={backlog.revisionsLoading} nameOf={nameOf}
          presence={presence.forItem(backlog.selectedId)} remoteChange={remoteChange} session={{ id: threads.activeThreadId ?? 'new' }} busy={agentBusy}
          menuActions={[
            { id: 'copy', label: <><MdContentCopy aria-hidden /> Copy Markdown</>, onSelect: () => void copyMarkdown() },
            { id: 'duplicate', label: <><MdControlPointDuplicate aria-hidden /> Duplicate item</>, onSelect: () => void backlog.duplicateSelected() },
            { id: 'download', label: <><MdDownload aria-hidden /> Download .md</>, onSelect: downloadMarkdown },
            { id: 'delete', label: <><MdDelete aria-hidden /> Delete item</>, danger: true, onSelect: () => void deleteSelected() },
          ]}
          onSelectItem={selectItem} onUpdate={backlog.editSelected}
          onResolveChecklist={(line, action, text) => void backlog.resolveChecklist(line, action, text)} onRestore={backlog.restoreRevision}
          onChangeStatus={(status) => void changeSelectedStatus(backlog, status)} onAssessQuality={() => void submit(() => run.continue('assess'))}
          onProposeChildren={(type) => void submit(() => run.continue('breakdown', type))}
        />
      </main>

      <CommandPalette projectId={project.id} currentItem={selectedItem && { id: selectedItem.id, type: selectedItem.type }} agentBusy={agentBusy}
        onSelectItem={selectItem} {...paletteHandlers} />

      <Toast notifications={notifications} />

      {conflict && backlog.selectedId && <ConflictDialog key={conflict.theirs.version} plan={conflict.plan} theirAuthor={nameOf(conflict.theirs.updatedBy)}
        onResolve={(merged) => void backlog.autosave.resolveConflict(conflict.itemId, merged)} onClose={() => backlog.autosave.postponeConflict(conflict.itemId)} />}

      {newItem && <NewItemModal type={newItem.type} title={newItem.title} onTypeChange={(type) => setNewItem({ ...newItem, type })} onTitleChange={(title) => setNewItem({ ...newItem, title })} onSubmit={() => void createItem()} onClose={() => setNewItem(undefined)} />}

      {settingsOpen && <SettingsModal projectName={project.name} onClose={() => setSettingsOpen(false)} onOpenProjectSettings={() => { setSettingsOpen(false); setProjectSettingsOpen(true); }} />}
      {projectSettingsOpen && <ProjectSettingsDialog project={project} onClose={() => setProjectSettingsOpen(false)} onOpenShare={onOpenShare && (() => { setProjectSettingsOpen(false); onOpenShare(); })} />}
    </div>
  );
}
