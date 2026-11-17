import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';

/** Opens a native <dialog> modally, closes on Escape/backdrop click and restores focus on unmount. */
export function useModalDialog(onClose: () => void, canClose: () => boolean = () => true) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (dialog && !dialog.open) dialog.showModal();
    // Browsers focus the first focusable control (or [autofocus]) themselves; make that explicit so it also holds where showModal does not.
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>('[autofocus], input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex="0"]')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return {
    ref,
    onCancel: (event: SyntheticEvent<HTMLDialogElement>) => { event.preventDefault(); if (canClose()) onClose(); },
    // Handling Escape on keydown suppresses the native cancel event and also works where it is not implemented.
    onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (canClose()) onClose();
    },
    onMouseDown: (event: MouseEvent<HTMLDialogElement>) => { if (event.target === event.currentTarget && canClose()) onClose(); },
  };
}
