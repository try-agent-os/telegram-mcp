// Phase 2 ingress hook (multiuser session routing): lazily spawn a per-user
// isolated Claude session on the first message from an ALLOWED user, so the
// Phase-1 routing filter then delivers only to it.
//
// CRITICAL GATING — the telegram-mcp binary may be SHARED by a single-operator
// instance and a multi-user instance running from the same dist. This hook MUST
// activate ONLY for the multi-user instance. It is gated behind the env flag
// MULTIUSER_AUTOSPAWN (default OFF). A single-operator unit leaves it unset, so
// it keeps its exact behavior even after the shared dist is rebuilt; only the
// multi-user unit sets MULTIUSER_AUTOSPAWN=1.
//
// This module is pure-ish (no grammY/MCP imports) and takes its spawn action +
// flag as injectable params, so the decision is unit-testable in isolation
// (mirrors group-routing.ts / user-routing.ts).

import fs from 'fs';
import path from 'path';

/** True iff the multiuser autospawn flag is enabled. Default OFF. */
export function isAutospawnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MULTIUSER_AUTOSPAWN ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface AutospawnDeps {
  /** Whether the hook is enabled (defaults to reading the env flag). */
  enabled?: boolean;
  /** Action invoked to ensure user <userId> has a live bound session. */
  ensure?: (userId: number) => void;
}

/**
 * Decide + perform autospawn for an ALLOWED private-chat user.
 *
 * Callers MUST only invoke this for users who already passed the access gate
 * (private + status 'allowed'); this function does NOT re-check access (the gate
 * owns that). It only enforces the FLAG gate. Returns true iff ensure() ran.
 *
 *  - flag OFF  -> no-op, returns false (identical to the single-operator setup).
 *  - flag ON   -> calls ensure(userId), returns true.
 */
export function maybeAutospawn(userId: number, deps: AutospawnDeps = {}): boolean {
  const enabled = deps.enabled ?? isAutospawnEnabled();
  if (!enabled) return false;
  const ensure = deps.ensure ?? defaultEnsure;
  try {
    ensure(userId);
  } catch (err) {
    // Never let a dispatcher hiccup break message ingress — log and continue.
    console.error(`[autospawn] ensure(${userId}) failed: ${(err as Error).message}`);
  }
  return true;
}

// Default ensure: drop a spawn-REQUEST file that an out-of-band consumer picks
// up and turns into a real "ensure a session exists for <user_id>" dispatch.
//
// WHY a request file (not a direct spawn): on production hosts the telegram-mcp
// process typically runs under a hardened systemd sandbox (ProtectHome=tmpfs,
// read-only filesystem views, NoNewPrivileges=yes). From inside it the
// dispatcher script, the `claude` binary, and the operator cwd may all be
// UNreachable, so a child spawn would ENOENT. The dispatcher must run as a user
// with home + binary access (like the operator unit). So the bot only WRITES a
// request into a dir that is writable in its namespace AND readable by a
// separate consumer (e.g. a systemd .path/.timer unit). This keeps the bot
// sandbox tight and decouples the privileged spawn.
//
// MULTIUSER_REQUEST_DIR is set in the multi-user telegram-mcp unit and points
// at its writable media dir (also readable by the consumer). Write is atomic
// (tmp + rename); idempotent — one file per user_id (a burst just rewrites it).
function defaultEnsure(userId: number): void {
  const reqDir = process.env.MULTIUSER_REQUEST_DIR;
  if (!reqDir) {
    console.error('[autospawn] MULTIUSER_AUTOSPAWN set but MULTIUSER_REQUEST_DIR unset — skipping');
    return;
  }
  const dir = path.join(reqDir, 'autospawn-requests');
  const finalPath = path.join(dir, `${userId}.req`);
  const tmpPath = `${finalPath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Body: user_id + epoch. The consumer reads user_id and runs `ensure`.
    fs.writeFileSync(tmpPath, `${userId}\n${Date.now()}\n`);
    fs.renameSync(tmpPath, finalPath); // atomic publish
  } catch (err) {
    console.error(`[autospawn] failed to write request for ${userId}: ${(err as Error).message}`);
  }
}
