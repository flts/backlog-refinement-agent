import { useEffect, useRef } from 'react';

/** Window CustomEvents that connect the palette (and the context bar) with components that own their own state. */
export const PALETTE_EVENTS = {
  /** Dispatched by the shell's ⌘K trigger; opens the palette. */
  open: 'shell:open-palette',
  /** `detail?: { type?: ItemType; parentId?: string }` — opens the New item dialog. */
  newItem: 'palette:new-item',
  /** Opens the Sources drawer. */
  openSources: 'palette:open-sources',
  /** `detail?: { section?: string }` — opens the project settings (optionally on a section such as an item type). */
  openSettings: 'palette:open-settings',
  /** Opens the Share / members dialog. */
  share: 'palette:share',
} as const;

export type PaletteEventName = (typeof PALETTE_EVENTS)[keyof typeof PALETTE_EVENTS];

export function emitPaletteEvent<Detail = undefined>(name: PaletteEventName, detail?: Detail): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Subscribes to a palette event for the lifetime of the component; the handler may change between renders. */
export function usePaletteEvent<Detail = undefined>(name: PaletteEventName, handler: (detail: Detail | undefined) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (event: Event) => ref.current((event as CustomEvent<Detail>).detail);
    window.addEventListener(name, listener);
    return () => window.removeEventListener(name, listener);
  }, [name]);
}
