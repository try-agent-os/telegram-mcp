// Multi-agent coordination-group routing.
//
// Background: when several agent bots (e.g. a primary server bot and a
// laptop bot) share one Telegram group AND BotFather Group
// Privacy is OFF, every bot sees every message — including each other's. With
// the naive "always engage" policy (TELEGRAM_ALWAYS_ENGAGE_CHAT_IDS) this means
// a single human prompt fans out into N replies, and bot↔bot chatter can loop.
//
// This module decides, for one observed message in a coordination group,
// whether THIS bot should engage. It implements the agreed protocol:
//
//   1. @mention (or reply) addressing THIS bot          → engage (the addressee).
//   2. @mention addressing ANOTHER bot                  → skip (not for us).
//   3. Bot message with no mention of us                → skip (no free-for-all;
//                                                          cross-agent comms are
//                                                          mention-addressed).
//   4. Human message, no mention                        → only the PRIMARY host
//                                                          engages; the BACKUP
//                                                          host defers unless the
//                                                          primary is offline.
//   5. Anti-loop guard: a bot↔bot reply chain deeper than MAX_BOT_EXCHANGE_DEPTH
//      is skipped (with a one-shot "depth exceeded" signal).
//
// Pure & framework-agnostic so it unit-tests without a live Telegram update.

/** Maximum bot↔bot reply-chain depth before the anti-loop guard trips. */
export const MAX_BOT_EXCHANGE_DEPTH = 3;

/** Coordination-group membership, parsed from TELEGRAM_ALWAYS_ENGAGE_CHAT_IDS. */
export function parseCoordinationChats(raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n)),
  );
}

/** Is the host's TELEGRAM_GROUP_PRIMARY_HOST flag truthy? Default false. */
export function isPrimaryHostEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface RoutingInput {
  /** message.from.is_bot — another agent posted this. */
  isFromBot: boolean;
  /** Does this message explicitly address THIS bot (mention OR reply-to-us)? */
  addressesThisBot: boolean;
  /** Does the message carry a mention/text_mention of SOME bot (maybe not us)? */
  hasAnyMention: boolean;
  /** TELEGRAM_GROUP_PRIMARY_HOST for this host. */
  isPrimaryHost: boolean;
  /** Bot↔bot reply-chain depth ending at (and including) this message. */
  botExchangeDepth: number;
  /**
   * Backup-host only: is the primary host believed to be online? When false the
   * backup takes over the human-no-mention default. Ignored on the primary host.
   */
  primaryHostOnline: boolean;
}

export interface RoutingVerdict {
  /** Notify the agent now. */
  engage: boolean;
  /** This message was authored by another bot (cross-agent event). */
  crossAgent: boolean;
  /** The anti-loop depth guard tripped (caller may emit a one-shot notice). */
  depthExceeded: boolean;
  /**
   * Backup host should defer this human-no-mention message: persist now, and
   * engage later only if the primary did not respond within the grace window.
   */
  deferBackup: boolean;
  /** Short machine-readable reason for logs. */
  reason: string;
}

const SKIP = (
  crossAgent: boolean,
  reason: string,
  extra?: Partial<RoutingVerdict>,
): RoutingVerdict => ({
  engage: false,
  crossAgent,
  depthExceeded: false,
  deferBackup: false,
  reason,
  ...extra,
});

const ENGAGE = (crossAgent: boolean, reason: string): RoutingVerdict => ({
  engage: true,
  crossAgent,
  depthExceeded: false,
  deferBackup: false,
  reason,
});

/**
 * Decide whether THIS bot should engage with one coordination-group message.
 */
export function decideGroupEngagement(input: RoutingInput): RoutingVerdict {
  const crossAgent = input.isFromBot;

  // Rule 5: anti-loop guard for bot↔bot exchanges. A directed bot message that
  // would push the chain past the cap is dropped (and flagged so the caller can
  // post a single "depth exceeded" notice instead of replying).
  if (crossAgent && input.botExchangeDepth > MAX_BOT_EXCHANGE_DEPTH) {
    return SKIP(crossAgent, `depth-exceeded:${input.botExchangeDepth}`, {
      depthExceeded: true,
    });
  }

  // Rules 1 & 3 (directed-at-us): explicit @mention or reply addressing THIS
  // bot → the addressee engages, whether the sender is human or another bot.
  if (input.addressesThisBot) {
    return ENGAGE(crossAgent, crossAgent ? 'cross-agent-mention' : 'mentioned');
  }

  // Rule 2: a mention of some OTHER bot → not for us.
  if (input.hasAnyMention) {
    return SKIP(crossAgent, 'mention-other');
  }

  // Rule 3 (cross-agent, no mention of us): ignore arbitrary bot chatter. This
  // is the primary loop-breaker — bots never react to un-addressed bot output.
  if (crossAgent) {
    return SKIP(crossAgent, 'bot-no-mention');
  }

  // Rule 4: human message with no mention.
  if (input.isPrimaryHost) {
    return ENGAGE(crossAgent, 'primary-host-default');
  }
  // Backup host: defer to the primary unless it is offline.
  if (input.primaryHostOnline) {
    return SKIP(crossAgent, 'backup-host-defer', { deferBackup: true });
  }
  return ENGAGE(crossAgent, 'backup-failover-primary-offline');
}

/**
 * Tracks bot↔bot reply-chain depth across a coordination group.
 *
 * depth(message) = number of consecutive bot-authored messages in the reply
 * chain ending at (and including) this message; human messages reset to 0.
 *
 * Both INCOMING (other bots') and OUTGOING (this bot's own) messages must be
 * fed in via observe()/observeOutgoing() so the chain links across hosts — a
 * bot does not receive update events for its own sends, so we record those at
 * the moment we send them. Requires cross-agent messages to be sent as replies
 * (reply_to_message_id) for the chain to link; otherwise each starts at depth 1
 * and the guard simply never trips (the mention/no-mention rules still apply).
 */
export class BotExchangeTracker {
  private depths = new Map<number, Map<number, number>>();
  private readonly perChatCap: number;

  constructor(perChatCap = 512) {
    this.perChatCap = perChatCap;
  }

  private chatMap(chatId: number): Map<number, number> {
    let m = this.depths.get(chatId);
    if (!m) {
      m = new Map();
      this.depths.set(chatId, m);
    }
    return m;
  }

  /**
   * Record a message and return its depth.
   * @param isBot whether the author is a bot (false → human, resets to 0).
   */
  observe(
    chatId: number,
    messageId: number,
    replyToMessageId: number | null,
    isBot: boolean,
  ): number {
    const m = this.chatMap(chatId);
    let depth: number;
    if (!isBot) {
      depth = 0;
    } else {
      const parent =
        replyToMessageId != null ? m.get(replyToMessageId) : undefined;
      depth = (parent ?? 0) + 1;
    }
    m.set(messageId, depth);
    // Bound memory: evict oldest-inserted entries beyond the cap.
    while (m.size > this.perChatCap) {
      const oldest = m.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    return depth;
  }

  /** Convenience for THIS bot's own outgoing message (always a bot author). */
  observeOutgoing(
    chatId: number,
    messageId: number,
    replyToMessageId: number | null,
  ): number {
    return this.observe(chatId, messageId, replyToMessageId, true);
  }
}

/** Process-wide tracker shared between the bot handlers and the MCP send tools. */
export const botExchangeTracker = new BotExchangeTracker();
