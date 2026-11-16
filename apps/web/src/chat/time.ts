const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400], ['hour', 3_600], ['minute', 60]];

/** "just now", "5 minutes ago", "yesterday"; older than a week falls back to a short date. */
export function relativeTime(value: string, now = Date.now()): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds >= 7 * 86_400) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(then);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (seconds >= size) return formatter.format(-Math.floor(seconds / size), unit);
  return formatter.format(-1, 'minute');
}

/** "12 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}
