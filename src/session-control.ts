// Per-user session control (/clear and /model for NON-admin users).
//
// Admin/owner /clear and /model inject a native command into the OPERATOR tmux
// session (clear-flow.ts / model-flow.ts) — unchanged. A non-admin user has no
// access to the operator session; instead, on a MULTI-USER instance each user
// gets their OWN isolated per-user Claude session (a `<slug>-user-<uid>` tmux
// session spawned by the instance-side dispatcher — see the autospawn hook in
// autospawn.ts and dispatch-user-session.sh). This module lets the bot request
// a /clear or /model on THAT per-user session.
//
// SAME decoupling as autospawn: the bot runs in a hardened sandbox and cannot
// reach the per-user tmux socket (owned by the instance unix user), so it only
// WRITES a request file into MULTIUSER_REQUEST_DIR/session-control/. An
// instance-side consumer (a systemd .path unit running dispatch-user-session.sh)
// picks it up and injects the native command into the user's session. Writes are
// atomic (tmp + rename) and idempotent (one file per user+action; a burst just
// rewrites it).
//
// Gating: this path is active only when per-user sessions exist, i.e. when the
// multiuser autospawn feature is enabled (isAutospawnEnabled). On a single-
// operator install (the hub) it is inert and non-admin /clear|/model fall through
// to their legacy behavior — the operator session is never touched by a non-admin.

import fs from 'fs';
import path from 'path';
import { isAutospawnEnabled } from './autospawn.js';
import { isValidModelAlias } from './model-flow.js';

/**
 * True iff per-user session control is available on this instance. Per-user
 * sessions only exist when multiuser autospawn is enabled, so we reuse that flag.
 */
export function isSessionControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isAutospawnEnabled(env);
}

// Directory the bot writes control requests into (consumed instance-side). Null
// when MULTIUSER_REQUEST_DIR is unset (misconfigured multiuser instance).
function requestDir(): string | null {
  const base = process.env.MULTIUSER_REQUEST_DIR;
  if (!base) return null;
  return path.join(base, 'session-control');
}

function atomicWrite(finalPath: string, body: string): void {
  const dir = path.dirname(finalPath);
  const tmpPath = `${finalPath}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, finalPath); // atomic publish
}

/**
 * Request a native /clear on <userId>'s per-user session. Returns true iff a
 * request file was written. Non-throwing (a write hiccup must not break ingress).
 */
export function requestClear(userId: number): boolean {
  const dir = requestDir();
  if (!dir) {
    console.error('[session-control] MULTIUSER_REQUEST_DIR unset — cannot request clear');
    return false;
  }
  try {
    atomicWrite(path.join(dir, `${userId}.clear`), `${userId}\n${Date.now()}\n`);
    return true;
  } catch (err) {
    console.error(`[session-control] failed to write clear request for ${userId}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Request a native /model <alias> switch on <userId>'s per-user session. The
 * alias is validated (same charset gate as the operator path) before writing.
 * Returns true iff a request file was written.
 */
export function requestModel(userId: number, alias: string): boolean {
  if (!isValidModelAlias(alias)) {
    console.error(`[session-control] rejecting invalid model alias '${alias}' for ${userId}`);
    return false;
  }
  const dir = requestDir();
  if (!dir) {
    console.error('[session-control] MULTIUSER_REQUEST_DIR unset — cannot request model switch');
    return false;
  }
  try {
    // Body: user_id + alias + epoch; the consumer reads line 2 as the alias.
    atomicWrite(path.join(dir, `${userId}.model`), `${userId}\n${alias}\n${Date.now()}\n`);
    return true;
  } catch (err) {
    console.error(`[session-control] failed to write model request for ${userId}: ${(err as Error).message}`);
    return false;
  }
}
