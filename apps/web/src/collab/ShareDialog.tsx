import { useId, useState } from 'react';
import { ApiError, useAddMember, useLeaveProject, useMembers, useRemoveMember, useUpdateMember, type Member, type MemberRole, type Project } from '../api';
import { useAuth } from '../auth';
import { useModalDialog } from '../app/useModalDialog';
import { errorText } from '../app/useNotifications';
import { Avatar } from './PresenceAvatars';
import { normalizeEmail } from './people';

const roleLabel: Record<MemberRole, string> = { owner: 'Owner', contributor: 'Contributor' };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lastOwnerText = 'A project needs at least one owner. Make someone else an owner first.';

function failureText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.slug === 'last-owner') return lastOwnerText;
    if (cause.slug === 'already-member') return 'This email address is already a member of the project.';
    if (cause.status === 403) return 'Only owners can change who has access to the project.';
  }
  return errorText(cause);
}

export interface ShareDialogProps {
  project: Pick<Project, 'id' | 'name' | 'role'>;
  onClose: () => void;
  /** The signed-in user left the project (the project is gone from their list). */
  onLeft?: () => void;
  /** Reports a success for a status message outside the dialog. */
  onNotice?: (text: string) => void;
}

/**
 * Members of a project. Owners add people by email (access is immediate, no invitation), change roles and remove members.
 * Contributors see a read-only list and can leave. The last owner cannot be demoted, removed or leave.
 */
export function ShareDialog({ project, onClose, onLeft, onNotice }: ShareDialogProps) {
  const { user } = useAuth();
  const self = normalizeEmail(user.email);
  const dialog = useModalDialog(onClose);
  const titleId = useId();
  const emailId = useId();
  const hintId = useId();
  const membersQuery = useMembers(project.id);
  const members = membersQuery.data ?? [];
  const addMember = useAddMember(project.id);
  const updateMember = useUpdateMember(project.id);
  const removeMember = useRemoveMember(project.id);
  const leaveProject = useLeaveProject();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('contributor');
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string }>();
  const [fieldError, setFieldError] = useState('');

  const isOwner = project.role === 'owner';
  const owners = members.filter((member) => member.role === 'owner');
  const busy = [addMember, updateMember, removeMember, leaveProject].some((mutation) => mutation.isPending);
  const isLastOwner = (member: Member) => member.role === 'owner' && owners.length <= 1;

  async function run(action: () => Promise<unknown>, success: string) {
    setMessage(undefined);
    try { await action(); setMessage({ kind: 'ok', text: success }); onNotice?.(success); return true; }
    catch (cause) { setMessage({ kind: 'error', text: failureText(cause) }); return false; }
  }

  async function submit() {
    const value = email.trim();
    if (!emailPattern.test(value)) { setFieldError('Enter a complete email address, for example anna@example.com.'); return; }
    if (members.some((member) => normalizeEmail(member.email) === normalizeEmail(value))) { setFieldError('This email address is already a member of the project.'); return; }
    setFieldError('');
    if (await run(() => addMember.mutateAsync({ email: value, role }), `${value} now has access as ${roleLabel[role].toLowerCase()}.`)) setEmail('');
  }

  async function leave() {
    if (!window.confirm(`Leave “${project.name}”? You will lose access to it.`)) return;
    setMessage(undefined);
    try { await leaveProject.mutateAsync({ projectId: project.id, email: user.email }); onNotice?.('You left the project.'); onLeft?.(); onClose(); }
    catch (cause) { setMessage({ kind: 'error', text: failureText(cause) }); }
  }

  return <dialog className="modal-dialog share-dialog" aria-labelledby={titleId} {...dialog}>
    <div className="modal share-modal" aria-busy={busy}>
      <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Close share dialog"><span aria-hidden="true">×</span></button>
      <span className="eyebrow">Share project</span>
      <h2 id={titleId}>{project.name}</h2>
      <p>{isOwner ? 'People you add have access immediately. Contributors edit items, owners also manage settings and members.' : 'Everyone below can see and edit this project. Only owners can add or remove people.'}</p>

      {isOwner && <form className="share-add" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="share-add-fields">
          <div className="share-email">
            <label htmlFor={emailId}>Add by email address</label>
            <input id={emailId} type="email" autoComplete="off" value={email} placeholder="name@example.com" aria-describedby={hintId} aria-invalid={fieldError ? true : undefined}
              onChange={(event) => { setEmail(event.target.value); setFieldError(''); }} disabled={busy} />
          </div>
          <div className="share-role">
            <label htmlFor={`${emailId}-role`}>Role</label>
            <select id={`${emailId}-role`} value={role} onChange={(event) => setRole(event.target.value as MemberRole)} disabled={busy}>
              {(Object.keys(roleLabel) as MemberRole[]).map((value) => <option key={value} value={value}>{roleLabel[value]}</option>)}
            </select>
          </div>
          <button className="button button-primary" disabled={busy || !email.trim()}>Add</button>
        </div>
        <p id={hintId} className={`share-hint ${fieldError ? 'share-error' : ''}`}>{fieldError || 'They need an account with this email address; they appear by name after their first sign-in.'}</p>
      </form>}

      <h3 className="share-heading">People with access ({members.length})</h3>
      {membersQuery.isLoading && <p role="status">Loading members…</p>}
      {membersQuery.isError && <p role="alert" className="share-error">Could not load the members: {errorText(membersQuery.error)}</p>}
      <ul className="share-members" aria-label="Project members">
        {members.map((member) => {
          const mine = normalizeEmail(member.email) === self;
          const last = isLastOwner(member);
          const explainId = `${emailId}-${member.email}-last`;
          return <li key={member.email} className="share-member">
            <Avatar person={member} />
            <div className="share-person">
              <strong>{member.name?.trim() || member.email}{mine && <span className="share-you"> (you)</span>}</strong>
              {member.name?.trim() && <span>{member.email}</span>}
              {!member.signedIn && !member.name?.trim() && <span className="share-pending">Not signed in yet</span>}
              {last && <span id={explainId} className="share-hint">Last owner: {lastOwnerText}</span>}
            </div>
            {isOwner
              ? <select aria-label={`Role of ${member.email}`} value={member.role} disabled={busy || last} aria-describedby={last ? explainId : undefined}
                  onChange={(event) => { void run(() => updateMember.mutateAsync({ email: member.email, role: event.target.value as MemberRole }), `${member.email} is now ${roleLabel[event.target.value as MemberRole].toLowerCase()}.`); }}>
                  {(Object.keys(roleLabel) as MemberRole[]).map((value) => <option key={value} value={value}>{roleLabel[value]}</option>)}
                </select>
              : <span className="share-role-text">{roleLabel[member.role]}</span>}
            {mine
              ? <button type="button" className="button button-secondary button-small" disabled={busy || last} aria-describedby={last ? explainId : undefined} onClick={() => void leave()}>Leave project</button>
              : isOwner && <button type="button" className="button button-secondary button-small" disabled={busy} aria-label={`Remove ${member.email}`}
                  onClick={() => { if (window.confirm(`Remove ${member.name?.trim() || member.email} from “${project.name}”?`)) void run(() => removeMember.mutateAsync(member.email), `${member.email} was removed.`); }}>Remove</button>}
          </li>;
        })}
      </ul>
      <p className={message?.kind === 'error' ? 'share-error' : 'share-hint'} role={message?.kind === 'error' ? 'alert' : 'status'}>{message?.text}</p>
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Done</button></div>
    </div>
  </dialog>;
}
