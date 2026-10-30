// Persistence adapter. The UI talks to a DataStore, never to localStorage
// directly, so a Supabase-backed store (or a local store + sync queue) can be
// dropped in later with the same interface.

import { emptyData, type AppData } from './domain';

export interface DataStore {
  load(): AppData;
  save(data: AppData): void;
  clear(): void;
}

/**
 * Storage key is namespaced by the page path. Branch previews are served from
 * the same origin as production (https://<user>.github.io/cg-tracker/preview/<b>/),
 * so without this a preview would read and overwrite the live floor data.
 */
export function storageKey(pathname: string): string {
  const dir = pathname.replace(/[^/]*$/, ''); // drop "index.html" if present
  return `cg-tracker:v1:${dir}`;
}

function isAppData(x: unknown): x is AppData {
  const d = x as AppData;
  return !!d && d.version === 1 && Array.isArray(d.scans) && !!d.meta && typeof d.meta === 'object' && !!d.settings && typeof d.settings === 'object';
}

export function parseData(raw: string | null): AppData {
  if (!raw) return emptyData();
  const parsed: unknown = JSON.parse(raw);
  if (!isAppData(parsed)) throw new Error('Saved data has an unknown format');
  const base = emptyData();
  return { ...base, ...parsed, settings: { ...base.settings, ...parsed.settings } };
}

export class LocalStore implements DataStore {
  constructor(
    private key: string,
    private ls: Storage = window.localStorage,
  ) {}

  load(): AppData {
    const raw = this.ls.getItem(this.key);
    try {
      return parseData(raw);
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
