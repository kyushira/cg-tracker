import { describe, it, expect } from 'vitest';
import { emptyData, summarizeCg, type AppData } from './domain';
import {
  blockText,
  changeExpected,
  editScan,
  mark,
  moveCg,
  occupancy,
  placementText,
  receive,
  removeScan,
  setSlotsPerRow,
  stagingMap,
  stagingStats,
} from './staging';

// Fixed clock values. Never Date.now() in these tests.
const NOW = 1_700_000_000_000;
const MIN = 60_000;

// Receives one cart and returns the new data.
function recv(d: AppData, cg: string, at: number, id: string): AppData {
  return receive(d, { cg }, at, id).data;
}

// Receives two carts for a CG (a married pair) at `at` and `at + 1 min`.
function pair(d: AppData, cg: string, at: number): AppData {
  return recv(recv(d, cg, at, `${cg}-${at}-a`), cg, at + MIN, `${cg}-${at}-b`);
}

function slotOf(d: AppData, id: string): string | undefined {
  return d.scans.find((s) => s.id === id)?.slot;
}

function blockOf(d: AppData, cg: string) {
  return d.meta[cg]?.block;
}

// ---------------------------------------------------------------- first and second scan

describe('staging: first and second cart of a CG', () => {
  it('gives the first cart of a new CG the first two slots of row A and reports its partner', () => {
    const { data, placement } = receive(emptyData(), { cg: '1001' }, NOW, 'a1');
    expect(blockOf(data, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(slotOf(data, 'a1')).toBe('A1');
    expect(placement).toEqual({ slot: 'A1', partners: ['A2'] });
    expect(placementText(placement!, 1)).toBe('Put in A1 · partner → A2');
  });

  it('puts the second cart of the same CG in the partner slot', () => {
    const first = recv(emptyData(), '1001', NOW, 'a1');
    const { data, placement } = receive(first, { cg: '1001' }, NOW + MIN, 'a2');
    expect(slotOf(data, 'a1')).toBe('A1');
    expect(slotOf(data, 'a2')).toBe('A2');
    expect(placement?.partners).toEqual(['A1']);
    expect(placementText(placement!, 2)).toBe('Put in A2, next to its partner');
  });

  it('gives a second CG the next free adjacent pair in row A', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = pair(d, '1002', NOW + 10 * MIN);
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 3, size: 2 });
  });

  it('never splits a pair across rows: the sixth pair goes to B1+B2, not A11+A12', () => {
    let d = emptyData();
    for (let i = 1; i <= 5; i++) d = pair(d, String(1000 + i), NOW + i * 10 * MIN);
    expect(blockOf(d, '1005')).toEqual({ row: 'A', start: 9, size: 2 });
    d = pair(d, '1006', NOW + 60 * MIN);
    expect(blockOf(d, '1006')).toEqual({ row: 'B', start: 1, size: 2 });
    expect(blockText(blockOf(d, '1006')!)).toBe('B1+B2');
  });

  it('shrinks a block to one slot when its CG is changed to expect 1, freeing the other slot', () => {
    let d = recv(emptyData(), '1001', NOW, 'a1');
    d = changeExpected(d, '1001', 1);
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 1 });
    d = pair(d, '1002', NOW + 5 * MIN);
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 2, size: 2 });
  });

  it('holds three adjacent slots in one row for a CG expecting 3', () => {
    let d = recv(emptyData(), '1001', NOW, 'a1');
    d = changeExpected(d, '1001', 3);
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 3 });
    expect(blockText(blockOf(d, '1001')!)).toBe('A1+A2+A3');
    expect(stagingStats(d).used).toBe(3);
    d = pair(d, '1002', NOW + 5 * MIN);
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 4, size: 2 });
  });
});

// ---------------------------------------------------------------- overflow

describe('staging: overflow past the normal slots', () => {
  // Ten pairs fill A1..A10 and B1..B10 (row A's A11 and row B's B11 are single leftovers).
  function tenPairs(): AppData {
    let d = emptyData();
    for (let i = 1; i <= 10; i++) d = pair(d, String(1000 + i), NOW + i * 10 * MIN);
    return d;
  }

  it('spills the 11th pair into one row past slot 11, as A12+A13', () => {
    const d = pair(tenPairs(), '1011', NOW + 200 * MIN);
    const b = blockOf(d, '1011')!;
    expect(b.size).toBe(2);
    expect(b.start).toBeGreaterThan(11);
    expect(b).toEqual({ row: 'A', start: 12, size: 2 });
    // A11 and B11 stay free (a pair can't straddle into overflow), so 22 used = not over yet
    expect(stagingStats(d)).toEqual({ used: 22, capacity: 22, over: 0 });
  });

  it('sends the 12th pair to the other row overflow, B12+B13', () => {
    let d = pair(tenPairs(), '1011', NOW + 200 * MIN);
    d = pair(d, '1012', NOW + 210 * MIN);
    expect(blockOf(d, '1012')).toEqual({ row: 'B', start: 12, size: 2 });
    expect(stagingStats(d)).toEqual({ used: 24, capacity: 22, over: 2 }); // "Staging 24/22 · over by 2"
  });

  it('stagingMap extends each row past 11 and marks overflow cells over:true', () => {
    let d = pair(tenPairs(), '1011', NOW + 200 * MIN);
    d = pair(d, '1012', NOW + 210 * MIN);
    const map = stagingMap(d);
    expect(map.A).toHaveLength(13);
    expect(map.B).toHaveLength(13);
    expect(map.A[10]).toMatchObject({ label: 'A11', over: false, cg: null });
    expect(map.A[11]).toMatchObject({ label: 'A12', over: true, cg: '1011', filled: true });
    expect(map.A[12]).toMatchObject({ label: 'A13', over: true, cg: '1011', filled: true });
    expect(map.B[11]).toMatchObject({ label: 'B12', over: true, cg: '1012', filled: true });
  });
});

// ---------------------------------------------------------------- capacity

describe('staging: slots per row', () => {
  it('reports the default capacity of 2 rows x 11 slots for empty data', () => {
    expect(stagingStats(emptyData())).toEqual({ used: 0, capacity: 22, over: 0 });
  });

  it('setSlotsPerRow changes the capacity and the number of cells per row', () => {
    const d = setSlotsPerRow(emptyData(), 20);
    expect(d.settings.slotsPerRow).toBe(20);
    expect(stagingStats(d).capacity).toBe(40);
    expect(stagingMap(d).A).toHaveLength(20);
  });

  it.each([0, 61, NaN])('ignores an invalid slotsPerRow of %s', (v) => {
    const d = emptyData();
    expect(setSlotsPerRow(d, v)).toBe(d);
  });
});

// ---------------------------------------------------------------- staged / dispatched

describe('staging: staged and dispatched marks', () => {
  it('keeps the block occupied when a CG is marked staged', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = mark(d, '1001', 'staged', NOW + 5 * MIN);
    expect(occupancy(d).get('A1')).toBe('1001');
    expect(occupancy(d).get('A2')).toBe('1001');
    expect(stagingStats(d).used).toBe(2);
    expect(stagingMap(d).A[0]).toMatchObject({ cg: '1001', filled: true });
  });

  it('frees the slots when a CG is marked dispatched, so a new CG can take them', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = mark(d, '1001', 'dispatched', NOW + 5 * MIN);
    expect(occupancy(d).has('A1')).toBe(false);
    expect(occupancy(d).has('A2')).toBe(false);
    expect(stagingStats(d).used).toBe(0);
    d = pair(d, '1002', NOW + 10 * MIN);
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 1, size: 2 });
  });

  it('un-dispatching a CG whose slots were not reused keeps the same block', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = mark(d, '1001', 'dispatched', NOW + 5 * MIN);
    d = mark(d, '1001', null, NOW + 6 * MIN);
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(slotOf(d, '1001-' + NOW + '-a')).toBe('A1');
  });

  it('un-dispatching takes slots again, moving to a free block if they were reused', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = mark(d, '1001', 'dispatched', NOW + 5 * MIN);
    d = pair(d, '1002', NOW + 10 * MIN); // reuses A1+A2
    d = mark(d, '1001', null, NOW + 20 * MIN);
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 3, size: 2 });
    expect(slotOf(d, `1001-${NOW}-a`)).toBe('A3');
    expect(slotOf(d, `1001-${NOW}-b`)).toBe('A4');
  });
});

// ---------------------------------------------------------------- removing carts

describe('staging: removing carts', () => {
  it('removing the only cart of a CG drops its block', () => {
    let d = recv(emptyData(), '1001', NOW, 'a1');
    d = removeScan(d, 'a1');
    expect(blockOf(d, '1001')).toBeUndefined();
    expect(stagingStats(d).used).toBe(0);
  });

  it('removing the second cart keeps the block, the first cart keeps its slot, and the second slot is reserved again', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = removeScan(d, `1001-${NOW}-b`);
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(slotOf(d, `1001-${NOW}-a`)).toBe('A1');
    expect(stagingMap(d).A[0]).toMatchObject({ cg: '1001', filled: true });
    expect(stagingMap(d).A[1]).toMatchObject({ cg: '1001', filled: false });
  });

  it('removing the first cart of a 2/2 CG leaves the second cart in its original slot', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = removeScan(d, `1001-${NOW}-a`);
    expect(slotOf(d, `1001-${NOW}-b`)).toBe('A2');
    expect(stagingMap(d).A[0]).toMatchObject({ cg: '1001', filled: false });
    expect(stagingMap(d).A[1]).toMatchObject({ cg: '1001', filled: true });
  });
});

// ---------------------------------------------------------------- moveCg

describe('staging: moveCg', () => {
  it('moves a CG to a free block and keeps each cart in its relative position', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = removeScan(d, `1001-${NOW}-a`); // second cart stays at A2 (offset 1)
    d = moveCg(d, '1001', { row: 'B', start: 5 });
    expect(blockOf(d, '1001')).toEqual({ row: 'B', start: 5, size: 2 });
    expect(slotOf(d, `1001-${NOW}-b`)).toBe('B6');
  });

  it('moves a pair as a unit, first cart to the first slot', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = moveCg(d, '1001', { row: 'B', start: 5 });
    expect(slotOf(d, `1001-${NOW}-a`)).toBe('B5');
    expect(slotOf(d, `1001-${NOW}-b`)).toBe('B6');
  });

  it('throws when the target slots are taken', () => {
    let d = pair(emptyData(), '1001', NOW); // A1+A2
    d = pair(d, '1002', NOW + 10 * MIN); // A3+A4
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 3, size: 2 });
    expect(() => moveCg(d, '1001', { row: 'A', start: 3 })).toThrow('taken');
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
  });

  it('throws for a start below 1', () => {
    const d = pair(emptyData(), '1001', NOW);
    expect(() => moveCg(d, '1001', { row: 'B', start: 0 })).toThrow('invalid slot');
  });
});

// ---------------------------------------------------------------- editScan

describe('staging: editScan re-keying a cart', () => {
  it('moves a cart re-keyed to another CG out of the old block and into the new CG block', () => {
    let d = pair(emptyData(), '1001', NOW);
    d = recv(d, '1002', NOW + 20 * MIN, 'y1'); // 1002 block A3+A4, y1 in A3
    d = editScan(d, `1001-${NOW}-b`, { cg: '1002' });

    const moved = d.scans.find((s) => s.id === `1001-${NOW}-b`)!;
    expect(moved.cg).toBe('1002');
    expect(moved.slot).toBe('A4');
    expect(slotOf(d, 'y1')).toBe('A3');
    expect(blockOf(d, '1002')).toEqual({ row: 'A', start: 3, size: 2 });

    // The old CG keeps its block with its remaining cart in A1, A2 reserved again.
    expect(blockOf(d, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(slotOf(d, `1001-${NOW}-a`)).toBe('A1');
    expect(stagingMap(d).A[1]).toMatchObject({ cg: '1001', filled: false });
  });
});

// ---------------------------------------------------------------- old data

describe('staging: data saved before the staging map', () => {
  // One cart, no block, no slot: what a save from before the staging map looks like.
  function oldData(): AppData {
    return {
      ...emptyData(),
      scans: [{ id: 'o1', cg: '1001', rawCode: '1001', at: NOW, ops: [], mc: '' }],
      meta: { '1001': { expected: 2 } },
    };
  }

  it('summaries still work', () => {
    const s = summarizeCg(oldData(), '1001');
    expect(s?.count).toBe(1);
    expect(s?.status).toBe('pending');
  });

  it('stagingMap shows nothing for it', () => {
    const d = oldData();
    expect(stagingMap(d).A.every((c) => c.cg === null)).toBe(true);
    expect(stagingMap(d).B.every((c) => c.cg === null)).toBe(true);
    expect(stagingStats(d).used).toBe(0);
  });

  it('a new scan assigns a block and gives both carts slots', () => {
    const { data, placement } = receive(oldData(), { cg: '1001' }, NOW + MIN, 'n2');
    expect(blockOf(data, '1001')).toEqual({ row: 'A', start: 1, size: 2 });
    expect(slotOf(data, 'o1')).toBe('A1');
    expect(slotOf(data, 'n2')).toBe('A2');
    expect(placementText(placement!, 2)).toBe('Put in A2, next to its partner');
  });
});
