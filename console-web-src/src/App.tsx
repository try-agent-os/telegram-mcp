import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppRoot,
  Cell,
  List,
  Placeholder,
  Section,
  Spinner,
} from '@telegram-apps/telegram-ui';
import { backButton } from '@telegram-apps/sdk';
import {
  drillTarget,
  drillUrl,
  komodoEnterUrl,
  fetchAgents,
  fetchDag,
  fetchDags,
  fetchStatus,
  fetchWorkers,
  StatusError,
  type AgentSummary,
  type CardStatus,
  type DagDetail,
  type DagSummary,
  type ServiceCard,
  type StatusPayload,
  type WorkerSummary,
} from './api';
import { getAppearance, getPlatform } from './telegram';

const POLL_MS = 10_000;
const BUILD_TAG = 'v0.5.0';

// Status → dot color. Telegram palette; rendered as a small filled circle in the
// Cell's `before` slot (tgui's Badge dot doesn't take arbitrary colors, and a
// status traffic-light is clearer than primary/critical).
const STATUS_COLOR: Record<CardStatus, string> = {
  ok: '#4dab6d',
  running: '#5288c1',
  warn: '#d9913a',
  error: '#e15a5a',
  down: '#b34b4b',
  unknown: '#8a949e',
  unconfigured: '#8a949e',
};

function StatusDot({ status }: { status: CardStatus }) {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.unknown;
  const pulse = status === 'running';
  return (
    <span
      className={'status-dot' + (pulse ? ' status-dot--pulse' : '')}
      style={{ background: color }}
      aria-label={status}
    />
  );
}

function kindBadge(kind: string) {
  return <span className="kind-badge">{kind.toUpperCase()}</span>;
}

// Worker health → status-dot color reuse.
function healthToStatus(h: string): CardStatus {
  switch (h.toLowerCase()) {
    case 'healthy':
      return 'ok';
    case 'warning':
      return 'warn';
    case 'unhealthy':
    case 'unreachable':
      return 'error';
    default:
      return 'unknown';
  }
}

// Relative-time formatter for finishedAt/lastHeartbeat (telegram-friendly).
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 0) return new Date(t).toLocaleString();
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

type View =
  | { view: 'home' }
  | { view: 'dags' }
  | { view: 'dag'; name: string }
  | { view: 'workers' };

// --- Home view --------------------------------------------------------------
function HomeView({
  payload,
  agents,
  error,
  daguAvailable,
  komodoAvailable,
  onCard,
  onWorkflows,
  onWorkers,
  onFullDagu,
  onKomodo,
}: {
  payload: StatusPayload;
  agents: AgentSummary[] | null;
  error: string | null;
  daguAvailable: boolean;
  komodoAvailable: boolean;
  onCard: (c: ServiceCard) => void;
  onWorkflows: () => void;
  onWorkers: () => void;
  onFullDagu: () => void;
  onKomodo: () => void;
}) {
  const updated = new Date(payload.generatedAt).toLocaleTimeString();
  return (
    <>
      {agents && agents.length > 0 && (
        <Section header="Agents" footer={`${agents.length} live session${agents.length === 1 ? '' : 's'}`}>
          {agents.map((a) => {
            const summary = a.summary.trim();
            const shown = summary
              ? summary.length > 80
                ? summary.slice(0, 79) + '…'
                : summary
              : 'idle / no summary';
            return (
              <Cell
                key={a.id}
                before={<StatusDot status={a.status === 'online' ? 'ok' : 'unknown'} />}
                subtitle={shown}
                hint={<span className="kind-badge">{relTime(a.lastSeen)}</span>}
                multiline
              >
                {a.role}
                {a.host ? ` · ${a.host}` : ''}
              </Cell>
            );
          })}
        </Section>
      )}
      {(daguAvailable || komodoAvailable) && (
        <Section header="Quick actions">
          {daguAvailable && (
            <>
              <Cell
                before={<span className="quick-emoji">📋</span>}
                after={<span className="drill-chevron">›</span>}
                subtitle="Dagu routines — native list, status & runs"
                onClick={onWorkflows}
                Component="button"
              >
                Workflows
              </Cell>
              <Cell
                before={<span className="quick-emoji">👷</span>}
                after={<span className="drill-chevron">›</span>}
                subtitle="Distributed workers + coordinator"
                onClick={onWorkers}
                Component="button"
              >
                Workers
              </Cell>
              <Cell
                before={<span className="quick-emoji">🗂️</span>}
                after={<span className="drill-chevron">›</span>}
                subtitle="Embedded Dagu admin UI (fallback)"
                onClick={onFullDagu}
                Component="button"
              >
                Open full Dagu
              </Cell>
            </>
          )}
          {komodoAvailable && (
            <Cell
              before={<span className="quick-emoji">🐊</span>}
              after={<span className="drill-chevron">›</span>}
              subtitle="Open Komodo dashboard — auto sign-in"
              onClick={onKomodo}
              Component="button"
            >
              Komodo
            </Cell>
          )}
        </Section>
      )}
      <Section
        header="Services"
        footer={
          (error ? `Last refresh failed: ${error}. ` : '') +
          `${payload.cards.length} services · updated ${updated}`
        }
      >
        {payload.cards.map((c) => {
          const svc = drillTarget(c.kind);
          const tappable = Boolean(svc) || Boolean(c.url);
          return (
            <Cell
              key={c.id}
              before={<StatusDot status={c.status} />}
              subtitle={c.detail || undefined}
              after={svc ? <span className="drill-chevron">›</span> : undefined}
              hint={kindBadge(c.kind)}
              multiline
              onClick={tappable ? () => onCard(c) : undefined}
              Component={tappable ? 'button' : 'div'}
            >
              {c.label}
            </Cell>
          );
        })}
      </Section>
    </>
  );
}

// --- DAGs list view ---------------------------------------------------------
function DagsView({
  dags,
  error,
  onOpen,
}: {
  dags: DagSummary[] | null;
  error: string | null;
  onOpen: (name: string) => void;
}) {
  if (error && !dags) return <Placeholder header="Could not load workflows" description={error} />;
  if (!dags)
    return (
      <div className="center-spin">
        <Spinner size="l" />
      </div>
    );
  if (dags.length === 0)
    return <Placeholder header="No workflows" description="Dagu reports no DAGs." />;
  return (
    <Section header="Workflows" footer={`${dags.length} routines`}>
      {dags.map((d) => (
        <Cell
          key={d.name}
          before={<StatusDot status={d.status} />}
          subtitle={
            (d.statusLabel ?? 'unknown') +
            (d.finishedAt ? ` · ${relTime(d.finishedAt)}` : '') +
            (d.suspended ? ' · suspended' : '')
          }
          after={<span className="drill-chevron">›</span>}
          multiline
          onClick={() => onOpen(d.name)}
          Component="button"
        >
          {d.name}
        </Cell>
      ))}
    </Section>
  );
}

// --- DAG detail view --------------------------------------------------------
function DagDetailView({ detail, error }: { detail: DagDetail | null; error: string | null }) {
  if (error && !detail) return <Placeholder header="Could not load workflow" description={error} />;
  if (!detail)
    return (
      <div className="center-spin">
        <Spinner size="l" />
      </div>
    );
  return (
    <>
      <Section header={detail.name} footer={detail.description || undefined}>
        <Cell
          before={<StatusDot status={detail.latestRun?.status ?? 'unknown'} />}
          subtitle={
            detail.latestRun
              ? `${detail.latestRun.statusLabel ?? 'unknown'} · ${relTime(detail.latestRun.finishedAt ?? detail.latestRun.startedAt)}`
              : 'never run'
          }
          multiline
        >
          Latest run
        </Cell>
      </Section>

      {detail.steps.length > 0 && (
        <Section header="Steps (latest run)">
          {detail.steps.map((s, i) => (
            <Cell
              key={`${s.name}-${i}`}
              before={<StatusDot status={s.status} />}
              subtitle={s.statusLabel ?? undefined}
              multiline
            >
              {s.name}
            </Cell>
          ))}
        </Section>
      )}

      <Section header="Recent runs" footer={detail.runs.length === 0 ? 'No run history.' : undefined}>
        {detail.runs.map((r, i) => (
          <Cell
            key={r.id ?? i}
            before={<StatusDot status={r.status} />}
            subtitle={`${relTime(r.startedAt)} → ${r.finishedAt ? relTime(r.finishedAt) : 'running'}`}
            hint={kindBadge(r.statusLabel ?? 'unknown')}
            multiline
          >
            {r.startedAt ? new Date(r.startedAt).toLocaleString() : r.id ?? 'run'}
          </Cell>
        ))}
      </Section>
    </>
  );
}

// --- Workers view -----------------------------------------------------------
function WorkersView({
  workers,
  error,
}: {
  workers: WorkerSummary[] | null;
  error: string | null;
}) {
  if (error && !workers) return <Placeholder header="Could not load workers" description={error} />;
  if (!workers)
    return (
      <div className="center-spin">
        <Spinner size="l" />
      </div>
    );
  if (workers.length === 0)
    return <Placeholder header="No workers" description="No Dagu workers are connected." />;
  return (
    <Section header="Workers" footer={`${workers.length} connected`}>
      {workers.map((w) => (
        <Cell
          key={w.id}
          before={<StatusDot status={healthToStatus(w.healthStatus)} />}
          subtitle={
            `${w.healthStatus} · ${w.busyPollers}/${w.totalPollers} pollers` +
            (w.runningCount ? ` · ${w.runningCount} running` : '') +
            ` · ${relTime(w.lastHeartbeatAt)}`
          }
          hint={kindBadge([w.host, w.os].filter(Boolean).join('/') || 'worker')}
          multiline
        >
          {w.id}
        </Cell>
      ))}
    </Section>
  );
}

export function App() {
  const [nav, setNav] = useState<View>({ view: 'home' });
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noTelegram, setNoTelegram] = useState(false);

  const [dags, setDags] = useState<DagSummary[] | null>(null);
  const [dagsErr, setDagsErr] = useState<string | null>(null);
  const [dag, setDag] = useState<DagDetail | null>(null);
  const [dagErr, setDagErr] = useState<string | null>(null);
  const [workers, setWorkers] = useState<WorkerSummary[] | null>(null);
  const [workersErr, setWorkersErr] = useState<string | null>(null);

  const loadingRef = useRef(false);
  const navRef = useRef(nav);
  navRef.current = nav;

  const handleErr = useCallback((e: unknown, set: (s: string | null) => void) => {
    if (e instanceof StatusError && e.message === 'NO_INIT_DATA') {
      setNoTelegram(true);
    } else {
      set(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);

  // Poll only the active view. Each tick reloads exactly what's on screen.
  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const cur = navRef.current;
    try {
      if (cur.view === 'home') {
        // Status + agents in parallel; agents failure must not blank the home.
        const [data, agentList] = await Promise.all([
          fetchStatus(),
          fetchAgents().catch(() => null),
        ]);
        setPayload(data);
        if (agentList) setAgents(agentList);
        setError(null);
        setNoTelegram(false);
      } else if (cur.view === 'dags') {
        const data = await fetchDags();
        setDags(data);
        setDagsErr(null);
      } else if (cur.view === 'dag') {
        const data = await fetchDag(cur.name);
        setDag(data);
        setDagErr(null);
      } else if (cur.view === 'workers') {
        const data = await fetchWorkers();
        setWorkers(data);
        setWorkersErr(null);
      }
    } catch (e) {
      if (cur.view === 'home') handleErr(e, setError);
      else if (cur.view === 'dags') handleErr(e, setDagsErr);
      else if (cur.view === 'dag') handleErr(e, setDagErr);
      else if (cur.view === 'workers') handleErr(e, setWorkersErr);
    } finally {
      loadingRef.current = false;
    }
  }, [handleErr]);

  // Re-load on view change + poll the active view every POLL_MS.
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load, nav]);

  // Navigation helpers — clear stale per-view state so we show a spinner, not
  // the previous view's data, while loading.
  const goHome = useCallback(() => setNav({ view: 'home' }), []);
  const goDags = useCallback(() => {
    setDags(null);
    setDagsErr(null);
    setNav({ view: 'dags' });
  }, []);
  const goDag = useCallback((name: string) => {
    setDag(null);
    setDagErr(null);
    setNav({ view: 'dag', name });
  }, []);
  const goWorkers = useCallback(() => {
    setWorkers(null);
    setWorkersErr(null);
    setNav({ view: 'workers' });
  }, []);

  // Telegram BackButton: shown on every sub-view, hidden on home. DAG detail
  // pops back to the DAGs list; everything else pops to home.
  useEffect(() => {
    try {
      if (!backButton.isMounted()) {
        if (backButton.mount.isAvailable()) backButton.mount();
      }
    } catch {
      /* not in Telegram — no-op */
    }
    const pop = () => {
      if (navRef.current.view === 'dag') goDags();
      else goHome();
    };
    try {
      if (nav.view === 'home') {
        if (backButton.hide.isAvailable()) backButton.hide();
      } else {
        if (backButton.show.isAvailable()) backButton.show();
      }
    } catch {
      /* no-op */
    }
    let off: (() => void) | undefined;
    try {
      if (backButton.onClick.isAvailable()) off = backButton.onClick(pop);
    } catch {
      /* no-op */
    }
    return () => {
      if (off) off();
    };
  }, [nav, goDags, goHome]);

  const onCard = useCallback((c: ServiceCard) => {
    const svc = drillTarget(c.kind);
    if (svc) {
      window.location.href = drillUrl(svc);
    } else if (c.url) {
      window.open(c.url, '_blank', 'noopener');
    }
  }, []);

  // Full-page navigation into the embedded Dagu drill-in (fallback path).
  const openFullDagu = useCallback(() => {
    window.location.href = drillUrl('dagu');
  }, []);

  // The Komodo public origin comes from the status payload (komodo card `url`,
  // filled server-side from env KOMODO_PUBLIC_URL) — nothing is baked into the
  // bundle. No URL → no TG-login button.
  const komodoCard = payload?.cards.find((c) => c.kind.toLowerCase() === 'komodo');
  const komodoPublicUrl = komodoCard?.url ?? null;

  // Komodo TG-login: open the Komodo-origin /enter handoff, which mints a session
  // JWT and seeds it into localStorage on the Komodo origin, then lands in the
  // dashboard. We open it as a LINK (Telegram in-app/system browser) rather than
  // navigating this Mini App's own webview: inside the Mini App container Komodo's
  // top toolbar renders under the Telegram header (Close / ⋯), so it looks clipped.
  // openLink escapes that chrome → full-height dashboard. initData rides in the URL
  // query so the owner-lock still validates in the opened browser context.
  const openKomodo = useCallback(() => {
    if (!komodoPublicUrl) return;
    const url = komodoEnterUrl(komodoPublicUrl);
    if (!url) return;
    const tg = (window as unknown as { Telegram?: { WebApp?: { openLink?: (u: string) => void } } })
      .Telegram?.WebApp;
    if (tg?.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }, [komodoPublicUrl]);

  const daguAvailable = Boolean(
    payload?.cards.some((c) => drillTarget(c.kind)) && !noTelegram,
  );

  // Show the Komodo TG-login button whenever Komodo is reporting (any non-
  // unconfigured komodo card) AND a public URL is configured. The server-side
  // gateway gate (KOMODO_GATEWAY_*) is the real boundary; if unset, /enter
  // returns 502.
  const komodoAvailable = Boolean(
    komodoCard && komodoCard.status !== 'unconfigured' && komodoPublicUrl && !noTelegram,
  );

  const platform = getPlatform() === 'ios' ? 'ios' : 'base';
  const appearance = getAppearance();

  let title = 'AgentOS Console';
  if (nav.view === 'dags') title = 'Workflows';
  else if (nav.view === 'dag') title = nav.name;
  else if (nav.view === 'workers') title = 'Workers';

  let body: React.ReactNode;
  if (noTelegram) {
    body = (
      <Placeholder
        header="Open from Telegram"
        description="Console authenticates via Telegram and stays empty in a normal browser."
      />
    );
  } else if (nav.view === 'home') {
    if (error && !payload) {
      body = <Placeholder header="Could not load status" description={error} />;
    } else if (!payload) {
      body = (
        <div className="center-spin">
          <Spinner size="l" />
        </div>
      );
    } else {
      body = (
        <HomeView
          payload={payload}
          agents={agents}
          error={error}
          daguAvailable={daguAvailable}
          komodoAvailable={komodoAvailable}
          onCard={onCard}
          onWorkflows={goDags}
          onWorkers={goWorkers}
          onFullDagu={openFullDagu}
          onKomodo={openKomodo}
        />
      );
    }
  } else if (nav.view === 'dags') {
    body = <DagsView dags={dags} error={dagsErr} onOpen={goDag} />;
  } else if (nav.view === 'dag') {
    body = <DagDetailView detail={dag} error={dagErr} />;
  } else {
    body = <WorkersView workers={workers} error={workersErr} />;
  }

  return (
    <AppRoot platform={platform} appearance={appearance}>
      <div className="console-shell">
        <header className="console-header">
          <h1>{title}</h1>
          <span className="build-tag">{BUILD_TAG}</span>
        </header>
        <List>{body}</List>
      </div>
    </AppRoot>
  );
}
