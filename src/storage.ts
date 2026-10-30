// Persistence adapter. The UI talks to a DataStore, never to localStorage
// directly, so a Supabase-backed store (or a local store + sync queue) can be
// dropped in later with the same interface.

import { cleanMc, cleanOps, emptyData, STANDARD_OPS, type AppData, type Scan, type Settings } from './domain';

export interface DataStore {
  load(): AppData;
  save(data: AppData): void;
  clear(): void;
}

/**
 * Storage key is namespaced by the page path. Branch previews are served from
 * the same origin as production (https://<user>.github.io/cg-tracker/preview/<b>/),
 * so without this a preview would read and overwrite the live floor data.
 * This prevents accidents only; it is not a security boundary (same origin).
 */
export function storageKey(pathname: string): string {
  const dir = pathname.replace(/[^/]*$/, ''); // drop "index.html" if present
  return `cg-tracker:v1:${dir}`;
}

function isAppData(x: unknown): x is AppData {
  const d = x as AppData;
  return !!d && d.version === 1 && Array.isArray(d.scans) && !!d.settings && typeof d.settings === 'object';
}

function isScan(x: unknown): x is Scan {
  const s = x as Scan;
  return !!s && typeof s.id === 'string' && typeof s.cg === 'string' && s.cg !== '' && Number.isFinite(s.at);
}

export function parseData(raw: string | null): AppData {
  if (!raw) return emptyData();
  const parsed: unknown = JSON.parse(raw);
  if (!isAppData(parsed)) throw new Error('Saved data has an unknown format');
  const base = emptyData();
  // One malformed row must not crash the whole app: drop it (LocalStore keeps
  // a backup of the raw data when anything was dropped).
  // Round 1 saved truck/door instead of ops/MC type; those fields are simply
  // dropped (test data only) and missing ops/mc default to empty.
  const scans: Scan[] = parsed.scans
    .filter(isScan)
    .map((s) => ({ id: s.id, cg: s.cg, at: s.at, ops: cleanOps(s.ops), mc: cleanMc(s.mc) }));
  const ps = parsed.settings as Partial<Settings>;
  const settings: Settings = {
    agingHours: Number.isFinite(ps.agingHours) && ps.agingHours! > 0 ? ps.agingHours! : base.settings.agingHours,
    ops: cleanOps(ps.ops).filter((o) => (STANDARD_OPS as readonly string[]).includes(o)),
    otherOn: ps.otherOn === true,
    otherText: typeof ps.otherText === 'string' ? ps.otherText.slice(0, 20) : '',
    mc: cleanMc(ps.mc),
  };
  const meta = parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : {};
  return { version: 1, scans, meta, settings };
}

export class LocalStore implements DataStore {
  constructor(
    private key: string,
    private ls: Storage = window.localStorage,
  ) {}

  load(): AppData {
    const raw = this.ls.getItem(this.key);
    try {
      const data = parseData(raw);
      const rawCount = raw ? (JSON.parse(raw) as AppData).scans.length : 0;
      if (raw && data.scans.length !== rawCount) {
        this.ls.setItem(`${this.key}:dropped:${Date.now()}`, raw);
        console.error(`cg-tracker: dropped ${rawCount - data.scans.length} unreadable scan(s); raw data backed up`);
      }
      return data;
    } catch (e) {
      // Never silently overwrite data we can't read: park it under a backup key.
      if (raw) {
        this.ls.setItem(`${this.key}:corrupt:${Date.now()}`, raw);
        this.ls.removeItem(this.key); // back up once, not on every load
      }
      console.error('cg-tracker: could not read saved data, started empty', e);
      return emptyData();
    }
  }

  save(data: AppData): void {
    this.ls.setItem(this.key, JSON.stringify(data));
  }

  clear(): void {
    this.ls.removeItem(this.key);
  }
}

export class MemoryStore implements DataStore {
  private raw: string | null = null;
  load(): AppData {
    return parseData(this.raw);
  }
  save(data: AppData): void {
    this.raw = JSON.stringify(data);
  }
  clear(): void {
    this.raw = null;
  }
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
