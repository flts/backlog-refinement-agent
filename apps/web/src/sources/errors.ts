import { ApiError } from '../api';

const number = (value: unknown) => typeof value === 'number' ? value.toLocaleString() : '?';

export function sourceErrorText(cause: unknown): string {
  if (cause instanceof ApiError && cause.slug === 'pinned-budget-exceeded') {
    const { used, limit, required } = cause.extensions;
    return `Not enough pinned budget: ${number(used)} of ${number(limit)} characters are already pinned and this source needs ${number(required)}. Unpin another source or keep this one searchable.`;
  }
  if (cause instanceof ApiError && cause.slug === 'version-conflict') return 'Someone else changed this source. The list was refreshed; try again.';
  return cause instanceof Error ? cause.message : 'Unexpected error';
}
