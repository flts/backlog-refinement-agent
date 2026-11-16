import { useState } from 'react';
import { useModalDialog } from '../app/useModalDialog';

/** Asks for a name, then creates the project. Stays open (with the name kept) when creation fails. */
export function NewProjectDialog({ onCreate, onClose }: { onCreate: (name: string) => Promise<boolean>; onClose: () => void }) {
  const dialog = useModalDialog(onClose);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    const created = await onCreate(name.trim());
    setPending(false);
    if (created) onClose();
  }

  return <dialog className="modal-dialog" aria-labelledby="new-project-title" {...dialog}>
    <form className="modal" onSubmit={(event) => { event.preventDefault(); if (name.trim() && !pending) void submit(); }}>
      <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Close new project dialog"><span aria-hidden="true">×</span></button>
      <span className="eyebrow">New project</span><h2 id="new-project-title">Name your project</h2>
      <label htmlFor="new-project-name">Project name</label>
      <input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} autoFocus autoComplete="off" />
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="button button-primary" disabled={pending || !name.trim()}>Create project</button>
      </div>
    </form>
  </dialog>;
}
