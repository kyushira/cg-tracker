// Local-time display helpers (the floor reads local time; CSV uses UTC ISO).

const pad = (n: number) => String(n).padStart(2, '0');

export function clock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

/** epoch ms -> value for <input type="datetime-local"> (local time). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** <input type="datetime-local"> value -> epoch ms, or null if invalid. */
export function fromLocalInput(v: string): number | null {
  const t = new Date(v).getTime(); // no zone suffix = local time
  return Number.isFinite(t) ? t : null;
}

export function fileStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
