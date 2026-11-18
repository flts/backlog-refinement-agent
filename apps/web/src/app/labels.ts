import type { ItemStatus, ItemType } from '../api';

export const itemTypeLabel: Record<ItemType, string> = {
  capability: 'Capability', feature: 'Feature', 'user-story': 'User story', enabler: 'Enabler',
};
export const itemTypes = Object.keys(itemTypeLabel) as ItemType[];
export const typeShort: Record<ItemType, string> = {
  capability: 'Cap', feature: 'Feat', 'user-story': 'Story', enabler: 'Enabler',
};

export function statusText(status: ItemStatus): string {
  return ({ draft: 'Draft', refining: 'Refining', ready: 'Ready', 'ready-with-open-questions': 'Ready · questions', complete: 'Complete' })[status];
}

export function formatTime(date: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}
