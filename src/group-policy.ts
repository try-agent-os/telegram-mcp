// Group / supergroup engagement policy.
//
// In private chats the bot always engages (every message is for the bot).
// In group chats with multiple human members the bot must NOT respond to
// every message — that would be spammy and burn tokens. Instead it only
// engages ("notifies the agent") when the user explicitly addresses it:
//
//   1. The message text/caption contains an @-mention of the bot.
//   2. The message is a reply to one of the bot's own messages.
//   3. The message is a slash command (starts with "/").
//
// Non-engagement messages are still persisted to the local SQLite store so
// the agent has full chat-history context when it IS addressed later.
//
// This module is intentionally framework-agnostic: it takes plain shape
// arguments (not grammY Context) so it can be unit-tested without a live
// Telegram update.

import type { ChatType } from './types.js';

/**
 * Minimal subset of a Telegram MessageEntity that we care about for mention
 * detection. The real grammY/Bot-API type has more fields; we only inspect a
 * few so the test fixtures stay small.
 */
export interface PolicyEntity {
  type: string; // "mention" | "text_mention" | "bot_command" | ...
  offset: number;
  length: number;
  /** Only present on text_mention entities — the embedded user record. */
  user?: { id: number; username?: string | null };
}

export interface PolicyMessage {
  /** Text body. For media messages this is the caption (may be empty). */
  text: string;
  /** Inline entities from `message.entities` or `caption_entities`. */
  entities: PolicyEntity[];
  /**
   * If this message is a reply, the user-id of the author of the message
   * being replied to. `null` if not a reply or if the original author is
   * unknown.
   */
  replyToUserId: number | null;
}

export interface BotIdentity {
  /** Numeric bot user-id (from getMe). Required for text_mention + reply checks. */
  id: number;
  /** Bot username WITHOUT the leading "@". Required for text-mention checks. */
  username: string;
}

/**
 * Does the message contain a `@botusername` mention of THIS bot?
 *
 * Telegram delivers two entity flavours we accept:
 *   - `mention`     — plain `@username` typed by the user; we substring the
 *                     text at offset/length and compare to `@<bot.username>`.
 *   - `text_mention` — clicked-from-list mention; carries an embedded `user`
 *                     object with the user id, which is more reliable than the
 *                     visible text.
 *
 * Case-insensitive on username (Telegram usernames are case-insensitive).
 */
export function isMentionedInText(msg: PolicyMessage, bot: BotIdentity): boolean {
  if (!msg.entities || msg.entities.length === 0) return false;
  const botHandle = `@${bot.username}`.toLowerCase();
  for (const ent of msg.entities) {
    if (ent.type === 'text_mention' && ent.user?.id === bot.id) {
      return true;
    }
    if (ent.type === 'mention') {
      const slice = msg.text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
      if (slice === botHandle) return true;
    }
  }
  return false;
}

/** Is the message a reply to one of the bot's own messages? */
export function isReplyToBot(msg: PolicyMessage, bot: BotIdentity): boolean {
  return msg.replyToUserId !== null && msg.replyToUserId === bot.id;
}

/**
 * Does the message start with a slash command? We accept either an explicit
 * `bot_command` entity at offset 0 (Telegram's canonical signal) or a literal
 * `/` prefix (covers edge cases where entities are stripped, e.g. captions on
 * older clients).
 *
 * `/cmd@botname` form is treated as a command regardless of which bot was
 * targeted, because the entity-at-offset-0 check fires either way.
 */
export function isSlashCommand(msg: PolicyMessage): boolean {
  if (msg.entities?.some(e => e.type === 'bot_command' && e.offset === 0)) return true;
  return msg.text.startsWith('/');
}

/**
 * Optional engagement context for `shouldNotifyAgent`.
 *
 *  - `chatId`       — the Telegram chat id of the incoming message; required if
 *                     `alwaysEngage` is supplied so it can be matched against
 *                     the override set.
 *  - `alwaysEngage` — set of group/supergroup chat ids where the bot should
 *                     notify on EVERY message (bypassing the mention / reply /
 *                     slash policy). Channels are still excluded — broadcast
 *                     posts are never treated as conversation. Use sparingly:
 *                     this is the "I trust this room, page me on everything"
 *                     escape hatch; default behaviour stays addressed-only.
 */
export interface EngagementContext {
  chatId?: number;
  alwaysEngage?: ReadonlySet<number>;
}

/**
 * Decide whether to push a channel notification to the connected Claude Code
 * session.
 *
 *  - Private chats: always notify (every message is for the bot).
 *  - Channels: never notify (broadcast posts, no real conversation expected).
 *  - Group / supergroup: notify only if the bot is explicitly addressed,
 *    OR if the chat id is in the `alwaysEngage` override set.
 *
 * Even when this returns `false` the caller should still persist the message
 * to the local message store so future agent invocations have history.
 */
export function shouldNotifyAgent(
  chatType: ChatType,
  msg: PolicyMessage,
  bot: BotIdentity,
  context?: EngagementContext,
): boolean {
  if (chatType === 'private') return true;
  if (chatType === 'channel') return false;
  if (
    context?.alwaysEngage &&
    context.chatId !== undefined &&
    context.alwaysEngage.has(context.chatId)
  ) {
    return true;
  }
  return (
    isMentionedInText(msg, bot) ||
    isReplyToBot(msg, bot) ||
    isSlashCommand(msg)
  );
}
