import { useEffect, useState } from 'react';
import { remoteChangeText, type RemoteItemChange } from './useProjectEvents';

const visibleMs = 10_000;

/** Polite live-region announcement ("Updated by Anna via agent") that stays visible for a few seconds. */
export function RemoteChangeNotice({ change }: { change?: RemoteItemChange & { key: number } }) {
  const [shown, setShown] = useState<string>();
  useEffect(() => {
    if (!change) return;
    setShown(remoteChangeText(change));
    const timer = setTimeout(() => setShown(undefined), visibleMs);
    return () => clearTimeout(timer);
  }, [change]);
  return <p className={`remote-change ${shown ? 'visible' : ''}`} role="status" aria-live="polite">{shown}</p>;
}
