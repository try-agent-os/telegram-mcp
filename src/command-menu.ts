// Bot command menu (the "/" suggestion sheet in Telegram clients).
//
// The list is built DYNAMICALLY from which host-side features are enabled, so a
// deployment only advertises commands it can actually service. Base commands are
// always present; the inject commands (/clear, /model) appear only when their
// inject scripts are configured. All commands live in the default scope — the menu
// is visible to everyone (the inject flows still enforce their own admin gate at
// call time, so a non-owner tapping /clear is rejected there, not by hiding it).
//
// buildBotCommands() is a pure function (feature flags in → command list out) so
// it can be unit-tested without a live Bot. registerBotCommands() performs the
// idempotent setMyCommands call and never throws (a failed setMyCommands must not
// take down bot startup).

import type { Bot } from 'grammy';
import { isClearConfigured } from './clear-flow.js';
import { isModelConfigured } from './model-flow.js';

export interface BotCommandSpec {
  command: string;
  description: string;
}

// Always-on product commands. Descriptions are English (public product repo).
export const BASE_COMMANDS: ReadonlyArray<BotCommandSpec> = [
  { command: 'tz', description: 'Set or view timezone (e.g. /tz Europe/Moscow)' },
  { command: 'timezone', description: 'Set or view timezone (e.g. /timezone America/New_York)' },
  { command: 'status', description: 'Check bot and Claude connection status' },
  { command: 'id', description: 'Show your Telegram user ID' },
  { command: 'login', description: 'Re-authenticate Claude OAuth (admin only)' },
  { command: 'login_cancel', description: 'Cancel a pending /login flow' },
  { command: 'console', description: 'Open the AgentOS Console Mini App' },
  { command: 'help', description: 'List available commands' },
];

// Feature-gated inject commands, each guarded by its feature flag. Shown to
// everyone when enabled; the inject flows enforce the admin gate at call time.
export const FEATURE_COMMANDS: ReadonlyArray<{ flag: keyof CommandFeatureFlags; spec: BotCommandSpec }> = [
  { flag: 'clearInject', spec: { command: 'clear', description: 'Clear the agent conversation context' } },
  { flag: 'modelInject', spec: { command: 'model', description: 'Switch the agent model' } },
];

export interface CommandFeatureFlags {
  clearInject: boolean;
  modelInject: boolean;
}

/** Read the current feature flags from the environment (call-time, not load-time). */
export function currentCommandFlags(): CommandFeatureFlags {
  return {
    clearInject: isClearConfigured(),
    modelInject: isModelConfigured(),
  };
}

/** Pure builder: base commands plus every feature command whose flag is enabled. */
export function buildBotCommands(flags: CommandFeatureFlags): BotCommandSpec[] {
  const cmds: BotCommandSpec[] = [...BASE_COMMANDS];
  for (const { flag, spec } of FEATURE_COMMANDS) {
    if (flags[flag]) cmds.push(spec);
  }
  return cmds;
}

/**
 * Register the command menu with Telegram at the default scope (visible to all).
 * Idempotent and non-throwing (a failed setMyCommands must not block bot startup).
 */
export async function registerBotCommands(bot: Bot): Promise<void> {
  const full = buildBotCommands(currentCommandFlags());
  const extras = full.slice(BASE_COMMANDS.length);
  try {
    await bot.api.setMyCommands(full);
    console.log(
      `[bot] setMyCommands ok: ${full.length} cmds${
        extras.length ? ` (incl. ${extras.map(c => '/' + c.command).join(', ')})` : ''
      }`,
    );
  } catch (err) {
    console.error('[bot] Failed to set commands:', err);
  }
}
