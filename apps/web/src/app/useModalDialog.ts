import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';

/** Opens a native <dialog> modally, closes on Escape/backdrop click and restores focus on unmount. */
export function useModalDialog(onClose: () => void, canClose: () => boolean = () => true) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (dialog && !dialog.open) dialog.showModal();
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
