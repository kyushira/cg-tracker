import { describe, it, expect } from 'vitest';
import { LocalStore, parseData } from './storage';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const good = { id: 'a', cg: '1234', at: 1000, ops: ['10'], mc: 'big' };
const raw = (scans: unknown[]) =>
  JSON.stringify({ version: 1, scans, meta: {}, settings: { agingHours: 24, ops: [], otherOn: false, otherText: '', mc: '' } });

describe('malformed scan rows', () => {
  it('parseData drops rows without a CG or a valid time and keeps the valid ones', () => {
    const d = parseData(
      raw([good, { id: 'b', cg: '', at: 1 }, { id: 'c', cg: '1234', at: 'x' }, null, { id: 'd', cg: '9999', at: 5 }]),
    );
    expect(d.scans.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('parseData gives a round-1 row with truck/door empty ops and mc, and drops the old keys', () => {
    const d = parseData(raw([{ id: 'r', cg: '1234', at: 1000, truck: 'T1', door: '4' }]));
    expect(d.scans[0]).toEqual({ id: 'r', cg: '1234', rawCode: '1234', at: 1000, ops: [], mc: '' });
    expect(d.scans[0]).not.toHaveProperty('truck');
    expect(d.scans[0]).not.toHaveProperty('door');
  });

  it('LocalStore keeps a backup of the raw data when rows are dropped', () => {
    const ls = memStorage();
    ls.setItem('k', raw([good, { id: 'b', cg: 42, at: 1 }]));
    const d = new LocalStore('k', ls).load();
    expect(d.scans).toHaveLength(1);
    const backups = Array.from({ length: ls.length }, (_, i) => ls.key(i)!).filter((k) => k.startsWith('k:dropped:'));
    expect(backups).toHaveLength(1);
  });

  it('LocalStore makes no backup when every row is fine', () => {
    const ls = memStorage();
    ls.setItem('k', raw([good]));
    new LocalStore('k', ls).load();
    expect(ls.length).toBe(1);
  });
});
