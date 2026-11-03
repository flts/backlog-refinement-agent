import type { BacklogItem, BacklogItemType } from '../domain/backlog-item';

export const itemTypeLabel: Record<BacklogItemType, string> = {
  capability: 'Capability', feature: 'Feature', 'user-story': 'User story', enabler: 'Enabler',
};
export const itemTypes = Object.keys(itemTypeLabel) as BacklogItemType[];
export const typeShort: Record<BacklogItemType, string> = {
  capability: 'CAP', feature: 'FEA', 'user-story': 'STO', enabler: 'ENA',
};

export function statusText(status: BacklogItem['status']): string {
  return ({ draft: 'Draft', refining: 'Refining', ready: 'Ready', 'ready-with-open-questions': 'Ready · questions', complete: 'Complete' })[status];
}

export function formatTime(date: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}
