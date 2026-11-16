import { useState } from 'react';
import { isVersionConflict } from '../api';
import { logError } from '../infrastructure/logging';

export function errorText(cause: unknown): string {
  logError('Operation failed', cause);
  return cause instanceof Error ? cause.message : 'Unexpected error';
}

export interface NotificationAction { label: string; onClick: () => void }

export function conflictMessage(subject: string): string {
  return `Someone else changed this ${subject}; reload to see their changes.`;
}

export function useNotifications() {
  const [error, setErrorText] = useState('');
  const [notice, setNoticeText] = useState('');
  const [action, setAction] = useState<NotificationAction>();
  const setError = (text: string, next?: NotificationAction) => { setErrorText(text); setAction(next); if (text) setNoticeText(''); };
  const setNotice = (text: string, next?: NotificationAction) => { setNoticeText(text); setAction(next); if (text) setErrorText(''); };
  /** Shows `prefix: reason`; a version conflict (409) becomes the "someone else changed this" notice with a Reload action. */
  const report = (prefix: string, cause: unknown, subject: string, reload?: () => void) => {
    if (isVersionConflict(cause)) {
      logError('Version conflict', cause);
      setError(conflictMessage(subject), reload && { label: 'Reload', onClick: reload });
    } else setError(`${prefix}: ${errorText(cause)}`);
  };
  return { error, notice, action, setError, setNotice, report, clear: () => { setErrorText(''); setNoticeText(''); setAction(undefined); } };
}

export type Notifications = ReturnType<typeof useNotifications>;
