import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addScan, emptyData, type AppData } from './domain';
import { LocalStore, MemoryStore, parseData, storageKey } from './storage';

// Minimal in-memory Storage for the node environment (no jsdom).
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  keysList(): string[] {
    return [...this.map.keys()];
  }
}

const T0 = 1_700_000_000_000;
const KEY = 'cg-tracker:v1:/cg-tracker/';

function sampleData(): AppData {
  let data = emptyData();
  data = addScan(data, { cg: '8000123', truck: 'T1', door: 'D2' }, T0, 'a1');
  data = addScan(data, { cg: '8000123', truck: 'T1', door: 'D2' }, T0 + 60_000, 'a2');
  return data;
}

// ---------------------------------------------------------------- storageKey

describe('storageKey', () => {
  it('treats a trailing-slash directory and index.html as the same namespace', () => {
    expect(storageKey('/cg-tracker/')).toBe(storageKey('/cg-tracker/index.html'));
  });

  it('gives a branch preview its own namespace', () => {
    expect(storageKey('/cg-tracker/preview/x/')).not.toBe(storageKey('/cg-tracker/'));
  });

  it('gives a preview index.html the preview namespace, not the production one', () => {
    expect(storageKey('/cg-tracker/preview/x/index.html')).toBe(storageKey('/cg-tracker/preview/x/'));
    expect(storageKey('/cg-tracker/preview/x/index.html')).not.toBe(storageKey('/cg-tracker/index.html'));
  });

  it('prefixes every key with the versioned app namespace', () => {
    expect(storageKey('/cg-tracker/')).toBe('cg-tracker:v1:/cg-tracker/');
  });
});

// ---------------------------------------------------------------- parseData

describe('parseData', () => {
  it('returns empty data for null', () => {
    expect(parseData(null)).toEqual(emptyData());
  });

  it('returns empty data for an empty string', () => {
    expect(parseData('')).toEqual(emptyData());
  });

  it('round-trips valid data through JSON', () => {
    const data = sampleData();
    expect(parseData(JSON.stringify(data))).toEqual(data);
  });

  it('fills missing settings fields with defaults', () => {
    const raw = JSON.stringify({ version: 1, scans: [], meta: {}, settings: { truck: 'T9' } });
    expect(parseData(raw).settings).toEqual({ agingHours: 24, truck: 'T9', door: '' });
  });

  it('fills every settings field when settings is an empty object', () => {
    const raw = JSON.stringify({ version: 1, scans: [], meta: {}, settings: {} });
    expect(parseData(raw).settings).toEqual({ agingHours: 24, truck: '', door: '' });
  });

  it('keeps a stored agingHours instead of overwriting it with the default', () => {
    const raw = JSON.stringify({ version: 1, scans: [], meta: {}, settings: { agingHours: 8 } });
    expect(parseData(raw).settings.agingHours).toBe(8);
  });

  it('throws on a version other than 1', () => {
    const raw = JSON.stringify({ version: 2, scans: [], meta: {}, settings: {} });
    expect(() => parseData(raw)).toThrow('unknown format');
  });

  it('throws when scans is not an array', () => {
    const raw = JSON.stringify({ version: 1, scans: {}, meta: {}, settings: {} });
    expect(() => parseData(raw)).toThrow('unknown format');
  });

  it('throws when settings is missing', () => {
    const raw = JSON.stringify({ version: 1, scans: [], meta: {} });
    expect(() => parseData(raw)).toThrow('unknown format');
  });

  it('throws on the JSON literal null', () => {
    expect(() => parseData('null')).toThrow('unknown format');
  });

  it('throws a syntax error on malformed JSON', () => {
    expect(() => parseData('{not json')).toThrow();
  });

  it('BUG: rejects meta: null (src/storage.ts:25 accepts it because typeof null === "object")', () => {
    // BUG: src/storage.ts:25 — isAppData checks `typeof d.meta === 'object'`, which is true for null.
    // Expected: parseData throws 'unknown format'. Actual: returns data with meta === null, and the
    // next summarizeCg/expectedFor call dereferences data.meta[cg] and throws a TypeError.
    const raw = JSON.stringify({ version: 1, scans: [], meta: null, settings: {} });
    expect(() => parseData(raw)).toThrow('unknown format');
  });
});

// ---------------------------------------------------------------- LocalStore

describe('LocalStore', () => {
  let ls: FakeStorage;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ls = new FakeStorage();
    // Corrupt-data loads log via console.error; silence it and assert on it where it matters.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('round-trips data through save and load', () => {
    const data = sampleData();
    new LocalStore(KEY, ls).save(data);
    expect(new LocalStore(KEY, ls).load()).toEqual(data);
  });

  it('writes the serialized data under the given key', () => {
    new LocalStore(KEY, ls).save(sampleData());
    expect(JSON.parse(ls.getItem(KEY) as string)).toEqual(sampleData());
  });

  it('loads empty data when the key is missing', () => {
    expect(new LocalStore(KEY, ls).load()).toEqual(emptyData());
  });

  it('loads empty data for a corrupt JSON value and keeps the raw string under a corrupt key', () => {
    const raw = '{"version":1,"scans":[' ; // truncated JSON
    ls.setItem(KEY, raw);

    expect(new LocalStore(KEY, ls).load()).toEqual(emptyData());

    const backups = ls.keysList().filter((k) => k.startsWith(`${KEY}:corrupt:`));
    expect(backups).toHaveLength(1);
    expect(ls.getItem(backups[0])).toBe(raw);
  });

  it('backs up valid JSON that is not app data, not just syntax errors', () => {
    const raw = '{"foo":1}';
    ls.setItem(KEY, raw);

    expect(new LocalStore(KEY, ls).load()).toEqual(emptyData());

    const backups = ls.keysList().filter((k) => k.startsWith(`${KEY}:corrupt:`));
    expect(backups).toHaveLength(1);
    expect(ls.getItem(backups[0])).toBe(raw);
  });

  it('logs an error when it recovers from corrupt data', () => {
    ls.setItem(KEY, '{bad');
    new LocalStore(KEY, ls).load();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not create a backup key when the store is missing', () => {
    new LocalStore(KEY, ls).load();
    expect(ls.keysList().some((k) => k.includes(':corrupt:'))).toBe(false);
  });

  it('does not create a backup key for valid data', () => {
    new LocalStore(KEY, ls).save(sampleData());
    new LocalStore(KEY, ls).load();
    expect(ls.keysList().some((k) => k.includes(':corrupt:'))).toBe(false);
  });

  it('clear removes the saved value so the next load is empty', () => {
    const store = new LocalStore(KEY, ls);
    store.save(sampleData());
    store.clear();
    expect(ls.getItem(KEY)).toBeNull();
    expect(store.load()).toEqual(emptyData());
  });

  it('clear does not touch other namespaces such as a branch preview', () => {
    const preview = 'cg-tracker:v1:/cg-tracker/preview/x/';
    new LocalStore(preview, ls).save(sampleData());
    new LocalStore(KEY, ls).save(sampleData());
    new LocalStore(KEY, ls).clear();
    expect(new LocalStore(preview, ls).load()).toEqual(sampleData());
  });

  it('keeps production and preview data isolated when both are saved', () => {
    const preview = 'cg-tracker:v1:/cg-tracker/preview/x/';
    const prodData = sampleData();
    const previewData = emptyData();
    new LocalStore(KEY, ls).save(prodData);
    new LocalStore(preview, ls).save(previewData);
    expect(new LocalStore(KEY, ls).load()).toEqual(prodData);
    expect(new LocalStore(preview, ls).load()).toEqual(previewData);
  });
});

// ---------------------------------------------------------------- MemoryStore

describe('MemoryStore', () => {
  it('loads empty data before anything is saved', () => {
    expect(new MemoryStore().load()).toEqual(emptyData());
  });

  it('round-trips data through save and load', () => {
    const store = new MemoryStore();
    const data = sampleData();
    store.save(data);
    expect(store.load()).toEqual(data);
  });

  it('returns a copy, so mutating the saved object does not change the store', () => {
    const store = new MemoryStore();
    const data = sampleData();
    store.save(data);
    data.scans.length = 0;
    expect(store.load().scans).toHaveLength(2);
  });

  it('returns empty data after clear', () => {
    const store = new MemoryStore();
    store.save(sampleData());
    store.clear();
    expect(store.load()).toEqual(emptyData());
  });
});
