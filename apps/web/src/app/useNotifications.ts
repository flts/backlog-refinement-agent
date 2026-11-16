import { useState } from 'react';
import { logError } from '../infrastructure/logging';

export function errorText(cause: unknown): string {
  logError('Operation failed', cause);
  return cause instanceof Error ? cause.message : 'Unexpected error';
}

export function useNotifications() {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return { error, notice, setError, setNotice, clear: () => { setError(''); setNotice(''); } };
}

export type Notifications = ReturnType<typeof useNotifications>;
