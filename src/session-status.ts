// Per-session status rendering for the `/status` command.
//
// Historically `/status` showed only a count ("Claude sessions: 2"). Vasily
// asked for a breakdown: one line per connected Claude session with who it is,
// its MCP client, and how long it has been connected.
//
// IMPORTANT scope note (why model / context-fill are NOT here): telegram-mcp is
// an MCP *server*; each Claude Code session connects as an MCP *client* over
// SSE. The MCP protocol's client handshake (`clientInfo`) carries only name +
// version — never the client's model or its live context-window token fill, and
// neither does the claude-peers broker. So those two fields are simply not
// observable from this side of the wire for externally-connected sessions. We
// surface everything we *can* see honestly (id, bound user, client, age) and
// leave a one-line note instead of inventing numbers. If a session ever
// self-reports model/tokens via a dedicated tool call, extend `SessionInfo` +
// `formatSessionLine` — the shape is deliberately open for it.
//
// Kept free of grammy / MCP imports so it is unit-testable in isolation
// (tests/session-status.test.ts), mirroring user-routing.ts.

export interface SessionInfo {
  /** SSE transport session id (opaque uuid). */
  id: string;
  /** Telegram user_id this session is bound to, or null for the admin/unbound sink. */
  boundUserId: string | null;
  /** MCP client name from the initialize handshake (e.g. "claude-code"). */
  clientName?: string;
  /** MCP client version from the initialize handshake. */
  clientVersion?: string;
  /** epoch ms when the SSE session connected. */
  connectedAt: number;
  /** Model id, if a session ever self-reports it (not available over MCP today). */
  model?: string;
  /** Context-window fill, if self-reported: [usedTokens, windowTokens]. */
  contextTokens?: [number, number];
}

/** Short human age like "45s", "12m", "3h 20m", "2d 4h". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Truncate the opaque session id so lines stay readable. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * One line per session: `N. <shortId> · <who> · <client> · <age>`.
 * Optional model / context-fill are appended only when actually present.
 */
export function formatSessionLine(index: number, info: SessionInfo, now: number): string {
  const who = info.boundUserId ? `user ${info.boundUserId}` : 'admin';
  const client =
    info.clientName
      ? `${info.clientName}${info.clientVersion ? ` ${info.clientVersion}` : ''}`
      : 'client ?';
  const parts = [shortId(info.id), who, client, formatAge(now - info.connectedAt)];
  if (info.model) parts.push(info.model);
  if (info.contextTokens) {
    const [used, win] = info.contextTokens;
    const pct = win > 0 ? Math.round((used / win) * 100) : 0;
    parts.push(`ctx ${Math.round(used / 1000)}k/${Math.round(win / 1000)}k (${pct}%)`);
  }
  return `${index}. ${parts.join(' · ')}`;
}

/** Full `/status` body. Pure so it can be asserted without a live bot. */
export function buildStatusText(args: {
  sessions: SessionInfo[];
  uptimeSeconds: number;
  now: number;
}): string {
  const { sessions, uptimeSeconds, now } = args;
  const h = Math.floor(uptimeSeconds / 3600);
  const m = Math.floor((uptimeSeconds % 3600) / 60);

  const lines = [`Bot: running`, `Uptime: ${h}h ${m}m`, `Claude sessions: ${sessions.length}`];

  if (sessions.length > 0) {
    lines.push('');
    // Stable order: oldest connection first.
    const ordered = [...sessions].sort((a, b) => a.connectedAt - b.connectedAt);
    ordered.forEach((s, i) => lines.push(formatSessionLine(i + 1, s, now)));

    // Only note the MCP limitation if nothing self-reported model/context.
    const anyRich = sessions.some((s) => s.model || s.contextTokens);
    if (!anyRich) {
      lines.push('');
      lines.push('model / context-fill не приходят по MCP (внешние Claude-сессии их не публикуют)');
    }
  }

  return lines.join('\n');
}
