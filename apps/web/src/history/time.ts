const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];

/** "2 hours ago", "yesterday", "just now". Pair it with `formatAbsolute` in a tooltip. */
export function formatRelative(date: string, now = Date.now()): string {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  const distance = Math.abs(seconds);
  if (distance < 45) return 'just now';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (distance >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(Math.round(seconds / 60), 'minute');
}

export function formatAbsolute(date: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
}
