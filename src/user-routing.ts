// Per-user session routing (Phase 1, design: multiuser-session-routing.md §A1).
//
// PROBLEM this solves: telegram-mcp historically broadcast EVERY incoming
// message to EVERY connected Claude session (a flat `activeSessions` map). With
// one operator session that is fine — "every session" == "the one operator".
// But a multi-user instance serves multiple humans (e.g. cofounders), each of
// whom should get their OWN isolated Claude session. Broadcasting interleaves
// everyone's threads into whichever sessions are connected.
//
// FIX: a session may *bind* itself to a user_id at SSE-connect time
// (`/sse?user_id=<id>`). Once any session is bound, an incoming message is
// routed ONLY to the session(s) bound to that message's user_id; admin/system
// traffic and any user with no bound session fall back to the UNBOUND sessions
// (the operator/admin session).
//
// BACKWARD COMPATIBILITY (critical — telegram-mcp is shared with the hub bot):
// when NO session has bound a user_id at all (the hub's single-operator case),
// `routeTargets()` returns ALL sessions for every message — byte-for-byte the
// old broadcast behavior. Per-user routing only ever *narrows* delivery, and
// only once at least one binding exists.
//
// This module is intentionally pure (no MCP / Express / grammY imports) so the
// routing decision is unit-testable in isolation, mirroring group-routing.ts.

/**
 * Tracks which connected sessions are bound to which Telegram user_id.
 *
 * - A session with no binding is "unbound" and serves as the admin/fallback
 *   sink (the single-operator session, or an owner-oversight session).
 * - A session binds exactly one user_id (per-USER granularity, per the design).
 * - Multiple sessions MAY bind the same user_id (e.g. a respawn racing a stale
 *   session); all bound sessions for a user receive that user's messages.
 */
export class SessionRegistry {
  // sessionId -> bound user_id (as string; Telegram ids are passed as strings
  // through the channel meta, so we normalize on string keys everywhere).
  private bindings = new Map<string, string>();
  // All currently-connected session ids (bound or not). The push loops own the
  // actual MCP Server handles; this registry only tracks identity/routing.
  private sessions = new Set<string>();

  /** Register a connected session. `userId` undefined/empty => unbound. */
  connect(sessionId: string, userId?: string | null): void {
    this.sessions.add(sessionId);
    const uid = normalizeUserId(userId);
    if (uid) this.bindings.set(sessionId, uid);
  }

  /** Bind (or rebind) an already-connected session to a user_id. */
  bind(sessionId: string, userId: string | number): void {
    const uid = normalizeUserId(userId);
    if (!uid) return;
    this.sessions.add(sessionId);
    this.bindings.set(sessionId, uid);
  }

  /** Drop a session entirely (on SSE disconnect). */
  disconnect(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.bindings.delete(sessionId);
  }

  /** True if at least one session anywhere is bound to a user_id. */
  hasAnyBinding(): boolean {
    return this.bindings.size > 0;
  }

  /** The user_id a session is bound to, or undefined if unbound. */
  boundUser(sessionId: string): string | undefined {
    return this.bindings.get(sessionId);
  }

  /** Session ids with no user binding (admin / fallback sinks). */
  unboundSessions(): string[] {
    return [...this.sessions].filter((s) => !this.bindings.has(s));
  }

  /** Session ids bound to a specific user_id. */
  sessionsForUser(userId: string | number): string[] {
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    return [...this.bindings.entries()].filter(([, u]) => u === uid).map(([s]) => s);
  }

  /**
   * Decide which connected session ids should receive a message.
   *
   * @param userId  the message's meta.user_id (string|number|null).
   * @param isAdminOrSystem  true for traffic that must always reach the
   *        admin/fallback session(s) regardless of user (worker reports, peer
   *        relays, evening-reminders, etc.). Routed to unbound sessions.
   *
   * Rules (in order):
   *  1. No binding exists anywhere  -> ALL sessions (legacy broadcast, hub-safe).
   *  2. Admin/system message        -> unbound sessions (fallback). If there are
   *                                    none, ALL sessions (never drop a system msg).
   *  3. User has bound session(s)    -> exactly those session(s).
   *  4. User has NO bound session    -> unbound sessions (so the admin/operator
   *                                    still sees a not-yet-routed user). If none,
   *                                    ALL sessions.
   */
  routeTargets(
    allSessionIds: Iterable<string>,
    userId?: string | number | null,
    isAdminOrSystem = false,
  ): string[] {
    const all = [...allSessionIds];

    // Rule 1: backward-compatible broadcast when nobody has bound. This is the
    // hub's single-operator case and MUST stay identical to the old behavior.
    if (!this.hasAnyBinding()) return all;

    const unbound = all.filter((s) => !this.bindings.has(s));

    // Rule 2: admin/system traffic goes to the fallback (unbound) sink.
    if (isAdminOrSystem) {
      return unbound.length > 0 ? unbound : all;
    }

    const uid = normalizeUserId(userId);
    if (uid) {
      const targeted = all.filter((s) => this.bindings.get(s) === uid);
      // Rule 3: the user has at least one bound session -> deliver only there.
      if (targeted.length > 0) return targeted;
    }

    // Rule 4: unknown / unbound user -> fallback to admin sink (or all if none).
    return unbound.length > 0 ? unbound : all;
  }
}

/** Normalize a user id to a non-empty string, or '' if absent/invalid. */
export function normalizeUserId(userId?: string | number | null): string {
  if (userId === null || userId === undefined) return '';
  const s = String(userId).trim();
  return s.length > 0 && s !== '0' ? s : '';
}

/**
 * Parse the `user_id` bind value out of an SSE connect URL/query.
 * Accepts a raw query value (string | string[] | undefined) from express.
 * Returns '' when no valid binding is requested (=> unbound / admin session).
 */
export function parseBindUserId(raw: unknown): string {
  if (Array.isArray(raw)) return normalizeUserId(raw[0] as string);
  return normalizeUserId(typeof raw === 'string' ? raw : '');
}
