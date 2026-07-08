// Bot command menu (the "/" suggestion sheet in Telegram clients).
//
// The list is built DYNAMICALLY from which host-side features are enabled, so a
// deployment only advertises commands it can actually service. Base commands are
// always present; owner-gated inject commands (/clear, /model) appear only when
// their inject scripts are configured, and — when an admin allowlist exists — are
// scoped to the owner's private chat via BotCommandScopeChat so other chats never
// see them.
//
// buildBotCommands() is a pure function (feature flags in → command list out) so
// it can be unit-tested without a live Bot. registerBotCommands() performs the
// idempotent Bot API calls and never throws (a failed setMyCommands must not take
// down bot startup).

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

// Owner-gated inject commands, each guarded by its feature flag.
export const OWNER_COMMANDS: ReadonlyArray<{ flag: keyof CommandFeatureFlags; spec: BotCommandSpec }> = [
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

/** Pure builder: base commands plus every owner command whose flag is enabled. */
export function buildBotCommands(flags: CommandFeatureFlags): BotCommandSpec[] {
  const cmds: BotCommandSpec[] = [...BASE_COMMANDS];
  for (const { flag, spec } of OWNER_COMMANDS) {
    if (flags[flag]) cmds.push(spec);
  }
  return cmds;
}

// Parse the admin allowlist the same way the inject flows do (login/clear/model):
// TELEGRAM_ADMIN_USER_IDS (comma-separated) with legacy TELEGRAM_USER_ID fallback.
export function parseAdminIds(): number[] {
  const raw = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  return raw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));
}

/**
 * Register the command menu with Telegram. Idempotent and non-throwing.
 * When owner-gated extras are enabled AND an admin allowlist exists, the base
 * list is registered at default scope and the full list is scoped to each
 * admin's private chat. Otherwise a single default-scope list is used.
 */
export async function registerBotCommands(bot: Bot): Promise<void> {
  const flags = currentCommandFlags();
  const full = buildBotCommands(flags);
  const extras = full.slice(BASE_COMMANDS.length);
  const adminIds = parseAdminIds();
  try {
    if (extras.length > 0 && adminIds.length > 0) {
      await bot.api.setMyCommands([...BASE_COMMANDS]);
      for (const id of adminIds) {
        await bot.api.setMyCommands(full, { scope: { type: 'chat', chat_id: id } });
      }
      console.log(
        `[bot] setMyCommands ok: ${BASE_COMMANDS.length} default cmds; owner extras [${extras
          .map(c => '/' + c.command)
          .join(', ')}] scoped to ${adminIds.length} admin chat(s)`,
      );
    } else {
      await bot.api.setMyCommands(full);
      console.log(
        `[bot] setMyCommands ok: ${full.length} default cmds${
          extras.length ? ` (incl. ${extras.map(c => '/' + c.command).join(', ')})` : ''
        }`,
      );
    }
  } catch (err) {
    console.error('[bot] Failed to set commands:', err);
  }
}
