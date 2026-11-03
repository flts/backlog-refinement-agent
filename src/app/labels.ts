import type { BacklogItemType } from '../domain/backlog-item';

export const itemTypeLabel: Record<BacklogItemType, string> = {
  capability: 'Capability', feature: 'Feature', 'user-story': 'User story', enabler: 'Enabler',
};
export const itemTypes = Object.keys(itemTypeLabel) as BacklogItemType[];
