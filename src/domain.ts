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
export const CG_PATTERN = /^\d{4}$/;
export const DEFAULT_AGING_HOURS = 24;
export const AGING_WARN_RATIO = 0.75;

/** Standard ops chips, in display order. Anything else is a free-text "Others" entry. */
export const STANDARD_OPS = ['10', '20', '30', '60', '70', '80'] as const;
export const OPS_OTHER_MAX = 20;

export type McType = 'big' | 'small' | 'open';
export const MC_TYPES: McType[] = ['big', 'small', 'open'];
export const MC_LABEL: Record<McType, string> = { big: 'Big MC', small: 'Small MC', open: 'Open MC' };

export interface Scan {
  id: string;
  cg: string; // CG key = last 4 digits, used for matching and display
  rawCode: string; // full code as entered/scanned (e.g. 80001234821, or 4821 if typed)
  at: number; // epoch ms
  ops: string[]; // e.g. ['10', '30'] or ['10', 'Rework']
  mc: McType | '';
  slot?: string; // staging slot the cart went into, e.g. 'A5' (set by staging.ts)
}

export type ArchiveMark = 'staged' | 'dispatched';

/** Staging rows on the floor. */
export type Row = 'A' | 'B';

/** Adjacent staging slots reserved for one CG, always in one row: row+start .. row+(start+size-1). */
export interface Block {
  row: Row;
  start: number; // 1-based slot number
  size: number;
}

export interface CgMeta {
  expected?: number;
  mark?: ArchiveMark;
  markAt?: number;
  block?: Block; // staging slots (see staging.ts); missing on data saved before the staging map
}

/** Sticky receive form: stays selected between scans. */
export interface Sticky {
  ops: string[]; // selected standard ops codes
  otherOn: boolean; // "Others" chip selected
  otherText: string; // its free text
  mc: McType | '';
}

export interface Settings extends Sticky {
  agingHours: number;
  slotsPerRow?: number; // staging slots per row; default in staging.ts
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

export type WarningKind = 'over' | 'recent';
export interface ScanWarning {
  kind: WarningKind;
  message: string;
}

export function emptyData(): AppData {
  return {
    version: 1,
    scans: [],
    meta: {},
    settings: { agingHours: DEFAULT_AGING_HOURS, ops: [], otherOn: false, otherText: '', mc: '' },
  };
}

/** The ops list a scan records for the current sticky selection, standard codes in display order. */
export function opsFromSticky(s: Pick<Sticky, 'ops' | 'otherOn' | 'otherText'>): string[] {
  const std = STANDARD_OPS.filter((o) => s.ops.includes(o));
  if (!s.otherOn) return [...std];
  const other = s.otherText.trim().slice(0, OPS_OTHER_MAX) || 'Others';
  return [...std, other];
}

export function cleanOps(ops: unknown): string[] {
  if (!Array.isArray(ops)) return [];
  const out: string[] = [];
  for (const o of ops) {
    const v = typeof o === 'string' ? o.trim().slice(0, OPS_OTHER_MAX) : '';
    if (v && !out.includes(v)) out.push(v);
  }
  // standard codes first, in display order; free text after
  const std = STANDARD_OPS.filter((o) => out.includes(o));
  return [...std, ...out.filter((o) => !(STANDARD_OPS as readonly string[]).includes(o))];
}

export function cleanMc(mc: unknown): McType | '' {
  return MC_TYPES.includes(mc as McType) ? (mc as McType) : '';
}

export function opsText(ops: string[]): string {
  return ops.join(';');
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

/** A CG key (what the team calls a CG): exactly 4 digits. */
export function isValidCg(cg: string): boolean {
  return CG_PATTERN.test(cg);
}

export const BARCODE_PREFIX = '8000';
const BARCODE_PATTERN = /^8000\d+$/;

export interface ParsedCg {
  cg: string; // the CG key: last 4 digits ('' if input was empty)
  rawCode: string; // what was entered after noise trimming (full barcode when scanned)
  error: string | null;
}

/**
 * Normalize scanner/hand input into a CG key.
 * Accepted: exactly 4 digits (typed), or a scanned barcode "8000" + more digits
 * (longer than 4). The key is the last 4 digits, so a typed 4821 and a scanned
 * 80001234821 are the same CG.
 */
export function parseCg(raw: string): ParsedCg {
  const code = normalizeCg(raw);
  if (!code) return { cg: '', rawCode: '', error: null }; // empty Enter: ignore quietly
  if (CG_PATTERN.test(code)) return { cg: code, rawCode: code, error: null };
  if (BARCODE_PATTERN.test(code)) return { cg: code.slice(-4), rawCode: code, error: null };
  return {
    cg: '',
    rawCode: code,
    error: `"${code.slice(0, 24)}" is not a CG. Type the 4-digit CG or scan the full ${BARCODE_PREFIX}… barcode.`,
  };
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
  const p = parseCg(query);
  // A pasted/scanned full barcode searches by its CG key; otherwise substring.
  const q = !p.error && p.cg ? p.cg : normalizeCg(query);
  if (!q) return [];
  return list
    .filter((s) => s.cg.includes(q) || s.scans.some((x) => x.rawCode.includes(q)))
    .sort((a, b) => Number(b.cg === q) - Number(a.cg === q) || b.lastAt - a.lastAt);
}

// ---------------------------------------------------------------- checks

/** Reasons to ask "are you sure?" before recording a scan. Empty = just save it. */
export function checkScan(data: AppData, cg: string, now: number): ScanWarning[] {
  const warnings: ScanWarning[] = [];
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
  ops?: string[];
  mc?: McType | '';
}

function parseOrThrow(input: string): ParsedCg {
  const p = parseCg(input);
  if (p.error || !p.cg) throw new Error(`invalid CG "${p.rawCode}"`);
  return p;
}

/**
 * Records one cart. `input.cg` may be a typed 4-digit CG or a full scanned
 * 8000… barcode; the scan is keyed by the last 4 digits and keeps the full
 * code as rawCode. Throws on anything else (the UI checks first).
 */
export function addScan(data: AppData, input: ScanInput, now: number, id: string): AppData {
  const { cg, rawCode } = parseOrThrow(input.cg);
  return {
    ...data,
    scans: [...data.scans, { id, cg, rawCode, at: now, ops: cleanOps(input.ops ?? []), mc: cleanMc(input.mc) }],
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
  patch: Partial<Pick<Scan, 'cg' | 'ops' | 'mc' | 'at'>>,
): AppData {
  return {
    ...data,
    scans: data.scans.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...patch };
      if (patch.cg !== undefined) {
        const p = parseOrThrow(patch.cg);
        next.cg = p.cg;
        next.rawCode = p.rawCode;
      }
      if (patch.ops !== undefined) next.ops = cleanOps(patch.ops);
      if (patch.mc !== undefined) next.mc = cleanMc(patch.mc);
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

export function setSticky(data: AppData, patch: Partial<Sticky>): AppData {
  const s = { ...data.settings, ...patch };
  return {
    ...data,
    settings: {
      ...s,
      ops: STANDARD_OPS.filter((o) => s.ops.includes(o)),
      otherText: s.otherText.slice(0, OPS_OTHER_MAX),
      mc: cleanMc(s.mc),
    },
  };
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
  'raw_code',
  'slot',
  'ops',
  'mc_type',
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
          scan.rawCode,
          scan.slot ?? '',
          opsText(scan.ops),
          scan.mc ? MC_LABEL[scan.mc] : '',
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
