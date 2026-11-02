import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  agingLevel,
  checkScan,
  completedList,
  countByStatus,
  emptyData,
  formatDuration,
  isValidCg,
  lastScan,
  MAX_EXPECTED,
  MC_LABEL,
  MC_TYPES,
  MIN_EXPECTED,
  normalizeCg,
  OPS_OTHER_MAX,
  opsFromSticky,
  parseCg,
  pendingList,
  searchCgs,
  setAgingHours,
  setSticky,
  STANDARD_OPS,
  summarizeAll,
  summarizeCg,
  toCsv,
  type AgingLevel,
  type AppData,
  type ArchiveMark,
  type Block,
  type CgMeta,
  type CgStatus,
  type CgSummary,
  type McType,
  type Scan,
} from './domain';
import {
  blockText,
  changeExpected,
  editScan,
  freeBlocks,
  mark,
  moveCg,
  placementText,
  receive,
  removeScan,
  ROWS,
  setSlotsPerRow,
  slotsNeeded,
  slotsPerRow,
  stagingMap,
  stagingStats,
  type Placement,
} from './staging';
import { LocalStore, newId, storageKey, type DataStore } from './storage';
import { cue } from './feedback';
import { clock, fileStamp, fromLocalInput, toLocalInput } from './time';
import { IconCheck, IconClock, IconDownload, IconGrid, IconMore, IconScan, IconSearch, IconUndo, IconX, Logo } from './icons';

type Tab = 'receive' | 'staging' | 'search' | 'more';
type ListView = 'pending' | 'completed';
type DoneFilter = 'active' | ArchiveMark | 'all';
type DbFilter = 'all' | CgStatus;

interface Banner {
  kind: 'pending' | 'complete' | 'extra' | 'info' | 'error';
  cg: string;
  title: string;
  detail: string;
  where?: string; // "Put in A5 · partner → A6"
  count?: number;
  expected?: number;
  key: number;
}

interface ConfirmState {
  title: string;
  lines: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'warn' | 'danger' | 'go';
  onConfirm: () => void;
}

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

// ------------------------------------------------------------------ data hook

function useData(store: DataStore) {
  const [data, setData] = useState<AppData>(() => store.load());
  const ref = useRef(data);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Save first, then show: the screen never shows a scan that isn't stored.
  const commit = useCallback(
    (fn: (d: AppData) => AppData): AppData | null => {
      let next: AppData;
      try {
        next = fn(ref.current);
      } catch (e) {
        setSaveError(`Not changed: ${(e as Error).message}`);
        cue('warn');
        return null;
      }
      try {
        store.save(next);
      } catch (e) {
        setSaveError(`NOT SAVED: this device's storage failed (${(e as Error).message}). Export a CSV now.`);
        cue('warn');
        return null;
      }
      setSaveError(null);
      ref.current = next;
      setData(next);
      return next;
    },
    [store],
  );

  // Another tab on the same device changed the data: pick it up.
  useEffect(() => {
    const onStorage = () => {
      const fresh = store.load();
      ref.current = fresh;
      setData(fresh);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [store]);

  return { data, ref, commit, saveError };
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------ small parts

function Chip(props: { on: boolean; onClick: () => void; children: ReactNode; wide?: boolean; label?: string }) {
  return (
    <button
      type="button"
      className={`chip${props.on ? ' on' : ''}${props.wide ? ' wide' : ''}`}
      aria-pressed={props.on}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** One box per expected cart, filled for each cart received. */
function Slots({ count, expected }: { count: number; expected: number }) {
  const n = Math.max(count, expected);
  return (
    <span className="slots" aria-label={`${count} of ${expected} carts`}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`slot${i < count ? ' full' : ''}${i >= expected ? ' extra' : ''}`} />
      ))}
      <span className="slots-n">{count}/{expected}</span>
    </span>
  );
}

function ScanTags({ scan }: { scan: Pick<Scan, 'ops' | 'mc'> }) {
  if (scan.ops.length === 0 && !scan.mc) return <span className="tag none">No ops / MC</span>;
  return (
    <>
      {scan.ops.length > 0 && <span className="tag ops">OPS {scan.ops.join(' · ')}</span>}
      {scan.mc && <span className={`tag mc mc-${scan.mc}`}>{MC_LABEL[scan.mc]}</span>}
    </>
  );
}

/** Staging slots of a CG, while it holds them. */
function SlotTag({ s, meta }: { s: CgSummary; meta: CgMeta | undefined }) {
  if (s.status === 'dispatched' || !meta?.block) return null;
  return <span className="tag slotpos">{blockText(meta.block)}</span>;
}

function OpsPicker(props: {
  ops: string[];
  otherOn: boolean;
  otherText: string;
  onToggle: (op: string) => void;
  onOther: (on: boolean) => void;
  onOtherText: (t: string) => void;
}) {
  return (
    <div className="picker">
      <div className="chip-grid ops-grid" role="group" aria-label="Ops (pick any)">
        {STANDARD_OPS.map((o) => (
          <Chip key={o} on={props.ops.includes(o)} onClick={() => props.onToggle(o)} label={`Ops ${o}`}>
            {o}
          </Chip>
        ))}
        <Chip on={props.otherOn} wide onClick={() => props.onOther(!props.otherOn)} label="Ops others">
          Others
        </Chip>
      </div>
      {props.otherOn && (
        <input
          className="field other-input"
          value={props.otherText}
          maxLength={OPS_OTHER_MAX}
          onChange={(e) => props.onOtherText(e.target.value)}
          placeholder="Other ops (e.g. 45)"
          aria-label="Other ops"
        />
      )}
    </div>
  );
}

function McPicker(props: { mc: McType | ''; onPick: (m: McType | '') => void }) {
  return (
    <div className="chip-grid mc-grid" role="radiogroup" aria-label="MC type">
      {MC_TYPES.map((m) => (
        <Chip key={m} on={props.mc === m} onClick={() => props.onPick(props.mc === m ? '' : m)}>
          {MC_LABEL[m]}
        </Chip>
      ))}
    </div>
  );
}

function slotsOf(s: CgSummary): string {
  return s.scans.map((x) => x.slot).filter(Boolean).join(', ') || 'no slot yet';
}

// ------------------------------------------------------------------ app

export default function App() {
  const store = useMemo(() => new LocalStore(storageKey(window.location.pathname)), []);
  const { data, ref, commit, saveError } = useData(store);
  const now = useNow(30_000);

  const [tab, setTab] = useState<Tab>('receive');
  const [list, setList] = useState<ListView>('pending');
  const [doneFilter, setDoneFilter] = useState<DoneFilter>('active');
  const [dbFilter, setDbFilter] = useState<DbFilter>('all');
  const [cgInput, setCgInput] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [flash, setFlash] = useState<Banner | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [openCg, setOpenCg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const cgRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => summarizeAll(data), [data]);
  const counts = useMemo(() => countByStatus(all), [all]);
  const pending = useMemo(() => pendingList(all), [all]);
  const done = useMemo(() => completedList(all, doneFilter), [all, doneFilter]);
  const stats = useMemo(() => stagingStats(data), [data]);
  const last = lastScan(data);
  const st = data.settings;

  const focusScan = useCallback(() => {
    window.setTimeout(() => cgRef.current?.focus(), 0);
  }, []);

  // The COMPLETE flash covers the screen briefly; it never takes focus or taps.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);

  // A handheld scanner "types" into whatever has focus. On the Receive screen,
  // if nothing editable is focused (user tapped a chip or button), send the
  // keystrokes to the CG box. Other screens never receive carts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirm || openCg || tab !== 'receive') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      cgRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirm, openCg, tab]);

  // ---- receiving

  /** `rawCode` is the typed/scanned code; the scan is keyed by its CG (last 4 digits). */
  const record = (cg: string, rawCode: string) => {
    const s0 = ref.current.settings;
    let placement = null as Placement | null;
    const next = commit((d) => {
      const r = receive(d, { cg: rawCode, ops: opsFromSticky(s0), mc: s0.mc }, Date.now(), newId());
      placement = r.placement;
      return r.data;
    });
    if (!next) return setBanner(null);
    const s = summarizeCg(next, cg)!;
    const where = placement ? placementText(placement, s.count) : undefined;
    const key = Date.now();
    let b: Banner;
    if (s.count === s.expected) {
      b = { kind: 'complete', cg, title: 'COMPLETE', detail: 'All carts here. Marry up now.', where, count: s.count, expected: s.expected, key };
      setFlash(b);
      cue('complete');
    } else if (s.count > s.expected) {
      b = { kind: 'extra', cg, title: 'EXTRA CART', detail: `Saved as cart ${s.count}. Only ${s.expected} expected.`, where, count: s.count, expected: s.expected, key };
      cue('warn');
    } else {
      const left = s.expected - s.count;
      b = { kind: 'pending', cg, title: 'PENDING', detail: `Waiting for ${left} more cart${left > 1 ? 's' : ''}.`, where, count: s.count, expected: s.expected, key };
      cue('pending');
    }
    setBanner(b);
  };

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const { cg, rawCode, error } = parseCg(cgInput);
    setCgInput('');
    if (error) {
      cue('warn');
      setBanner({ kind: 'error', cg: rawCode, title: 'NOT SAVED', detail: error, key: Date.now() });
      return focusScan();
    }
    if (!cg) return focusScan();
    const t = Date.now();
    const s = summarizeCg(ref.current, cg);
    const recent = checkScan(ref.current, cg, t).filter((w) => w.kind === 'recent');

    // The CG already has carts but isn't complete: typing a CG is also how the
    // floor checks whether the partner has arrived, so never save silently.
    if (s && !s.complete) {
      const first = s.scans[0];
      const nth = s.count + 1;
      const info = [
        first.ops.length ? `ops ${first.ops.join('·')}` : 'no ops',
        first.mc ? MC_LABEL[first.mc] : 'no MC type',
        `waiting ${formatDuration(t - s.firstAt)}`,
      ].join(', ');
      cue('pending');
      setConfirm({
        title: `Is this the ${ordinal(nth)} MC?`,
        lines: [
          `CG ${cg} has ${s.count}/${s.expected} — ${s.count === 1 ? 'first half' : 'carts'} in ${slotsOf(s)} (${info}).`,
          ...recent.map((w) => w.message),
        ],
        confirmLabel: nth >= s.expected ? 'COMPLETE IT' : `SAVE MC ${nth}/${s.expected}`,
        cancelLabel: 'Just checking',
        tone: 'go',
        onConfirm: () => record(cg, rawCode),
      });
      return;
    }

    const warnings = checkScan(ref.current, cg, t);
    if (warnings.length === 0) {
      record(cg, rawCode);
      return focusScan();
    }
    cue('warn');
    setConfirm({
      title: `Check CG ${cg}`,
      lines: warnings.map((w) => w.message),
      confirmLabel: 'Save anyway',
      tone: 'warn',
      onConfirm: () => record(cg, rawCode),
    });
  };

  const onUndo = () => {
    if (!last) return;
    setConfirm({
      title: 'Undo last scan?',
      lines: [`CG ${last.cg} scanned at ${clock(last.at)}${last.slot ? ` (slot ${last.slot})` : ''}.`],
      confirmLabel: 'Undo scan',
      tone: 'danger',
      onConfirm: () => {
        if (!commit((d) => removeScan(d, last.id))) return;
        setBanner({ kind: 'info', cg: last.cg, title: 'UNDONE', detail: `Removed the last scan of CG ${last.cg}.`, key: Date.now() });
      },
    });
  };

  const closeConfirm = () => {
    setConfirm(null);
    if (!openCg && tab === 'receive') focusScan();
  };

  const sticky = (patch: Parameters<typeof setSticky>[1]) => commit((d) => setSticky(d, patch));

  // ---- export / clear

  const exportCsv = () => {
    const blob = new Blob([toCsv(ref.current)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cg-tracker-${fileStamp(Date.now())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const clearAll = () => {
    commit(() => emptyData());
    setBanner(null);
    setTab('receive');
  };

  const goList = (v: ListView) => {
    setTab('receive');
    setList(v);
  };

  const openSummary = openCg ? summarizeCg(data, openCg) : null;
  const openBlock = openCg ? data.meta[openCg]?.block : undefined;
  const moveOptions =
    openCg && openSummary && openSummary.status !== 'dispatched'
      ? freeBlocks(data, slotsNeeded(data, openCg), openCg, 30).filter(
          (b) => !openBlock || b.row !== openBlock.row || b.start !== openBlock.start,
        )
      : [];

  const tabs: [Tab, string, ReactNode, number | null][] = [
    ['receive', 'Receive', <IconScan key="i" />, counts.pending],
    ['staging', 'Staging', <IconGrid key="i" />, stats.over || null],
    ['search', 'Search', <IconSearch key="i" />, null],
    ['more', 'More', <IconMore key="i" />, null],
  ];

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div className="wordmark">
            <b>CG MARRY-UP</b>
            <span>Inbound tracker</span>
          </div>
        </div>
        <div className="counts" aria-live="polite">
          <button className="count pending" onClick={() => goList('pending')}>
            <b data-testid="count-pending">{counts.pending}</b>
            <span>Pending</span>
          </button>
          <button className="count done" onClick={() => goList('completed')}>
            <b data-testid="count-completed">{counts.completed}</b>
            <span>Completed</span>
          </button>
        </div>
      </header>
      <div className="hazard" aria-hidden />

      {saveError && <div className="save-error" role="alert">{saveError}</div>}

      {tab === 'receive' && (
        <section className="scan card" aria-label="Receive a cart" data-testid="receive-panel">
          {/* noValidate: `pattern` is only there for the iOS number pad; the browser's own
              validation must never swallow a scan (e.g. "]C1*1234*") before parseCg sees it. */}
          <form onSubmit={onScan} autoComplete="off" noValidate>
            <label htmlFor="cg" className="label">Scan CG</label>
            <input
              id="cg"
              ref={cgRef}
              className={`cg-input${banner?.kind === 'error' ? ' bad' : ''}`}
              value={cgInput}
              onChange={(e) => setCgInput(e.target.value)}
              placeholder="0000"
              inputMode="numeric"
              pattern="[0-9]*"
              enterKeyHint="done"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />

            <div className="label-row">
              <span className="label">Ops</span>
              <span className="label-hint">pick any · stays on</span>
            </div>
            <OpsPicker
              ops={st.ops}
              otherOn={st.otherOn}
              otherText={st.otherText}
              onToggle={(o) => sticky({ ops: st.ops.includes(o) ? st.ops.filter((x) => x !== o) : [...st.ops, o] })}
              onOther={(on) => sticky({ otherOn: on })}
              onOtherText={(t) => sticky({ otherText: t })}
            />

            <div className="label-row">
              <span className="label">MC type</span>
              <span className="label-hint">pick one · stays on</span>
            </div>
            <McPicker mc={st.mc} onPick={(m) => sticky({ mc: m })} />

            <div className="scan-actions">
              <button type="submit" className="btn primary big">Receive cart</button>
              <button type="button" className="btn ghost big" onClick={onUndo} disabled={!last} aria-label="Undo last scan">
                <IconUndo /> Undo
              </button>
            </div>
          </form>

          {banner && (
            <button
              key={banner.key}
              className={`banner ${banner.kind}`}
              data-testid="banner"
              onClick={() => (banner.kind === 'error' || banner.kind === 'info' ? focusScan() : setOpenCg(banner.cg))}
              aria-live="assertive"
            >
              <span className="banner-top">
                <span className="banner-title">
                  {banner.kind === 'complete' && <IconCheck className="banner-icon" />}
                  {banner.kind === 'error' && <IconX className="banner-icon" />}
                  {banner.title}
                  {banner.count !== undefined && ` ${banner.count}/${banner.expected}`}
                </span>
                {banner.count !== undefined && <Slots count={banner.count} expected={banner.expected!} />}
              </span>
              {banner.kind !== 'error' && <span className="banner-cg">CG {banner.cg}</span>}
              {banner.where && <span className="banner-slot" data-testid="banner-slot">{banner.where}</span>}
              <span className="banner-detail">{banner.detail}</span>
            </button>
          )}
        </section>
      )}

      <main className="panel">
        {tab === 'receive' && (
          <>
            <div className="segment" role="group" aria-label="Lists">
              <button className={list === 'pending' ? 'on' : ''} aria-pressed={list === 'pending'} onClick={() => setList('pending')}>
                Pending <i>{counts.pending}</i>
              </button>
              <button className={list === 'completed' ? 'on' : ''} aria-pressed={list === 'completed'} onClick={() => setList('completed')}>
                Completed <i>{counts.completed}</i>
              </button>
            </div>
            {list === 'pending' ? (
              <PendingView list={pending} meta={data.meta} now={now} agingHours={st.agingHours} onOpen={setOpenCg} />
            ) : (
              <CompletedView
                list={done}
                meta={data.meta}
                filter={doneFilter}
                counts={counts}
                onFilter={setDoneFilter}
                onOpen={setOpenCg}
                onMark={(cg, m) => commit((d) => mark(d, cg, m, Date.now()))}
              />
            )}
          </>
        )}
        {tab === 'staging' && <StagingView data={data} all={all} now={now} onOpen={setOpenCg} />}
        {tab === 'search' && (
          <DatabaseView
            all={all}
            meta={data.meta}
            query={query}
            onQuery={setQuery}
            filter={dbFilter}
            onFilter={setDbFilter}
            onOpen={setOpenCg}
            now={now}
          />
        )}
        {tab === 'more' && (
          <MoreView
            data={data}
            onAging={(h) => commit((d) => setAgingHours(d, h))}
            onSlots={(n) => commit((d) => setSlotsPerRow(d, n))}
            onExport={exportCsv}
            onClear={clearAll}
          />
        )}
      </main>

      <nav className="tabbar" role="tablist" aria-label="Views">
        {tabs.map(([t, label, icon, n]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {icon}
            <span>{label}</span>
            {n !== null && n > 0 && <i className={`tab-badge ${t}`}>{n}</i>}
          </button>
        ))}
      </nav>

      {flash && (
        <div className="flash" key={flash.key} aria-hidden data-testid="flash">
          <svg className="flash-check" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" />
            <path d="M34 62l17 17 36-38" />
          </svg>
          <div className="flash-title">COMPLETE</div>
          <div className="flash-cg">CG {flash.cg}</div>
          <div className="flash-sub">{flash.count}/{flash.expected} carts · MARRY UP</div>
          {flash.where && <div className="flash-slot">{flash.where}</div>}
        </div>
      )}

      {openCg && (
        <CgDetail
          cg={openCg}
          summary={openSummary}
          block={openBlock}
          moveOptions={moveOptions}
          now={now}
          agingHours={st.agingHours}
          onClose={() => {
            setOpenCg(null);
            if (tab === 'receive') focusScan();
          }}
          onExpected={(n) => commit((d) => changeExpected(d, openCg, n))}
          onMark={(m) => commit((d) => mark(d, openCg, m, Date.now()))}
          onMove={(b) => commit((d) => moveCg(d, openCg, b))}
          onSaveScan={(id, patch) => commit((d) => editScan(d, id, patch))}
          onDeleteScan={(scan) =>
            setConfirm({
              title: 'Delete this scan?',
              lines: [`CG ${scan.cg}, scanned ${clock(scan.at)}${scan.slot ? `, slot ${scan.slot}` : ''}.`],
              confirmLabel: 'Delete scan',
              tone: 'danger',
              onConfirm: () => commit((d) => removeScan(d, scan.id)),
            })
          }
        />
      )}

      {confirm && (
        <ConfirmDialog
          state={confirm}
          onCancel={closeConfirm}
          onConfirm={() => {
            confirm.onConfirm();
            closeConfirm();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ views

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

const AGE_TAG: Record<AgingLevel, string | null> = { ok: null, warn: 'AGING', late: 'LATE' };

function PendingView(props: {
  list: CgSummary[];
  meta: AppData['meta'];
  now: number;
  agingHours: number;
  onOpen: (cg: string) => void;
}) {
  const { list, meta, now, agingHours, onOpen } = props;
  if (list.length === 0) return <Empty>No pending CGs. Everything received is married up.</Empty>;
  return (
    <ul className="rows" data-testid="pending-list">
      {list.map((s) => {
        const first = s.scans[0];
        const level = agingLevel(s.firstAt, now, agingHours);
        return (
          <li key={s.cg}>
            <button className={`row st-pending age-${level}`} onClick={() => onOpen(s.cg)} data-cg={s.cg}>
              <span className="row-main">
                <span className="cg">{s.cg}</span>
                <Slots count={s.count} expected={s.expected} />
                <span className="wait">
                  {AGE_TAG[level] && <em className={`age-tag ${level}`}>{AGE_TAG[level]}</em>}
                  <IconClock className="wait-icon" />
                  {formatDuration(now - s.firstAt)}
                </span>
              </span>
              <span className="row-sub">
                <SlotTag s={s} meta={meta[s.cg]} />
                <span className="first">1st cart <span className="time">{clock(first.at, now)}</span></span>
                <ScanTags scan={first} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const FILTERS: [DoneFilter, string][] = [
  ['active', 'Active'],
  ['staged', 'Staged'],
  ['dispatched', 'Dispatched'],
  ['all', 'All'],
];

function CartLines({ s, now }: { s: CgSummary; now?: number }) {
  return (
    <span className="carts">
      {s.scans.map((x, i) => (
        <span className="cart-line" key={x.id}>
          <b>#{i + 1}</b>
          <span className="time">{clock(x.at, now)}</span>
          {x.slot && s.status !== 'dispatched' && <span className="tag slotpos">{x.slot}</span>}
          <ScanTags scan={x} />
        </span>
      ))}
    </span>
  );
}

function CompletedView(props: {
  list: CgSummary[];
  meta: AppData['meta'];
  filter: DoneFilter;
  counts: ReturnType<typeof countByStatus>;
  onFilter: (f: DoneFilter) => void;
  onOpen: (cg: string) => void;
  onMark: (cg: string, m: ArchiveMark | null) => void;
}) {
  const { list, filter, counts, onFilter, onOpen, onMark } = props;
  const n: Record<DoneFilter, number> = {
    active: counts.completed,
    staged: counts.staged,
    dispatched: counts.dispatched,
    all: counts.completed + counts.staged + counts.dispatched,
  };
  return (
    <>
      <div className="filters" role="group" aria-label="Filter completed">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {label} <i>{n[f]}</i>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <ul className="rows" data-testid="completed-list">
          {list.map((s) => (
            <li key={s.cg} className="done-item">
              <button className={`row st-${s.status}`} onClick={() => onOpen(s.cg)} data-cg={s.cg}>
                <span className="row-main">
                  <span className="cg">{s.cg}</span>
                  <Slots count={s.count} expected={s.expected} />
                  <span className={`pill ${s.status}`}>{s.status === 'complete' ? 'Complete' : s.status}</span>
                </span>
                <CartLines s={s} />
              </button>
              <div className="row-actions">
                {s.status === 'complete' ? (
                  <>
                    <button className="btn" onClick={() => onMark(s.cg, 'staged')}>Married &amp; staged</button>
                    <button className="btn" onClick={() => onMark(s.cg, 'dispatched')}>Dispatched</button>
                  </>
                ) : s.status === 'staged' ? (
                  <>
                    <button className="btn" onClick={() => onMark(s.cg, 'dispatched')}>Dispatched</button>
                    <button className="btn ghost" onClick={() => onMark(s.cg, null)}>Unmark</button>
                  </>
                ) : (
                  <button className="btn ghost" onClick={() => onMark(s.cg, null)}>
                    Unmark ({s.status} {s.markAt ? clock(s.markAt) : ''})
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function statusLabel(s: CgSummary): string {
  switch (s.status) {
    case 'pending':
      return `PENDING ${s.count}/${s.expected}`;
    case 'complete':
      return `COMPLETE ${s.count}/${s.expected}`;
    case 'staged':
      return 'MARRIED & STAGED';
    case 'dispatched':
      return 'DISPATCHED';
  }
}

function StagingView(props: { data: AppData; all: CgSummary[]; now: number; onOpen: (cg: string) => void }) {
  const { data, all, now, onOpen } = props;
  const stats = stagingStats(data);
  const map = stagingMap(data);
  const byCg = new Map(all.map((s) => [s.cg, s]));
  const unslotted = all.filter((s) => s.status !== 'dispatched' && !data.meta[s.cg]?.block);
  return (
    <>
      <div className={`staging-head${stats.over > 0 ? ' over' : ''}`} data-testid="staging-head">
        Staging {stats.used}/{stats.capacity}
        {stats.over > 0 && ` · over by ${stats.over}`}
      </div>
      <div className="legend" aria-hidden>
        <span><i className="lg married" />Married</span>
        <span><i className="lg waiting" />Waiting</span>
        <span><i className="lg reserved" />Reserved for partner</span>
        <span><i className="lg empty" />Empty</span>
      </div>
      {ROWS.map((row) => {
        const cells = map[row];
        return (
          <div className="srow" key={row} data-row={row}>
            <div className="srow-label">{row}</div>
            <div className="srow-scroll">
              <div className="srow-grid" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(30px, 1fr))` }}>
                {cells.map((c, i) => {
                  const s = c.cg ? byCg.get(c.cg) : undefined;
                  const prev = cells[i - 1];
                  const nxt = cells[i + 1];
                  const cls = [
                    'slotbox',
                    c.cg ? (c.filled ? 'filled' : 'reserved') : 'empty',
                    s && `st-${s.status}`,
                    s?.status === 'pending' && `age-${agingLevel(s.firstAt, now, data.settings.agingHours)}`,
                    c.over && 'over',
                    c.over && !prev?.over && 'over-first',
                    c.cg && prev?.cg === c.cg && 'join-l',
                    c.cg && nxt?.cg === c.cg && 'join-r',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  const inner = (
                    <>
                      <span className="sb-n">{c.n}</span>
                      {c.cg && <span className="sb-cg">{c.cg}</span>}
                    </>
                  );
                  return c.cg ? (
                    <button
                      key={c.label}
                      className={cls}
                      data-slot={c.label}
                      data-cg={c.cg}
                      onClick={() => onOpen(c.cg!)}
                      aria-label={`${c.label}: CG ${c.cg}, ${c.filled ? s?.status ?? '' : 'reserved for partner'}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div key={c.label} className={cls} data-slot={c.label} aria-label={`${c.label}: empty`}>
                      {inner}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      <p className="hint">Tap a slot to see the CG and move it. Slots are only freed when a CG is marked Dispatched.</p>
      {unslotted.length > 0 && (
        <div className="unslotted">
          <p className="hint">Received before the staging map (no slot yet), tap to assign:</p>
          <div className="move-grid">
            {unslotted.map((s) => (
              <button key={s.cg} className="btn small" onClick={() => onOpen(s.cg)}>{s.cg}</button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const DB_FILTERS: [DbFilter, string][] = [
  ['all', 'All'],
  ['pending', 'Pending'],
  ['complete', 'Complete'],
  ['staged', 'Staged'],
  ['dispatched', 'Dispatched'],
];

/** Read-only browser over every CG. Nothing here receives a cart. */
function DatabaseView(props: {
  all: CgSummary[];
  meta: AppData['meta'];
  query: string;
  onQuery: (q: string) => void;
  filter: DbFilter;
  onFilter: (f: DbFilter) => void;
  onOpen: (cg: string) => void;
  now: number;
}) {
  const { all, meta, query, onQuery, filter, onFilter, onOpen, now } = props;
  const q = normalizeCg(query);
  const base = q ? searchCgs(all, query) : [...all].sort((a, b) => b.lastAt - a.lastAt);
  const n: Record<DbFilter, number> = { all: base.length, pending: 0, complete: 0, staged: 0, dispatched: 0 };
  for (const s of base) n[s.status]++;
  const shown = base.filter((s) => filter === 'all' || s.status === filter);
  return (
    <>
      <p className="hint db-note">All CGs on this device, newest first. Read only: receive carts on the Receive screen.</p>
      <input
        className="field search-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find CG or barcode…"
        inputMode="numeric"
        aria-label="Search CG"
      />
      <div className="filters db-filters" role="group" aria-label="Filter by status">
        {DB_FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {label} <i>{n[f]}</i>
          </button>
        ))}
      </div>
      {shown.length === 0 && <Empty>{q ? `No CG matching ${q}.` : 'No CGs yet.'}</Empty>}
      <ul className="rows" data-testid="db-list">
        {shown.slice(0, 300).map((s) => {
          const lastScanOf = s.scans[s.scans.length - 1];
          return (
            <li key={s.cg}>
              <button className={`row st-${s.status}`} onClick={() => onOpen(s.cg)} data-cg={s.cg}>
                <span className="row-main">
                  <span className="cg">{s.cg}</span>
                  <Slots count={s.count} expected={s.expected} />
                  <span className={`pill ${s.status}`}>{s.status === 'complete' ? 'Complete' : s.status}</span>
                </span>
                <span className="row-sub">
                  <SlotTag s={s} meta={meta[s.cg]} />
                  <span className="first">last <span className="time">{clock(s.lastAt, now)}</span></span>
                  <ScanTags scan={lastScanOf} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length > 300 && <p className="hint small">Showing the newest 300. Search to narrow down.</p>}
    </>
  );
}

function MoreView(props: {
  data: AppData;
  onAging: (h: number) => void;
  onSlots: (n: number) => void;
  onExport: () => void;
  onClear: () => void;
}) {
  const { data, onAging, onSlots, onExport, onClear } = props;
  const [typed, setTyped] = useState('');
  const [hours, setHours] = useState(String(data.settings.agingHours));
  const [slots, setSlots] = useState(String(slotsPerRow(data)));
  const ok = typed.trim() === 'DELETE';
  return (
    <div className="more">
      <section className="card">
        <h3>Staging rows</h3>
        <p className="hint">MC slots in each row (rows A and B). Pairs past this number overflow (A12, A13…).</p>
        <label className="inline">
          Slots per row
          <input
            className="field"
            type="number"
            min={1}
            max={60}
            step={1}
            value={slots}
            onChange={(e) => setSlots(e.target.value)}
            onBlur={() => {
              onSlots(Number(slots));
              setSlots(String(Math.round(Number(slots)) >= 1 && Number(slots) <= 60 ? Math.round(Number(slots)) : slotsPerRow(data)));
            }}
            aria-label="Slots per row"
          />
        </label>
      </section>
      <section className="card">
        <h3>Aging alert</h3>
        <p className="hint">Pending CGs turn orange (AGING) at 75% of this time and red (LATE) once it has passed.</p>
        <label className="inline">
          Alert after
          <input
            className="field"
            type="number"
            min={1}
            step={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            onBlur={() => {
              const h = Number(hours);
              onAging(h);
              setHours(String(h > 0 ? h : data.settings.agingHours));
            }}
            aria-label="Aging hours"
          />
          hours
        </label>
      </section>
      <section className="card">
        <h3>Export</h3>
        <p className="hint">{data.scans.length} scans on this device. One CSV row per cart, with slot, ops and MC type.</p>
        <button className="btn primary big" onClick={onExport} disabled={data.scans.length === 0}>
          <IconDownload /> Download CSV
        </button>
      </section>
      <section className="card danger-zone">
        <h3>Clear all data</h3>
        <p className="hint">Deletes every scan on this device. Export a CSV first. Type DELETE to confirm.</p>
        <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" autoCapitalize="characters" />
        <button
          className="btn danger big"
          disabled={!ok}
          onClick={() => {
            onClear();
            setTyped('');
          }}
        >
          Clear all data
        </button>
      </section>
      <p className="hint small">Data is stored only in this browser on this device. Works offline.</p>
    </div>
  );
}

// ------------------------------------------------------------------ detail sheet

type ScanPatch = Partial<Pick<Scan, 'cg' | 'ops' | 'mc' | 'at'>>;

function CgDetail(props: {
  cg: string;
  summary: CgSummary | null;
  block: Block | undefined;
  moveOptions: Block[];
  now: number;
  agingHours: number;
  onClose: () => void;
  onExpected: (n: number) => void;
  onMark: (m: ArchiveMark | null) => void;
  onMove: (b: Block) => void;
  onSaveScan: (id: string, patch: ScanPatch) => void;
  onDeleteScan: (s: Scan) => void;
}) {
  const { cg, summary: s, block, moveOptions, now, agingHours, onClose, onExpected, onMark, onMove, onSaveScan, onDeleteScan } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    // Escape closes the sheet, unless a confirm dialog is on top of it (that one handles its own Escape).
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !editing && !document.querySelector('[data-testid=confirm]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={`CG ${cg}`}>
      <div className="sheet" data-testid="detail">
        <div className="sheet-head">
          <h2 className="cg">CG {cg}</h2>
          <button className="btn ghost" onClick={onClose} autoFocus aria-label="Close">
            <IconX /> Close
          </button>
        </div>
        {!s ? (
          <Empty>No scans left for this CG.</Empty>
        ) : (
          <>
            <div
              className={`status-big ${s.status} ${s.status === 'pending' ? `age-${agingLevel(s.firstAt, now, agingHours)}` : ''}`}
              data-testid="detail-status"
            >
              <span>{statusLabel(s)}</span>
              <Slots count={s.count} expected={s.expected} />
              {s.status === 'pending' && <small>waiting {formatDuration(now - s.firstAt)}</small>}
            </div>

            <div className="staging-info" data-testid="detail-slots">
              <span className="label">Staging slots</span>
              {s.status === 'dispatched' ? (
                <p className="hint">Dispatched: its slots are free again.</p>
              ) : block ? (
                <div className="slot-row">
                  <b className="slot-big">{blockText(block)}</b>
                  <button className="btn small" onClick={() => setMoving(!moving)} aria-expanded={moving}>
                    {moving ? 'Cancel move' : 'Move…'}
                  </button>
                </div>
              ) : (
                <div className="slot-row">
                  <p className="hint">No slot yet (received before the staging map).</p>
                  <button className="btn small" onClick={() => setMoving(!moving)} aria-expanded={moving}>
                    {moving ? 'Cancel' : 'Assign…'}
                  </button>
                </div>
              )}
              {moving && s.status !== 'dispatched' && (
                <div className="move-grid" role="group" aria-label="Free slots">
                  {moveOptions.map((b) => (
                    <button
                      key={`${b.row}${b.start}`}
                      className="btn small"
                      onClick={() => {
                        onMove(b);
                        setMoving(false);
                      }}
                    >
                      {blockText(b)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="stepper">
              <span>Carts expected</span>
              <button className="btn" aria-label="Fewer carts" disabled={s.expected <= MIN_EXPECTED} onClick={() => onExpected(s.expected - 1)}>−</button>
              <b data-testid="expected">{s.expected}</b>
              <button className="btn" aria-label="More carts" disabled={s.expected >= MAX_EXPECTED} onClick={() => onExpected(s.expected + 1)}>+</button>
            </div>

            {s.complete && (
              <div className="row-actions">
                {s.status === 'complete' ? (
                  <>
                    <button className="btn" onClick={() => onMark('staged')}>Married &amp; staged</button>
                    <button className="btn" onClick={() => onMark('dispatched')}>Dispatched</button>
                  </>
                ) : s.status === 'staged' ? (
                  <>
                    <button className="btn" onClick={() => onMark('dispatched')}>Dispatched</button>
                    <button className="btn ghost" onClick={() => onMark(null)}>Unmark staged</button>
                  </>
                ) : (
                  <button className="btn ghost" onClick={() => onMark(null)}>Unmark {s.status}</button>
                )}
              </div>
            )}

            <h3 className="label">Scan history</h3>
            <ol className="history">
              {s.scans.map((scan, i) =>
                editing === scan.id ? (
                  <EditScan
                    key={scan.id}
                    scan={scan}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => {
                      onSaveScan(scan.id, patch);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <li key={scan.id}>
                    <div className="history-main">
                      <b>Cart {i + 1}</b> <span className="time">{clock(scan.at, now)}</span>
                      {scan.slot && s.status !== 'dispatched' && <span className="tag slotpos">Slot {scan.slot}</span>}
                      {scan.rawCode !== scan.cg && <span className="raw">Barcode {scan.rawCode}</span>}
                      <div className="tags">
                        <ScanTags scan={scan} />
                      </div>
                    </div>
                    <div className="history-actions">
                      <button className="btn small" onClick={() => setEditing(scan.id)}>Edit</button>
                      <button className="btn small danger" onClick={() => onDeleteScan(scan)}>Delete</button>
                    </div>
                  </li>
                ),
              )}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

const isStd = (o: string) => (STANDARD_OPS as readonly string[]).includes(o);

function EditScan(props: { scan: Scan; onCancel: () => void; onSave: (patch: ScanPatch) => void }) {
  const { scan, onCancel, onSave } = props;
  const [cg, setCg] = useState(scan.cg);
  const [ops, setOps] = useState(scan.ops.filter(isStd));
  const initialOther = scan.ops.filter((o) => !isStd(o)).join(' ');
  const [otherOn, setOtherOn] = useState(initialOther !== '');
  const [otherText, setOtherText] = useState(initialOther === 'Others' ? '' : initialOther);
  const [mc, setMc] = useState<McType | ''>(scan.mc);
  const original = toLocalInput(scan.at);
  const [at, setAt] = useState(original);
  const ms = fromLocalInput(at);
  const parsed = parseCg(cg);
  const cgOk = !parsed.error && isValidCg(parsed.cg);
  const valid = cgOk && ms !== null;
  return (
    <li className="edit">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const patch: ScanPatch = { ops: opsFromSticky({ ops, otherOn, otherText }), mc };
          // Only re-key if the CG field was changed, so the stored barcode isn't replaced by its 4 digits.
          if (cg !== scan.cg) patch.cg = cg;
          // Only touch the time if it was edited (the input drops milliseconds,
          // and the local-time round trip is ambiguous on DST change nights).
          if (at !== original) patch.at = ms!;
          onSave(patch);
        }}
      >
        <label className="label">
          CG
          <input className={`field${cgOk ? '' : ' bad'}`} value={cg} onChange={(e) => setCg(e.target.value)} inputMode="numeric" pattern="[0-9]*" aria-label="Edit CG" />
        </label>
        {!cgOk && <p className="field-error">Enter the 4-digit CG or the full 8000… barcode.</p>}
        {cgOk && cg === scan.cg && scan.rawCode !== scan.cg && <p className="raw">Scanned barcode {scan.rawCode}</p>}
        {cgOk && cg !== scan.cg && parsed.rawCode !== parsed.cg && <p className="raw">Saves as CG {parsed.cg}</p>}
        <span className="label">Ops</span>
        <OpsPicker
          ops={ops}
          otherOn={otherOn}
          otherText={otherText}
          onToggle={(o) => setOps(ops.includes(o) ? ops.filter((x) => x !== o) : [...ops, o])}
          onOther={setOtherOn}
          onOtherText={setOtherText}
        />
        <span className="label">MC type</span>
        <McPicker mc={mc} onPick={setMc} />
        <label className="label">
          Time
          <input className="field" type="datetime-local" step={1} value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <div className="history-actions">
          <button type="submit" className="btn primary" disabled={!valid}>Save</button>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </li>
  );
}

// ------------------------------------------------------------------ confirm

/** Ignore taps/keys for this long after a dialog opens: a scanner that sends CR+LF
 *  would otherwise answer the dialog with its second Enter. */
const CONFIRM_ARM_MS = 350;

function ConfirmDialog(props: { state: ConfirmState; onCancel: () => void; onConfirm: () => void }) {
  const { state, onCancel, onConfirm } = props;
  const openedAt = useRef(performance.now());
  const armed = () => performance.now() - openedAt.current >= CONFIRM_ARM_MS;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const tone = state.tone ?? 'warn';
  return (
    <div className="sheet-backdrop confirm-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className={`confirm ${tone}`} data-testid="confirm">
        <h2 id="confirm-title">{state.title}</h2>
        {state.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <div className="confirm-actions">
          {/* Cancel is focused so a scanner Enter never confirms. */}
          <button className="btn big cancel" data-testid="confirm-cancel" onClick={() => armed() && onCancel()} autoFocus>
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button className={`btn big ${tone}`} data-testid="confirm-ok" onClick={() => armed() && onConfirm()}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
