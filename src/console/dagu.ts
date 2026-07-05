// Dagu client — REST over loopback, basic auth.
// This Dagu (v2.7.x) serves its API under /api/v1 (the SPA is served for any
// unmatched path, so probing /api/v2 returns HTML 200 — a false positive).
// Credentials reuse the existing DAGU_AUTH_BASIC_* env the scheduler already uses.
const BASE = (process.env.DAGU_HOST_LOCAL ?? 'http://localhost:8080') + '/api/v1';
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
