// Telegram-triggered native `/model <alias>` switch of the operator's Claude Code
// session. Sibling of clear-flow.ts — same interception + tmux-inject mechanism.
//
// The owner sends `/model` in their private chat → bot.ts intercepts it (owner-only)
// BEFORE it is dispatched to the agent as a channel-push and replies with inline
// model buttons (callback_data `model_switch:<alias>`). A tap — or a direct
// `/model <alias>` — injects a NATIVE `/model <alias>` into the operator's live
// tmux session via a host-provided inject script (OPERATOR_MODEL_INJECT_SCRIPT).
// Claude runs its own in-place model switch — NO process restart, MCP connections
// stay alive.
//
// Configuration: the feature is OFF unless OPERATOR_MODEL_INJECT_SCRIPT points at
// an executable inject script. Without it, bot.ts replies with a "not configured"
// hint instead of injecting (isModelConfigured() below is the gate).
//
// Security: only reachable after bot.ts confirmed the sender is the configured
// owner/admin (same allowlist as /clear). The alias additionally passes a strict
// charset check here AND should be re-validated in the inject script before being
// typed into the TUI.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

// Read at call time (not module load) so tests and late-loaded env both work.
function injectScript(): string {
  return (process.env.OPERATOR_MODEL_INJECT_SCRIPT ?? '').trim();
}

/** Is the /model inject feature configured on this host? */
export function isModelConfigured(): boolean {
  return injectScript().length > 0;
}

// Button set for the bare `/model` picker. Aliases verified against the installed
// claude CLI 2026-07-05 (each accepted via `claude --model <alias> -p`). Fable
// keeps the [1m] 1M-context variant — plain claude-fable-5 would shrink the
// window to 200k under a live large context.
export const MODEL_CHOICES: ReadonlyArray<{ label: string; alias: string }> = [
  { label: 'Fable 5', alias: 'claude-fable-5[1m]' },
  { label: 'Opus 4.8', alias: 'claude-opus-4-8[1m]' },
  { label: 'Sonnet 5', alias: 'claude-sonnet-5' },
  { label: 'Haiku 4.5', alias: 'claude-haiku-4-5' },
];

export const MODEL_CALLBACK_PREFIX = 'model_switch:';

// Same strict charset the inject script should enforce: plain model id/alias with
// an optional [1m]-style suffix. Anything else is rejected before it can be typed
// into the live TUI.
const ALIAS_RE = /^[A-Za-z0-9._-]+(\[[A-Za-z0-9]+\])?$/;

export function isValidModelAlias(alias: string): boolean {
  return ALIAS_RE.test(alias);
}

// Owner allowlist — same source as the /clear and /login admin gates.
function adminIds(): Set<number> {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const ids = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return new Set(ids);
}

export function isModelAdmin(userId: number): boolean {
  return adminIds().has(userId);
}

// Parse an incoming text as the /model command (case-insensitive on the command
// itself, optional @botname suffix, alias case preserved):
//   `/model`            → { kind: 'menu' }
//   `/model <alias>`    → { kind: 'switch', alias } (alias charset-validated)
//   anything else       → null (reaches the agent as a normal message)
export type ModelCommand = { kind: 'menu' } | { kind: 'switch'; alias: string };

export function parseModelCommand(text: string | undefined | null): ModelCommand | null {
  if (!text) return null;
  const m = text.trim().match(/^\/model(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/i);
  if (!m) return null;
  if (!m[1]) return { kind: 'menu' };
  if (!isValidModelAlias(m[1])) return null;
  return { kind: 'switch', alias: m[1] };
}

// Extract the alias from a `model_switch:<alias>` callback_data. Returns null for
// non-model callbacks or an alias failing the charset check.
export function parseModelCallback(data: string | undefined | null): string | null {
  if (!data || !data.startsWith(MODEL_CALLBACK_PREFIX)) return null;
  const alias = data.slice(MODEL_CALLBACK_PREFIX.length);
  return isValidModelAlias(alias) ? alias : null;
}

// Human label for an alias (button label if known, else the alias itself).
export function labelForAlias(alias: string): string {
  return MODEL_CHOICES.find(c => c.alias === alias)?.label ?? alias;
}

// grammY inline keyboard for the bare `/model` picker — one button per row.
export function modelKeyboard(): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: MODEL_CHOICES.map(c => [
      { text: c.label, callback_data: `${MODEL_CALLBACK_PREFIX}${c.alias}` },
    ]),
  };
}

export interface ModelSwitchResult {
  ok: boolean;
  error?: string;
}

// Inject the native `/model <alias>` into the operator tmux session. Mirrors
// handleClear() — the inject script resolves the operator socket/session from env.
export async function handleModelSwitch(alias: string): Promise<ModelSwitchResult> {
  if (!isValidModelAlias(alias)) {
    return { ok: false, error: `invalid model alias: ${alias}` };
  }
  const script = injectScript();
  if (!script) {
    return { ok: false, error: 'OPERATOR_MODEL_INJECT_SCRIPT is not set — /model inject is not configured on this host' };
  }
  try {
    const { stdout, stderr } = await execFileP(script, [alias], {
      timeout: 10_000,
      env: {
        ...process.env,
        TMUX_TMPDIR: process.env.TMUX_TMPDIR || `${process.env.HOME || '/home/agent-os'}/.tmux`,
      },
    });
    if (stdout) console.log(`[model-flow] ${stdout.trim()}`);
    if (stderr) console.log(`[model-flow] ${stderr.trim()}`);
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const error = e.stderr?.trim() || e.message;
    console.error(`[model-flow] inject failed: ${error}`);
    return { ok: false, error };
  }
}
