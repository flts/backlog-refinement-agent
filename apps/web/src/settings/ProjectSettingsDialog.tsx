import { useMemo, useState, type KeyboardEvent } from 'react';
import { useGuidance, useGuidanceDefaults, type EffectiveGuidance, type GuidanceTarget, type ItemType, type Project } from '../api';
import { itemTypeLabel, itemTypes } from '../app/labels';
import { errorText } from '../app/useNotifications';
import { useModalDialog } from '../app/useModalDialog';
import { GeneralSection } from './GeneralSection';
import { GuidanceEditor } from './GuidanceEditor';
import { ImportExportSection } from './ImportExportSection';
import { MembersSection } from './MembersSection';
import { entryFor, guidanceKey } from './guidanceCache';

type Section = 'general' | 'members' | 'principles' | ItemType | 'import-export';

const sections: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  { id: 'principles', label: 'Agent principles' },
  ...itemTypes.map((type) => ({ id: type, label: itemTypeLabel[type] })),
  { id: 'import-export', label: 'Import / Export' },
];

function targetsOf(section: Section): { target: GuidanceTarget; label: string; help: string; rows: number }[] {
  if (section === 'principles') {
    return [{ target: { kind: 'principles' }, label: 'Agent principles', help: 'Stable rules the agent applies to every backlog item of this project.', rows: 16 }];
  }
  if (section === 'general' || section === 'members' || section === 'import-export') return [];
  const type = itemTypeLabel[section].toLowerCase();
  return [
    { target: { kind: 'template', itemType: section }, label: `${itemTypeLabel[section]} template`, help: `Markdown structure of every new ${type}. Placeholders such as {{…}} are not allowed.`, rows: 14 },
    { target: { kind: 'type-instructions', itemType: section }, label: `${itemTypeLabel[section]} instructions`, help: `Added to the principles when the agent refines a ${type}.`, rows: 10 },
  ];
}

function dirtySections(guidance: EffectiveGuidance | undefined, drafts: Record<string, string>): Section[] {
  if (!guidance) return [];
  return sections.map((entry) => entry.id).filter((section) => targetsOf(section).some(({ target }) => {
    const draft = drafts[guidanceKey(target)];
    const entry = entryFor(guidance, target);
    return draft !== undefined && entry !== undefined && draft !== entry.content;
  }));
}

type Props = {
  project: Project;
  onClose: () => void;
  /** Opens the Share / members dialog. Without it the Members section stays read-only. */
  onOpenShare?: () => void;
  initialSection?: Section;
};

/** Project settings: owners edit, contributors read. Guidance is the effective text (project override ?? skill default). */
export function ProjectSettingsDialog({ project, onClose, onOpenShare, initialSection = 'general' }: Props) {
  const isOwner = project.role === 'owner';
  const guidanceQuery = useGuidance(project.id);
  const defaultsQuery = useGuidanceDefaults(project.id);
  const [section, setSection] = useState<Section>(initialSection);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dirty = useMemo(() => dirtySections(guidanceQuery.data, drafts), [guidanceQuery.data, drafts]);

  function discard(target: Section) {
    setDrafts((current) => {
      const next = { ...current };
      for (const { target: guidanceTarget } of targetsOf(target)) delete next[guidanceKey(guidanceTarget)];
      return next;
    });
  }

  function select(next: Section) {
    if (next === section) return;
    if (dirty.includes(section)) {
      if (!window.confirm('You have unsaved changes in this section. Discard them?')) return;
      discard(section);
    }
    setSection(next);
  }

  function close() {
    if (dirty.length && !window.confirm('You have unsaved changes. Close and discard them?')) return;
    onClose();
  }

  const dialog = useModalDialog(close);

  function moveTab(event: KeyboardEvent, index: number) {
    const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? index + 1
      : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? sections.length - 1
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = sections[(next + sections.length) % sections.length];
    document.getElementById(`project-settings-tab-${target.id}`)?.focus();
    select(target.id);
  }

  const guidance = guidanceQuery.data;
  const editors = targetsOf(section);

  return <dialog className="modal-dialog" aria-labelledby="project-settings-title" {...dialog}>
    <div className="modal settings-modal project-settings">
      <button type="button" className="close-button modal-close" onClick={close} aria-label="Close project settings"><span aria-hidden="true">×</span></button>
      <span className="eyebrow">{project.name}</span><h2 id="project-settings-title">Project settings</h2>
      {!isOwner && <p className="settings-help readonly-note" id="settings-readonly-note">Only project owners can change project settings. You can read everything here and export the guidance.</p>}
      <div className="project-settings-layout">
        <div className="settings-nav" role="tablist" aria-label="Project settings sections" aria-orientation="vertical">
          {sections.map((entry, index) => (
            <button key={entry.id} type="button" role="tab" id={`project-settings-tab-${entry.id}`} aria-selected={section === entry.id} aria-controls="project-settings-panel"
              tabIndex={section === entry.id ? 0 : -1} className={`settings-tab ${section === entry.id ? 'active' : ''}`}
              onClick={() => select(entry.id)} onKeyDown={(event) => moveTab(event, index)}>
              {entry.label}{dirty.includes(entry.id) && <span className="sr-only"> (unsaved changes)</span>}{dirty.includes(entry.id) && <span aria-hidden="true" className="unsaved-dot" />}
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" id="project-settings-panel" aria-labelledby={`project-settings-tab-${section}`} tabIndex={-1}>
          {section === 'general' && <GeneralSection project={project} isOwner={isOwner} onDeleted={onClose} />}
          {section === 'members' && <MembersSection project={project} isOwner={isOwner} onOpenShare={onOpenShare} />}
          {section === 'import-export' && <ImportExportSection project={project} isOwner={isOwner} hasUnsaved={dirty.length > 0} onImported={() => setDrafts({})} />}
          {editors.length > 0 && <>
            <h3>{section === 'principles' ? 'Agent principles' : `${itemTypeLabel[section as ItemType]}`}</h3>
            {guidanceQuery.isLoading && <p role="status">Loading guidance…</p>}
            {guidanceQuery.isError && <div role="alert"><p className="field-error">Guidance could not be loaded: {errorText(guidanceQuery.error)}</p>
              <button type="button" className="button button-secondary button-small" onClick={() => void guidanceQuery.refetch()}>Try again</button></div>}
            {guidance && editors.map(({ target, label, help, rows }) => {
              const entry = entryFor(guidance, target);
              if (!entry) return null;
              const key = guidanceKey(target);
              return <GuidanceEditor key={key} projectId={project.id} target={target} label={label} help={help} rows={rows} entry={entry} defaults={defaultsQuery.data}
                readOnly={!isOwner} draft={drafts[key]}
                onDraftChange={(value) => setDrafts((current) => {
                  const next = { ...current };
                  if (value === undefined) delete next[key]; else next[key] = value;
                  return next;
                })} />;
            })}
            {guidance && section === 'principles' && <details className="document-format">
              <summary>Document format rules (read-only)</summary>
              <pre className="document-format-text">{guidance.documentFormat}</pre>
            </details>}
          </>}
        </div>
      </div>
      <div className="modal-actions"><button type="button" className="button button-primary" onClick={close}>Done</button></div>
    </div>
  </dialog>;
}
