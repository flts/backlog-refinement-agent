import type { ReactNode } from 'react';

export function LoadingScreen({ message }: { message: string }) {
  return <main className="loading-screen" aria-busy="true"><span className="brand-mark" aria-hidden="true">b.</span><h1 className="sr-only">Backlog Studio</h1><p role="status">{message}</p></main>;
}

export function ErrorScreen({ title, message, actionLabel = 'Try again', onAction, children }: {
  title: string; message: string; actionLabel?: string; onAction?: () => void; children?: ReactNode;
}) {
  return <main className="loading-screen error-screen">
    <span className="brand-mark" aria-hidden="true">b.</span>
    <h1>{title}</h1>
    <p role="alert">{message}</p>
    {children}
    {onAction && <button type="button" className="button button-primary" onClick={onAction}>{actionLabel}</button>}
  </main>;
}
