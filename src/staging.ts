// Staging map: 2 rows (A, B) of N MC slots (default 11). Pure functions over
// AppData, like domain.ts.
//
// Model
// - meta[cg].block = {row, start, size} reserves adjacent slots in ONE row, so
//   a married pair always sits side by side (A5+A6), never across rows.
// - Each scan stores the slot its cart went into (scan.slot).
// - A CG holds its block until it is marked Dispatched. Nothing frees slots on
//   its own; removing every scan of a CG (undo/delete) drops its reservation.
// - When the normal slots are full, numbering continues past N (A12, A13...).
//
// The App calls receive/removeScan/changeExpected/mark/editScan/moveCg instead
// of the raw domain updates so the slots always stay consistent.

import {
  addScan,
  deleteScan,
  expectedFor,
  scansFor,
  setExpected,
  setMark,
  summarizeCg,
  updateScan,
  type AppData,
  type ArchiveMark,
  type Block,
  type Row,
  type Scan,
  type ScanInput,
} from './domain';

export const ROWS: Row[] = ['A', 'B'];
export const DEFAULT_SLOTS_PER_ROW = 11;
export const MAX_SLOTS_PER_ROW = 60;

export function slotsPerRow(d: AppData): number {
  const n = d.settings.slotsPerRow;
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS_PER_ROW ? n : DEFAULT_SLOTS_PER_ROW;
}

export function setSlotsPerRow(d: AppData, n: number): AppData {
  const v = Math.round(n);
  if (!(v >= 1 && v <= MAX_SLOTS_PER_ROW)) return d;
  return { ...d, settings: { ...d.settings, slotsPerRow: v } };
}

export const slotLabel = (row: Row, n: number): string => `${row}${n}`;

export function parseSlot(s: string | undefined): { row: Row; n: number } | null {
  const m = s ? /^([AB])(\d+)$/.exec(s) : null;
  return m ? { row: m[1] as Row, n: Number(m[2]) } : null;
}

export function blockSlots(b: Block): string[] {
  return Array.from({ length: b.size }, (_, i) => slotLabel(b.row, b.start + i));
}

/** "A5+A6" */
export function blockText(b: Block): string {
  return blockSlots(b).join('+');
}

/** A CG holds its slots while it has carts and isn't dispatched. */
export function holdsSlots(d: AppData, cg: string): boolean {
  const s = summarizeCg(d, cg);
  return !!s && s.status !== 'dispatched';
}

/** Slot label -> CG for every CG holding slots (optionally ignoring one CG). */
export function occupancy(d: AppData, except?: string): Map<string, string> {
  const occ = new Map<string, string>();
  for (const [cg, m] of Object.entries(d.meta)) {
    if (!m?.block || cg === except || !holdsSlots(d, cg)) continue;
    for (const l of blockSlots(m.block)) if (!occ.has(l)) occ.set(l, cg);
  }
  return occ;
}

function fits(occ: Map<string, string>, row: Row, start: number, size: number): boolean {
  for (let i = 0; i < size; i++) if (occ.has(slotLabel(row, start + i))) return false;
  return true;
}

/**
 * Free blocks of `size` adjacent slots: first every fit inside the normal
 * slots (row A left to right, then row B), then one overflow position per row
 * past the normal slots (lowest number first, row A on a tie, so overflow
 * alternates A12+A13, B12+B13, A14+A15...). Never empty.
 */
export function freeBlocks(d: AppData, size: number, except?: string, limit = Infinity): Block[] {
  const occ = occupancy(d, except);
  const n = slotsPerRow(d);
  const out: Block[] = [];
  for (const row of ROWS) {
    for (let s = 1; s + size - 1 <= n; s++) {
      if (fits(occ, row, s, size)) {
        out.push({ row, start: s, size });
        if (out.length >= limit) return out;
      }
    }
  }
  const over = ROWS.map((row) => {
    let s = n + 1;
    while (!fits(occ, row, s, size)) s++;
    return { row, start: s, size };
  }).sort((a, b) => a.start - b.start);
  return [...out, ...over].slice(0, limit);
}

/** Slots a CG needs: expected carts, carts received, and never fewer than where its carts already sit. */
export function slotsNeeded(d: AppData, cg: string): number {
  const scans = scansFor(d, cg);
  const b = d.meta[cg]?.block;
  let reach = 0;
  if (b) {
    for (const s of scans) {
      const p = parseSlot(s.slot);
      if (p && p.row === b.row && p.n >= b.start && p.n < b.start + b.size) reach = Math.max(reach, p.n - b.start + 1);
    }
  }
  return Math.max(expectedFor(d, cg), scans.length, reach);
}

/** Put the CG's carts into `block`, keeping each cart's position in its old block where possible. */
function layout(d: AppData, cg: string, block: Block): AppData {
  const scans = scansFor(d, cg);
  const old = d.meta[cg]?.block;
  const used = new Set<number>();
  const off = new Map<string, number>();
  for (const s of scans) {
    const p = parseSlot(s.slot);
    if (!old || !p || p.row !== old.row) continue;
    const o = p.n - old.start;
    if (o >= 0 && o < block.size && !used.has(o)) {
      used.add(o);
      off.set(s.id, o);
    }
  }
  for (const s of scans) {
    if (off.has(s.id)) continue;
    let o = 0;
    while (used.has(o)) o++;
    used.add(o);
    off.set(s.id, o);
  }
  return {
    ...d,
    meta: { ...d.meta, [cg]: { ...d.meta[cg], block } },
    scans: d.scans.map((s) => (off.has(s.id) ? { ...s, slot: slotLabel(block.row, block.start + off.get(s.id)!) } : s)),
  };
}

/** Bring one CG's slots up to date after any change to it. */
function place(d: AppData, cg: string): AppData {
  if (scansFor(d, cg).length === 0) {
    if (!d.meta[cg]?.block) return d;
    const { block: _drop, ...rest } = d.meta[cg];
    return { ...d, meta: { ...d.meta, [cg]: rest } };
  }
  if (!holdsSlots(d, cg)) return d; // dispatched: the old block stays as history but holds nothing
  const size = slotsNeeded(d, cg);
  const b = d.meta[cg]?.block;
  const target = b && fits(occupancy(d, cg), b.row, b.start, size) ? { ...b, size } : freeBlocks(d, size, cg, 1)[0];
  return layout(d, cg, target);
}

// ---------------------------------------------------------------- updates

export interface Placement {
  slot: string; // where this cart goes
  partners: string[]; // the CG's other slots (filled or reserved)
}

/** Record a cart and give it a slot. */
export function receive(
  d: AppData,
  input: ScanInput,
  now: number,
  id: string,
): { data: AppData; placement: Placement | null } {
  let next = addScan(d, input, now, id);
  const cg = next.scans[next.scans.length - 1].cg;
  next = place(next, cg);
  const scan = next.scans.find((s) => s.id === id)!;
  const b = next.meta[cg]?.block;
  if (!scan.slot || !b || !holdsSlots(next, cg)) return { data: next, placement: null };
  return { data: next, placement: { slot: scan.slot, partners: blockSlots(b).filter((l) => l !== scan.slot) } };
}

export function placementText(p: Placement, count: number): string {
  if (p.partners.length === 0) return `Put in ${p.slot}`;
  if (count === 1) return `Put in ${p.slot} · partner${p.partners.length > 1 ? 's' : ''} → ${p.partners.join(', ')}`;
  return `Put in ${p.slot}, next to its partner${count > 2 ? 's' : ''}`;
}

/** Undo/delete a scan: frees that cart's slot (the CG keeps its reservation while it has carts). */
export function removeScan(d: AppData, id: string): AppData {
  const scan = d.scans.find((s) => s.id === id);
  if (!scan) return d;
  return place(deleteScan(d, id), scan.cg);
}

export function changeExpected(d: AppData, cg: string, n: number): AppData {
  return place(setExpected(d, cg, n), cg);
}

/** Staged keeps the slots; Dispatched frees them; un-dispatching takes slots again (moving if they were reused). */
export function mark(d: AppData, cg: string, m: ArchiveMark | null, now: number): AppData {
  return place(setMark(d, cg, m, now), cg);
}

export function editScan(d: AppData, id: string, patch: Partial<Pick<Scan, 'cg' | 'ops' | 'mc' | 'at'>>): AppData {
  const before = d.scans.find((s) => s.id === id);
  if (!before) return d;
  let next = updateScan(d, id, patch);
  const after = next.scans.find((s) => s.id === id)!;
  if (after.cg !== before.cg) {
    // Re-keyed to another CG: the cart leaves its old slot and joins the new CG's block.
    next = {
      ...next,
      scans: next.scans.map((s) => {
        if (s.id !== id) return s;
        const { slot: _drop, ...rest } = s;
        return rest;
      }),
    };
    next = place(next, before.cg);
  }
  return place(next, after.cg);
}

/** Manual override: move a CG to another free block starting at row/start. Throws if those slots are taken. */
export function moveCg(d: AppData, cg: string, to: { row: Row; start: number }): AppData {
  const size = slotsNeeded(d, cg);
  if (to.start < 1 || !fits(occupancy(d, cg), to.row, to.start, size)) {
    throw new Error(to.start < 1 ? 'invalid slot' : `slots ${slotLabel(to.row, to.start)}+ are taken`);
  }
  return layout(d, cg, { row: to.row, start: to.start, size });
}

// ---------------------------------------------------------------- map

export interface SlotCell {
  label: string;
  row: Row;
  n: number;
  cg: string | null;
  filled: boolean; // a cart is in it (otherwise reserved or empty)
  over: boolean; // past the normal slots
}

/** One cell per slot per row: the normal slots plus any overflow in use. */
export function stagingMap(d: AppData): Record<Row, SlotCell[]> {
  const n = slotsPerRow(d);
  const occ = occupancy(d);
  const filled = new Set(d.scans.filter((s) => s.slot && occ.get(s.slot) === s.cg).map((s) => s.slot!));
  const out = {} as Record<Row, SlotCell[]>;
  for (const row of ROWS) {
    let max = n;
    for (const l of occ.keys()) {
      const p = parseSlot(l)!;
      if (p.row === row) max = Math.max(max, p.n);
    }
    out[row] = Array.from({ length: max }, (_, i) => {
      const label = slotLabel(row, i + 1);
      return { label, row, n: i + 1, cg: occ.get(label) ?? null, filled: filled.has(label), over: i + 1 > n };
    });
  }
  return out;
}

/**
 * "Staging used/capacity · over by X": used counts filled and reserved slots;
 * over = used − capacity. (With an odd slot count the last slot of each row only
 * takes 1-cart CGs, so overflow can start while A11/B11 are still empty.)
 */
export function stagingStats(d: AppData): { used: number; capacity: number; over: number } {
  const capacity = ROWS.length * slotsPerRow(d);
  const used = occupancy(d).size;
  return { used, capacity, over: Math.max(0, used - capacity) };
}
