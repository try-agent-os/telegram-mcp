// claude-peers broker client — lists live agent sessions on this machine.
// Each peer = one running Claude Code session. The Console home renders them as
// a native "Agents" section so the operator sees session status in-app.
//
// Broker base URL: CLAUDE_PEERS_BASE_URL if set, else derived from the existing
// CLAUDE_PEERS_HEALTH_URL by stripping the trailing /health, else the default
// loopback. The list endpoint is POST /list-peers with body {scope}.

function brokerBase(): string {
  const explicit = process.env.CLAUDE_PEERS_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const health = process.env.CLAUDE_PEERS_HEALTH_URL;
  if (health) return health.replace(/\/health\/?$/, '').replace(/\/$/, '');
  return 'http://localhost:7899';
}

// Raw shape from POST /list-peers (subset we use).
export interface RawPeer {
  id?: string;
  pid?: number;
  cwd?: string;
  git_root?: string;
  tty?: string;
  summary?: string;
  registered_at?: string;
  last_seen?: string;
  slug?: string | null;
  status?: string;
  host?: string | null;
}

export interface AgentSummary {
  id: string;
  role: string;
  summary: string;
  status: string;
  lastSeen: string | null;
  host: string | null;
  cwd: string | null;
}

function titleCase(s: string): string {
  return s
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Display role: prefer slug; else derive from cwd (.../agents/<name> → <name>,
// otherwise the last path segment).
function deriveRole(peer: RawPeer): string {
  if (peer.slug) return peer.slug;
  const cwd = peer.cwd ?? '';
  const m = cwd.match(/\/agents\/([^/]+)/);
  if (m) return titleCase(m[1]);
  const seg = cwd.split('/').filter(Boolean).pop();
  return seg ? titleCase(seg) : 'session';
}

export async function listAgents(): Promise<AgentSummary[]> {
  const res = await fetch(`${brokerBase()}/list-peers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'machine' }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`peers /list-peers -> ${res.status}`);
  const peers = (await res.json()) as RawPeer[];
  if (!Array.isArray(peers)) return [];
  return peers.map((p) => ({
    id: p.id ?? 'unknown',
    role: deriveRole(p),
    summary: p.summary ?? '',
    status: p.status ?? 'unknown',
    lastSeen: p.last_seen ?? null,
    host: p.host ?? null,
    cwd: p.cwd ?? null,
  }));
}
