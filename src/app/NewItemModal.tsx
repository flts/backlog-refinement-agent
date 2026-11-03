import React from 'react';
import type { BacklogItemType } from '../domain/backlog-item';
import { itemTypeLabel } from './labels';

type Props = {
  type: BacklogItemType;
  title: string;
  onTypeChange: (type: BacklogItemType) => void;
  onTitleChange: (title: string) => void;
  onSubmit: () => void;
  onClose: () => void;
};

export function NewItemModal({ type, title, onTypeChange, onTitleChange, onSubmit, onClose }: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <button type="button" className="close-button modal-close" onClick={onClose} aria-label="Close">×</button>
        <span className="eyebrow">NEW BACKLOG ITEM</span><h2>What are we shaping?</h2>
        <p>Start with the item type and a working title. You can refine it as you go.</p>
        <label htmlFor="new-type">Item type</label>
        <select id="new-type" value={type} onChange={(event) => onTypeChange(event.target.value as BacklogItemType)}>{Object.entries(itemTypeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
        <label htmlFor="new-title">Working title <span>Optional</span></label>
        <input id="new-title" value={title} onChange={(event) => onTitleChange(event.target.value)} placeholder={`Untitled ${itemTypeLabel[type]}`} autoFocus />
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit">Create and refine <span>→</span></button></div>
      </form>
    </div>
  );
}
