import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bounds, clampWidth, defaultWidths, fitWidths, loadWidths, saveWidths, type FocusTarget, type PanelId, type Widths } from './layout';

/** The shortcut is Ctrl+. or ⌘. */
export const focusShortcut = { key: '.', label: 'Ctrl+.' };

/**
 * State of the three-panel workspace: panel widths (persisted in localStorage `layout-widths`) and focus mode, which shows
 * only the chat or only the document panel. `toggleFocus` focuses the panel the user last worked in (chat by default).
 */
export function useWorkspaceLayout() {
  const [stored, setStored] = useState<Widths>(loadWidths);
  const [containerWidth, setContainerWidth] = useState(0);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const lastPanel = useRef<FocusTarget>('chat');
  const observer = useRef<ResizeObserver>(undefined);

  const gridRef = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    container.current = node;
    if (!node) return;
    setContainerWidth(node.clientWidth);
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(() => setContainerWidth(node.clientWidth));
      observer.current.observe(node);
    }
  }, []);

  useEffect(() => {
    const onResize = () => { if (container.current) setContainerWidth(container.current.clientWidth); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => { saveWidths(stored); }, [stored]);

  const widths = fitWidths(stored, containerWidth);

  const setWidth = useCallback((panel: PanelId, value: number) => {
    setStored((current) => {
      const fitted = fitWidths(current, containerWidth);
      return { ...fitted, [panel]: clampWidth(panel, value, fitted, containerWidth) };
    });
  }, [containerWidth]);

  const resetWidth = useCallback((panel: PanelId) => setStored((current) => ({ ...current, [panel]: defaultWidths[panel] })), []);

  const toggleFocus = useCallback(() => setFocus((current) => current ? null : lastPanel.current), []);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === focusShortcut.key) {
        event.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleFocus]);

  /** Remember which panel has the keyboard focus (focusin on the grid). */
  const trackFocus = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    if (target.closest('.preview-column')) lastPanel.current = 'document';
    else if (target.closest('.refinement-column')) lastPanel.current = 'chat';
  }, []);

  return { widths, limits: bounds, containerWidth, setWidth, resetWidth, focus, setFocus, toggleFocus, gridRef, trackFocus };
}

export type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;
