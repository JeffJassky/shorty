export const fmtNumber = (n: number): string => new Intl.NumberFormat('en-US').format(n);

export function hostAndPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    const path = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    return { host: u.host.replace(/^www\./, ''), path };
  } catch {
    return { host: url, path: '' };
  }
}

export function hostOf(url: string): string {
  return hostAndPath(url).host;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in the viewer's local calendar. */
export function dateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** ISO → value for `<input type="datetime-local">`. */
export function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${dateOnly(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Common prefix/suffix diff — enough to highlight what changed in a URL. */
export function diffMiddle(a: string, b: string): { head: string; aMid: string; bMid: string; tail: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { head: a.slice(0, i), aMid: a.slice(i, a.length - j), bMid: b.slice(i, b.length - j), tail: a.slice(a.length - j) };
}

/** Case/whitespace/punctuation-insensitive form, for the near-duplicate lint. */
export const looseKey = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
