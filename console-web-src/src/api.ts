// Console status API client. Contract (unchanged from Phase 1/2):
//   GET /console/api/status
//     Authorization: tma <initDataRaw>
//   → { cards: [{ id,label,kind,status,detail,url }], generatedAt }
//   401 missing/invalid initData · 403 wrong user.
import { getRawInitData } from './telegram';

export type CardStatus =
  | 'ok'
  | 'running'
  | 'warn'
  | 'error'
  | 'down'
  | 'unknown'
  | 'unconfigured';

export interface ServiceCard {
  id: string;
  label: string;
  kind: string;
  status: CardStatus;
  detail?: string;
  url?: string | null;
}

export interface StatusPayload {
  generatedAt: string;
  cards: ServiceCard[];
}

export class StatusError extends Error {}

// Shared fetch wrapper: tma auth header + cache-buster + 401/403/!ok handling,
// identical contract to the original fetchStatus.
async function apiGet<T>(path: string): Promise<T> {
  const initData = getRawInitData();
  if (!initData) {
    throw new StatusError('NO_INIT_DATA');
  }
  // Cache-buster: Telegram's in-app webview aggressively caches responses and
  // will replay a stale 401 without hitting the server. A unique URL per request
  // + no-store forces a real network call every time.
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${path}${sep}t=${Date.now()}`, {
    cache: 'no-store',
    headers: { Authorization: `tma ${initData}` },
  });
  if (res.status === 401) throw new StatusError('Session invalid or expired — reopen from Telegram.');
  if (res.status === 403) throw new StatusError('Access denied — this Console is single-user.');
  if (!res.ok) throw new StatusError(`Request failed (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

export async function fetchStatus(): Promise<StatusPayload> {
  return apiGet<StatusPayload>('/console/api/status');
}

// --- Dagu native views -----------------------------------------------------
export interface DagSummary {
  name: string;
  fileName: string | null;
  status: CardStatus;
  statusLabel: string | null;
  finishedAt: string | null;
  suspended: boolean;
}

export interface DagRunSummary {
  id: string | null;
  status: CardStatus;
  statusLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DagStepSummary {
  name: string;
  status: CardStatus;
  statusLabel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DagDetail {
  name: string;
  description: string | null;
  suspended: boolean;
  latestRun: DagRunSummary | null;
  steps: DagStepSummary[];
  runs: DagRunSummary[];
}

export interface WorkerSummary {
  id: string;
  host: string | null;
  os: string | null;
  healthStatus: string;
  busyPollers: number;
  totalPollers: number;
  lastHeartbeatAt: string | null;
  runningCount: number;
}

export async function fetchDags(): Promise<DagSummary[]> {
  const data = await apiGet<{ dags: DagSummary[] }>('/console/api/dagu/dags');
  return data.dags ?? [];
}

export async function fetchDag(name: string): Promise<DagDetail> {
  return apiGet<DagDetail>(`/console/api/dagu/dags/${encodeURIComponent(name)}`);
}

export async function fetchWorkers(): Promise<WorkerSummary[]> {
  const data = await apiGet<{ workers: WorkerSummary[] }>('/console/api/dagu/workers');
  return data.workers ?? [];
}

// --- Live agent sessions (claude-peers) ------------------------------------
export interface AgentSummary {
  id: string;
  role: string;
  summary: string;
  status: string;
  lastSeen: string | null;
  host: string | null;
  cwd: string | null;
}

export async function fetchAgents(): Promise<AgentSummary[]> {
  const data = await apiGet<{ agents: AgentSummary[] }>('/console/api/agents');
  return data.agents ?? [];
}

// Cards whose `kind` supports the Phase 2 drill-in. The status API emits a
// lowercase kind (e.g. 'dagu'); tapping such a card navigates the webview to the
// service's /enter handoff, which validates initData server-side, mints a signed
// cookie and 302s into the proxied admin UI under /console. Full-page navigation
// can't carry the Authorization header, so initData rides once as a query param.
const DRILL_SVC: Record<string, string> = { dagu: 'dagu' };

export function drillTarget(kind: string): string | null {
  return DRILL_SVC[kind.toLowerCase()] ?? null;
}

export function drillUrl(svc: string, to?: string): string {
  const base = `/console/svc/${svc}/enter?initData=${encodeURIComponent(getRawInitData())}`;
  // Optional deep-link into a service sub-route (e.g. Dagu's /workers). The
  // server sanitises `to` against open-redirects, but we still only pass plain
  // rooted paths from here.
  return to ? `${base}&to=${encodeURIComponent(to)}` : base;
}

// Komodo TG-login: unlike Dagu's same-origin proxy drill-in, Komodo keeps its
// session in localStorage, which is PER-ORIGIN. The bootstrap page therefore
// MUST run on Komodo's own origin so its localStorage write lands where the
// Komodo SPA reads it. So we navigate to the ABSOLUTE Komodo /enter URL (not a
// relative path on the Console origin). No origin is baked into the bundle:
// the caller passes the komodo card's `url` from the status payload, which the
// server fills from env KOMODO_PUBLIC_URL.
export function komodoEnterUrl(komodoPublicUrl: string): string | null {
  let origin: string;
  try {
    origin = new URL(komodoPublicUrl).origin;
  } catch {
    return null;
  }
  return `${origin}/console/svc/komodo/enter?initData=${encodeURIComponent(getRawInitData())}`;
}
