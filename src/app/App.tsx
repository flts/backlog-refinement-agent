import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { WorkspaceApplicationService } from '../application/workspace-service';
import { IndexedDbRefinementStore } from '../infrastructure/storage/IndexedDbRefinementStore';
import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';
import type { PendingQuestion, RefinementSession } from '../domain/refinement-session';
import type { DecompositionProposal } from '../domain/proposal';
import { RefinementApplicationService } from '../application/refinement-service';
import { ProxyLlmProvider } from '../infrastructure/llm/ProxyLlmProvider';
import { ProxyRefinementProvider } from '../infrastructure/llm/ProxyRefinementProvider';
import { getLlmConfiguration } from '../infrastructure/llm/llmConfig';
import { SettingsRepository, defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { defaultBacklogTemplates } from '../defaults/templates';
import { defaultPrinciples, defaultTypeInstructions } from '../defaults/instructions';
import type { BacklogRelationship } from '../domain/relationship';
import { diffDocuments, splitSections, parseChecklistSections, updateChecklistLine, convertPlaceholderTemplate } from '../domain/document';
import { logError } from '../infrastructure/logging';

const refinementStore = new IndexedDbRefinementStore();
const workspace = new WorkspaceApplicationService(refinementStore);
const settingsRepository = new SettingsRepository();
const itemTypeLabel: Record<BacklogItemType, string> = {
  capability: 'Capability', feature: 'Feature', 'user-story': 'User story', enabler: 'Enabler',
};
const typeShort: Record<BacklogItemType, string> = {
  capability: 'CAP', feature: 'FEA', 'user-story': 'STO', enabler: 'ENA',
};

function makeRefinementService(settings: UserSettings): RefinementApplicationService {
  return new RefinementApplicationService({
    store: refinementStore,
    provider: new ProxyRefinementProvider(
      new ProxyLlmProvider(getLlmConfiguration()),
      settings.instructions,
      settings.templates,
      { principles: settings.principles, typeInstructions: settings.typeInstructions },
    ),
    templates: settings.templates,
    ids: { nextId: () => crypto.randomUUID() },
  });
}

function qualityDiagnostics(quality: NonNullable<BacklogItem['quality']>): string[] {
  return [
    quality.excessiveTechnicalDetail && 'Contains excessive technical detail',
    quality.speculativeScope && 'Contains speculative scope',
    quality.unnecessaryConfigurability && 'Contains unnecessary configurability',
    quality.mixedOutcomes && 'Mixes multiple outcomes',
    quality.suggestedItemType && `Better suited as: ${itemTypeLabel[quality.suggestedItemType]}`,
    ...(quality.suggestedSplit ?? []).map((part) => `Suggested split: ${part}`),
    ...(quality.excludedFollowUpCandidates ?? []).map((part) => `Follow-up candidate: ${part}`),
  ].filter((entry): entry is string => Boolean(entry));
}

function markdownFor(item: BacklogItem): string {
  return `# ${item.title}\n\n${item.description}`.trim();
}

function childTypeOptions(type: BacklogItemType): BacklogItemType[] {
  if (type === 'capability') return ['feature', 'enabler'];
  if (type === 'feature') return ['user-story', 'enabler'];
  return [];
}

export default function App() {
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [relationships, setRelationships] = useState<BacklogRelationship[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [session, setSession] = useState<RefinementSession>();
  const [sessions, setSessions] = useState<RefinementSession[]>([]);
  const [settings, setSettings] = useState<UserSettings>(defaultUserSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newType, setNewType] = useState<BacklogItemType>('capability');
  const [newTitle, setNewTitle] = useState('');
  const [newParentId, setNewParentId] = useState<string>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryState, setRetryState] = useState<{ sessionId: string; force: boolean }>();
  const [proposal, setProposal] = useState<DecompositionProposal>();
  const [selectedProposals, setSelectedProposals] = useState<string[]>([]);
  const [mobilePanel, setMobilePanel] = useState<'tree' | 'refine' | 'preview'>('refine');
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const conversationRef = useRef<HTMLDivElement | null>(null);

  const selectedItem = items.find((item) => item.id === selectedId);
  const orderedItems = useMemo(() => [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [items]);
  const refinement = useMemo(() => makeRefinementService(settings), [settings]);
  const llmConfiguration = useMemo(() => getLlmConfiguration(), []);
  const llmConfigurationReady = Boolean(
    llmConfiguration.endpoint && llmConfiguration.model,
  );

  const refresh = useCallback(async (preferredId?: string) => {
    const [nextItems, nextRelationships] = await Promise.all([workspace.listItems(), workspace.listRelationships()]);
    setItems(nextItems);
    setRelationships(nextRelationships);
    const id = preferredId ?? selectedId;
    if (id && nextItems.some((item) => item.id === id)) setSelectedId(id);
    else if (nextItems[0]) setSelectedId(nextItems[0].id);
    else setSelectedId(undefined);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([refresh(), settingsRepository.load()])
      .then(([, storedSettings]) => { if (!cancelled) setSettings(storedSettings); })
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not load local backlog: ${errorText(cause)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) { setSession(undefined); setSessions([]); return; }
    let cancelled = false;
    workspace.getOrCreateSession(selectedId)
      .then(async (next) => {
        const history = await workspace.listSessionsForItem(selectedId);
        if (!cancelled) { setSession(next); setSessions(history); }
      })
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not resume refinement: ${errorText(cause)}`); });
    return () => { cancelled = true; };
  }, [selectedId]);

  function errorText(cause: unknown): string {
    logError('Operation failed', cause);
    return cause instanceof Error ? cause.message : 'Unexpected error';
  }

  function startRequest(): AbortSignal {
    const controller = new AbortController();
    abortRef.current = controller;
    return controller.signal;
  }

  function cancelRequest() {
    abortRef.current?.abort();
  }

  async function selectItem(id: string) {
    setError(''); setProposal(undefined); setSession(undefined); setSessions([]); setMessage(''); setSelectedId(id); setMobilePanel('refine');
    const selected = items.find((item) => item.id === id);
    if (selected) setNotice(`${itemTypeLabel[selected.type]} selected`);
  }

  async function createItem(event?: FormEvent) {
    event?.preventDefault();
    setError('');
    try {
      const created = await workspace.createItem(newType, newTitle.trim() || undefined, newParentId);
      await refresh(created.id);
      setShowNew(false); setNewTitle(''); setNewParentId(undefined); setNotice(`${itemTypeLabel[created.type]} created`);
    } catch (cause) { setError(`Could not create backlog item: ${errorText(cause)}`); }
  }

  async function startNewSession() {
    if (!selectedItem) return;
    try {
      const created = await workspace.createSession(selectedItem.id);
      setSession(created);
      setSessions((current) => [created, ...current]);
      setNotice('A new refinement session has started.');
    } catch (cause) { setError(`Could not start a session: ${errorText(cause)}`); }
  }

  async function switchSession(sessionId: string) {
    try {
      const next = await workspace.getSession(sessionId);
      if (!next) throw new Error('That refinement session no longer exists.');
      setSession(next);
      setRetryState(undefined);
      setMessage('');
      setProposal(undefined);
    } catch (cause) { setError(`Could not resume session: ${errorText(cause)}`); }
  }

  async function changeSelectedStatus(status: BacklogItem['status']) {
    if (!selectedItem || !session) return;
    try {
      if (selectedItem.status === 'draft' && status === 'ready') {
        const refiningItem = await refinement.beginRefinement(session.id);
        setItems((current) => current.map((item) => item.id === refiningItem.id ? refiningItem : item));
      }
      await updateSelected({ status });
    } catch (cause) { setError(`Could not change status: ${errorText(cause)}`); }
  }

  async function updateSelected(changes: Partial<BacklogItem>): Promise<boolean> {
    if (!selectedItem) return false;
    const optimistic = { ...selectedItem, ...changes, updatedAt: new Date().toISOString() };
    setItems((current) => current.map((item) => item.id === optimistic.id ? optimistic : item));
    try {
      const updated = await workspace.updateItem(optimistic);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      return true;
    } catch (cause) {
      setError(`Could not save item: ${errorText(cause)}`);
      const persisted = await workspace.getItem(selectedItem.id).catch(() => undefined);
      if (persisted) setItems((current) => current.map((item) => item.id === persisted.id ? persisted : item));
      return false;
    }
  }

  async function submitMessage(event?: FormEvent, force = false) {
    event?.preventDefault();
    if (!session || !selectedItem || busy || (!message.trim() && !force)) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    let messageSaved = false;
    const humanText = force ? 'Continue with the current information. Do not ask more questions; capture uncertainty as open questions.' : message.trim();
    try {
      let currentItem = await refinement.beginRefinement(session.id);
      setItems((current) => current.map((item) => item.id === currentItem.id ? currentItem : item));
      let currentSession = await refinement.recordHumanMessage(session.id, humanText);
      messageSaved = true;
      setSession(currentSession);
      if (!force) setMessage('');
      if (force) currentSession = await workspace.setForceGeneration(session.id, true);
      const response = await refinement.proposeAssessment(currentSession.id, signal);
      if (response.kind !== 'assessment') throw new Error('The model returned the wrong response type.');
      const [updated] = await refinement.acceptProposal(response);
      if (refinement.lastWarnings.length) setNotice(refinement.lastWarnings.join(' '));
      const currentStatus = response.suggestedStatus ?? updated.status;
      const agentText = response.questions.length
        ? `${response.summary}\n\n${response.questions.map((question) => `• ${question.text}`).join('\n')}`
        : response.summary;
      const pendingQuestions: PendingQuestion[] = response.questions.map(({ id, text, importance, relatedField, rationale }) => ({ id, text, importance, relatedField, rationale }));
      const savedSession = await workspace.addAgentMessage(currentSession.id, agentText, pendingQuestions);
      setSession(savedSession);
      currentItem = { ...updated, status: currentStatus };
      setItems((current) => current.map((item) => item.id === currentItem.id ? currentItem : item));
      setRetryState(undefined);
      if (force) {
        await workspace.setForceGeneration(session.id, false);
        setNotice('Refinement finished with the information available. Review remaining questions in the item preview.');
      }
    } catch (cause) {
      let resetFailure = '';
      if (force) {
        try { await workspace.setForceGeneration(session.id, false); }
        catch (resetError) { resetFailure = ` The generation flag could not be reset: ${errorText(resetError)}`; }
      }
      setRetryState(messageSaved ? { sessionId: session.id, force } : undefined);
      if (signal.aborted) {
        setNotice('Request cancelled. Your message is saved; retry when ready.');
        return;
      }
      setError(`${errorText(cause)}${resetFailure} ${messageSaved ? 'Your message is saved; retry the request.' : force ? 'No request was sent because the session could not be saved.' : 'Your message remains in the composer.'}`);
    } finally { setBusy(false); }
  }

  async function retryAssessment() {
    if (!retryState || !session || !selectedItem || busy) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      await refinement.beginRefinement(retryState.sessionId);
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, true);
      const response = await refinement.proposeAssessment(retryState.sessionId, signal);
      if (response.kind !== 'assessment') throw new Error('The model returned the wrong response type.');
      const [updated] = await refinement.acceptProposal(response);
      if (refinement.lastWarnings.length) setNotice(refinement.lastWarnings.join(' '));
      const agentText = response.questions.length
        ? `${response.summary}\n\n${response.questions.map((question) => `• ${question.text}`).join('\n')}`
        : response.summary;
      const pendingQuestions: PendingQuestion[] = response.questions.map(({ id, text, importance, relatedField, rationale }) => ({ id, text, importance, relatedField, rationale }));
      const savedSession = await workspace.addAgentMessage(retryState.sessionId, agentText, pendingQuestions);
      setSession(savedSession);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, false);
      setRetryState(undefined);
      setNotice('Refinement response received.');
    } catch (cause) {
      if (retryState.force) await workspace.setForceGeneration(retryState.sessionId, false).catch(() => undefined);
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Retry failed: ${errorText(cause)}`);
    } finally { setBusy(false); }
  }

  async function proposeChildren(type: BacklogItemType) {
    if (!selectedItem || !session) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      const generated = await refinement.proposeDecomposition(session.id, signal, type);
      if (generated.kind !== 'decomposition') throw new Error('The model returned the wrong response type.');
      const children = generated.children.filter((child) => child.type === type);
      const refs = new Set([generated.parentItemId, ...children.map((child) => child.proposalId)]);
      const filtered: DecompositionProposal = {
        ...generated,
        children,
        relationships: generated.relationships.filter((relationship) =>
          refs.has(relationship.sourceRef) && refs.has(relationship.targetRef)),
      };
      if (!filtered.children.length) {
        setNotice(`No ${itemTypeLabel[type].toLowerCase()} proposals suggested. ${generated.rationale}`);
        return;
      }
      setProposal(filtered);
      setSelectedProposals(filtered.children.map((child) => child.proposalId));
    } catch (cause) {
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Could not propose children: ${errorText(cause)}`);
    }
    finally { setBusy(false); }
  }

  async function acceptSelectedProposals() {
    if (!proposal || !selectedProposals.length) return;
    setBusy(true); setError('');
    try {
      const created = await refinement.acceptProposal(proposal, selectedProposals);
      setProposal(undefined);
      await refresh(created[0]?.id);
      setNotice(`${created.length} child ${created.length === 1 ? 'item' : 'items'} added to the backlog`);
    } catch (cause) { setError(`Could not accept proposals: ${errorText(cause)}`); }
    finally { setBusy(false); }
  }

  async function assessQuality() {
    if (!selectedItem || busy) return;
    setBusy(true); setError(''); setNotice('');
    const signal = startRequest();
    try {
      const updated = await refinement.assessQuality(selectedItem.id, signal);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice('Quality assessment updated.');
    } catch (cause) {
      logError('Quality assessment failed', cause);
      if (signal.aborted) setNotice('Request cancelled.');
      else setError(`Could not assess quality: ${errorText(cause)}`);
    } finally { setBusy(false); }
  }
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | BacklogItemType>('general');

  async function deleteSelected() {
    setMenuOpen(false);
    if (!selectedItem || !window.confirm(`Delete “${selectedItem.title}” and its refinement sessions? Related items will be kept.`)) return;
    try {
      await workspace.deleteItemAndReferences(selectedItem.id);
      setSession(undefined); setProposal(undefined);
      await refresh();
      setNotice('Backlog item deleted. Related items were kept.');
    } catch (cause) { setError(`Could not delete item: ${errorText(cause)}`); }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      const saved = await settingsRepository.save({
        instructions: String(form.get('instructions') ?? ''),
        templates: Object.fromEntries(
          (Object.keys(itemTypeLabel) as BacklogItemType[]).map((type) => [
            type, String(form.get(`template-${type}`) ?? ''),
          ]),
        ) as UserSettings['templates'],
        principles: String(form.get('principles') ?? ''),
        typeInstructions: Object.fromEntries(
          (Object.keys(itemTypeLabel) as BacklogItemType[]).map((type) => [
            type, String(form.get(`type-instructions-${type}`) ?? ''),
          ]),
        ) as UserSettings['typeInstructions'],
      });
      setSettings(saved); setShowSettings(false); setNotice('Instructions and templates saved locally in IndexedDB.');
    } catch (cause) { setError(`Could not save settings: ${errorText(cause)}`); }
  }

  function exportConfig() {
    const json = JSON.stringify({ version: 4, settings }, null, 2);
    downloadFile('backlog-refinement-config.json', json, 'application/json');
  }

  async function importConfig(file?: File) {
    if (!file) return;
    try {
      const typeMap = z.object({
        capability: z.string(), feature: z.string(),
        'user-story': z.string(), enabler: z.string(),
      });
      const v3ConfigSchema = z.object({
        version: z.union([z.literal(3), z.literal(4)]),
        settings: z.object({
          templates: typeMap,
          instructions: z.string(),
          principles: z.string(),
          typeInstructions: typeMap,
        }),
      });
      const currentConfigSchema = z.object({
        version: z.literal(2),
        settings: z.object({
          templates: z.object({
            capability: z.string(), feature: z.string(),
            'user-story': z.string(), enabler: z.string(),
          }),
          instructions: z.string(),
        }),
      });
      const legacyConfigSchema = z.object({
        version: z.literal(1),
        settings: z.object({
          templates: z.object({
            capability: z.array(z.string()), feature: z.array(z.string()),
            'user-story': z.array(z.string()), enabler: z.array(z.string()),
          }),
          instructions: z.string().optional(),
        }),
      });
      const parsed = z.union([v3ConfigSchema, currentConfigSchema, legacyConfigSchema]).parse(JSON.parse(await file.text()));
      const templates = parsed.version !== 1
        ? Object.fromEntries(Object.entries(parsed.settings.templates).map(([type, value]) => [type, convertPlaceholderTemplate(value)])) as UserSettings['templates']
        : Object.fromEntries(
          (Object.keys(itemTypeLabel) as BacklogItemType[]).map((type) => [
            type,
            parsed.settings.templates[type].length
              ? parsed.settings.templates[type].map((section) => `## ${section}`).join('\n\n')
              : defaultBacklogTemplates[type],
          ]),
        ) as UserSettings['templates'];
      const saved = await settingsRepository.save({
        instructions: parsed.settings.instructions ?? '',
        templates,
        principles: 'principles' in parsed.settings ? parsed.settings.principles : defaultPrinciples,
        typeInstructions: 'typeInstructions' in parsed.settings ? parsed.settings.typeInstructions : defaultTypeInstructions,
      });
      setSettings(saved); setNotice('Configuration imported.');
    } catch (cause) { setError(`Could not import configuration: ${errorText(cause)}`); }
  }

  async function resolveChecklist(line: number, action: 'check' | 'remove', message: string) {
    if (!selectedItem) return;
    const description = updateChecklistLine(selectedItem.description, line, action);
    if (description === selectedItem.description) return;
    const saved = await updateSelected({ description });
    if (saved) setNotice(message);
  }

  async function undoLastChange() {
    if (!selectedItem) return;
    try {
      const restored = await refinement.undoLastChange(selectedItem.id);
      setItems((current) => current.map((item) => item.id === restored.id ? restored : item));
      setNotice('Restored the version before the last AI change.');
    } catch (cause) { logError('Could not undo', cause); setError(`Could not undo: ${errorText(cause)}`); }
  }

  async function copyMarkdown() {
    if (!selectedItem) return;
    try {
      await navigator.clipboard.writeText(markdownFor(selectedItem));
      setNotice('Markdown copied to clipboard.');
    } catch (cause) { setError(`Could not copy Markdown: ${errorText(cause)}`); }
  }

  const roots = orderedItems.filter((item) => !relationships.some((relationship) => relationship.type === 'parent-child' && relationship.targetId === item.id));
  const currentMessages = session?.conversation ?? [];
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || (!busy && currentMessages.length === 0)) return;
    const frame = requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, currentMessages.length, selectedId]);
  const parentRelationship = selectedItem && relationships.find((relationship) => relationship.type === 'parent-child' && relationship.targetId === selectedItem.id);
  const checklist = useMemo(() => selectedItem ? parseChecklistSections(selectedItem.description) : [], [selectedItem]);
  const lastRevision = selectedItem?.revisions[selectedItem.revisions.length - 1];
  const lastChange = selectedItem && lastRevision ? diffDocuments(lastRevision.description, selectedItem.description) : undefined;
  const parentItem = parentRelationship && items.find((item) => item.id === parentRelationship.sourceId);

  if (loading) return <main className="loading-screen"><span className="brand-mark">b.</span><p>Opening your local backlog…</p></main>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Backlog Studio home" onClick={(event) => event.preventDefault()}><span className="brand-mark">b.</span><span>backlog<span className="brand-light">studio</span></span></a>
        <div className="topbar-center"><span className="workspace-dot" /> Personal workspace <span className="topbar-divider">/</span> Product backlog</div>
        <div className="topbar-actions"><span className="local-badge"><span /> Saved locally</span><button className="icon-button" aria-label="Open settings" onClick={() => setShowSettings(true)}>⚙</button><button className="avatar" aria-label="Local workspace profile">F</button></div>
      </header>

      <nav className="mobile-tabs" aria-label="Workspace sections">
        <button className={mobilePanel === 'tree' ? 'active' : ''} onClick={() => setMobilePanel('tree')}>Backlog</button>
        <button className={mobilePanel === 'refine' ? 'active' : ''} onClick={() => setMobilePanel('refine')}>Refine</button>
        <button className={mobilePanel === 'preview' ? 'active' : ''} onClick={() => setMobilePanel('preview')}>Item preview</button>
      </nav>

      <main className="workspace-grid">
        <aside className={`sidebar panel-${mobilePanel}`}>
          <div className="sidebar-head"><div><span className="eyebrow">WORKSPACE</span><h2>Backlog</h2></div><button className="add-button" aria-label="Create backlog item" onClick={() => { setNewParentId(undefined); setShowNew(true); }}>+</button></div>
          <div className="backlog-summary"><span>{items.length} {items.length === 1 ? 'item' : 'items'}</span><span className="summary-dot">·</span><span>{items.filter((item) => item.status === 'ready' || item.status === 'ready-with-open-questions').length} ready</span></div>
          <div className="tree-list">
            {roots.length ? roots.map((root) => <TreeItem key={root.id} item={root} allItems={items} relationships={relationships} selectedId={selectedId} onSelect={selectItem} onAddChild={(parentId) => { setShowNew(true); setNewParentId(parentId); const parent = items.find((item) => item.id === parentId); setNewType(parent?.type === 'capability' ? 'feature' : parent?.type === 'feature' ? 'user-story' : 'enabler'); }} />) : <div className="tree-empty"><span className="empty-icon">⌘</span><strong>Your backlog starts here</strong><p>Add a capability, feature, story, or enabler to begin shaping the work.</p><button className="button button-secondary button-small" onClick={() => { setNewParentId(undefined); setShowNew(true); }}>Create first item</button></div>}
          </div>
          <div className="sidebar-bottom"><button className="sidebar-link" onClick={() => setShowSettings(true)}><span>⚙</span> Agent & settings</button><button className="sidebar-link" onClick={exportConfig}><span>⇧</span> Export configuration</button><button className="sidebar-link" onClick={() => fileInput.current?.click()}><span>⇩</span> Import configuration</button><input ref={fileInput} type="file" accept="application/json" hidden onChange={(event) => void importConfig(event.target.files?.[0])} /></div>
        </aside>

        <section className={`refinement-column panel-${mobilePanel}`} aria-label="Refinement workspace">
          {selectedItem ? <>
            <div className="refine-heading"><div><span className="eyebrow">REFINEMENT WORKSPACE</span><h1>{selectedItem.title}</h1><p>{parentItem ? <><button className="text-link" onClick={() => void selectItem(parentItem.id)}>{parentItem.title}</button><span className="crumb-sep">/</span></> : null}{itemTypeLabel[selectedItem.type]} <span className="crumb-sep">·</span> {selectedItem.status.replaceAll('-', ' ')}</p></div><div className="heading-actions">{sessions.length > 1 && <select className="session-select" aria-label="Choose refinement session" value={session?.id ?? ''} onChange={(event) => void switchSession(event.target.value)}>{sessions.map((savedSession, index) => <option key={savedSession.id} value={savedSession.id}>Session {sessions.length - index} · {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(savedSession.updatedAt))}</option>)}</select>}<button className="new-session-button" onClick={() => void startNewSession()} aria-label="Start a new refinement session" title="New refinement session">＋</button><div className="menu-wrap"><button className="more-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }} onClick={() => setMenuOpen((open) => !open)} onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setMenuOpen(false); }}>···</button>{menuOpen && <div className="menu-popover" role="menu" onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }} onBlur={(event) => { if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setMenuOpen(false); }}><button role="menuitem" className="menu-item menu-danger" onClick={() => void deleteSelected()}>🗑 Delete item</button></div>}</div></div></div>
            {parentItem && <div className="context-banner"><span className="context-icon">↳</span><span>Refining within <strong>{parentItem.title}</strong></span><button onClick={() => void selectItem(parentItem.id)}>View parent</button></div>}
            <div ref={conversationRef} className="conversation-scroll" aria-live="polite">
              {currentMessages.length === 0 && <div className="welcome-card"><div className="agent-icon">✳</div><div><strong>Let’s make this item clear and useful.</strong><p>Share what you know. I’ll help identify what’s missing, keep assumptions visible, and shape the work without inventing requirements.</p><div className="welcome-prompt"><span>↳</span> What outcome should this work make possible?</div></div></div>}
              {currentMessages.map((entry) => <div key={entry.id} className={`message-row ${entry.role === 'user' ? 'message-user' : ''}`}><div className={entry.role === 'user' ? 'user-avatar' : 'agent-icon'}>{entry.role === 'user' ? 'F' : '✳'}</div><div className="message-content"><span className="message-author">{entry.role === 'user' ? 'You' : 'Refinement agent'} <time>{formatTime(entry.createdAt)}</time></span><p>{entry.content}</p></div></div>)}
              {busy && <div className="message-row"><div className="agent-icon">✳</div><div className="message-content"><span className="message-author">Refinement agent</span><p className="typing"><i /><i /><i /><span>Thinking through the details</span></p></div></div>}
              {proposal && <div className="proposal-panel"><div className="proposal-heading"><div><span className="eyebrow">DECOMPOSITION PROPOSAL</span><h3>Possible next pieces</h3></div><button className="close-button" onClick={() => setProposal(undefined)} aria-label="Dismiss proposal">×</button></div><p className="proposal-rationale">{proposal.rationale}</p><div className="proposal-list">{proposal.children.map((child) => <label className="proposal-item" key={child.proposalId}><input type="checkbox" checked={selectedProposals.includes(child.proposalId)} onChange={(event) => setSelectedProposals((current) => event.target.checked ? [...current, child.proposalId] : current.filter((id) => id !== child.proposalId))} /><span className="proposal-copy"><input aria-label="Proposal title" value={child.title} onChange={(event) => setProposal({ ...proposal, children: proposal.children.map((value) => value.proposalId === child.proposalId ? { ...value, title: event.target.value } : value) })} /><small className="muted-copy">{parseChecklistSections(child.description).filter((entry) => entry.kind === 'assumption').length} assumptions · {parseChecklistSections(child.description).filter((entry) => entry.kind === 'question').length} open questions{(() => { const sections = splitSections(child.description).sections; return sections.length ? ` · ${sections.filter((section) => section.body.trim() && !/^(- \[ \]\s*)?$/.test(section.body.trim())).length}/${sections.length} sections filled` : ''; })()}</small><textarea aria-label="Proposal description" rows={10} value={child.description} placeholder="Add a short description before accepting" onChange={(event) => setProposal({ ...proposal, children: proposal.children.map((value) => value.proposalId === child.proposalId ? { ...value, description: event.target.value } : value) })} /></span><span className="type-pill">{typeShort[child.type]}</span></label>)}</div><div className="proposal-actions"><span>{selectedProposals.length} selected</span><button className="button button-primary button-small" disabled={!selectedProposals.length || busy} onClick={() => void acceptSelectedProposals()}>Add selected items <span>→</span></button></div></div>}
            </div>
            <div className="composer-wrap"><div className="composer-tools"><span><span className="green-spark">✳</span> Refine with AI</span><span className="composer-hint">Enter to send · Shift+Enter for new line</span></div><form className="composer" onSubmit={(event) => void submitMessage(event)}><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (message.trim() && !busy) void submitMessage(); } }} placeholder="Share context, answer a question, or describe what you know…" rows={3} aria-label="Message the refinement agent" disabled={busy} /><div className="composer-bottom"><div className="composer-tip"><span>↗</span> Your structured item updates as you refine</div><button className="send-button" type="submit" disabled={busy || !message.trim()} aria-label="Send message">{busy ? '…' : '↑'}</button></div></form><div className="composer-actions">{busy && <button className="retry-button" onClick={cancelRequest}>■ Cancel request</button>}{retryState?.sessionId === session?.id && <button className="retry-button" onClick={() => void retryAssessment()} disabled={busy}>↻ Retry last request</button>}<button className="continue-button" onClick={() => void submitMessage(undefined, true)} disabled={busy || !session}><span>◷</span> Continue with current information <span className="continue-note">Stop asking and capture what’s still unknown</span></button></div></div>
          </> : <div className="no-selection"><div className="empty-icon">✳</div><h2>Choose what to refine</h2><p>Select an item from your backlog or create something new.</p><button className="button button-primary" onClick={() => { setNewParentId(undefined); setShowNew(true); }}>Create backlog item</button></div>}
        </section>

        <aside className={`preview-column panel-${mobilePanel}`}>
          {selectedItem ? <>
            <div className="preview-head"><div><span className="eyebrow">BACKLOG ITEM</span><h2>Live preview</h2></div><button className="copy-button" onClick={() => void copyMarkdown()}><span>▣</span> Copy Markdown</button></div>
            <div className="preview-scroll">
              <div className="preview-type"><span className="type-icon">{typeShort[selectedItem.type]}</span><span>{itemTypeLabel[selectedItem.type]}</span><span className={`status-chip status-${selectedItem.status}`}>{statusText(selectedItem.status)}</span></div>
              <label className="field-label" htmlFor="item-title">TITLE</label><input id="item-title" className="preview-title-input" value={selectedItem.title} onChange={(event) => void updateSelected({ title: event.target.value })} />
              <label className="field-label" htmlFor="item-description">DOCUMENT (MARKDOWN)</label><textarea id="item-description" className="preview-description" value={selectedItem.description} placeholder="What is this item about? Add a starting point or refine it with the agent." onChange={(event) => void updateSelected({ description: event.target.value })} rows={14} />
              {checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Assumptions to confirm</h3><span className="count-badge amber">{checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).length}</span></div>{checklist.filter((entry) => entry.kind === 'assumption' && !entry.checked).map((entry) => <div className="uncertainty-card assumption-card" key={entry.line}><span>◇</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Confirm assumption" title="Confirm" onClick={() => void resolveChecklist(entry.line, 'check', 'Assumption confirmed.')}>✓</button><button className="uncertainty-action reject" aria-label="Reject assumption" title="Reject" onClick={() => void resolveChecklist(entry.line, 'remove', 'Assumption rejected.')}>×</button></div>)}</section>}
              {checklist.filter((entry) => entry.kind === 'question' && !entry.checked).length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>Open questions</h3><span className="count-badge blue">{checklist.filter((entry) => entry.kind === 'question' && !entry.checked).length}</span></div>{checklist.filter((entry) => entry.kind === 'question' && !entry.checked).map((entry) => <div className="uncertainty-card question-card" key={entry.line}><span>?</span><p>{entry.text}</p><button className="uncertainty-action" aria-label="Mark question resolved" title="Resolve" onClick={() => void resolveChecklist(entry.line, 'check', 'Question marked resolved.')}>✓</button></div>)}</section>}
              {selectedItem.revisions.length > 0 && <section className="preview-section"><div className="preview-section-head"><h3>AI changes</h3><span className="subtle-label">{selectedItem.revisions.length} saved</span></div>{lastChange && <ul className="quality-list">{lastChange.removed.slice(0, 5).map((line) => <li key={`r-${line}`} className="quality-missing"><span>− {line}</span></li>)}{lastChange.added.slice(0, 5).map((line) => <li key={`a-${line}`} className="quality-clear"><span>+ {line}</span></li>)}</ul>}<button className="button button-secondary button-small" onClick={() => void undoLastChange()}>Undo last AI change</button></section>}
              <section className="preview-section"><div className="preview-section-head"><h3>Structure</h3><span className="subtle-label">{relationships.filter((relationship) => relationship.sourceId === selectedItem.id || relationship.targetId === selectedItem.id).length} links</span></div>{parentItem ? <button className="related-item" onClick={() => void selectItem(parentItem.id)}><span className="type-icon tiny">{typeShort[parentItem.type]}</span>{parentItem.title}<span>↗</span></button> : <p className="muted-copy">No parent item linked.</p>}{items.filter((item) => relationships.some((relationship) => relationship.type === 'parent-child' && relationship.sourceId === selectedItem.id && relationship.targetId === item.id)).map((item) => <button className="related-item" key={item.id} onClick={() => void selectItem(item.id)}><span className="type-icon tiny">{typeShort[item.type]}</span>{item.title}<span>↗</span></button>)}</section>
              {selectedItem.quality && <section className="preview-section quality-section" aria-label="Quality assessment"><div className="preview-section-head"><h3>Quality assessment</h3><span className="status-indicator"><i /> {selectedItem.quality.overall === 'ready' ? 'Ready' : selectedItem.quality.overall === 'ready-with-open-questions' ? 'Ready with open questions' : 'Needs clarification'}</span></div><ul className="quality-list">{selectedItem.quality.areas.map((entry) => <li key={entry.area} className={`quality-${entry.level}`}><strong>{entry.area.replaceAll('-', ' ')}</strong><span className="quality-level">{entry.level.replaceAll('-', ' ')}</span>{entry.note && <small>{entry.note}</small>}</li>)}</ul>{qualityDiagnostics(selectedItem.quality).length > 0 && <ul className="quality-list quality-diagnostics">{qualityDiagnostics(selectedItem.quality).map((text) => <li key={text} className="quality-unclear"><span>{text}</span></li>)}</ul>}</section>}
              <section className="preview-section quality-section"><div className="preview-section-head"><h3>Refinement status</h3><span className="status-indicator"><i /> {statusText(selectedItem.status)}</span></div><p>{selectedItem.status === 'ready-with-open-questions' ? 'Ready to move forward with a few details to resolve.' : selectedItem.status === 'ready' || selectedItem.status === 'complete' ? 'This item has enough clarity to move forward.' : 'Keep refining to clarify the outcome, value, and boundaries.'}</p><button className="button button-secondary button-small" onClick={() => void changeSelectedStatus(selectedItem.status === 'complete' ? 'refining' : selectedItem.status === 'ready' ? 'complete' : 'ready')}>{selectedItem.status === 'complete' ? 'Reopen item' : selectedItem.status === 'ready' ? 'Mark complete' : 'Mark ready'}</button> <button className="button button-secondary button-small" disabled={busy} onClick={() => void assessQuality()}>Assess quality</button></section>
            </div>
            <div className="decompose-area"><div className="decompose-title"><span>✳</span><div><strong>Break this down</strong><small>Propose child items for your review</small></div></div><div className="decompose-buttons">{childTypeOptions(selectedItem.type).map((type) => <button key={type} className="button button-secondary button-small" disabled={busy || !session} onClick={() => void proposeChildren(type)}>＋ {type === 'feature' ? 'Features' : type === 'user-story' ? 'User stories' : 'Enablers'}</button>)}</div></div>
          </> : <div className="preview-empty"><span className="type-icon">↗</span><h3>Your item preview</h3><p>Choose an item to see its structure and refinement details.</p></div>}
        </aside>
      </main>

      {(error || notice) && <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error ? '!' : '✓'}</span><p>{error || notice}</p><button onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss notification">×</button></div>}

      {showNew && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNew(false); }}><form className="modal" onSubmit={(event) => void createItem(event)}><button type="button" className="close-button modal-close" onClick={() => setShowNew(false)} aria-label="Close">×</button><span className="eyebrow">NEW BACKLOG ITEM</span><h2>What are we shaping?</h2><p>Start with the item type and a working title. You can refine it as you go.</p><label htmlFor="new-type">Item type</label><select id="new-type" value={newType} onChange={(event) => setNewType(event.target.value as BacklogItemType)}>{Object.entries(itemTypeLabel).map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select><label htmlFor="new-title">Working title <span>Optional</span></label><input id="new-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder={`Untitled ${itemTypeLabel[newType]}`} autoFocus /><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setShowNew(false)}>Cancel</button><button className="button button-primary" type="submit">Create and refine <span>→</span></button></div></form></div>}

      {showSettings && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}><form className="modal settings-modal" onSubmit={(event) => void saveSettings(event)} onKeyDown={(event) => { if (event.key === 'Escape') setShowSettings(false); }}>
        <button type="button" className="close-button modal-close" onClick={() => setShowSettings(false)} aria-label="Close">×</button>
        <span className="eyebrow">PERSONALIZE YOUR AGENT</span><h2>Instructions & templates</h2>
        <div className="settings-tabs" role="tablist" aria-label="Settings sections">{settingsTabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`settings-tab-${tab.id}`} aria-selected={settingsTab === tab.id} aria-controls={`settings-panel-${tab.id}`} className={`settings-tab ${settingsTab === tab.id ? 'active' : ''}`} onClick={() => setSettingsTab(tab.id)}>{tab.label}</button>)}</div>
        <div className="settings-body">
          <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={settingsTab !== 'general'}>
            <div className="env-config-note"><strong>LLM connection</strong><span className={llmConfigurationReady ? 'env-ready' : 'env-missing'}>{llmConfigurationReady ? 'Endpoint and model detected' : 'Missing VITE_LLM_ENDPOINT or VITE_LLM_MODEL'}</span><code>VITE_LLM_ENDPOINT · VITE_LLM_MODEL</code><small>In local development only, LOCAL_LLM_API_KEY from .env.local is attached to requests. Production builds omit this key and send requests without browser-held credentials.</small></div>
            <label htmlFor="principles">Base refinement principles</label>
            <p className="settings-help">Stable rules applied to every backlog item. Restoring defaults reloads them from <code>src/defaults/instructions/principles.md</code>.</p>
            <textarea className="markdown-template-input" id="principles" name="principles" rows={12} defaultValue={settings.principles} />
            <label htmlFor="instructions">Additional agent instructions <span>Optional</span></label>
            <textarea id="instructions" name="instructions" rows={4} placeholder="Add local instructions for how the agent should refine your backlog…" defaultValue={settings.instructions} />
          </div>
          {(Object.keys(itemTypeLabel) as BacklogItemType[]).map((type) => <div key={type} role="tabpanel" id={`settings-panel-${type}`} aria-labelledby={`settings-tab-${type}`} hidden={settingsTab !== type}>
            <label htmlFor={`type-instructions-${type}`}>{itemTypeLabel[type]} instructions</label>
            <p className="settings-help">Added to the base principles when refining a {itemTypeLabel[type].toLowerCase()}.</p>
            <textarea className="markdown-template-input" id={`type-instructions-${type}`} name={`type-instructions-${type}`} rows={8} defaultValue={settings.typeInstructions[type]} />
            <label htmlFor={`template-${type}`}>{itemTypeLabel[type]} template</label>
            <p className="settings-help">Plain Markdown: headings plus optional &lt;!-- hints --&gt; for the agent, which decides what to fill in. Keep &quot;Assumptions&quot; and &quot;Open questions&quot; sections (one &quot;- [ ] item&quot; per line) to get confirm/reject/resolve buttons.</p>
            <textarea className="markdown-template-input" id={`template-${type}`} name={`template-${type}`} rows={14} defaultValue={settings.templates[type]} />
          </div>)}
        </div>
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => { if (!window.confirm('Restore ALL instructions and templates to the source defaults? Your customizations will be lost.')) return; void settingsRepository.restoreDefaults().then(setSettings).then(() => { setShowSettings(false); setNotice('Instructions and templates restored to source defaults.'); }).catch((cause: unknown) => setError(`Could not restore defaults: ${errorText(cause)}`)); }}>Restore source defaults</button><button className="button button-primary" type="submit">Save customization</button></div>
      </form></div>}
    </div>
  );
}

function TreeItem({ item, allItems, relationships, selectedId, onSelect, onAddChild, depth = 0 }: {
  item: BacklogItem; allItems: BacklogItem[]; relationships: BacklogRelationship[]; selectedId?: string;
  onSelect: (id: string) => void; onAddChild: (id: string) => void; depth?: number;
}) {
  const children = relationships.filter((relationship) => relationship.type === 'parent-child' && relationship.sourceId === item.id).map((relationship) => allItems.find((candidate) => candidate.id === relationship.targetId)).filter((candidate): candidate is BacklogItem => Boolean(candidate));
  const [expanded, setExpanded] = useState(true);
  return <div className="tree-node"><div className={`tree-row ${selectedId === item.id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth * 17 }}><button className="tree-expand" disabled={!children.length} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.title}`} onClick={() => setExpanded((value) => !value)}><span className={`tree-chevron ${children.length && expanded ? 'expanded' : ''}`}>{children.length ? '›' : ''}</span></button><button className="tree-select" onClick={() => onSelect(item.id)} aria-current={selectedId === item.id ? 'page' : undefined}><span className={`tree-type tree-type-${item.type}`}>{typeShort[item.type]}</span><span className="tree-title">{item.title}</span><span className={`tree-status tree-status-${item.status}`} aria-label={statusText(item.status)} /></button><button className="tree-add" aria-label={`Add child to ${item.title}`} onClick={() => onAddChild(item.id)}>+</button></div>{children.length > 0 && expanded && <div className="tree-children">{children.map((child) => <TreeItem key={child.id} item={child} allItems={allItems} relationships={relationships} selectedId={selectedId} onSelect={onSelect} onAddChild={onAddChild} depth={depth + 1} />)}</div>}</div>;
}

const settingsTabs: { id: 'general' | BacklogItemType; label: string }[] = [
  { id: 'general', label: 'General' },
  ...(Object.keys(itemTypeLabel) as BacklogItemType[]).map((type) => ({ id: type, label: itemTypeLabel[type] })),
];

function statusText(status: BacklogItem['status']): string {
  return ({ draft: 'Draft', refining: 'Refining', ready: 'Ready', 'ready-with-open-questions': 'Ready · questions', complete: 'Complete' })[status];
}

function formatTime(date: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}

function downloadFile(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}
