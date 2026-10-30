import { describe, it, expect } from 'vitest';
import {
  CSV_HEADER,
  addScan,
  agingLevel,
  checkScan,
  clampExpected,
  cleanMc,
  cleanOps,
  completedList,
  countByStatus,
  deleteScan,
  emptyData,
  formatDuration,
  isValidCg,
  lastScan,
  normalizeCg,
  opsFromSticky,
  parseCg,
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
  type McType,
} from './domain';

// Fixed clock values. Never Date.now() in these tests.
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

// Records one scan with a deterministic id so tests can refer to it.
function scan(data: AppData, cg: string, at: number, id: string, ops: string[] = [], mc: McType | '' = ''): AppData {
  return addScan(data, { cg, ops, mc }, at, id);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- normalizeCg

describe('normalizeCg', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeCg('   1234   ')).toBe('1234');
  });

  it('removes embedded spaces', () => {
    expect(normalizeCg('12 34')).toBe('1234');
  });

  it('strips CR, LF and TAB control characters', () => {
    expect(normalizeCg('\r1234\n')).toBe('1234');
    expect(normalizeCg('12\t34')).toBe('1234');
  });

  it('strips STX and ETX control characters that scanners wrap codes in', () => {
    expect(normalizeCg('\x021234\x03')).toBe('1234');
    expect(normalizeCg('12\x0234')).toBe('1234');
  });

  it('strips the AIM symbology prefix ]C1', () => {
    expect(normalizeCg(']C11234')).toBe('1234');
  });

  it('strips the AIM symbology prefix ]Q3', () => {
    expect(normalizeCg(']Q31234')).toBe('1234');
  });

  it('strips an AIM prefix that arrives with whitespace and line endings around it', () => {
    expect(normalizeCg('  ]C1 1234\r\n')).toBe('1234');
  });

  it('strips leading and trailing punctuation', () => {
    expect(normalizeCg('*1234*')).toBe('1234');
    expect(normalizeCg('#1234.')).toBe('1234');
  });

  it('strips an AIM prefix and then punctuation', () => {
    expect(normalizeCg(']C1*1234*')).toBe('1234');
  });

  it('upper-cases letters', () => {
    expect(normalizeCg('12ab')).toBe('12AB');
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
    expect(normalizeCg('1234')).toBe('1234');
  });
});

// ---------------------------------------------------------------- parseCg / isValidCg

describe('parseCg', () => {
  it('accepts exactly 4 typed digits, with rawCode equal to the typed digits', () => {
    expect(parseCg('4821')).toEqual({ cg: '4821', rawCode: '4821', error: null });
  });

  it('treats 8000 typed alone as a 4-digit CG, not a barcode', () => {
    expect(parseCg('8000')).toEqual({ cg: '8000', rawCode: '8000', error: null });
  });

  it('takes the last 4 digits of a scanned 8000 barcode as the CG key and keeps the full code as rawCode', () => {
    expect(parseCg('80001234821')).toEqual({ cg: '4821', rawCode: '80001234821', error: null });
  });

  it('keeps leading zeros in the key of a short 8000 barcode', () => {
    expect(parseCg('80001')).toEqual({ cg: '0001', rawCode: '80001', error: null });
  });

  it('cleans noisy scanner input from a scanned barcode', () => {
    expect(parseCg('  ]C1*80001234821*\r\n')).toEqual({ cg: '4821', rawCode: '80001234821', error: null });
  });

  it.each(['123', '12345', '90001234', 'AB12', '8000AB12'])(
    'rejects %s with an error that mentions 4-digit and 8000 and returns an empty cg',
    (raw) => {
      const r = parseCg(raw);
      expect(r.cg).toBe('');
      expect(r.error).toContain('4-digit');
      expect(r.error).toContain('8000');
    },
  );

  it('rejects a 5-digit code that does not start with 8000', () => {
    const r = parseCg('12345');
    expect(r.cg).toBe('');
    expect(r.error).not.toBeNull();
  });

  it('treats empty input as a quiet no-op (no error)', () => {
    expect(parseCg('')).toEqual({ cg: '', rawCode: '', error: null });
  });

  it('treats whitespace-only input as a quiet no-op (no error)', () => {
    expect(parseCg(' \r\n ')).toEqual({ cg: '', rawCode: '', error: null });
  });
});

describe('isValidCg', () => {
  it('is true only for exactly 4 digits', () => {
    expect(isValidCg('1234')).toBe(true);
    expect(isValidCg('123')).toBe(false);
    expect(isValidCg('12345')).toBe(false);
    expect(isValidCg('12A4')).toBe(false);
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
    expect(summarizeCg(emptyData(), '1234')).toBeNull();
  });

  it('marks the first scan of a CG as pending with count 1 of expected 2', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('pending');
    expect(s?.count).toBe(1);
    expect(s?.expected).toBe(2);
    expect(s?.complete).toBe(false);
    expect(s?.completedAt).toBeNull();
    expect(s?.firstAt).toBe(T0);
    expect(s?.lastAt).toBe(T0);
  });

  it('marks the second scan as complete and stamps completedAt with that scan time', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + 5 * MIN, 'a2');
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('complete');
    expect(s?.complete).toBe(true);
    expect(s?.count).toBe(2);
    expect(s?.completedAt).toBe(T0 + 5 * MIN);
  });

  it('sorts a CG summary oldest first even when scans were recorded out of time order', () => {
    let data = scan(emptyData(), '1234', T0 + 10 * MIN, 'late');
    data = scan(data, '1234', T0, 'early');
    const s = summarizeCg(data, '1234');
    expect(s?.scans.map((x) => x.id)).toEqual(['early', 'late']);
    expect(s?.firstAt).toBe(T0);
    expect(s?.lastAt).toBe(T0 + 10 * MIN);
    // completedAt is the time of the scan that reached expected (the 2nd one by time).
    expect(s?.completedAt).toBe(T0 + 10 * MIN);
  });

  it('normalizes the CG before storing it', () => {
    const data = addScan(emptyData(), { cg: ' ]C1 1234\r\n' }, T0, 'a1');
    expect(data.scans[0].cg).toBe('1234');
    expect(summarizeCg(data, '1234')?.count).toBe(1);
  });

  it('stores a scanned barcode under its last 4 digits and keeps the full code as rawCode', () => {
    const data = addScan(emptyData(), { cg: '80001234821' }, T0, 'a1');
    expect(data.scans[0]).toEqual({ id: 'a1', cg: '4821', rawCode: '80001234821', at: T0, ops: [], mc: '' });
    expect(summarizeCg(data, '4821')?.count).toBe(1);
  });

  it('cleans a noisy scanner barcode before keying it', () => {
    const data = addScan(emptyData(), { cg: '  ]C1*80001234821*\r\n' }, T0, 'a1');
    expect(data.scans[0].cg).toBe('4821');
    expect(data.scans[0].rawCode).toBe('80001234821');
  });

  it('stores a typed 4-digit CG with rawCode equal to the CG', () => {
    const data = addScan(emptyData(), { cg: '4821' }, T0, 'a1');
    expect(data.scans[0].cg).toBe('4821');
    expect(data.scans[0].rawCode).toBe('4821');
  });

  it('stores typed 8000 as a 4-digit CG, not a barcode', () => {
    const data = addScan(emptyData(), { cg: '8000' }, T0, 'a1');
    expect(data.scans[0].cg).toBe('8000');
    expect(data.scans[0].rawCode).toBe('8000');
  });

  it('counts a typed 4821 and a scanned 80001234821 as the same CG, complete at two carts', () => {
    let data = scan(emptyData(), '4821', T0, 'a1');
    data = addScan(data, { cg: '80001234821' }, T0 + 5 * MIN, 'a2');
    const s = summarizeCg(data, '4821');
    expect(s?.count).toBe(2);
    expect(s?.status).toBe('complete');
    expect(s?.scans.map((x) => x.rawCode)).toEqual(['4821', '80001234821']);
  });

  it('counts a scanned barcode followed by the typed CG as the same CG', () => {
    let data = addScan(emptyData(), { cg: '80001234821' }, T0, 'a1');
    data = scan(data, '4821', T0 + 5 * MIN, 'a2');
    expect(summarizeCg(data, '4821')?.count).toBe(2);
  });

  it('rejects a 5-digit code without the 8000 prefix and an 8-digit code that is not an 8000 barcode', () => {
    expect(() => addScan(emptyData(), { cg: '12345' }, T0, 'a1')).toThrow('invalid CG');
    expect(() => addScan(emptyData(), { cg: '90001234' }, T0, 'a1')).toThrow('invalid CG');
  });

  it.each(['123', '12345', 'ABCD'])('throws for the non-4-digit CG %s', (cg) => {
    expect(() => addScan(emptyData(), { cg }, T0, 'a1')).toThrow('invalid CG');
  });

  it('throws for an empty CG', () => {
    expect(() => addScan(emptyData(), { cg: '' }, T0, 'a1')).toThrow('invalid CG');
  });

  it('throws when the CG normalizes to empty', () => {
    expect(() => addScan(emptyData(), { cg: '   *** ' }, T0, 'a1')).toThrow('invalid CG');
  });

  it('stores ops and mc on the scan, with ops cleaned', () => {
    const data = addScan(emptyData(), { cg: '1234', ops: [' 30 ', '10'], mc: 'small' }, T0, 'a1');
    expect(data.scans[0]).toEqual({ id: 'a1', cg: '1234', rawCode: '1234', at: T0, ops: ['10', '30'], mc: 'small' });
  });

  it('stores an invalid mc as an empty string', () => {
    const data = addScan(emptyData(), { cg: '1234', mc: 'bogus' as McType }, T0, 'a1');
    expect(data.scans[0].mc).toBe('');
  });

  it('stores empty ops and mc when neither is given', () => {
    const data = addScan(emptyData(), { cg: '1234' }, T0, 'a1');
    expect(data.scans[0]).toEqual({ id: 'a1', cg: '1234', rawCode: '1234', at: T0, ops: [], mc: '' });
  });

  it('does not touch settings (ops/mc are sticky only via setSticky)', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', ['10'], 'big');
    expect(data.settings).toEqual(emptyData().settings);
  });

  it('does not mutate the input data', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const before = structuredClone(data);
    const scansRef = data.scans;
    const next = scan(data, '1234', T0 + MIN, 'a2', ['30'], 'open');
    expect(data).toEqual(before);
    expect(data.scans).toBe(scansRef);
    expect(next).not.toBe(data);
  });

  it('does not affect the status of other CGs', () => {
    let data = scan(emptyData(), '1111', T0, 'a1');
    data = scan(data, '2222', T0, 'b1');
    const other = summarizeCg(data, '1111');
    expect(other?.count).toBe(1);
    expect(other?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------- cleanOps / cleanMc / opsFromSticky

describe('cleanOps', () => {
  it('trims whitespace around each op', () => {
    expect(cleanOps([' 10 '])).toEqual(['10']);
  });

  it('dedupes after trimming', () => {
    expect(cleanOps(['10', '10', ' 10'])).toEqual(['10']);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(cleanOps(['', '   ', '20'])).toEqual(['20']);
  });

  it('drops non-string entries', () => {
    expect(cleanOps([42, null, '30'])).toEqual(['30']);
  });

  it('puts standard codes first in display order, then free text in input order', () => {
    expect(cleanOps(['Rework', '80', '10', 'Rework2', '60'])).toEqual(['10', '60', '80', 'Rework', 'Rework2']);
  });

  it('clips free text to 20 characters', () => {
    expect(cleanOps(['x'.repeat(25)])).toEqual(['x'.repeat(20)]);
  });

  it('dedupes after clipping, so two long entries with the same first 20 characters become one', () => {
    expect(cleanOps(['a'.repeat(20) + 'b', 'a'.repeat(20) + 'c'])).toEqual(['a'.repeat(20)]);
  });

  it('returns an empty list for a non-array', () => {
    expect(cleanOps('10')).toEqual([]);
    expect(cleanOps(undefined)).toEqual([]);
  });
});

describe('cleanMc', () => {
  it.each(['big', 'small', 'open'])('keeps the valid type %s', (mc) => {
    expect(cleanMc(mc)).toBe(mc);
  });

  it.each(['Big MC', 'BIG', '', 3, null, undefined])('turns invalid value %j into an empty string', (mc) => {
    expect(cleanMc(mc)).toBe('');
  });
});

describe('opsFromSticky', () => {
  it('returns standard ops in display order', () => {
    expect(opsFromSticky({ ops: ['80', '20', '60'], otherOn: false, otherText: '' })).toEqual(['20', '60', '80']);
  });

  it('ignores the other text when Others is off', () => {
    expect(opsFromSticky({ ops: ['30'], otherOn: false, otherText: 'Rework' })).toEqual(['30']);
  });

  it('appends trimmed other text when Others is on', () => {
    expect(opsFromSticky({ ops: ['10'], otherOn: true, otherText: '  Rework  ' })).toEqual(['10', 'Rework']);
  });

  it('uses the literal "Others" when Others is on with empty text', () => {
    expect(opsFromSticky({ ops: [], otherOn: true, otherText: '' })).toEqual(['Others']);
  });

  it('uses the literal "Others" when Others is on with whitespace-only text', () => {
    expect(opsFromSticky({ ops: [], otherOn: true, otherText: '   ' })).toEqual(['Others']);
  });

  it('clips other text to 20 characters', () => {
    expect(opsFromSticky({ ops: [], otherOn: true, otherText: 'x'.repeat(30) })).toEqual(['x'.repeat(20)]);
  });

  it('returns an empty list when nothing is selected', () => {
    expect(opsFromSticky({ ops: [], otherOn: false, otherText: '' })).toEqual([]);
  });
});

// ---------------------------------------------------------------- setExpected

describe('setExpected', () => {
  it('makes a single scan complete when expected is 1', () => {
    let data = setExpected(emptyData(), '1234', 1);
    data = scan(data, '1234', T0, 'a1');
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('complete');
    expect(s?.completedAt).toBe(T0);
  });

  it('needs three scans when expected is 3', () => {
    let data = setExpected(emptyData(), '1234', 3);
    data = scan(data, '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    expect(summarizeCg(data, '1234')?.status).toBe('pending');
    data = scan(data, '1234', T0 + 2 * MIN, 'a3');
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('complete');
    expect(s?.completedAt).toBe(T0 + 2 * MIN);
  });

  it('lowering expected below the current count completes the CG at the earlier scan', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    data = setExpected(data, '1234', 1);
    expect(summarizeCg(data, '1234')?.completedAt).toBe(T0);
  });

  it('clamps values below 1 to 1', () => {
    expect(setExpected(emptyData(), '1234', 0).meta['1234'].expected).toBe(1);
  });

  it('clamps values above 9 to 9', () => {
    expect(setExpected(emptyData(), '1234', 42).meta['1234'].expected).toBe(9);
  });

  it('falls back to 2 for a non-finite value', () => {
    expect(setExpected(emptyData(), '1234', NaN).meta['1234'].expected).toBe(2);
  });

  it('keeps an existing mark when changing expected', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    data = setMark(data, '1234', 'staged', T0 + 2 * MIN);
    data = setExpected(data, '1234', 2);
    expect(summarizeCg(data, '1234')?.status).toBe('staged');
  });

  it('does not mutate the input', () => {
    const data = emptyData();
    const before = structuredClone(data);
    setExpected(data, '1234', 3);
    expect(data).toEqual(before);
  });
});

// ---------------------------------------------------------------- checkScan

describe('checkScan', () => {
  it('returns no warnings for a fresh CG', () => {
    expect(checkScan(emptyData(), '1234', T0)).toEqual([]);
  });

  it('warns with kind over when the CG is already at expected', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + 5 * MIN, 'a2');
    const w = checkScan(data, '1234', T0 + 10 * MIN);
    expect(w.map((x) => x.kind)).toEqual(['over']);
    expect(w[0].message).toContain('2 of 2');
    expect(w[0].message).toContain('cart 3');
  });

  it('does not warn with kind over while the CG is still below expected', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(checkScan(data, '1234', T0 + 5 * MIN).some((x) => x.kind === 'over')).toBe(false);
  });

  it('warns with kind over when expected is 1 and one cart is already in', () => {
    let data = setExpected(emptyData(), '1234', 1);
    data = scan(data, '1234', T0, 'a1');
    expect(checkScan(data, '1234', T0 + 5 * MIN).map((x) => x.kind)).toEqual(['over']);
  });

  it('warns with kind recent when the last scan of the same CG was under 60 seconds ago', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const w = checkScan(data, '1234', T0 + 59_999);
    expect(w.map((x) => x.kind)).toEqual(['recent']);
  });

  it('does not warn with kind recent at exactly 60 seconds', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(checkScan(data, '1234', T0 + 60_000).some((x) => x.kind === 'recent')).toBe(false);
  });

  it('warns with kind recent for a scan at the same instant', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(checkScan(data, '1234', T0).map((x) => x.kind)).toEqual(['recent']);
  });

  it('reports the recent window in seconds', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const recent = checkScan(data, '1234', T0 + 30_000).find((x) => x.kind === 'recent');
    expect(recent?.message).toContain('scanned 30s ago');
  });

  it('ignores recent scans of a different CG', () => {
    const data = scan(emptyData(), '9999', T0, 'b1');
    expect(checkScan(data, '1234', T0 + 1_000)).toEqual([]);
  });

  it('does not warn with kind recent when the last scan is in the future', () => {
    const data = scan(emptyData(), '1234', T0 + MIN, 'a1');
    expect(checkScan(data, '1234', T0).some((x) => x.kind === 'recent')).toBe(false);
  });

  it('stacks over and recent warnings together in that order', () => {
    let data = setExpected(emptyData(), '1234', 1);
    data = scan(data, '1234', T0, 'a1');
    const w = checkScan(data, '1234', T0 + 10_000);
    expect(w.map((x) => x.kind)).toEqual(['over', 'recent']);
  });
});

// ---------------------------------------------------------------- undo / last / delete / update

describe('undoLastScan', () => {
  it('removes the most recently recorded scan by insertion order, not by time', () => {
    let data = scan(emptyData(), '1111', T0 + 10 * MIN, 'recorded-first');
    data = scan(data, '2222', T0, 'recorded-second');
    const undone = undoLastScan(data);
    expect(undone.scans.map((s) => s.id)).toEqual(['recorded-first']);
  });

  it('is a no-op on empty data and returns the same object', () => {
    const data = emptyData();
    expect(undoLastScan(data)).toBe(data);
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const before = structuredClone(data);
    undoLastScan(data);
    expect(data).toEqual(before);
  });

  it('leaves settings and meta untouched', () => {
    let data = setExpected(emptyData(), '1234', 3);
    data = scan(data, '1234', T0, 'a1', ['10'], 'big');
    const undone = undoLastScan(data);
    expect(undone.meta).toEqual(data.meta);
    expect(undone.settings).toEqual(data.settings);
  });
});

describe('lastScan', () => {
  it('returns the most recently inserted scan', () => {
    let data = scan(emptyData(), '1111', T0, 'a1');
    data = scan(data, '2222', T0 - MIN, 'b1');
    expect(lastScan(data)?.id).toBe('b1');
  });

  it('returns null on empty data', () => {
    expect(lastScan(emptyData())).toBeNull();
  });
});

describe('deleteScan', () => {
  it('removes only the scan with the given id', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    const next = deleteScan(data, 'a1');
    expect(next.scans.map((s) => s.id)).toEqual(['a2']);
  });

  it('is a no-op for an unknown id', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(deleteScan(data, 'missing').scans).toHaveLength(1);
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const before = structuredClone(data);
    deleteScan(data, 'a1');
    expect(data).toEqual(before);
  });
});

describe('updateScan', () => {
  it('normalizes a changed CG', () => {
    const data = scan(emptyData(), '1111', T0, 'a1');
    const next = updateScan(data, 'a1', { cg: ' ]Q3 9999 ' });
    expect(next.scans[0].cg).toBe('9999');
    expect(summarizeCg(next, '1111')).toBeNull();
    expect(summarizeCg(next, '9999')?.count).toBe(1);
  });

  it('sets both cg and rawCode when a scanned barcode is patched in', () => {
    const data = scan(emptyData(), '1111', T0, 'a1');
    const next = updateScan(data, 'a1', { cg: '  ]C1*80009876543*\r\n' });
    expect(next.scans[0].cg).toBe('6543');
    expect(next.scans[0].rawCode).toBe('80009876543');
  });

  it('sets rawCode to the typed 4 digits when a typed CG is patched in', () => {
    const data = addScan(emptyData(), { cg: '80001111111' }, T0, 'a1');
    const next = updateScan(data, 'a1', { cg: '2222' });
    expect(next.scans[0].cg).toBe('2222');
    expect(next.scans[0].rawCode).toBe('2222');
  });

  it('leaves rawCode alone when the patch has no cg', () => {
    const data = addScan(emptyData(), { cg: '80001234821' }, T0, 'a1');
    const next = updateScan(data, 'a1', { ops: ['20'] });
    expect(next.scans[0].cg).toBe('4821');
    expect(next.scans[0].rawCode).toBe('80001234821');
  });

  it('re-derives status when a scan moves into a CG that already has one cart', () => {
    let data = scan(emptyData(), '1111', T0, 'a1');
    data = scan(data, '2222', T0, 'b1');
    const next = updateScan(data, 'a1', { cg: '2222' });
    expect(summarizeCg(next, '2222')?.status).toBe('complete');
    expect(summarizeCg(next, '1111')).toBeNull();
  });

  it('re-derives completedAt when the scan time changes order', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + 50, 'a2');
    const next = updateScan(data, 'a1', { at: T0 + 100 });
    expect(summarizeCg(next, '1234')?.completedAt).toBe(T0 + 100);
  });

  it('cleans ops on update (standard first, deduped, trimmed)', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const next = updateScan(data, 'a1', { ops: [' 30', 'Rework', '10', '30'] });
    expect(next.scans[0].ops).toEqual(['10', '30', 'Rework']);
  });

  it('updates mc to a valid type', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(updateScan(data, 'a1', { mc: 'open' }).scans[0].mc).toBe('open');
  });

  it('turns an invalid mc into an empty string', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', [], 'big');
    expect(updateScan(data, 'a1', { mc: 'bogus' as McType }).scans[0].mc).toBe('');
  });

  it.each(['  ', '123', '12345', 'ABCD'])('throws for the invalid new CG %j', (cg) => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(() => updateScan(data, 'a1', { cg })).toThrow('invalid CG');
  });

  it('is a no-op for an unknown id', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    expect(updateScan(data, 'missing', { cg: '9999' }).scans[0].cg).toBe('1234');
  });

  it('does not mutate the input', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const before = structuredClone(data);
    updateScan(data, 'a1', { cg: '9999', ops: ['20'] });
    expect(data).toEqual(before);
  });
});

// ---------------------------------------------------------------- setMark / counts

describe('setMark', () => {
  function completedCg(): AppData {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    return data;
  }

  it('marks a complete CG as staged and records markAt', () => {
    const data = setMark(completedCg(), '1234', 'staged', T0 + 5 * MIN);
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('staged');
    expect(s?.markAt).toBe(T0 + 5 * MIN);
  });

  it('marks a complete CG as dispatched', () => {
    const data = setMark(completedCg(), '1234', 'dispatched', T0 + 5 * MIN);
    expect(summarizeCg(data, '1234')?.status).toBe('dispatched');
  });

  it('clears the mark when given null and returns status to complete', () => {
    let data = setMark(completedCg(), '1234', 'staged', T0 + 5 * MIN);
    data = setMark(data, '1234', null, T0 + 6 * MIN);
    const s = summarizeCg(data, '1234');
    expect(s?.status).toBe('complete');
    expect(s?.markAt).toBeNull();
    expect(data.meta['1234'].mark).toBeUndefined();
    expect(data.meta['1234'].markAt).toBeUndefined();
  });

  it('reverts a marked CG to pending when a scan is deleted, and a later re-completion is not silently re-marked', () => {
    let data = setMark(completedCg(), '1234', 'staged', T0 + 5 * MIN);
    data = deleteScan(data, 'a2');
    expect(summarizeCg(data, '1234')?.status).toBe('pending');
    expect(summarizeCg(data, '1234')?.markAt).toBeNull();

    data = scan(data, '1234', T0 + 7 * MIN, 'a3');
    expect(summarizeCg(data, '1234')?.status).toBe('complete');
    expect(summarizeCg(data, '1234')?.markAt).toBeNull();
  });

  it('ignores a mark made before the current completion', () => {
    // e.g. marked, a cart deleted, then completed again with a later scan
    const data = setMark(completedCg(), '1234', 'dispatched', T0 - MIN);
    expect(summarizeCg(data, '1234')?.status).toBe('complete');
  });

  it('does not mutate the input', () => {
    const data = completedCg();
    const before = structuredClone(data);
    setMark(data, '1234', 'staged', T0);
    expect(data).toEqual(before);
  });
});

describe('countByStatus and summarizeAll', () => {
  it('returns no summaries for empty data', () => {
    expect(summarizeAll(emptyData())).toEqual([]);
    expect(countByStatus([])).toEqual({ pending: 0, completed: 0, staged: 0, dispatched: 0 });
  });

  it('counts each status once per CG', () => {
    let data = scan(emptyData(), '1001', T0, 'p1'); // pending
    data = scan(data, '2002', T0, 'c1');
    data = scan(data, '2002', T0 + MIN, 'c2'); // complete
    data = scan(data, '3003', T0, 's1');
    data = scan(data, '3003', T0 + MIN, 's2');
    data = setMark(data, '3003', 'staged', T0 + 2 * MIN); // staged
    data = scan(data, '4004', T0, 'd1');
    data = scan(data, '4004', T0 + MIN, 'd2');
    data = setMark(data, '4004', 'dispatched', T0 + 2 * MIN); // dispatched
    expect(countByStatus(summarizeAll(data))).toEqual({
      pending: 1,
      completed: 1,
      staged: 1,
      dispatched: 1,
    });
  });

  it('summarizes each CG exactly once even when it has several scans', () => {
    let data = scan(emptyData(), '1234', T0, 'a1');
    data = scan(data, '1234', T0 + MIN, 'a2');
    data = scan(data, '1234', T0 + 2 * MIN, 'a3');
    expect(summarizeAll(data)).toHaveLength(1);
  });
});

describe('pendingList', () => {
  it('lists pending CGs oldest first by first scan', () => {
    let data = scan(emptyData(), '3333', T0 + 2 * MIN, 'c1');
    data = scan(data, '1111', T0, 'a1');
    data = scan(data, '2222', T0 + MIN, 'b1');
    expect(pendingList(summarizeAll(data)).map((s) => s.cg)).toEqual(['1111', '2222', '3333']);
  });

  it('excludes complete and marked CGs', () => {
    let data = scan(emptyData(), '1111', T0, 'a1');
    data = scan(data, '1111', T0 + MIN, 'a2'); // complete
    data = scan(data, '2222', T0, 'b1'); // pending
    expect(pendingList(summarizeAll(data)).map((s) => s.cg)).toEqual(['2222']);
  });
});

describe('completedList', () => {
  // Two completed CGs and one pending CG. Set up so that completion time and
  // last-scan time disagree: 1111 completes at T0+100 but has a later scan at T0+500.
  function fixture(): AppData {
    let data = setExpected(emptyData(), '1111', 2);
    data = scan(data, '1111', T0, 'a1');
    data = scan(data, '1111', T0 + 100, 'a2');
    data = scan(data, '1111', T0 + 500, 'a3');
    data = scan(data, '2222', T0 + 200, 'b1');
    data = scan(data, '2222', T0 + 300, 'b2');
    data = scan(data, '3333', T0 + 400, 'c1');
    return data;
  }

  it('orders completed CGs newest completion first, using completedAt rather than last scan', () => {
    const list = completedList(summarizeAll(fixture()), 'all');
    expect(list.map((s) => s.cg)).toEqual(['2222', '1111']);
  });

  it('excludes pending CGs from every filter', () => {
    const list = completedList(summarizeAll(fixture()), 'all');
    expect(list.map((s) => s.cg)).not.toContain('3333');
  });

  it("'active' returns only CGs that are complete and not marked", () => {
    const data = setMark(fixture(), '2222', 'staged', T0 + 900);
    const list = completedList(summarizeAll(data), 'active');
    expect(list.map((s) => s.cg)).toEqual(['1111']);
  });

  it("'staged' returns only staged CGs", () => {
    let data = setMark(fixture(), '2222', 'staged', T0 + 900);
    data = setMark(data, '1111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'staged').map((s) => s.cg)).toEqual(['2222']);
  });

  it("'dispatched' returns only dispatched CGs", () => {
    let data = setMark(fixture(), '2222', 'staged', T0 + 900);
    data = setMark(data, '1111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'dispatched').map((s) => s.cg)).toEqual(['1111']);
  });

  it("'all' includes active, staged and dispatched CGs", () => {
    let data = setMark(fixture(), '2222', 'staged', T0 + 900);
    data = setMark(data, '1111', 'dispatched', T0 + 901);
    expect(completedList(summarizeAll(data), 'all').map((s) => s.cg).sort()).toEqual(['1111', '2222']);
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
    let data = scan(emptyData(), '1235', T0 + 500, 'x1');
    data = scan(data, '1234', T0, 'x2');
    data = scan(data, '9999', T0 + 100, 'x3');
    return summarizeAll(data);
  }

  it('matches a substring of the CG', () => {
    const cgs = searchCgs(list(), '123').map((s) => s.cg);
    expect(cgs).toContain('1234');
    expect(cgs).toContain('1235');
    expect(cgs).not.toContain('9999');
  });

  it('ranks the more recently scanned match first when several match', () => {
    expect(searchCgs(list(), '123').map((s) => s.cg)).toEqual(['1235', '1234']);
  });

  it('finds an exact CG', () => {
    expect(searchCgs(list(), '1234').map((s) => s.cg)).toEqual(['1234']);
  });

  it('normalizes the query before matching', () => {
    expect(searchCgs(list(), '  *1234* ')[0].cg).toBe('1234');
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

  it('returns no results for a letter query, since CGs are digits only', () => {
    expect(searchCgs(list(), 'ab')).toEqual([]);
  });

  it('returns no results when nothing matches', () => {
    expect(searchCgs(list(), '7777')).toEqual([]);
  });

  describe('with scanned barcodes', () => {
    function barcodeList() {
      let data = addScan(emptyData(), { cg: '80001234821' }, T0, 'x1'); // key 4821, rawCode 80001234821
      data = scan(data, '1111', T0 + MIN, 'x2');
      return summarizeAll(data);
    }

    it('searches a full barcode by its CG key', () => {
      expect(searchCgs(barcodeList(), '80001234821').map((s) => s.cg)).toEqual(['4821']);
    });

    it('matches a substring that only appears in the stored rawCode', () => {
      expect(searchCgs(barcodeList(), '1234').map((s) => s.cg)).toEqual(['4821']);
    });

    it('still matches the CG key by substring', () => {
      expect(searchCgs(barcodeList(), '482').map((s) => s.cg)).toEqual(['4821']);
    });
  });

  it('breaks ties between equal matches by most recent scan first', () => {
    let data = scan(emptyData(), '1555', T0, 'a');
    data = scan(data, '1556', T0 + MIN, 'b');
    // Both CGs contain '155'; neither is an exact match, so recency decides.
    expect(searchCgs(summarizeAll(data), '155').map((s) => s.cg)).toEqual(['1556', '1555']);
  });
});

// ---------------------------------------------------------------- settings

describe('setAgingHours', () => {
  it('stores a positive finite aging limit', () => {
    expect(setAgingHours(emptyData(), 12).settings.agingHours).toBe(12);
  });

  it.each([0, -3, NaN, Infinity])('falls back to 24 hours for invalid value %s', (h) => {
    expect(setAgingHours(emptyData(), h).settings.agingHours).toBe(24);
  });
});

describe('setSticky', () => {
  it('stores ops, otherOn, otherText and mc, and leaves agingHours and scans alone', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const next = setSticky(data, { ops: ['30', '10'], otherOn: true, otherText: 'Rework', mc: 'small' });
    expect(next.settings).toEqual({
      agingHours: 24,
      ops: ['10', '30'],
      otherOn: true,
      otherText: 'Rework',
      mc: 'small',
    });
    expect(next.scans).toEqual(data.scans);
  });

  it('keeps only standard op codes, in display order', () => {
    const next = setSticky(emptyData(), { ops: ['60', 'Rework', '40', '10'] });
    expect(next.settings.ops).toEqual(['10', '60']);
  });

  it('clips otherText to 20 characters', () => {
    const next = setSticky(emptyData(), { otherText: 'y'.repeat(30) });
    expect(next.settings.otherText).toBe('y'.repeat(20));
  });

  it('cleans an invalid mc to an empty string', () => {
    const next = setSticky(emptyData(), { mc: 'bogus' as McType });
    expect(next.settings.mc).toBe('');
  });

  it('patches only the given fields and keeps the rest', () => {
    let data = setSticky(emptyData(), { ops: ['20'], mc: 'open' });
    data = setSticky(data, { otherOn: true });
    expect(data.settings.ops).toEqual(['20']);
    expect(data.settings.mc).toBe('open');
    expect(data.settings.otherOn).toBe(true);
  });

  it('does not mutate the input', () => {
    const data = emptyData();
    const before = structuredClone(data);
    setSticky(data, { ops: ['10'] });
    expect(data).toEqual(before);
  });
});

describe('emptyData', () => {
  it('returns a fresh empty structure with default settings', () => {
    expect(emptyData()).toEqual({
      version: 1,
      scans: [],
      meta: {},
      settings: { agingHours: 24, ops: [], otherOn: false, otherText: '', mc: '' },
    });
  });

  it('returns a new object each call so callers cannot share state', () => {
    const a = emptyData();
    const b = emptyData();
    expect(a).not.toBe(b);
    expect(a.scans).not.toBe(b.scans);
    expect(a.settings).not.toBe(b.settings);
    expect(a.settings.ops).not.toBe(b.settings.ops);
  });
});

// ---------------------------------------------------------------- export

describe('toCsv', () => {
  // CG 1111: two carts, completes at the second scan.
  // CG 2222: one cart, pending. Recorded later, so it sorts after 1111.
  function fixture(): AppData {
    let data = scan(emptyData(), '1111', T0, 'a1', ['10', '30'], 'big');
    data = scan(data, '1111', T0 + MIN, 'a2', ['10'], 'big');
    data = scan(data, '2222', T0 + 2 * MIN, 'b1', ['20'], 'open');
    return data;
  }

  it('has the header columns, with raw_code after scanned_at_utc', () => {
    expect(CSV_HEADER).toEqual([
      'cg',
      'cart_no',
      'scanned_at_utc',
      'raw_code',
      'ops',
      'mc_type',
      'cg_carts_received',
      'cg_carts_expected',
      'cg_status',
      'cg_completed_at_utc',
      'cg_marked_at_utc',
    ]);
  });

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

  it('writes the expected values for a complete CG row, with ops joined by ; and the mc label', () => {
    const row = toCsv(fixture()).split('\r\n')[1];
    expect(row).toBe(['1111', '1', iso(T0), '1111', '10;30', 'Big MC', '2', '2', 'complete', iso(T0 + MIN), ''].join(','));
  });

  it('writes an empty completed_at for a pending CG and the Open MC label', () => {
    const row = toCsv(fixture()).split('\r\n')[3];
    expect(row).toBe(['2222', '1', iso(T0 + 2 * MIN), '2222', '20', 'Open MC', '1', '2', 'pending', '', ''].join(','));
  });

  it('writes empty ops and mc_type cells for a scan with neither', () => {
    const data = scan(emptyData(), '1234', T0, 'a1');
    const cells = toCsv(data).split('\r\n')[1].split(',');
    expect(cells[4]).toBe('');
    expect(cells[5]).toBe('');
  });

  it('writes the staged status and marked_at timestamp', () => {
    const data = setMark(fixture(), '1111', 'staged', T0 + 5 * MIN);
    const row = toCsv(data).split('\r\n')[1];
    const cells = row.split(',');
    expect(cells[8]).toBe('staged');
    expect(cells[10]).toBe(iso(T0 + 5 * MIN));
  });

  it('groups rows by CG oldest CG first and numbers carts 1..n per CG', () => {
    let data = scan(emptyData(), '2222', T0, 'b1');
    data = scan(data, '1111', T0 + MIN, 'a1');
    data = scan(data, '1111', T0 + 2 * MIN, 'a2');
    data = scan(data, '1111', T0 + 3 * MIN, 'a3');
    const rows = toCsv(data).split('\r\n').slice(1).filter((l) => l !== '');
    const cgAndCart = rows.map((r) => {
      const c = r.split(',');
      return `${c[0]}#${c[1]}`;
    });
    expect(cgAndCart).toEqual(['2222#1', '1111#1', '1111#2', '1111#3']);
  });

  it('writes the full scanned code in raw_code and the last 4 digits in cg', () => {
    const data = addScan(emptyData(), { cg: '80001234821', ops: ['10'] }, T0, 'a1');
    const cells = toCsv(data).split('\r\n')[1].split(',');
    expect(cells[0]).toBe('4821');
    expect(cells[3]).toBe('80001234821');
  });

  it('quotes an ops text that contains a comma', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', ['Bay 1, north']);
    const row = toCsv(data).split('\r\n')[1];
    expect(row).toContain('"Bay 1, north"');
  });

  it('doubles embedded double quotes inside a quoted cell', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', ['Bay "N", east']);
    const row = toCsv(data).split('\r\n')[1];
    expect(row).toContain('"Bay ""N"", east"');
  });

  it('leaves a plain ops value unquoted', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', ['30']);
    expect(toCsv(data).split('\r\n')[1].split(',')[4]).toBe('30');
  });

  it.each(['=', '+', '-', '@'])(
    'prefixes a free-text op starting with %s with a single quote (CSV injection guard)',
    (lead) => {
      const text = `${lead}1+1`;
      const data = scan(emptyData(), '1234', T0, 'a1', [text]);
      const cell = toCsv(data).split('\r\n')[1].split(',')[4];
      expect(cell).toBe(`'${text}`);
    },
  );

  it('prefixes a formula-looking op that also contains quotes and still quotes the cell', () => {
    const data = scan(emptyData(), '1234', T0, 'a1', ['=HYPERLINK("x")']);
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
