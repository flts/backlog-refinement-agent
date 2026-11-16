import { useMembers, type Project } from '../api';
import { errorText } from '../app/useNotifications';

export function MembersSection({ project, isOwner, onOpenShare }: { project: Project; isOwner: boolean; onOpenShare?: () => void }) {
  const members = useMembers(project.id);
  return <>
    <h3>Members</h3>
    <p className="settings-help">Everyone listed here has access to this project. Owners manage access, contributors work on the backlog.</p>
    {members.isLoading && <p role="status">Loading members…</p>}
    {members.isError && <p className="field-error" role="alert">Members could not be loaded: {errorText(members.error)}</p>}
    {members.data && <ul className="member-list" aria-label="Project members">
      {members.data.map((member) => <li key={member.email}>
        <span className="member-name">{member.name || member.email}{member.name && <span className="member-email">{member.email}</span>}</span>
        <span className="badge">{member.role === 'owner' ? 'Owner' : 'Contributor'}</span>
        {!member.signedIn && <span className="badge">Not signed in yet</span>}
      </li>)}
    </ul>}
    {isOwner
      ? onOpenShare && <p><button type="button" className="button button-secondary button-small" onClick={onOpenShare}>Manage members</button></p>
      : <p className="settings-help">Only project owners can add or remove members.</p>}
  </>;
}
