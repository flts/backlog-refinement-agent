import { useRef } from 'react';

/** Keeps the latest value in a ref, for callbacks that must not retrigger effects. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
