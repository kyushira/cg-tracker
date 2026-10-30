// Pure domain logic for the CG Marry-Up Tracker.
//
// Everything here is a pure function over AppData: no React, no storage, no
// clock (callers pass `now`). The persistence layer (storage.ts) and the UI
// only call these, so a Supabase sync adapter can be added later without
// touching the rules.
//
// Model: the source of truth is an append-only-ish list of scans (one per cart
// received) plus small per-CG metadata (expected cart count, staged/dispatched
// mark). CG status is always derived from those, never stored.

export const DEFAULT_EXPECTED = 2;
export const MIN_EXPECTED = 1;
export const MAX_EXPECTED = 9;
export const DUP_WINDOW_MS = 60_000;
export const CG_PREFIX = '8000';
export const DEFAULT_AGING_HOURS = 24;
export const AGING_WARN_RATIO = 0.75;

export interface Scan {
  id: string;
  cg: string;
  at: number; // epoch ms
  truck: string;
  door: string;
}

export type ArchiveMark = 'staged' | 'dispatched';

export interface CgMeta {
  expected?: number;
  mark?: ArchiveMark;
  markAt?: number;
}

export interface Settings {
  agingHours: number;
  truck: string; // sticky between scans
  door: string; // sticky between scans
}

export interface AppData {
  version: 1;
  scans: Scan[]; // in the order they were recorded (undo removes the last one)
  meta: Record<string, CgMeta>;
  settings: Settings;
}

export type CgStatus = 'pending' | 'complete' | 'staged' | 'dispatched';

export interface CgSummary {
  cg: string;
  scans: Scan[]; // sorted by time, oldest first
  count: number;
  expected: number;
  complete: boolean;
  status: CgStatus;
  firstAt: number;
  lastAt: number;
  completedAt: number | null; // time of the scan that reached `expected`
  markAt: number | null;
}

export type WarningKind = 'prefix' | 'over' | 'recent';
export interface ScanWarning {
  kind: WarningKind;
  message: string;
}

export function emptyData(): AppData {
  return {
    version: 1,
    scans: [],
    meta: {},
    settings: { agingHours: DEFAULT_AGING_HOURS, truck: '', door: '' },
  };
}

// ---------------------------------------------------------------- input

/**
 * Clean up whatever a handheld scanner (or a thumb) typed.
 * - drops control characters (STX/ETX/CR/LF/TAB that some scanners wrap codes in)
 * - drops an AIM symbology identifier prefix such as "]C1" or "]Q3"
 * - drops leading/trailing punctuation and all whitespace
 * - upper-cases letters
 */
export function normalizeCg(raw: string): string {
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.trim().replace(/^\][A-Za-z][0-9A-Za-z]/, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '');
  return s.toUpperCase();
}

export function clampExpected(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EXPECTED;
  return Math.min(MAX_EXPECTED, Math.max(MIN_EXPECTED, Math.round(n)));
}

// ---------------------------------------------------------------- derive

export function expectedFor(data: AppData, cg: string): number {
  return clampExpected(data.meta[cg]?.expected ?? DEFAULT_EXPECTED);
}

export function scansFor(data: AppData, cg: string): Scan[] {
  return data.scans.filter((s) => s.cg === cg).sort((a, b) => a.at - b.at);
}

export function summarizeCg(data: AppData, cg: string): CgSummary | null {
  const scans = scansFor(data, cg);
  if (scans.length === 0) return null;
  const expected = expectedFor(data, cg);
  const complete = scans.length >= expected;
  const meta = data.meta[cg];
  const completedAt = complete ? scans[expected - 1].at : null;
  // A mark only counts while the CG is still complete, and only for the
  // completion it was made on: if a scan is deleted and the CG is completed
  // again later, it shows as complete (not silently staged/dispatched).
  const mark =
    completedAt !== null && meta?.mark && (meta.markAt ?? 0) >= completedAt ? meta.mark : undefined;
  return {
    cg,
    scans,
    count: scans.length,
    expected,
    complete,
    status: mark ?? (complete ? 'complete' : 'pending'),
    firstAt: scans[0].at,
    lastAt: scans[scans.length - 1].at,
    completedAt,
    markAt: mark ? (meta?.markAt ?? null) : null,
  };
}

export function summarizeAll(data: AppData): CgSummary[] {
  const cgs = new Set(data.scans.map((s) => s.cg));
  const out: CgSummary[] = [];
  for (const cg of cgs) {
    const s = summarizeCg(data, cg);
    if (s) out.push(s);
  }
  return out;
}

export interface Counts {
  pending: number;
  completed: number; // complete and not yet staged/dispatched
  staged: number;
  dispatched: number;
}

export function countByStatus(list: CgSummary[]): Counts {
  const c: Counts = { pending: 0, completed: 0, staged: 0, dispatched: 0 };
  for (const s of list) {
    if (s.status === 'pending') c.pending++;
    else if (s.status === 'complete') c.completed++;
    else c[s.status]++;
  }
  return c;
}

/** Pending CGs, oldest first. */
export function pendingList(list: CgSummary[]): CgSummary[] {
  return list.filter((s) => s.status === 'pending').sort((a, b) => a.firstAt - b.firstAt);
}

/** Completed CGs matching the filter, most recently completed first. */
export function completedList(
  list: CgSummary[],
  filter: 'active' | ArchiveMark | 'all',
): CgSummary[] {
  return list
    .filter((s) => s.complete)
    .filter((s) =>
      filter === 'all' ? true : filter === 'active' ? s.status === 'complete' : s.status === filter,
    )
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

export type AgingLevel = 'ok' | 'warn' | 'late';

export function agingLevel(firstAt: number, now: number, agingHours: number): AgingLevel {
  const limit = agingHours * 3_600_000;
  if (!(limit > 0)) return 'ok';
  const age = now - firstAt;
  if (age >= limit) return 'late';
  if (age >= limit * AGING_WARN_RATIO) return 'warn';
  return 'ok';
}

/** Case-insensitive substring search over CG numbers, exact match first. */
export function searchCgs(list: CgSummary[], query: string): CgSummary[] {
  const q = normalizeCg(query);
  if (!q) return [];
  return list
    .filter((s) => s.cg.includes(q))
    .sort((a, b) => Number(b.cg === q) - Number(a.cg === q) || b.lastAt - a.lastAt);
}

// ---------------------------------------------------------------- checks

/** Reasons to ask "are you sure?" before recording a scan. Empty = just save it. */
export function checkScan(data: AppData, cg: string, now: number): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  if (!cg.startsWith(CG_PREFIX)) {
    warnings.push({
      kind: 'prefix',
      message: `CG ${cg} does not start with ${CG_PREFIX}. Wrong label scanned?`,
    });
  }
  const scans = scansFor(data, cg);
  const expected = expectedFor(data, cg);
  if (scans.length >= expected) {
    warnings.push({
      kind: 'over',
      message: `CG ${cg} already has ${scans.length} of ${expected} carts. This would be cart ${scans.length + 1}.`,
    });
  }
  const last = scans[scans.length - 1];
  if (last && now - last.at >= 0 && now - last.at < DUP_WINDOW_MS) {
    const secs = Math.max(1, Math.round((now - last.at) / 1000));
    warnings.push({
      kind: 'recent',
      message: `CG ${cg} was scanned ${secs}s ago. Double scan of the same cart?`,
    });
  }
  return warnings;
}

// ---------------------------------------------------------------- updates
// Each returns a new AppData; inputs are never mutated.

export interface ScanInput {
  cg: string;
  truck?: string;
  door?: string;
}

export function addScan(data: AppData, input: ScanInput, now: number, id: string): AppData {
  const cg = normalizeCg(input.cg);
  if (!cg) throw new Error('empty CG');
  const truck = (input.truck ?? '').trim();
  const door = (input.door ?? '').trim();
  return {
    ...data,
    scans: [...data.scans, { id, cg, at: now, truck, door }],
    settings: { ...data.settings, truck, door },
  };
}

export function lastScan(data: AppData): Scan | null {
  return data.scans[data.scans.length - 1] ?? null;
}

export function undoLastScan(data: AppData): AppData {
  if (data.scans.length === 0) return data;
  return { ...data, scans: data.scans.slice(0, -1) };
}

export function updateScan(
  data: AppData,
  id: string,
  patch: Partial<Pick<Scan, 'cg' | 'truck' | 'door' | 'at'>>,
): AppData {
  return {
    ...data,
    scans: data.scans.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...patch };
      if (patch.cg !== undefined) {
        next.cg = normalizeCg(patch.cg);
        if (!next.cg) throw new Error('empty CG');
      }
      if (patch.truck !== undefined) next.truck = patch.truck.trim();
      if (patch.door !== undefined) next.door = patch.door.trim();
      return next;
    }),
  };
}

export function deleteScan(data: AppData, id: string): AppData {
  return { ...data, scans: data.scans.filter((s) => s.id !== id) };
}

export function setExpected(data: AppData, cg: string, n: number): AppData {
  return { ...data, meta: { ...data.meta, [cg]: { ...data.meta[cg], expected: clampExpected(n) } } };
}

export function setMark(data: AppData, cg: string, mark: ArchiveMark | null, now: number): AppData {
  const meta = { ...data.meta[cg] };
  if (mark) {
    meta.mark = mark;
    meta.markAt = now;
  } else {
    delete meta.mark;
    delete meta.markAt;
  }
  return { ...data, meta: { ...data.meta, [cg]: meta } };
}

export function setAgingHours(data: AppData, hours: number): AppData {
  const h = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_AGING_HOURS;
  return { ...data, settings: { ...data.settings, agingHours: h } };
}

export function setSticky(data: AppData, truck: string, door: string): AppData {
  return { ...data, settings: { ...data.settings, truck, door } };
}

// ---------------------------------------------------------------- export

function csvCell(v: string | number): string {
  let s = String(v);
  // Stop spreadsheet apps treating a cell as a formula (CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iso(ms: number | null): string {
  return ms == null ? '' : new Date(ms).toISOString();
}

export const CSV_HEADER = [
  'cg',
  'cart_no',
  'scanned_at_utc',
  'truck',
  'dock_door',
  'cg_carts_received',
  'cg_carts_expected',
  'cg_status',
  'cg_completed_at_utc',
  'cg_marked_at_utc',
];

/** One row per scan, grouped by CG (oldest CG first), carts in time order. */
export function toCsv(data: AppData): string {
  const rows: string[] = [CSV_HEADER.join(',')];
  const list = summarizeAll(data).sort((a, b) => a.firstAt - b.firstAt);
  for (const s of list) {
    s.scans.forEach((scan, i) => {
      rows.push(
        [
          s.cg,
          i + 1,
          iso(scan.at),
          scan.truck,
          scan.door,
          s.count,
          s.expected,
          s.status,
          iso(s.completedAt),
          iso(s.markAt),
        ]
          .map(csvCell)
          .join(','),
      );
    });
  }
  return rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- format

export function formatDuration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
