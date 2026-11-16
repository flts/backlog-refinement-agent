import { useState, type ReactNode } from 'react';
import { MdCenterFocusStrong, MdSettings } from 'react-icons/md';
import type { Project } from '../api';
import { useSources } from '../api';
import { PresenceAvatars, type PresenceUser } from '../collab';
import type { SaveStatus as Status } from '../collab';
import type { RunPhase } from '../run';
import { SaveStatus } from '../app/SaveStatus';
import { SourcesDrawer } from '../sources';
import { AccountMenu } from './AccountMenu';
import { AgentStatusPill } from './AgentStatusPill';
import { Menu, type MenuEntry } from './Menu';
import { ProjectSwitcher, type ProjectControls } from './ProjectSwitcher';
import { focusShortcut } from './useWorkspaceLayout';
import { useMediaQuery } from './useMediaQuery';

/** Event dispatched on `window` by the search trigger; the ⌘K palette listens for it. */
export const openPaletteEvent = 'shell:open-palette';
/** Below this width the secondary controls collapse into the overflow menu. */
export const overflowQuery = '(max-width: 1100px)';

export function requestOpenPalette(onOpenPalette?: () => void) {
  window.dispatchEvent(new CustomEvent(openPaletteEvent));
  onOpenPalette?.();
}

const isMac = () => typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true">b.</span><span className="brand-text">backlog<span className="brand-light">studio</span></span></span>;
}

export interface TopbarProps {
  project: Project;
  controls: ProjectControls;
  /** The agent is running: switching projects is disabled. */
  locked?: boolean;
  people: PresenceUser[];
  saveStatus: Status;
  onResolveConflict: () => void;
  agentPhase: RunPhase;
  focusMode: boolean;
  onToggleFocus: () => void;
  onOpenSettings: () => void;
  onOpenProjectSettings: () => void;
  /** Share button and overflow entry are omitted without it. */
  onOpenShare?: () => void;
  /** Extra callback when the search trigger is activated; the `shell:open-palette` event is always dispatched. */
  onOpenPalette?: () => void;
}

/**
 * Application topbar: project switcher · Sources · ⌘K search trigger · members + Share · agent status · save status ·
 * focus mode · settings · account. Up to 1100 px wide everything but the switcher, search, agent status and account
 * moves into a "More" overflow menu.
 */
export function Topbar(props: TopbarProps) {
  const { project, controls, people, onOpenShare } = props;
  const overflow = useMediaQuery(overflowQuery);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sources = useSources(project.id);
  const list = sources.data?.items ?? [];
  const pinned = list.filter((source) => source.mode === 'pinned').length;

  const sourcesLabel = <>Sources <span className="count-badge">{list.length}</span><span className="sr-only">, {pinned} pinned</span></>;
  const focusLabel = props.focusMode ? 'Exit focus mode' : 'Focus mode';
  const moreItems: MenuEntry[] = [
    { id: 'sources', label: <>Sources ({list.length})</>, onSelect: () => setSourcesOpen(true) },
    ...(onOpenShare ? [{ id: 'share', label: 'Share…', onSelect: onOpenShare }] : []),
    { id: 'focus', label: focusLabel, onSelect: props.onToggleFocus },
    { id: 'sep', separator: true },
    { id: 'settings', label: 'Settings…', onSelect: props.onOpenSettings },
    { id: 'project-settings', label: 'Project settings…', onSelect: props.onOpenProjectSettings },
  ];

  let secondary: ReactNode;
  if (overflow) {
    secondary = <Menu label="More" className="topbar-more" triggerClassName="icon-button" align="end" items={moreItems} trigger={<span aria-hidden="true">⋯</span>} />;
  } else {
    secondary = <>
      <PresenceAvatars people={people} label="People in this project right now" />
      {onOpenShare && <button type="button" className="button button-secondary button-small share-button" aria-haspopup="dialog" onClick={onOpenShare}>Share</button>}
      <button type="button" className="icon-button" aria-label={focusLabel} aria-pressed={props.focusMode} title={`${focusLabel} (${focusShortcut.label})`} onClick={props.onToggleFocus}><MdCenterFocusStrong aria-hidden /></button>
      <Menu label="Settings" className="settings-menu" triggerClassName="icon-button" align="end" trigger={<MdSettings aria-hidden />}
        items={[{ id: 'settings', label: 'User settings…', onSelect: props.onOpenSettings }, { id: 'project-settings', label: 'Project settings…', onSelect: props.onOpenProjectSettings }]} />
    </>;
  }

  return <header className={`topbar ${overflow ? 'topbar-compact' : ''}`}>
    <Brand />
    <ProjectSwitcher project={project} controls={controls} locked={props.locked} onOpenProjectSettings={props.onOpenProjectSettings} />
    {!overflow && <button type="button" className="topbar-button sources-button" aria-haspopup="dialog" onClick={() => setSourcesOpen(true)}>
      <span aria-hidden="true">📎</span> {sourcesLabel}
    </button>}
    <button type="button" className="search-trigger" aria-keyshortcuts="Control+K Meta+K" onClick={() => requestOpenPalette(props.onOpenPalette)}>
      <span aria-hidden="true">⌕</span><span className="search-text">Search items, run commands…</span><kbd aria-hidden="true">{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
    <div className="topbar-actions">
      {secondary}
      <AgentStatusPill phase={props.agentPhase} />
      <SaveStatus status={props.saveStatus} onResolve={props.onResolveConflict} />
      <AccountMenu />
    </div>
    {sourcesOpen && <SourcesDrawer projectId={project.id} projectName={project.name} onClose={() => setSourcesOpen(false)} />}
  </header>;
}

/** Topbar for the screen without a project: only the project switcher (to create or import one) and the account menu. */
export function EmptyTopbar({ controls }: { controls: ProjectControls }) {
  return <header className="topbar">
    <Brand />
    <ProjectSwitcher controls={controls} />
    <div className="topbar-actions"><AccountMenu /></div>
  </header>;
}
