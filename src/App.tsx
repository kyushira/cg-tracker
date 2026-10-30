import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  addScan,
  agingLevel,
  checkScan,
  completedList,
  countByStatus,
  deleteScan,
  formatDuration,
  lastScan,
  MAX_EXPECTED,
  MIN_EXPECTED,
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
  updateScan,
  emptyData,
  type AppData,
  type ArchiveMark,
  type CgSummary,
  type Scan,
  type ScanWarning,
} from './domain';
import { LocalStore, newId, storageKey, type DataStore } from './storage';
import { cue } from './feedback';
import { clock, fileStamp, fromLocalInput, toLocalInput } from './time';

type Tab = 'pending' | 'completed' | 'search' | 'more';
type DoneFilter = 'active' | ArchiveMark | 'all';

interface Banner {
  kind: 'pending' | 'complete' | 'extra' | 'info';
  cg: string;
  title: string;
  detail: string;
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

// ------------------------------------------------------------------ app

export default function App() {
  const store = useMemo(() => new LocalStore(storageKey(window.location.pathname)), []);
  const { data, ref, commit, saveError } = useData(store);
  const now = useNow(30_000);

  const [tab, setTab] = useState<Tab>('pending');
  const [doneFilter, setDoneFilter] = useState<DoneFilter>('active');
  const [cgInput, setCgInput] = useState('');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [openCg, setOpenCg] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const cgRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => summarizeAll(data), [data]);
  const counts = useMemo(() => countByStatus(all), [all]);
  const pending = useMemo(() => pendingList(all), [all]);
  const done = useMemo(() => completedList(all, doneFilter), [all, doneFilter]);
  const last = lastScan(data);

  const focusScan = useCallback(() => {
    window.setTimeout(() => cgRef.current?.focus(), 0);
  }, []);

  // A handheld scanner "types" into whatever has focus. If nothing editable is
  // focused (user tapped a tab or a button), send the keystrokes to the CG box.
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
    const { truck, door } = ref.current.settings;
    const next = commit((d) => addScan(d, { cg, truck, door }, Date.now(), newId()));
    if (!next) return setBanner(null);
    const s = summarizeCg(next, cg)!;
    const first = s.scans[0];
    let b: Banner;
    if (s.count === s.expected) {
      const from = s.expected > 1 && first.truck ? ` · 1st cart came on truck ${first.truck}` : '';
      b = { kind: 'complete', cg, title: `COMPLETE ${s.count}/${s.expected}`, detail: `Marry up now${from}`, key: Date.now() };
      cue('complete');
    } else if (s.count > s.expected) {
      b = { kind: 'extra', cg, title: `EXTRA CART ${s.count}/${s.expected}`, detail: 'Saved as an extra cart', key: Date.now() };
      cue('warn');
    } else {
      b = {
        kind: 'pending',
        cg,
        title: `PENDING ${s.count}/${s.expected}`,
        detail: `Stage it and wait for ${s.expected - s.count} more cart${s.expected - s.count > 1 ? 's' : ''}`,
        key: Date.now(),
      };
      cue('pending');
    }
    setBanner(b);
  };

  const onScan = (e: FormEvent) => {
    e.preventDefault();
    const cg = normalizeCg(cgInput);
    setCgInput('');
    if (!cg) return focusScan();
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
      lines: [`CG ${last.cg} scanned at ${clock(last.at)}${last.truck ? ` (truck ${last.truck})` : ''}.`],
      confirmLabel: 'Undo scan',
      danger: true,
      onConfirm: () => {
        if (!commit((d) => deleteScan(d, last.id))) return;
        setBanner({ kind: 'info', cg: last.cg, title: 'UNDONE', detail: `Removed last scan of CG ${last.cg}`, key: Date.now() });
      },
    });
  };

  const closeConfirm = () => {
    setConfirm(null);
    if (!openCg) focusScan();
  };

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

  return (
    <div className="app">
      <header className="top">
        <h1>CG Marry-Up</h1>
        <div className="counts" aria-live="polite">
          <button className="count pending" onClick={() => setTab('pending')}>
            Pending: <b data-testid="count-pending">{counts.pending}</b>
          </button>
          <span className="sep">|</span>
          <button className="count done" onClick={() => setTab('completed')}>
            Completed: <b data-testid="count-completed">{counts.completed}</b>
          </button>
        </div>
      </header>

      {saveError && <div className="save-error" role="alert">{saveError}</div>}

      <section className="scan" aria-label="Receive a cart">
        <form onSubmit={onScan} autoComplete="off">
          <label htmlFor="cg" className="sr-only">CG number</label>
          <input
            id="cg"
            ref={cgRef}
            className="cg-input"
            value={cgInput}
            onChange={(e) => setCgInput(e.target.value)}
            placeholder="Scan CG…"
            inputMode="numeric"
            enterKeyHint="done"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="sticky-row">
            <label>
              Truck / trailer
              <input
                value={data.settings.truck}
                onChange={(e) => commit((d) => setSticky(d, e.target.value, d.settings.door))}
                placeholder="optional"
                autoCapitalize="characters"
              />
            </label>
            <label>
              Dock door
              <input
                value={data.settings.door}
                onChange={(e) => commit((d) => setSticky(d, d.settings.truck, e.target.value))}
                placeholder="optional"
                inputMode="numeric"
              />
            </label>
          </div>
          <div className="scan-actions">
            <button type="submit" className="btn primary big">Receive cart</button>
            <button type="button" className="btn ghost" onClick={onUndo} disabled={!last}>
              ↶ Undo last
            </button>
          </div>
        </form>

        {banner && (
          <button
            key={banner.key}
            className={`banner ${banner.kind}`}
            data-testid="banner"
            onClick={() => banner.kind !== 'info' && setOpenCg(banner.cg)}
            aria-live="assertive"
          >
            <span className="banner-title">{banner.kind === 'complete' ? '✔ ' : ''}{banner.title}</span>
            <span className="banner-cg">CG {banner.cg}</span>
            <span className="banner-detail">{banner.detail}</span>
          </button>
        )}
      </section>

      <nav className="tabs" role="tablist">
        {(
          [
            ['pending', `Pending (${counts.pending})`],
            ['completed', `Completed (${counts.completed})`],
            ['search', 'Search'],
            ['more', 'More'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>

      <main className="panel">
        {tab === 'pending' && (
          <PendingView list={pending} now={now} agingHours={data.settings.agingHours} onOpen={setOpenCg} />
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
        {tab === 'search' && (
          <SearchView all={all} query={query} onQuery={setQuery} onOpen={setOpenCg} />
        )}
        {tab === 'more' && (
          <MoreView
            data={data}
            onAging={(h) => commit((d) => setAgingHours(d, h))}
            onExport={exportCsv}
            onClear={clearAll}
          />
        )}
      </main>

      {openCg && (
        <CgDetail
          cg={openCg}
          summary={openSummary}
          now={now}
          agingHours={data.settings.agingHours}
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
              lines: [`CG ${scan.cg}, scanned ${clock(scan.at)}${scan.truck ? `, truck ${scan.truck}` : ''}.`],
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

function cartsLine(s: CgSummary): string {
  return s.scans.map((x) => `${clock(x.at)}${x.truck ? ` · ${x.truck}` : ''}${x.door ? ` · D${x.door}` : ''}`).join('  +  ');
}

function PendingView(props: {
  list: CgSummary[];
  now: number;
  agingHours: number;
  onOpen: (cg: string) => void;
}) {
  const { list, now, agingHours, onOpen } = props;
  if (list.length === 0) return <Empty>No pending CGs. Every received CG is married up.</Empty>;
  return (
    <ul className="rows" data-testid="pending-list">
      {list.map((s) => {
        const first = s.scans[0];
        const level = agingLevel(s.firstAt, now, agingHours);
        return (
          <li key={s.cg}>
            <button className={`row age-${level}`} onClick={() => onOpen(s.cg)} data-cg={s.cg}>
              <span className="row-main">
                <span className="cg">{s.cg}</span>
                <span className="badge pending">{s.count}/{s.expected}</span>
              </span>
              <span className="row-sub">
                <span className="wait">⏱ {formatDuration(now - s.firstAt)}</span>
                <span>1st: {clock(first.at)}{first.truck ? ` · truck ${first.truck}` : ''}{first.door ? ` · door ${first.door}` : ''}</span>
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
      <div className="chips" role="group" aria-label="Filter completed">
        {FILTERS.map(([f, label]) => (
          <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => onFilter(f)}>
            {label} ({n[f]})
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <ul className="rows" data-testid="completed-list">
          {list.map((s) => (
            <li key={s.cg} className="done-item">
              <button className="row" onClick={() => onOpen(s.cg)} data-cg={s.cg}>
                <span className="row-main">
                  <span className="cg">{s.cg}</span>
                  <span className={`badge ${s.status}`}>
                    {s.status === 'complete' ? `${s.count}/${s.expected}` : s.status}
                  </span>
                </span>
                <span className="row-sub">{cartsLine(s)}</span>
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
        className="search-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search CG (any part)…"
        inputMode="numeric"
        aria-label="Search CG"
      />
      {q && results.length === 0 && <Empty>CG {q} has not been received on this device.</Empty>}
      <ul className="rows" data-testid="search-list">
        {results.map((s) => (
          <li key={s.cg}>
            <button className="row" onClick={() => onOpen(s.cg)} data-cg={s.cg}>
              <span className="row-main">
                <span className="cg">{s.cg}</span>
                <span className={`badge ${s.status}`}>{statusLabel(s)}</span>
              </span>
              <span className="row-sub">{cartsLine(s)}</span>
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
      <section>
        <h2>Aging alert</h2>
        <p className="hint">Pending CGs turn orange at 75% of this time and red once it has passed.</p>
        <label className="inline">
          Alert after
          <input
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
      <section>
        <h2>Export</h2>
        <p className="hint">{data.scans.length} scans on this device. One CSV row per cart.</p>
        <button className="btn primary big" onClick={onExport} disabled={data.scans.length === 0}>
          ⬇ Download CSV
        </button>
      </section>
      <section className="danger-zone">
        <h2>Clear all data</h2>
        <p className="hint">Deletes every scan on this device. Export a CSV first. Type DELETE to confirm.</p>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" autoCapitalize="characters" />
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

function CgDetail(props: {
  cg: string;
  summary: CgSummary | null;
  now: number;
  agingHours: number;
  onClose: () => void;
  onExpected: (n: number) => void;
  onMark: (m: ArchiveMark | null) => void;
  onSaveScan: (id: string, patch: Partial<Pick<Scan, 'cg' | 'truck' | 'door' | 'at'>>) => void;
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
          <button className="btn ghost" onClick={onClose} autoFocus>✕ Close</button>
        </div>
        {!s ? (
          <Empty>No scans left for this CG.</Empty>
        ) : (
          <>
            <div className={`status-big ${s.status} ${s.status === 'pending' ? `age-${agingLevel(s.firstAt, now, agingHours)}` : ''}`} data-testid="detail-status">
              {statusLabel(s)}
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

            <h3>Scan history</h3>
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
                    <div>
                      <b>Cart {i + 1}</b> · {clock(scan.at, now)}
                      <div className="hint">
                        {scan.truck ? `Truck ${scan.truck}` : 'No truck'} · {scan.door ? `Door ${scan.door}` : 'No door'}
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

function EditScan(props: {
  scan: Scan;
  onCancel: () => void;
  onSave: (patch: Partial<Pick<Scan, 'cg' | 'truck' | 'door' | 'at'>>) => void;
}) {
  const { scan, onCancel, onSave } = props;
  const [cg, setCg] = useState(scan.cg);
  const [truck, setTruck] = useState(scan.truck);
  const [door, setDoor] = useState(scan.door);
  const original = toLocalInput(scan.at);
  const [at, setAt] = useState(original);
  const ms = fromLocalInput(at);
  const valid = normalizeCg(cg) !== '' && ms !== null;
  return (
    <li className="edit">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          // Only touch the time if it was edited (the input drops milliseconds,
          // and the local-time round trip is ambiguous on DST change nights).
          onSave(at === original ? { cg, truck, door } : { cg, truck, door, at: ms! });
        }}
      >
        <label>CG<input value={cg} onChange={(e) => setCg(e.target.value)} inputMode="numeric" /></label>
        <label>Truck<input value={truck} onChange={(e) => setTruck(e.target.value)} /></label>
        <label>Door<input value={door} onChange={(e) => setDoor(e.target.value)} /></label>
        <label>Time<input type="datetime-local" step={1} value={at} onChange={(e) => setAt(e.target.value)} /></label>
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
      <div className="confirm" data-testid="confirm">
        <h2 id="confirm-title">⚠ {state.title}</h2>
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
