import { useEffect, useState } from 'react';
import { MdContentCopy,MdControlPointDuplicate, MdDelete, MdDownload } from "react-icons/md";
import type { ItemType, Project } from '../api';
import {
  ConflictDialog, RemoteChangeNotice, closeReasonText, useMemberDirectory, usePresence, useProjectEvents, useProjectPresence,
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
import { Topbar, WorkspaceLayout, useWorkspaceLayout, type ProjectControls } from '../shell';
import { useBacklog } from './useBacklog';
import { errorText, useNotifications } from './useNotifications';
import { useAgentRun, useThreads } from '../run';
import { changeSelectedStatus } from './statusActions';
import { useProjectThreadStatuses } from '../backlog';

export interface AppProps {
  project: Project;
  projectBusy: boolean;
  /** Project list actions of the topbar's project switcher; without it the switcher only shows the current project. */
  projectControls?: ProjectControls;
  onOpenShare?: () => void;
  onProjectGone?: (reason: FinalCloseReason, message: string) => void;
  /** Called when the topbar's ⌘K search trigger is activated (it also dispatches `shell:open-palette` on window). */
  onOpenPalette?: () => void;
}

const noop = () => undefined;

export default function App({ project, projectBusy, projectControls, onOpenShare, onProjectGone, onOpenPalette }: AppProps) {
  const layout = useWorkspaceLayout();
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
  const controls: ProjectControls = projectControls ?? { projects: [project], busy: false, onSelect: noop, onCreate: async () => false, onRename: async () => false, onDelete: noop, onImport: noop };

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
      <Topbar project={project} controls={controls} locked={agentBusy} people={presence.people}
        saveStatus={backlog.saveStatus} onResolveConflict={() => backlog.selectedId && backlog.autosave.reopenConflict(backlog.selectedId)}
        agentPhase={run.state.phase} focusMode={layout.focus !== null} onToggleFocus={layout.toggleFocus}
        onOpenSettings={() => setSettingsOpen(true)} onOpenProjectSettings={() => setProjectSettingsOpen(true)} onOpenShare={onOpenShare} onOpenPalette={onOpenPalette} />

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} aria-pressed={mobilePanel === 'tree'} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} aria-pressed={mobilePanel === 'refine'} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} aria-pressed={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <WorkspaceLayout layout={layout} inert={projectBusy}
        tree={<SidebarPanel
          className={`sidebar panel-${mobilePanel}`}
          items={backlog.items} selectedId={backlog.selectedId}
          onSelect={selectItem} presenceFor={presence.forItem} projectId={project.id} threadStatuses={threadStatuses.statuses}
          onCreate={(parent) => setNewItem({ type: parent?.childType ?? 'capability', title: '', parentId: parent?.id })}
        />}

        chat={<ChatPanel
          className={`refinement-column panel-${mobilePanel}`}
          item={selectedItem} parentItem={backlog.parentItem} threads={threads.threads} activeThreadId={threads.activeThreadId}
          run={run.state} busy={agentBusy} canRetry={run.canRetry} message={message}
          onSelectItem={selectItem} onNewThread={() => void newThread()} onSelectThread={threads.selectThread} onRenameThread={threads.rename} onDeleteThread={deleteThread}
          onMessageChange={setMessage} onSubmit={sendMessage} onContinue={() => void submit(() => run.continue('continue'))}
          onStop={run.stop} onRetry={() => void submit(() => run.retry())}
          onAnswer={(result) => void submit(() => run.answer(result))} onDecideAll={(approved) => void submit(() => run.decideAll(approved))}
          onCreateItem={() => setNewItem({ type: 'capability', title: '' })}
        />}

        preview={<PreviewPanel
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
        />}
      />

      <Toast notifications={notifications} />

      {conflict && backlog.selectedId && <ConflictDialog key={conflict.theirs.version} plan={conflict.plan} theirAuthor={nameOf(conflict.theirs.updatedBy)}
        onResolve={(merged) => void backlog.autosave.resolveConflict(conflict.itemId, merged)} onClose={() => backlog.autosave.postponeConflict(conflict.itemId)} />}

      {newItem && <NewItemModal type={newItem.type} title={newItem.title} onTypeChange={(type) => setNewItem({ ...newItem, type })} onTitleChange={(title) => setNewItem({ ...newItem, title })} onSubmit={() => void createItem()} onClose={() => setNewItem(undefined)} />}

      {settingsOpen && <SettingsModal projectName={project.name} onClose={() => setSettingsOpen(false)} onOpenProjectSettings={() => { setSettingsOpen(false); setProjectSettingsOpen(true); }} />}
      {projectSettingsOpen && <ProjectSettingsDialog project={project} onClose={() => setProjectSettingsOpen(false)} onOpenShare={onOpenShare && (() => { setProjectSettingsOpen(false); onOpenShare(); })} />}
    </div>
  );
}
