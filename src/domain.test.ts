import { describe, it, expect } from 'vitest';
import {
  CSV_HEADER,
  addScan,
  agingLevel,
  checkScan,
  clampExpected,
  completedList,
  countByStatus,
  deleteScan,
  emptyData,
  formatDuration,
  lastScan,
  normalizeCg,
  pendingList,
  searchCgs,
  setAgingHours,
  setExpected,
  setMark,
  setSticky,
  summarizeAll,
  summarizeCg,
  toCsv,
  undoLastScan,
  updateScan,
  type AppData,
} from './domain';

// Fixed clock values. Never Date.now() in these tests.
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

// Records one scan with a deterministic id so tests can refer to it.
function scan(data: AppData, cg: string, at: number, id: string, truck = '', door = ''): AppData {
  return addScan(data, { cg, truck, door }, at, id);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- normalizeCg

describe('normalizeCg', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeCg('   8000123   ')).toBe('8000123');
  });

  it('removes embedded spaces', () => {
    expect(normalizeCg('8000 123')).toBe('8000123');
  });

  it('strips CR, LF and TAB control characters', () => {
    expect(normalizeCg('\r8000123\n')).toBe('8000123');
    expect(normalizeCg('8000\t123')).toBe('8000123');
  });

  it('strips STX and ETX control characters that scanners wrap codes in', () => {
    expect(normalizeCg('\x028000123\x03')).toBe('8000123');
    expect(normalizeCg('80\x0200123')).toBe('8000123');
  });

  it('strips the AIM symbology prefix ]C1', () => {
    expect(normalizeCg(']C18000123')).toBe('8000123');
  });

  it('strips the AIM symbology prefix ]Q3', () => {
    expect(normalizeCg(']Q38000123')).toBe('8000123');
  });

  it('strips an AIM prefix that arrives with whitespace and line endings around it', () => {
    expect(normalizeCg('  ]C1 8000123\r\n')).toBe('8000123');
  });

  it('strips leading and trailing punctuation', () => {
    expect(normalizeCg('*8000123*')).toBe('8000123');
    expect(normalizeCg('#8000123.')).toBe('8000123');
  });

  it('strips an AIM prefix and then punctuation', () => {
    expect(normalizeCg(']C1*8000123*')).toBe('8000123');
  });

  it('upper-cases letters', () => {
    expect(normalizeCg('8000ab')).toBe('8000AB');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeCg('')).toBe('');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeCg(' \r\n\t ')).toBe('');
  });

  it('returns an empty string when only punctuation remains', () => {
    expect(normalizeCg('***')).toBe('');
  });

  it('leaves an already clean CG unchanged', () => {
    expect(normalizeCg('8000123')).toBe('8000123');
  });
});

// ---------------------------------------------------------------- clampExpected

describe('clampExpected', () => {
  it('clamps values below 1 up to 1', () => {
    expect(clampExpected(0)).toBe(1);
    expect(clampExpected(-5)).toBe(1);
  });

  it('clamps values above 9 down to 9', () => {
    expect(clampExpected(10)).toBe(9);
    expect(clampExpected(99)).toBe(9);
  });

  it('rounds fractional values to the nearest whole number', () => {
    expect(clampExpected(2.4)).toBe(2);
    expect(clampExpected(2.6)).toBe(3);
  });

  it.each([NaN, Infinity, -Infinity])('maps non-finite value %s to the default of 2', (n) => {
    expect(clampExpected(n)).toBe(2);
  });
});

// ---------------------------------------------------------------- addScan / summarizeCg

describe('addScan', () => {
  it('returns no summary for a CG that has never been scanned', () => {
    expect(summarizeCg(emptyData(), '8000123')).toBeNull();
  });

  it('marks the first scan of a CG as pending with count 1 of expected 2', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('pending');
    expect(s?.count).toBe(1);
    expect(s?.expected).toBe(2);
    expect(s?.complete).toBe(false);
    expect(s?.completedAt).toBeNull();
    expect(s?.firstAt).toBe(T0);
    expect(s?.lastAt).toBe(T0);
  });

  it('marks the second scan as complete and stamps completedAt with that scan time', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + 5 * MIN, 'a2');
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('complete');
    expect(s?.complete).toBe(true);
    expect(s?.count).toBe(2);
    expect(s?.completedAt).toBe(T0 + 5 * MIN);
  });

  it('sorts a CG summary oldest first even when scans were recorded out of time order', () => {
    let data = scan(emptyData(), '8000123', T0 + 10 * MIN, 'late');
    data = scan(data, '8000123', T0, 'early');
    const s = summarizeCg(data, '8000123');
    expect(s?.scans.map((x) => x.id)).toEqual(['early', 'late']);
    expect(s?.firstAt).toBe(T0);
    expect(s?.lastAt).toBe(T0 + 10 * MIN);
    // completedAt is the time of the scan that reached expected (the 2nd one by time).
    expect(s?.completedAt).toBe(T0 + 10 * MIN);
  });

  it('normalizes the CG before storing it', () => {
    const data = addScan(emptyData(), { cg: ' ]C1 8000123\r\n' }, T0, 'a1');
    expect(data.scans[0].cg).toBe('8000123');
    expect(summarizeCg(data, '8000123')?.count).toBe(1);
  });

  it('throws on an empty CG', () => {
    expect(() => addScan(emptyData(), { cg: '' }, T0, 'a1')).toThrow('empty CG');
  });

  it('throws when the CG normalizes to empty', () => {
    expect(() => addScan(emptyData(), { cg: '   *** ' }, T0, 'a1')).toThrow('empty CG');
  });

  it('saves truck and door on the scan, trimmed', () => {
    const data = addScan(emptyData(), { cg: '8000123', truck: ' T1 ', door: ' D2 ' }, T0, 'a1');
    expect(data.scans[0]).toEqual({ id: 'a1', cg: '8000123', at: T0, truck: 'T1', door: 'D2' });
  });

  it('copies truck and door into settings so they are sticky for the next scan', () => {
    const data = addScan(emptyData(), { cg: '8000123', truck: 'T1', door: 'D2' }, T0, 'a1');
    expect(data.settings.truck).toBe('T1');
    expect(data.settings.door).toBe('D2');
  });

  it('updates the sticky truck and door when a later scan uses different values', () => {
    let data = addScan(emptyData(), { cg: '8000123', truck: 'T1', door: 'D2' }, T0, 'a1');
    data = addScan(data, { cg: '8000999', truck: 'T9', door: 'D8' }, T0 + MIN, 'a2');
    expect(data.settings.truck).toBe('T9');
    expect(data.settings.door).toBe('D8');
    expect(data.scans[0].truck).toBe('T1');
  });

  it('does not mutate the input data', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    const before = structuredClone(data);
    const scansRef = data.scans;
    const next = scan(data, '8000123', T0 + MIN, 'a2', 'T5', 'D5');
    expect(data).toEqual(before);
    expect(data.scans).toBe(scansRef);
    expect(next).not.toBe(data);
  });

  it('does not affect the status of other CGs', () => {
    let data = scan(emptyData(), '8000111', T0, 'a1');
    data = scan(data, '8000222', T0, 'b1');
    const other = summarizeCg(data, '8000111');
    expect(other?.count).toBe(1);
    expect(other?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------- setExpected

describe('setExpected', () => {
  it('makes a single scan complete when expected is 1', () => {
    let data = setExpected(emptyData(), '8000123', 1);
    data = scan(data, '8000123', T0, 'a1');
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('complete');
    expect(s?.completedAt).toBe(T0);
  });

  it('needs three scans when expected is 3', () => {
    let data = setExpected(emptyData(), '8000123', 3);
    data = scan(data, '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    expect(summarizeCg(data, '8000123')?.status).toBe('pending');
    data = scan(data, '8000123', T0 + 2 * MIN, 'a3');
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('complete');
    expect(s?.completedAt).toBe(T0 + 2 * MIN);
  });

  it('lowering expected below the current count completes the CG at the earlier scan', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    data = setExpected(data, '8000123', 1);
    expect(summarizeCg(data, '8000123')?.completedAt).toBe(T0);
  });

  it('clamps values below 1 to 1', () => {
    expect(setExpected(emptyData(), '8000123', 0).meta['8000123'].expected).toBe(1);
  });

  it('clamps values above 9 to 9', () => {
    expect(setExpected(emptyData(), '8000123', 42).meta['8000123'].expected).toBe(9);
  });

  it('falls back to 2 for a non-finite value', () => {
    expect(setExpected(emptyData(), '8000123', NaN).meta['8000123'].expected).toBe(2);
  });

  it('keeps an existing mark when changing expected', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    data = setMark(data, '8000123', 'staged', T0 + 2 * MIN);
    data = setExpected(data, '8000123', 2);
    expect(summarizeCg(data, '8000123')?.status).toBe('staged');
  });

  it('does not mutate the input', () => {
    const data = emptyData();
    const before = structuredClone(data);
    setExpected(data, '8000123', 3);
    expect(data).toEqual(before);
  });
});

// ---------------------------------------------------------------- checkScan

describe('checkScan', () => {
  it('returns no warnings for a fresh 8000 CG', () => {
    expect(checkScan(emptyData(), '8000123', T0)).toEqual([]);
  });

  it('warns with kind prefix for a CG that does not start with 8000', () => {
    const w = checkScan(emptyData(), '9000123', T0);
    expect(w.map((x) => x.kind)).toEqual(['prefix']);
    expect(w[0].message).toContain('9000123');
  });

  it('warns with kind prefix for a CG that is a truncated 8000 prefix', () => {
    expect(checkScan(emptyData(), '800', T0).map((x) => x.kind)).toEqual(['prefix']);
  });

  it('does not warn about the prefix for a CG that starts with 8000', () => {
    expect(checkScan(emptyData(), '80001', T0).some((x) => x.kind === 'prefix')).toBe(false);
  });

  it('warns with kind over when the CG is already at expected', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + 5 * MIN, 'a2');
    const w = checkScan(data, '8000123', T0 + 10 * MIN);
    expect(w.map((x) => x.kind)).toEqual(['over']);
    expect(w[0].message).toContain('2 of 2');
    expect(w[0].message).toContain('cart 3');
  });

  it('does not warn with kind over while the CG is still below expected', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(checkScan(data, '8000123', T0 + 5 * MIN).some((x) => x.kind === 'over')).toBe(false);
  });

  it('warns with kind over when expected is 1 and one cart is already in', () => {
    let data = setExpected(emptyData(), '8000123', 1);
    data = scan(data, '8000123', T0, 'a1');
    expect(checkScan(data, '8000123', T0 + 5 * MIN).map((x) => x.kind)).toEqual(['over']);
  });

  it('warns with kind recent when the last scan of the same CG was under 60 seconds ago', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const w = checkScan(data, '8000123', T0 + 59_999);
    expect(w.map((x) => x.kind)).toEqual(['recent']);
  });

  it('does not warn with kind recent at exactly 60 seconds', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(checkScan(data, '8000123', T0 + 60_000).some((x) => x.kind === 'recent')).toBe(false);
  });

  it('warns with kind recent for a scan at the same instant', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(checkScan(data, '8000123', T0).map((x) => x.kind)).toEqual(['recent']);
  });

  it('reports the recent window using the DUP_WINDOW_MS boundary of 60 seconds', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const recent = checkScan(data, '8000123', T0 + 30_000).find((x) => x.kind === 'recent');
    expect(recent?.message).toContain('scanned 30s ago');
  });

  it('ignores recent scans of a different CG', () => {
    const data = scan(emptyData(), '8000999', T0, 'b1');
    expect(checkScan(data, '8000123', T0 + 1_000)).toEqual([]);
  });

  it('does not warn with kind recent when the last scan is in the future', () => {
    const data = scan(emptyData(), '8000123', T0 + MIN, 'a1');
    expect(checkScan(data, '8000123', T0).some((x) => x.kind === 'recent')).toBe(false);
  });

  it('stacks prefix, over and recent warnings together in that order', () => {
    let data = setExpected(emptyData(), '9000001', 1);
    data = scan(data, '9000001', T0, 'a1');
    const w = checkScan(data, '9000001', T0 + 10_000);
    expect(w.map((x) => x.kind)).toEqual(['prefix', 'over', 'recent']);
  });
});

// ---------------------------------------------------------------- undo / last / delete / update

describe('undoLastScan', () => {
  it('removes the most recently recorded scan by insertion order, not by time', () => {
    let data = scan(emptyData(), '8000111', T0 + 10 * MIN, 'recorded-first');
    data = scan(data, '8000222', T0, 'recorded-second');
    const undone = undoLastScan(data);
    expect(undone.scans.map((s) => s.id)).toEqual(['recorded-first']);
  });

  it('is a no-op on empty data and returns the same object', () => {
    const data = emptyData();
    expect(undoLastScan(data)).toBe(data);
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const before = structuredClone(data);
    undoLastScan(data);
    expect(data).toEqual(before);
  });

  it('leaves settings and meta untouched', () => {
    let data = setExpected(emptyData(), '8000123', 3);
    data = scan(data, '8000123', T0, 'a1', 'T1', 'D1');
    const undone = undoLastScan(data);
    expect(undone.meta).toEqual(data.meta);
    expect(undone.settings).toEqual(data.settings);
  });
});

describe('lastScan', () => {
  it('returns the most recently inserted scan', () => {
    let data = scan(emptyData(), '8000111', T0, 'a1');
    data = scan(data, '8000222', T0 - MIN, 'b1');
    expect(lastScan(data)?.id).toBe('b1');
  });

  it('returns null on empty data', () => {
    expect(lastScan(emptyData())).toBeNull();
  });
});

describe('deleteScan', () => {
  it('removes only the scan with the given id', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    const next = deleteScan(data, 'a1');
    expect(next.scans.map((s) => s.id)).toEqual(['a2']);
  });

  it('is a no-op for an unknown id', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(deleteScan(data, 'missing').scans).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const before = structuredClone(data);
    deleteScan(data, 'a1');
    expect(data).toEqual(before);
  });
});

describe('updateScan', () => {
  it('normalizes a changed CG', () => {
    const data = scan(emptyData(), '8000111', T0, 'a1');
    const next = updateScan(data, 'a1', { cg: ' ]Q3 8000999 ' });
    expect(next.scans[0].cg).toBe('8000999');
    expect(summarizeCg(next, '8000111')).toBeNull();
    expect(summarizeCg(next, '8000999')?.count).toBe(1);
  });

  it('re-derives status when a scan moves into a CG that already has one cart', () => {
    let data = scan(emptyData(), '8000111', T0, 'a1');
    data = scan(data, '8000222', T0, 'b1');
    const next = updateScan(data, 'a1', { cg: '8000222' });
    expect(summarizeCg(next, '8000222')?.status).toBe('complete');
    expect(summarizeCg(next, '8000111')).toBeNull();
  });

  it('re-derives completedAt when the scan time changes order', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + 50, 'a2');
    const next = updateScan(data, 'a1', { at: T0 + 100 });
    expect(summarizeCg(next, '8000123')?.completedAt).toBe(T0 + 100);
  });

  it('trims truck and door', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const next = updateScan(data, 'a1', { truck: '  T7 ', door: ' D3 ' });
    expect(next.scans[0].truck).toBe('T7');
    expect(next.scans[0].door).toBe('D3');
  });

  it('throws when the new CG normalizes to empty', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(() => updateScan(data, 'a1', { cg: '  ' })).toThrow('empty CG');
  });

  it('is a no-op for an unknown id', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    expect(updateScan(data, 'missing', { cg: '8000999' }).scans[0].cg).toBe('8000123');
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const before = structuredClone(data);
    updateScan(data, 'a1', { cg: '8000999', truck: 'T2' });
    expect(data).toEqual(before);
  });
});

// ---------------------------------------------------------------- setMark / counts

describe('setMark', () => {
  function completedCg(): AppData {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    return data;
  }

  it('marks a complete CG as staged and records markAt', () => {
    const data = setMark(completedCg(), '8000123', 'staged', T0 + 5 * MIN);
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('staged');
    expect(s?.markAt).toBe(T0 + 5 * MIN);
  });

  it('marks a complete CG as dispatched', () => {
    const data = setMark(completedCg(), '8000123', 'dispatched', T0 + 5 * MIN);
    expect(summarizeCg(data, '8000123')?.status).toBe('dispatched');
  });

  it('clears the mark when given null and returns status to complete', () => {
    let data = setMark(completedCg(), '8000123', 'staged', T0 + 5 * MIN);
    data = setMark(data, '8000123', null, T0 + 6 * MIN);
    const s = summarizeCg(data, '8000123');
    expect(s?.status).toBe('complete');
    expect(s?.markAt).toBeNull();
    expect(data.meta['8000123'].mark).toBeUndefined();
    expect(data.meta['8000123'].markAt).toBeUndefined();
  });

  it('reverts a marked CG to pending when a scan is deleted, then restores the mark when re-scanned', () => {
    let data = setMark(completedCg(), '8000123', 'staged', T0 + 5 * MIN);
    data = deleteScan(data, 'a2');
    expect(summarizeCg(data, '8000123')?.status).toBe('pending');
    expect(summarizeCg(data, '8000123')?.markAt).toBeNull();

    data = scan(data, '8000123', T0 + 7 * MIN, 'a3');
    expect(summarizeCg(data, '8000123')?.status).toBe('staged');
  });

  it('does not mutate the input', () => {
    const data = completedCg();
    const before = structuredClone(data);
    setMark(data, '8000123', 'staged', T0);
    expect(data).toEqual(before);
  });
});

describe('countByStatus and summarizeAll', () => {
  it('returns no summaries for empty data', () => {
    expect(summarizeAll(emptyData())).toEqual([]);
    expect(countByStatus([])).toEqual({ pending: 0, completed: 0, staged: 0, dispatched: 0 });
  });

  it('counts each status once per CG', () => {
    let data = scan(emptyData(), '8000001', T0, 'p1'); // pending
    data = scan(data, '8000002', T0, 'c1');
    data = scan(data, '8000002', T0 + MIN, 'c2'); // complete
    data = scan(data, '8000003', T0, 's1');
    data = scan(data, '8000003', T0 + MIN, 's2');
    data = setMark(data, '8000003', 'staged', T0 + 2 * MIN); // staged
    data = scan(data, '8000004', T0, 'd1');
    data = scan(data, '8000004', T0 + MIN, 'd2');
    data = setMark(data, '8000004', 'dispatched', T0 + 2 * MIN); // dispatched
    expect(countByStatus(summarizeAll(data))).toEqual({
      pending: 1,
      completed: 1,
      staged: 1,
      dispatched: 1,
    });
  });

  it('summarizes each CG exactly once even when it has several scans', () => {
    let data = scan(emptyData(), '8000123', T0, 'a1');
    data = scan(data, '8000123', T0 + MIN, 'a2');
    data = scan(data, '8000123', T0 + 2 * MIN, 'a3');
    expect(summarizeAll(data)).toHaveLength(1);
  });
});

describe('pendingList', () => {
  it('lists pending CGs oldest first by first scan', () => {
    let data = scan(emptyData(), '8000333', T0 + 2 * MIN, 'c1');
    data = scan(data, '8000111', T0, 'a1');
    data = scan(data, '8000222', T0 + MIN, 'b1');
    expect(pendingList(summarizeAll(data)).map((s) => s.cg)).toEqual([
      '8000111',
      '8000222',
      '8000333',
    ]);
  });

  it('excludes complete and marked CGs', () => {
    let data = scan(emptyData(), '8000111', T0, 'a1');
    data = scan(data, '8000111', T0 + MIN, 'a2'); // complete
    data = scan(data, '8000222', T0, 'b1'); // pending
    expect(pendingList(summarizeAll(data)).map((s) => s.cg)).toEqual(['8000222']);
  });
});

describe('completedList', () => {
  // Two completed CGs and one pending CG. Set up so that completion time and
  // last-scan time disagree: 8000111 completes at T0+100 but has a later scan at T0+500.
  function fixture(): AppData {
    let data = setExpected(emptyData(), '8000111', 2);
    data = scan(data, '8000111', T0, 'a1');
    data = scan(data, '8000111', T0 + 100, 'a2');
    data = scan(data, '8000111', T0 + 500, 'a3');
    data = scan(data, '8000222', T0 + 200, 'b1');
    data = scan(data, '8000222', T0 + 300, 'b2');
    data = scan(data, '8000333', T0 + 400, 'c1');
    return data;
  }

  it('orders completed CGs newest completion first, using completedAt rather than last scan', () => {
    const list = completedList(summarizeAll(fixture()), 'all');
    expect(list.map((s) => s.cg)).toEqual(['8000222', '8000111']);
  });

  it('excludes pending CGs from every filter', () => {
    const list = completedList(summarizeAll(fixture()), 'all');
    expect(list.map((s) => s.cg)).not.toContain('8000333');
  });

  it("'active' returns only CGs that are complete and not marked", () => {
    let data = setMark(fixture(), '8000222', 'staged', T0 + 900);
    const list = completedList(summarizeAll(data), 'active');
    expect(list.map((s) => s.cg)).toEqual(['8000111']);
  });

  it("'staged' returns only staged CGs", () => {
    let data = setMark(fixture(), '8000222', 'staged', T0 + 900);
    data = setMark(data, '8000111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'staged').map((s) => s.cg)).toEqual(['8000222']);
  });

  it("'dispatched' returns only dispatched CGs", () => {
    let data = setMark(fixture(), '8000222', 'staged', T0 + 900);
    data = setMark(data, '8000111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'dispatched').map((s) => s.cg)).toEqual(['8000111']);
  });

  it("'all' includes active, staged and dispatched CGs", () => {
    let data = setMark(fixture(), '8000222', 'staged', T0 + 900);
    data = setMark(data, '8000111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'all').map((s) => s.cg).sort()).toEqual([
      '8000111',
      '8000222',
    ]);
  });
});

// ---------------------------------------------------------------- aging

describe('agingLevel (24h limit)', () => {
  const LIMIT = 24;

  it('is ok at 0 hours', () => {
    expect(agingLevel(T0, T0, LIMIT)).toBe('ok');
  });

  it('is ok just under 18 hours (75%)', () => {
    expect(agingLevel(T0, T0 + 17.9 * HOUR, LIMIT)).toBe('ok');
  });

  it('is warn at exactly 18 hours', () => {
    expect(agingLevel(T0, T0 + 18 * HOUR, LIMIT)).toBe('warn');
  });

  it('is warn just under 24 hours', () => {
    expect(agingLevel(T0, T0 + 23.9 * HOUR, LIMIT)).toBe('warn');
  });

  it('is late at exactly 24 hours', () => {
    expect(agingLevel(T0, T0 + 24 * HOUR, LIMIT)).toBe('late');
  });

  it('is ok when agingHours is 0 (aging disabled)', () => {
    expect(agingLevel(T0, T0 + 100 * 24 * HOUR, 0)).toBe('ok');
  });

  it('is ok when the first scan is in the future (clock skew)', () => {
    expect(agingLevel(T0 + HOUR, T0, LIMIT)).toBe('ok');
  });
});

// ---------------------------------------------------------------- search

describe('searchCgs', () => {
  function list() {
    let data = scan(emptyData(), '80001234', T0 + 500, 'x1');
    data = scan(data, '8000123', T0, 'x2');
    data = scan(data, '8000999', T0 + 100, 'x3');
    data = scan(data, '8000ab', T0 + 50, 'x4');
    return summarizeAll(data);
  }

  it('matches a substring of the CG', () => {
    const cgs = searchCgs(list(), '123').map((s) => s.cg);
    expect(cgs).toContain('8000123');
    expect(cgs).toContain('80001234');
    expect(cgs).not.toContain('8000999');
  });

  it('puts an exact match first even when a longer CG was scanned more recently', () => {
    const cgs = searchCgs(list(), '8000123').map((s) => s.cg);
    expect(cgs[0]).toBe('8000123');
    expect(cgs).toContain('80001234');
  });

  it('matches case-insensitively because the query is normalized', () => {
    expect(searchCgs(list(), 'ab').map((s) => s.cg)).toEqual(['8000AB']);
  });

  it('normalizes the query before matching', () => {
    expect(searchCgs(list(), '  *8000123* ')[0].cg).toBe('8000123');
  });

  it('returns no results for an empty query', () => {
    expect(searchCgs(list(), '')).toEqual([]);
  });

  it('returns no results for a whitespace-only query', () => {
    expect(searchCgs(list(), '   ')).toEqual([]);
  });

  it('returns no results for a punctuation-only query', () => {
    expect(searchCgs(list(), '***')).toEqual([]);
  });

  it('returns no results when nothing matches', () => {
    expect(searchCgs(list(), '7777')).toEqual([]);
  });

  it('breaks ties between equal matches by most recent scan first', () => {
    let data = scan(emptyData(), '8000555', T0, 'a');
    data = scan(data, '8000556', T0 + MIN, 'b');
    // Both CGs contain '0055'; neither is an exact match, so recency decides.
    expect(searchCgs(summarizeAll(data), '0055').map((s) => s.cg)).toEqual(['8000556', '8000555']);
  });
});

// ---------------------------------------------------------------- checks / settings

describe('setAgingHours and setSticky', () => {
  it('stores a positive finite aging limit', () => {
    expect(setAgingHours(emptyData(), 12).settings.agingHours).toBe(12);
  });

  it.each([0, -3, NaN, Infinity])('falls back to 24 hours for invalid value %s', (h) => {
    expect(setAgingHours(emptyData(), h).settings.agingHours).toBe(24);
  });

  it('sets sticky truck and door without touching scans', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1');
    const next = setSticky(data, 'T3', 'D4');
    expect(next.settings.truck).toBe('T3');
    expect(next.settings.door).toBe('D4');
    expect(next.scans).toEqual(data.scans);
  });
});

describe('emptyData', () => {
  it('returns a fresh empty structure with default settings', () => {
    expect(emptyData()).toEqual({
      version: 1,
      scans: [],
      meta: {},
      settings: { agingHours: 24, truck: '', door: '' },
    });
  });

  it('returns a new object each call so callers cannot share state', () => {
    const a = emptyData();
    const b = emptyData();
    expect(a).not.toBe(b);
    expect(a.scans).not.toBe(b.scans);
    expect(a.settings).not.toBe(b.settings);
  });
});

// ---------------------------------------------------------------- export

describe('toCsv', () => {
  // CG 8000111: two carts, completes at the second scan.
  // CG 8000222: one cart, pending. Recorded later, so it sorts after 8000111.
  function fixture(): AppData {
    let data = scan(emptyData(), '8000111', T0, 'a1', 'T1', 'D1');
    data = scan(data, '8000111', T0 + MIN, 'a2', 'T1', 'D1');
    data = scan(data, '8000222', T0 + 2 * MIN, 'b1', 'T2', 'D2');
    return data;
  }

  it('starts with the header row built from CSV_HEADER', () => {
    const lines = toCsv(fixture()).split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
  });

  it('writes one row per scan under the header', () => {
    const lines = toCsv(fixture()).split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1 + 3);
  });

  it('uses CRLF line endings with no bare LF', () => {
    const csv = toCsv(fixture());
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('returns only the header row (with a trailing CRLF) for empty data', () => {
    expect(toCsv(emptyData())).toBe(CSV_HEADER.join(',') + '\r\n');
  });

  it('writes the expected values for a complete CG row', () => {
    const row = toCsv(fixture()).split('\r\n')[1];
    expect(row).toBe(
      [
        '8000111',
        '1',
        iso(T0),
        'T1',
        'D1',
        '2',
        '2',
        'complete',
        iso(T0 + MIN),
        '',
      ].join(','),
    );
  });

  it('writes an empty completed_at for a pending CG', () => {
    const row = toCsv(fixture()).split('\r\n')[3];
    expect(row).toBe(['8000222', '1', iso(T0 + 2 * MIN), 'T2', 'D2', '1', '2', 'pending', '', ''].join(','));
  });

  it('writes the staged status and marked_at timestamp', () => {
    const data = setMark(fixture(), '8000111', 'staged', T0 + 5 * MIN);
    const row = toCsv(data).split('\r\n')[1];
    const cells = row.split(',');
    expect(cells[7]).toBe('staged');
    expect(cells[9]).toBe(iso(T0 + 5 * MIN));
  });

  it('groups rows by CG oldest CG first and numbers carts 1..n per CG', () => {
    let data = scan(emptyData(), '8000222', T0, 'b1');
    data = scan(data, '8000111', T0 + MIN, 'a1');
    data = scan(data, '8000111', T0 + 2 * MIN, 'a2');
    data = scan(data, '8000111', T0 + 3 * MIN, 'a3');
    const rows = toCsv(data).split('\r\n').slice(1).filter((l) => l !== '');
    const cgAndCart = rows.map((r) => {
      const c = r.split(',');
      return `${c[0]}#${c[1]}`;
    });
    expect(cgAndCart).toEqual(['8000222#1', '8000111#1', '8000111#2', '8000111#3']);
  });

  it('quotes a cell that contains a comma', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1', 'Bay 1, north', 'D1');
    const row = toCsv(data).split('\r\n')[1];
    expect(row).toContain('"Bay 1, north"');
  });

  it('doubles embedded double quotes inside a quoted cell', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1', 'Bay "N", east', 'D1');
    const row = toCsv(data).split('\r\n')[1];
    expect(row).toContain('"Bay ""N"", east"');
  });

  it('leaves a plain value unquoted', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1', 'T1', 'D1');
    expect(toCsv(data).split('\r\n')[1].split(',')[3]).toBe('T1');
  });

  it.each(['=', '+', '-', '@'])(
    'prefixes a truck starting with %s with a single quote (CSV injection guard)',
    (lead) => {
      const truck = `${lead}1+1`;
      const data = scan(emptyData(), '8000123', T0, 'a1', truck, 'D1');
      const cell = toCsv(data).split('\r\n')[1].split(',')[3];
      expect(cell).toBe(`'${truck}`);
    },
  );

  it('prefixes a formula-looking truck that also contains quotes and still quotes the cell', () => {
    const data = scan(emptyData(), '8000123', T0, 'a1', '=HYPERLINK("x")', 'D1');
    const row = toCsv(data).split('\r\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

// ---------------------------------------------------------------- format

describe('formatDuration', () => {
  it('shows 0m for 59 seconds', () => {
    expect(formatDuration(59_000)).toBe('0m');
  });

  it('shows 0m for zero', () => {
    expect(formatDuration(0)).toBe('0m');
  });

  it('shows 0m for a negative duration', () => {
    expect(formatDuration(-5 * MIN)).toBe('0m');
  });

  it('shows minutes under an hour', () => {
    expect(formatDuration(45 * MIN)).toBe('45m');
  });

  it('shows 1h 1m for 61 minutes', () => {
    expect(formatDuration(61 * MIN)).toBe('1h 1m');
  });

  it('shows 1h 0m at exactly one hour', () => {
    expect(formatDuration(HOUR)).toBe('1h 0m');
  });

  it('shows 23h 59m just under a day', () => {
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe('23h 59m');
  });

  it('shows 1d 0h at exactly 24 hours', () => {
    expect(formatDuration(24 * HOUR)).toBe('1d 0h');
  });

  it('shows 1d 1h for 25 hours', () => {
    expect(formatDuration(25 * HOUR)).toBe('1d 1h');
  });

  it('shows whole days and remaining hours for multi-day spans', () => {
    expect(formatDuration(2 * 24 * HOUR + 3 * HOUR + 5 * MIN)).toBe('2d 3h');
  });
});
