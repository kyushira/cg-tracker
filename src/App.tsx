import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  addScan,
  agingLevel,
  checkScan,
  completedList,
  countByStatus,
  deleteScan,
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
  setExpected,
  setMark,
  setSticky,
  STANDARD_OPS,
  summarizeAll,
  summarizeCg,
  toCsv,
  updateScan,
  type AgingLevel,
  type AppData,
  type ArchiveMark,
  type CgSummary,
  type McType,
  type Scan,
  type ScanWarning,
} from './domain';
import { LocalStore, newId, storageKey, type DataStore } from './storage';
import { cue } from './feedback';
import { clock, fileStamp, fromLocalInput, toLocalInput } from './time';
import { IconCheck, IconClock, IconDownload, IconMore, IconSearch, IconUndo, IconX, Logo } from './icons';

type Tab = 'pending' | 'completed' | 'search' | 'more';
type DoneFilter = 'active' | ArchiveMark | 'all';

interface Banner {
  kind: 'pending' | 'complete' | 'extra' | 'info' | 'error';
  cg: string;
  title: string;
  detail: string;
  count?: number;
  expected?: number;
  key: number;
}

interface ConfirmState {
  title: string;
  lines: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

// ------------------------------------------------------------------ data hook

function useData(store: DataStore) {
  const [data, setData] = useState<AppData>(() => store.load());
  const ref = useRef(data);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Save first, then show: the screen never shows a scan that isn't stored.
  const commit = useCallback(
    (fn: (d: AppData) => AppData): AppData | null => {
      const next = fn(ref.current);
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

// ------------------------------------------------------------------ app

export default function App() {
  const store = useMemo(() => new LocalStore(storageKey(window.location.pathname)), []);
  const { data, ref, commit, saveError } = useData(store);
  const now = useNow(30_000);

  const [tab, setTab] = useState<Tab>('pending');
  const [doneFilter, setDoneFilter] = useState<DoneFilter>('active');
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
  const last = lastScan(data);
  const st = data.settings;

  const focusScan = useCallback(() => {
    window.setTimeout(() => cgRef.current?.focus(), 0);
  }, []);

  // The COMPLETE flash covers the screen briefly; it never takes focus or taps.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(t);
  }, [flash]);

  // A handheld scanner "types" into whatever has focus. If nothing editable is
  // focused (user tapped a chip, tab or button), send the keystrokes to the CG box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirm || openCg) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      cgRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirm, openCg]);

  // ---- receiving

  const record = (cg: string) => {
    const s0 = ref.current.settings;
    const next = commit((d) => addScan(d, { cg, ops: opsFromSticky(s0), mc: s0.mc }, Date.now(), newId()));
    if (!next) return setBanner(null);
    const s = summarizeCg(next, cg)!;
    const key = Date.now();
    let b: Banner;
    if (s.count === s.expected) {
      b = { kind: 'complete', cg, title: 'COMPLETE', detail: 'All carts here. Marry up now.', count: s.count, expected: s.expected, key };
      setFlash(b);
      cue('complete');
    } else if (s.count > s.expected) {
      b = { kind: 'extra', cg, title: 'EXTRA CART', detail: `Saved as cart ${s.count}. Only ${s.expected} expected.`, count: s.count, expected: s.expected, key };
      cue('warn');
    } else {
      const left = s.expected - s.count;
      b = { kind: 'pending', cg, title: 'PENDING', detail: `Stage it. Waiting for ${left} more cart${left > 1 ? 's' : ''}.`, count: s.count, expected: s.expected, key };
      cue('pending');
    }
    setBanner(b);
  };

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const { cg, error } = parseCg(cgInput);
    setCgInput('');
    if (!cg) return focusScan();
    if (error) {
      cue('warn');
      setBanner({ kind: 'error', cg, title: 'NOT SAVED', detail: error, key: Date.now() });
      return focusScan();
    }
    const warnings: ScanWarning[] = checkScan(ref.current, cg, Date.now());
    if (warnings.length === 0) {
      record(cg);
      return focusScan();
    }
    cue('warn');
    setConfirm({
      title: `Check CG ${cg}`,
      lines: warnings.map((w) => w.message),
      confirmLabel: 'Save anyway',
      onConfirm: () => record(cg),
    });
  };

  const onUndo = () => {
    if (!last) return;
    setConfirm({
      title: 'Undo last scan?',
      lines: [`CG ${last.cg} scanned at ${clock(last.at)}.`],
      confirmLabel: 'Undo scan',
      danger: true,
      onConfirm: () => {
        if (!commit((d) => deleteScan(d, last.id))) return;
        setBanner({ kind: 'info', cg: last.cg, title: 'UNDONE', detail: `Removed the last scan of CG ${last.cg}.`, key: Date.now() });
      },
    });
  };

  const closeConfirm = () => {
    setConfirm(null);
    if (!openCg) focusScan();
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
    setTab('pending');
  };

  const openSummary = openCg ? summarizeCg(data, openCg) : null;

  const tabs: [Tab, string, ReactNode, number | null][] = [
    ['pending', 'Pending', <IconClock key="i" />, counts.pending],
    ['completed', 'Completed', <IconCheck key="i" />, counts.completed],
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
          <button className="count pending" onClick={() => setTab('pending')}>
            <b data-testid="count-pending">{counts.pending}</b>
            <span>Pending</span>
          </button>
          <button className="count done" onClick={() => setTab('completed')}>
            <b data-testid="count-completed">{counts.completed}</b>
            <span>Completed</span>
          </button>
        </div>
      </header>
      <div className="hazard" aria-hidden />

      {saveError && <div className="save-error" role="alert">{saveError}</div>}

      <section className="scan card" aria-label="Receive a cart">
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
            <span className="banner-detail">{banner.detail}</span>
          </button>
        )}
      </section>

      <main className="panel">
        <h2 className="panel-title">{tabs.find((t) => t[0] === tab)![1]}</h2>
        {tab === 'pending' && (
          <PendingView list={pending} now={now} agingHours={st.agingHours} onOpen={setOpenCg} />
        )}
        {tab === 'completed' && (
          <CompletedView
            list={done}
            filter={doneFilter}
            counts={counts}
            onFilter={setDoneFilter}
            onOpen={setOpenCg}
            onMark={(cg, m) => commit((d) => setMark(d, cg, m, Date.now()))}
          />
        )}
        {tab === 'search' && <SearchView all={all} query={query} onQuery={setQuery} onOpen={setOpenCg} />}
        {tab === 'more' && (
          <MoreView data={data} onAging={(h) => commit((d) => setAgingHours(d, h))} onExport={exportCsv} onClear={clearAll} />
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
        </div>
      )}

      {openCg && (
        <CgDetail
          cg={openCg}
          summary={openSummary}
          now={now}
          agingHours={st.agingHours}
          onClose={() => {
            setOpenCg(null);
            focusScan();
          }}
          onExpected={(n) => commit((d) => setExpected(d, openCg, n))}
          onMark={(m) => commit((d) => setMark(d, openCg, m, Date.now()))}
          onSaveScan={(id, patch) => commit((d) => updateScan(d, id, patch))}
          onDeleteScan={(scan) =>
            setConfirm({
              title: 'Delete this scan?',
              lines: [`CG ${scan.cg}, scanned ${clock(scan.at)}.`],
              confirmLabel: 'Delete scan',
              danger: true,
              onConfirm: () => commit((d) => deleteScan(d, scan.id)),
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

function PendingView(props: { list: CgSummary[]; now: number; agingHours: number; onOpen: (cg: string) => void }) {
  const { list, now, agingHours, onOpen } = props;
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
          <ScanTags scan={x} />
        </span>
      ))}
    </span>
  );
}

function CompletedView(props: {
  list: CgSummary[];
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

function SearchView(props: { all: CgSummary[]; query: string; onQuery: (q: string) => void; onOpen: (cg: string) => void }) {
  const { all, query, onQuery, onOpen } = props;
  const results = searchCgs(all, query).slice(0, 50);
  const q = normalizeCg(query);
  return (
    <>
      <input
        className="field search-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search CG…"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label="Search CG"
      />
      {q && results.length === 0 && <Empty>CG {q} has not been received on this device.</Empty>}
      <ul className="rows" data-testid="search-list">
        {results.map((s) => (
          <li key={s.cg}>
            <button className={`row st-${s.status}`} onClick={() => onOpen(s.cg)} data-cg={s.cg}>
              <span className="row-main">
                <span className="cg">{s.cg}</span>
                <Slots count={s.count} expected={s.expected} />
                <span className={`pill ${s.status}`}>{statusLabel(s)}</span>
              </span>
              <CartLines s={s} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function MoreView(props: { data: AppData; onAging: (h: number) => void; onExport: () => void; onClear: () => void }) {
  const { data, onAging, onExport, onClear } = props;
  const [typed, setTyped] = useState('');
  const [hours, setHours] = useState(String(data.settings.agingHours));
  const ok = typed.trim() === 'DELETE';
  return (
    <div className="more">
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
        <p className="hint">{data.scans.length} scans on this device. One CSV row per cart, with ops and MC type.</p>
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
  now: number;
  agingHours: number;
  onClose: () => void;
  onExpected: (n: number) => void;
  onMark: (m: ArchiveMark | null) => void;
  onSaveScan: (id: string, patch: ScanPatch) => void;
  onDeleteScan: (s: Scan) => void;
}) {
  const { cg, summary: s, now, agingHours, onClose, onExpected, onMark, onSaveScan, onDeleteScan } = props;
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    // Escape closes the sheet, unless a confirm dialog is on top of it (that one handles its own Escape).
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !editing && !document.querySelector('[data-testid=confirm]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={`CG ${cg}`}>
      <div className="sheet">
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
  const cgOk = isValidCg(normalizeCg(cg));
  const valid = cgOk && ms !== null;
  return (
    <li className="edit">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const patch: ScanPatch = { cg, ops: opsFromSticky({ ops, otherOn, otherText }), mc };
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
        {!cgOk && <p className="field-error">A CG is exactly 4 digits.</p>}
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

function ConfirmDialog(props: { state: ConfirmState; onCancel: () => void; onConfirm: () => void }) {
  const { state, onCancel, onConfirm } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="sheet-backdrop confirm-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className={`confirm${state.danger ? ' danger' : ''}`} data-testid="confirm">
        <h2 id="confirm-title">{state.title}</h2>
        {state.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <div className="confirm-actions">
          {/* Cancel is focused so a stray scanner Enter never confirms. */}
          <button className="btn big" onClick={onCancel} autoFocus>Cancel</button>
          <button className={`btn big ${state.danger ? 'danger' : 'warn'}`} onClick={onConfirm}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
