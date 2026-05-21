// Telegram-triggered `claude auth login` flow.
//
// State machine:
//   /login                         → cmd_start → URL → user copies code →
//   <next text msg from same chat> → cmd_submit → OK / FAIL
//   /login_cancel  or 5min timeout → cmd_cancel
//
// The script `scripts/claude-login-pipe.sh` does the actual tmux dance with
// `claude auth login`. This module is a thin wrapper that tracks per-chat
// pending state and adds an operator-watchdog so the OAuth refresh also
// unblocks the operator if it was sitting on a stale token.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const SCRIPT = process.env.CLAUDE_LOGIN_PIPE ?? '/opt/agent-os/claude/scripts/claude-login-pipe.sh';
const OPERATOR_UNIT = process.env.LOGIN_OPERATOR_UNIT ?? 'agent-os-operator.service';
const OPERATOR_TMUX = process.env.LOGIN_OPERATOR_TMUX ?? 'operator';
const TMUX_TMPDIR = process.env.LOGIN_TMUX_TMPDIR ?? '/home/agent-os/.tmux';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingLogin {
  startedAt: number;
  timer: NodeJS.Timeout;
}

const pending = new Map<number, PendingLogin>();

function adminIds(): Set<number> {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const ids = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return new Set(ids);
}

export function isLoginAdmin(userId: number): boolean {
  return adminIds().has(userId);
}

export function isLoginPending(chatId: number): boolean {
  return pending.has(chatId);
}

function clearPending(chatId: number): void {
  const p = pending.get(chatId);
  if (p) clearTimeout(p.timer);
  pending.delete(chatId);
}

// Ensure the operator tmux session is alive. The login script itself spawns
// its own tmux session ("claude-login") so operator is NOT a prerequisite, but
// after a successful refresh we want operator to be ready to receive the
// fresh token at request time. If the session is dead, restart the unit.
async function ensureOperatorAlive(): Promise<{ wasDead: boolean; restarted: boolean }> {
  try {
    await execFileP('tmux', ['has-session', '-t', OPERATOR_TMUX], {
      env: { ...process.env, TMUX_TMPDIR },
    });
    return { wasDead: false, restarted: false };
  } catch {
    // Session missing — restart the unit. systemd will spawn a fresh tmux.
    try {
      await execFileP('sudo', ['-n', 'systemctl', 'restart', OPERATOR_UNIT]);
      return { wasDead: true, restarted: true };
    } catch (err) {
      console.error(`[login-flow] failed to restart ${OPERATOR_UNIT}:`, (err as Error).message);
      return { wasDead: true, restarted: false };
    }
  }
}

export interface StartResult {
  ok: true;
  url: string;
  operatorRestarted: boolean;
}
export interface StartFailure {
  ok: false;
  error: string;
}

export async function startLogin(chatId: number): Promise<StartResult | StartFailure> {
  // Kill any prior session in case of stale state from a previous attempt.
  clearPending(chatId);
  try {
    await execFileP(SCRIPT, ['cancel']);
  } catch {
    // ignore — "no session" is fine
  }

  const operatorStatus = await ensureOperatorAlive();

  try {
    const { stdout } = await execFileP(SCRIPT, ['start'], { timeout: 40_000 });
    const urlMatch = stdout.match(/^URL=(.+)$/m);
    if (!urlMatch) {
      return { ok: false, error: 'login script returned no URL' };
    }
    const url = urlMatch[1].trim();
    const timer = setTimeout(() => {
      pending.delete(chatId);
      execFile(SCRIPT, ['cancel'], () => { /* fire and forget */ });
      console.log(`[login-flow] chat ${chatId} login timed out after 5min`);
    }, LOGIN_TIMEOUT_MS);
    pending.set(chatId, { startedAt: Date.now(), timer });
    return { ok: true, url, operatorRestarted: operatorStatus.restarted };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

export interface SubmitResult {
  ok: true;
}
export interface SubmitFailure {
  ok: false;
  error: string;
}

export async function submitLogin(chatId: number, code: string): Promise<SubmitResult | SubmitFailure> {
  if (!pending.has(chatId)) {
    return { ok: false, error: 'no active login session — start with /login first' };
  }
  try {
    const { stdout } = await execFileP(SCRIPT, ['submit', code], { timeout: 60_000 });
    clearPending(chatId);
    if (stdout.trim() === 'OK') {
      return { ok: true };
    }
    return { ok: false, error: `unexpected script output: ${stdout.trim()}` };
  } catch (err) {
    clearPending(chatId);
    const e = err as { stderr?: string; message: string };
    return { ok: false, error: e.stderr?.trim() || e.message };
  }
}

export async function cancelLogin(chatId: number): Promise<void> {
  clearPending(chatId);
  try {
    await execFileP(SCRIPT, ['cancel']);
  } catch {
    // ignore
  }
}
