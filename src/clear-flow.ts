// Telegram-triggered native `/clear` of the operator's Claude Code session.
//
// The owner sends `/clear` in their private chat → bot.ts intercepts it (owner-only)
// BEFORE it is dispatched to the agent as a channel-push, and calls handleClear().
// We then inject a NATIVE Claude Code `/clear` straight into the operator's live
// tmux session via a host-provided inject script (OPERATOR_CLEAR_INJECT_SCRIPT),
// which types `/clear` + Enter into the claude TUI. Claude runs its own in-place
// context-clear — NO process restart, MCP connections stay alive, so there is no
// anti-replay / suicide-restart concern.
//
// Configuration: the feature is OFF unless OPERATOR_CLEAR_INJECT_SCRIPT points at
// an executable inject script. Without it, bot.ts replies with a "not configured"
// hint instead of injecting (isClearConfigured() below is the gate).
//
// Security: handleClear is only reachable after bot.ts has confirmed the sender is
// the configured owner/admin in a private chat (isClearAdmin below mirrors the
// /login admin allowlist). A non-owner `/clear` is never injected.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { isOperatorRequestEnabled, operatorRequest } from './operator-request.js';

const execFileP = promisify(execFile);

// Read at call time (not module load) so tests and late-loaded env both work.
function injectScript(): string {
  return (process.env.OPERATOR_CLEAR_INJECT_SCRIPT ?? '').trim();
}

/**
 * Is the /clear inject feature configured on this host? Either transport counts:
 * the new request-file transport (OPERATOR_REQUEST_DIR, sandbox-safe) OR the
 * legacy direct-exec inject script.
 */
export function isClearConfigured(): boolean {
  return isOperatorRequestEnabled() || injectScript().length > 0;
}

// Owner allowlist — same source as the /login admin gate (login-flow.ts).
// Only these Telegram user IDs may inject commands into the operator session.
function adminIds(): Set<number> {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const ids = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return new Set(ids);
}

export function isClearAdmin(userId: number): boolean {
  return adminIds().has(userId);
}

// Recognise an incoming text as the /clear command (exact, case-insensitive,
// optional @botname suffix). We deliberately do NOT match `/clear <args>` — a bare
// context-clear takes no arguments, and anything else should reach the agent.
export function isClearCommand(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return t === '/clear' || /^\/clear@[a-z0-9_]+$/.test(t);
}

export interface ClearResult {
  ok: boolean;
  error?: string;
}

// Inject the native /clear into the operator tmux session. The inject script reads
// the operator socket/session from env (TMUX_TMPDIR/OPERATOR_TMUX_SESSION) and types
// `/clear` + Enter. We pass TMUX_TMPDIR through so it resolves the operator's tmux
// server the same way the operator startup script created it.
export async function handleClear(): Promise<ClearResult> {
  // Preferred path: hand off via a request file the host consumer executes. The
  // bot needs no tmux / host-script access, so it stays fully sandboxed.
  if (isOperatorRequestEnabled()) {
    const r = await operatorRequest('clear', { timeoutMs: 12_000 });
    return { ok: r.ok, error: r.error };
  }
  // Legacy fallback: direct exec of the host inject script (pre-migration units).
  const script = injectScript();
  if (!script) {
    return { ok: false, error: 'neither OPERATOR_REQUEST_DIR nor OPERATOR_CLEAR_INJECT_SCRIPT is set — /clear is not configured on this host' };
  }
  try {
    const { stdout, stderr } = await execFileP(script, [], {
      timeout: 10_000,
      env: {
        ...process.env,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR || `${process.env.HOME || '/home/agent-os'}/.tmux`,
      },
    });
    if (stdout) console.log(`[clear-flow] ${stdout.trim()}`);
    if (stderr) console.log(`[clear-flow] ${stderr.trim()}`);
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const error = e.stderr?.trim() || e.message;
    console.error(`[clear-flow] inject failed: ${error}`);
    return { ok: false, error };
  }
}
