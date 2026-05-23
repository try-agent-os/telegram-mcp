// Komodo Core client — talks to the local Komodo API over loopback only.
// API model: POST /read/{NAME} and /execute/{NAME}, JSON body, auth via the
// X-Api-Key / X-Api-Secret header pair (a dedicated read-only service user key).
// Credentials live in /etc/agent-os/agent-os.env and never reach the client.
const BASE = process.env.KOMODO_HOST_LOCAL ?? 'http://localhost:9120';
const KEY = process.env.KOMODO_API_KEY ?? '';
const SECRET = process.env.KOMODO_API_SECRET ?? '';

export const komodoConfigured = (): boolean => Boolean(KEY && SECRET);

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': KEY,
    'X-Api-Secret': SECRET,
  };
}

export async function komoRead<T = unknown>(name: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}/read/${name}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`komodo /read/${name} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export interface StacksSummary {
  total: number;
  running: number;
  stopped: number;
  down: number;
  unhealthy: number;
  unknown: number;
}

export interface StackListItem {
  name: string;
  id?: string;
  info?: { state?: string; status?: string; services_count?: number };
}

export interface ServerListItem {
  name: string;
  id?: string;
  info?: { state?: string };
}
