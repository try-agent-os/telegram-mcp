// Owner-path request/result-file transport for the three host-coupled flows
// (/login, /clear, /model). Replaces the direct execFile() of host scripts
// (claude-login-pipe.sh, operator-clear-inject.sh, operator-model-inject.sh) with
// a filesystem request/result round-trip:
//
//   bot  --writes-->  $OPERATOR_REQUEST_DIR/<kind>/<id>.req   (atomic tmp+rename)
//   host consumer (systemd .path -> .service, running as the operator unix user
//   with tmux + creds access) executes the matching script and writes
//                      $OPERATOR_REQUEST_DIR/<kind>/<id>.res   (JSON {ok,url?,error?})
//   bot  --polls-->   reads <id>.res, deletes both files, returns the outcome.
//
// WHY: the bot then needs NO sudo, NO host-script exec and NO operator-tmux /
// creds access — only a writable request dir under its own state dir. The
// telegram-mcp unit can drop its NoNewPrivileges/ReadWritePaths tmux+creds
// exceptions and the bot can run fully sandboxed / containerized (GHCR). This
// mirrors the autospawn.ts / session-control.ts request-file decoupling, extended
// with a RESULT channel because these three flows need a synchronous answer (the
// login URL, OK/FAIL, inject ok/error) that fire-and-forget autospawn does not.
//
// GATING: active only when OPERATOR_REQUEST_DIR is set. When unset the callers
// fall back to their legacy execFile() path, so a single shared dist keeps working
// on not-yet-migrated units (same philosophy as MULTIUSER_AUTOSPAWN).

import fs from 'fs';
import path from 'path';

/** Request kinds understood by the host consumer. */
export type OperatorRequestKind =
  | 'login-start'
  | 'login-submit'
  | 'login-cancel'
  | 'clear'
  | 'model';

/** True iff the request-file transport is configured on this instance. */
export function isOperatorRequestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPERATOR_REQUEST_DIR ?? '').trim().length > 0;
}

export interface OperatorResult {
  ok: boolean;
  url?: string;
  error?: string;
  /** login-start only: consumer restarted a dead operator unit before proceeding. */
  restarted?: boolean;
}

interface RequestOpts {
  /** Optional string argument (login code / model alias). */
  arg?: string;
  /** How long to wait for the consumer's result file before giving up. */
  timeoutMs?: number;
  /** Poll interval for the result file. */
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
}

let seq = 0;

function baseDir(env: NodeJS.ProcessEnv): string | null {
  const base = (env.OPERATOR_REQUEST_DIR ?? '').trim();
  return base ? base : null;
}

function atomicWrite(finalPath: string, body: string): void {
  const dir = path.dirname(finalPath);
  const tmpPath = `${finalPath}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, finalPath); // atomic publish — consumer never sees a partial req
}

/**
 * Write a request file for <kind> and await the consumer's result file.
 *
 * The request is a single JSON line { id, kind, arg?, ts }. The consumer writes
 * <id>.res as JSON { ok, url?, error? } (atomically), which we read then remove
 * along with the (already-consumed) request file. On timeout we return a
 * structured failure and best-effort clean up the request so it is not replayed.
 */
export async function operatorRequest(
  kind: OperatorRequestKind,
  opts: RequestOpts = {},
): Promise<OperatorResult> {
  const env = opts.env ?? process.env;
  const base = baseDir(env);
  if (!base) {
    return { ok: false, error: 'OPERATOR_REQUEST_DIR is not set — request transport not configured' };
  }
  const dir = path.join(base, kind);
  const id = `${process.pid}-${Date.now()}-${++seq}`;
  const reqPath = path.join(dir, `${id}.req`);
  const resPath = path.join(dir, `${id}.res`);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 150;

  const body = JSON.stringify({ id, kind, arg: opts.arg, ts: Date.now() }) + '\n';
  try {
    atomicWrite(reqPath, body);
  } catch (err) {
    return { ok: false, error: `failed to write request: ${(err as Error).message}` };
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      let raw: string | null = null;
      try {
        raw = fs.readFileSync(resPath, 'utf8');
      } catch {
        // not written yet — wait and retry
        await sleep(pollMs);
        continue;
      }
      // Result present. Clean up both files before returning.
      safeUnlink(resPath);
      safeUnlink(reqPath);
      try {
        const parsed = JSON.parse(raw) as OperatorResult;
        return { ok: !!parsed.ok, url: parsed.url, error: parsed.error, restarted: parsed.restarted };
      } catch {
        return { ok: false, error: `malformed result file: ${raw.slice(0, 200)}` };
      }
    }
    // Timed out — drop the request so a late consumer does not act on a stale ask.
    safeUnlink(reqPath);
    return { ok: false, error: `timed out after ${timeoutMs}ms waiting for host consumer (${kind})` };
  } catch (err) {
    safeUnlink(reqPath);
    return { ok: false, error: (err as Error).message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone — fine
  }
}
