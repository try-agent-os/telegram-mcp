// Console status aggregation (Phase 1, read-only).
// Fans out to Komodo (localhost:9120) + Dagu (localhost:8080) + a couple of
// localhost health probes, and returns a normalized array of service cards.
// Every source is isolated: one failing source degrades to an "error"/"unknown"
// card, never breaks the whole response.
import { komoRead, komodoConfigured, type StacksSummary, type StackListItem, type ServerListItem } from './komodo.js';
import { daguGet, daguConfigured, type DagListResponse, type DagListItem } from './dagu.js';

// Optional public links for the Komodo/Dagu cards (the "open in UI" target shown
// in the SPA). No personal domain is baked in — unset → the card has no external
// link. Override via env if you expose Komodo/Dagu on your own public URL.
const KOMODO_PUBLIC_URL = process.env.KOMODO_PUBLIC_URL || null;
const DAGU_PUBLIC_URL = process.env.DAGU_PUBLIC_URL || null;

export type CardStatus = 'ok' | 'running' | 'down' | 'error' | 'unknown' | 'unconfigured';

export interface ServiceCard {
  id: string;
  label: string;
  kind: 'komodo' | 'stack' | 'server' | 'dagu' | 'health';
  status: CardStatus;
  detail?: string;
  url?: string | null;
}

export interface StatusPayload {
  generatedAt: string;
  cards: ServiceCard[];
}

function mapStackState(state?: string): CardStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'running': return 'running';
    case 'stopped':
    case 'down':
    case 'paused':
    case 'exited': return 'down';
    case 'unhealthy': return 'error';
    case '': return 'unknown';
    default: return 'running';
  }
}

export function mapDaguStatus(label?: string): CardStatus {
  switch ((label ?? '').toLowerCase()) {
    case 'succeeded':
    case 'finished': return 'ok';
    case 'running':
    case 'queued': return 'running';
    case 'failed':
    case 'cancelled': return 'error';
    case 'not started':
    case 'none': return 'unknown';
    default: return 'unknown';
  }
}

async function komodoCards(): Promise<ServiceCard[]> {
  if (!komodoConfigured()) {
    return [{ id: 'komodo-core', label: 'Komodo Core', kind: 'komodo', status: 'unconfigured', detail: 'KOMODO_API_KEY not set', url: KOMODO_PUBLIC_URL }];
  }
  const cards: ServiceCard[] = [];
  try {
    const [summary, stacks, servers] = await Promise.all([
      komoRead<StacksSummary>('GetStacksSummary'),
      komoRead<StackListItem[]>('ListStacks'),
      komoRead<ServerListItem[]>('ListServers'),
    ]);
    cards.push({
      id: 'komodo-core',
      label: 'Komodo Core',
      kind: 'komodo',
      status: 'ok',
      detail: `${summary.running}/${summary.total} stacks running`,
      url: KOMODO_PUBLIC_URL,
    });
    for (const srv of servers) {
      cards.push({
        id: `server-${srv.name}`,
        label: `Server: ${srv.name}`,
        kind: 'server',
        status: mapStackState(srv.info?.state),
        detail: srv.info?.state ?? undefined,
        url: null,
      });
    }
    for (const st of stacks) {
      cards.push({
        id: `stack-${st.name}`,
        label: st.name,
        kind: 'stack',
        status: mapStackState(st.info?.state ?? st.info?.status),
        detail: st.info?.state ?? st.info?.status ?? undefined,
        url: null,
      });
    }
  } catch (err) {
    cards.push({ id: 'komodo-core', label: 'Komodo Core', kind: 'komodo', status: 'error', detail: (err as Error).message, url: KOMODO_PUBLIC_URL });
  }
  return cards;
}

async function daguCard(): Promise<ServiceCard> {
  if (!daguConfigured()) {
    return { id: 'dagu', label: 'Dagu (routines)', kind: 'dagu', status: 'unconfigured', detail: 'DAGU_AUTH_BASIC_* not set', url: DAGU_PUBLIC_URL };
  }
  try {
    const res = await daguGet<DagListResponse>('/dags?limit=200');
    const items: DagListItem[] = res.dags ?? [];
    const failing = items.filter((d) => mapDaguStatus(d.latestDAGRun?.statusLabel) === 'error');
    const running = items.filter((d) => mapDaguStatus(d.latestDAGRun?.statusLabel) === 'running');
    let status: CardStatus = 'ok';
    if (failing.length > 0) status = 'error';
    else if (running.length > 0) status = 'running';
    const detail = failing.length > 0
      ? `${failing.length} failing: ${failing.slice(0, 3).map((d) => d.dag?.name ?? d.fileName).join(', ')}`
      : `${items.length} routines, all green`;
    return { id: 'dagu', label: 'Dagu (routines)', kind: 'dagu', status, detail, url: DAGU_PUBLIC_URL };
  } catch (err) {
    return { id: 'dagu', label: 'Dagu (routines)', kind: 'dagu', status: 'error', detail: (err as Error).message, url: DAGU_PUBLIC_URL };
  }
}

async function healthProbe(id: string, label: string, url: string): Promise<ServiceCard> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { id, label, kind: 'health', status: res.ok ? 'ok' : 'error', detail: `HTTP ${res.status}`, url: null };
  } catch (err) {
    return { id, label, kind: 'health', status: 'down', detail: (err as Error).message, url: null };
  }
}

export async function buildStatus(): Promise<StatusPayload> {
  const port = process.env.PORT ?? '3848';
  const peersHealth = process.env.CLAUDE_PEERS_HEALTH_URL ?? 'http://localhost:7899/health';
  const [komodo, dagu, telegram, peers] = await Promise.all([
    komodoCards(),
    daguCard(),
    healthProbe('telegram-mcp', 'Telegram MCP', `http://localhost:${port}/health`),
    healthProbe('claude-peers', 'claude-peers broker', peersHealth),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    cards: [telegram, peers, dagu, ...komodo],
  };
}
