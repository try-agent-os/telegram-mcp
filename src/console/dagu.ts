// Dagu client — REST over loopback, basic auth.
// This Dagu (v2.7.x) serves its API under /api/v1 (the SPA is served for any
// unmatched path, so probing /api/v2 returns HTML 200 — a false positive).
// Credentials reuse the existing DAGU_AUTH_BASIC_* env the scheduler already uses.
//
// Phase 2 NB: Dagu now runs with DAGU_BASE_PATH=/console/svc/dagu (so the Console
// reverse-proxy can embed its UI). With a base path set, the REST API moves under
// that prefix — the BARE /api/v1 falls through to the SPA (HTML). So this client
// must hit the prefixed path. DAGU_BASE_PATH defaults to the value we configure;
// if it is ever unset (no embed), this falls back to bare /api/v1.
const DAGU_BASE_PATH = process.env.DAGU_BASE_PATH ?? '/console/svc/dagu';
const BASE = (process.env.DAGU_HOST_LOCAL ?? 'http://localhost:8080') + DAGU_BASE_PATH + '/api/v1';
const USER = process.env.DAGU_AUTH_BASIC_USERNAME ?? '';
const PASS = process.env.DAGU_AUTH_BASIC_PASSWORD ?? '';

export const daguConfigured = (): boolean => Boolean(USER && PASS);

function authHeader(): Record<string, string> {
  if (!USER && !PASS) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
}

export async function daguGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeader(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`dagu GET ${path} -> ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error(`dagu GET ${path} -> non-JSON (${ct})`);
  return res.json() as Promise<T>;
}

// Shape of /api/v1/dags items (subset). Latest run status lives under
// `latestDAGRun.statusLabel` ("succeeded" | "failed" | "running" | ...).
export interface DagListItem {
  dag?: { name?: string };
  fileName?: string;
  latestDAGRun?: { status?: number; statusLabel?: string; finishedAt?: string };
  suspended?: boolean;
}

export interface DagListResponse {
  dags?: DagListItem[];
  pagination?: { totalRecords?: number };
}

// --- /dags/{name} detail + /dags/{name}/dag-runs run history ---------------
// A run "node" = one step's execution. The step name lives under `step.name`;
// the run-level result under top-level statusLabel.
export interface DagRunNode {
  step?: { name?: string };
  status?: number;
  statusLabel?: string;
  startedAt?: string;
  finishedAt?: string;
  retryCount?: number;
}

export interface DagRun {
  dagRunId?: string;
  status?: number;
  statusLabel?: string;
  startedAt?: string;
  finishedAt?: string;
  log?: string;
  nodes?: DagRunNode[];
}

export interface DagDetailResponse {
  dag?: { name?: string; description?: string };
  filePath?: string;
  latestDAGRun?: DagRun;
  suspended?: boolean;
  errors?: string[];
}

export interface DagRunsResponse {
  dagRuns?: DagRun[];
}

// --- /workers --------------------------------------------------------------
export interface DaguWorker {
  id?: string;
  healthStatus?: string;
  labels?: { host?: string; os?: string };
  lastHeartbeatAt?: string;
  busyPollers?: number;
  totalPollers?: number;
  runningTasks?: unknown[];
}

export interface WorkersResponse {
  errors?: string[];
  workers?: DaguWorker[];
}

export const encodeName = (name: string): string => encodeURIComponent(name);

export const fetchDagList = (): Promise<DagListResponse> => daguGet<DagListResponse>('/dags?limit=200');

export const fetchDagDetail = (name: string): Promise<DagDetailResponse> =>
  daguGet<DagDetailResponse>(`/dags/${encodeName(name)}`);

export const fetchDagRuns = (name: string): Promise<DagRunsResponse> =>
  daguGet<DagRunsResponse>(`/dags/${encodeName(name)}/dag-runs`);

export const fetchWorkers = (): Promise<WorkersResponse> => daguGet<WorkersResponse>('/workers');
