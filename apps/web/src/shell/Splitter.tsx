import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { resizeStep } from './layout';

export interface SplitterProps {
  label: string;
  /** Current width of the panel this separator resizes, and its limits. */
  value: number;
  min: number;
  max: number;
  /** Which side of the separator the resized panel is on: dragging right grows a `start` panel and shrinks an `end` panel. */
  side: 'start' | 'end';
  controls?: string;
  onChange: (value: number) => void;
  onReset: () => void;
  className?: string;
}

/**
 * A vertical window splitter (WAI-ARIA `separator`, focusable). Arrow keys move the separator by 16 px in that direction,
 * Home/End set the smallest/largest width, Enter and double-click restore the default. Dragging uses pointer capture.
 */
export function Splitter({ label, value, min, max, side, controls, onChange, onReset, className = '' }: SplitterProps) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const direction = side === 'start' ? 1 : -1;

  function onKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const handled = () => event.preventDefault();
    switch (event.key) {
      case 'ArrowLeft': handled(); onChange(value - direction * resizeStep); break;
      case 'ArrowRight': handled(); onChange(value + direction * resizeStep); break;
      case 'Home': handled(); onChange(min); break;
      case 'End': handled(); onChange(max); break;
      case 'Enter': handled(); onReset(); break;
      default: break;
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, start: value };
    document.body.classList.add('is-resizing');
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    document.body.classList.remove('is-resizing');
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
    aria-controls={controls} tabIndex={0} className={`splitter ${className}`}
    onKeyDown={onKeyDown} onDoubleClick={onReset} onPointerDown={onPointerDown} onPointerUp={end} onPointerCancel={end}
    onPointerMove={(event) => { if (drag.current) onChange(drag.current.start + direction * (event.clientX - drag.current.x)); }}>
    <span aria-hidden="true" />
  </div>;
}
