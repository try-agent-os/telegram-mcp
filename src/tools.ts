import { InlineKeyboard, type Bot } from 'grammy';
import type { ReactionTypeEmoji } from '@grammyjs/types';

type ButtonSpec = { text: string; url?: string; callback?: string };
type ButtonRows = ButtonSpec[][];

function buildInlineKeyboard(rows: ButtonRows | undefined): InlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined;
  const kb = new InlineKeyboard();
  rows.forEach((row, ri) => {
    if (ri > 0) kb.row();
    for (const btn of row) {
      const hasUrl = typeof btn.url === 'string' && btn.url.length > 0;
      const hasCb = typeof btn.callback === 'string' && btn.callback.length > 0;
      if (hasUrl && hasCb) throw new Error(`Button "${btn.text}": url and callback mutually exclusive`);
      if (!hasUrl && !hasCb) throw new Error(`Button "${btn.text}": must have url or callback`);
      if (hasUrl) kb.url(btn.text, btn.url!);
      else kb.text(btn.text, btn.callback!);
    }
  });
  return kb;
}
import { saveMessage, searchMessages, getMessageByTelegramId, getRecent, listChats, getLastIncomingMessageId, listUsers, getUnansweredMessages } from './db.js';
import { semanticSearchMessages } from './semantic.js';
import { approveUser, denyUser, getTimezone, setTimezone } from './access.js';
import { botExchangeTracker, parseCoordinationChats } from './group-routing.js';

// Coordination groups whose outgoing messages we record into the bot↔bot reply
// chain (so the anti-loop depth guard links across this bot's own sends — a bot
// gets no update event for its own messages).
const COORD_CHATS = parseCoordinationChats(process.env.TELEGRAM_ALWAYS_ENGAGE_CHAT_IDS);
function recordOutgoing(chatId: number, messageId: number, replyToMessageId: number | null): void {
  if (COORD_CHATS.has(chatId)) {
    botExchangeTracker.observeOutgoing(chatId, messageId, replyToMessageId);
  }
}

// Markdown → Telegram HTML conversion.
// Telegram HTML subset: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <tg-spoiler>, <blockquote>.
// Auto-applied when text contains markdown syntax and parse_mode not explicitly set.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hasMarkdown(text: string): boolean {
  return /(\*\*[^*\n]+\*\*|```[\s\S]+?```|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|^#+\s|^\s*[-*]\s)/m.test(text);
}

// Already-HTML text (raw Telegram-HTML tags). When present we must set parse_mode HTML
// but NOT run markdownToTelegramHtml (it would escape the tags into literal text).
function hasHtmlTags(text: string): boolean {
  return /<\/?(b|i|u|s|code|pre|a|tg-spoiler|blockquote)(\s[^>]*)?>/i.test(text);
}

function markdownToTelegramHtml(text: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks ```lang\n...\n```
  let working = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${lang}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  // 2. Extract inline code `...`
  working = working.replace(/`([^`\n]+)`/g, (_m, body) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(body)}</code>`);
    return `\u0000INLINE${idx}\u0000`;
  });

  // 3. HTML-escape remaining text
  working = escapeHtml(working);

  // 4. Apply markdown transformations on escaped text.
  // Bold: **text** → <b>text</b>
  working = working.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Italic: _text_ → <i>text</i> (strict: underscore-wrapped, non-greedy, no newlines)
  working = working.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<i>$2</i>');
  // Links: [text](url) — note: & was escaped to &amp; so must match that
  working = working.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url.replace(/&amp;/g, '&')}">${label}</a>`;
  });
  // Headers: # text (line start) → <b>text</b>
  working = working.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  // Bullets: - item or * item (line start) → • item
  working = working.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  // 5. Restore code placeholders
  working = working.replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inlineCodes[Number(i)]);
  working = working.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)]);

  return working;
}

// Decide parse_mode and transform text when auto-markdown is desired.
function prepareOutgoing(text: string, explicitParseMode?: string): { text: string; parse_mode?: 'HTML' | 'MarkdownV2' } {
  if (explicitParseMode) {
    return { text, parse_mode: explicitParseMode as 'HTML' | 'MarkdownV2' };
  }
  if (hasHtmlTags(text)) {
    return { text, parse_mode: 'HTML' };
  }
  if (hasMarkdown(text)) {
    return { text: markdownToTelegramHtml(text), parse_mode: 'HTML' };
  }
  return { text };
}

// --- Rich Messages (Bot API 10.1, sendRichMessage) ---------------------------
// InputRichMessage takes extended HTML or Markdown content (exactly one). Telegram
// parses it server-side into RichBlock* blocks (headings, tables, lists, details,
// block quotes, dividers, …). New clients render natively; older clients receive
// Telegram's own fallback representation. grammY's typed Api (1.35) predates 10.1,
// so we call the raw Bot API HTTP endpoint. If the rich send fails entirely we
// degrade to a plain HTML sendMessage so the operator never loses a report.
function richApiBase(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return `https://api.telegram.org/bot${token}`;
}

// Strip rich/HTML tags down to readable plain text for the method-level fallback.
function richToPlain(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|li|h[1-6]|details|summary|blockquote|table)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const buttonsSchema = {
  type: 'array' as const,
  description: 'Inline keyboard buttons as 2D array (rows). Each button: {text, url?} (URL button) or {text, callback?} (callback button). Exactly one of url/callback per button.',
  items: {
    type: 'array' as const,
    items: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Button label' },
        url: { type: 'string', description: 'URL to open when clicked (URL button)' },
        callback: { type: 'string', description: 'Callback data sent back when clicked (callback button, max 64 bytes)' },
      },
      required: ['text'],
    },
  },
};

export function getToolDefinitions() {
  return [
    {
      name: 'telegram_send_message',
      description: 'Send a text message to a Telegram chat',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          text: { type: 'string', description: 'Message text' },
          reply_to_message_id: { type: 'number', description: 'Message ID to reply to (optional)' },
          parse_mode: { type: 'string', enum: ['HTML', 'MarkdownV2'], description: 'Parse mode (optional)' },
          buttons: buttonsSchema,
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'telegram_send_rich_message',
      description:
        'Send a NATIVE rich message (Bot API 10.1 sendRichMessage): headings, tables, lists, ' +
        'collapsible <details>, block quotes, dividers, code blocks. Provide content as extended ' +
        'HTML (preferred) or Markdown — exactly one. Supported HTML: <h1>-<h6>, <p>, <table>/<tr>/<td>, ' +
        '<ul>/<ol>/<li>, <details>/<summary>, <blockquote>, <hr>, <b>/<i>/<u>/<s>/<code>/<pre>/<a>. ' +
        'New Telegram clients render natively; older clients get Telegram\'s automatic fallback. ' +
        'Use this for structured reports/tables instead of monospace <pre> fakes. If the rich send ' +
        'fails entirely, the tool degrades to a plain HTML text message (never silently drops).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          html: { type: 'string', description: 'Rich content as extended HTML. Provide exactly one of html|markdown.' },
          markdown: { type: 'string', description: 'Rich content as Markdown. Provide exactly one of html|markdown.' },
          fallback_text: { type: 'string', description: 'Optional plain/HTML text used only if the rich send fails (method-level fallback). If omitted, derived from html/markdown.' },
          reply_to_message_id: { type: 'number', description: 'Message ID to reply to (optional)' },
          buttons: buttonsSchema,
          is_rtl: { type: 'boolean', description: 'Render the rich message right-to-left (optional)' },
          skip_entity_detection: { type: 'boolean', description: 'Skip automatic detection of URLs/mentions/hashtags etc. (optional)' },
          disable_notification: { type: 'boolean', description: 'Send silently (optional)' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'telegram_reply',
      description: 'Reply to the latest incoming message in a chat',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          text: { type: 'string', description: 'Reply text' },
          parse_mode: { type: 'string', enum: ['HTML', 'MarkdownV2'], description: 'Parse mode (optional)' },
          buttons: buttonsSchema,
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'telegram_edit_message',
      description: 'Edit a previously sent message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          message_id: { type: 'number', description: 'Message ID to edit' },
          text: { type: 'string', description: 'New text' },
          parse_mode: { type: 'string', enum: ['HTML', 'MarkdownV2'], description: 'Parse mode (optional; HTML auto-applied when text has markdown/HTML tags)' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
    {
      name: 'telegram_react',
      description: 'Add an emoji reaction to a message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          message_id: { type: 'number', description: 'Message ID' },
          emoji: { type: 'string', description: 'Emoji to react with' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'telegram_search_messages',
      description: 'Full-text search across message history. Pass message_id to look up a single message by its telegram_message_id (e.g. resolve a reply\'s reply_to_message_id back to the original alert) — query is ignored in that mode.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (required unless message_id is given)' },
          message_id: { type: 'number', description: 'Look up the single message with this telegram_message_id (e.g. a reply_to_message_id). Bypasses full-text search.' },
          chat_id: { type: 'number', description: 'Filter by chat ID (optional)' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'Filter by direction (optional)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
          days: { type: 'number', description: 'Search last N days (optional)' },
        },
      },
    },
    {
      name: 'telegram_semantic_search',
      description: 'Semantic (meaning-based) search across message history using local embeddings, hybrid with full-text. ' +
        'Use for paraphrased/conceptual queries where exact words are unknown or ASR-mangled (e.g. "когда перечислял свои долги", "что решали про домены"). ' +
        'Supports date-range filters and recency boost. Returns messages with chat_id, date, direction, display_name and a fused relevance score.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Natural-language query (meaning matters, exact words do not)' },
          chat_id: { type: 'number', description: 'Filter by chat ID (optional)' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'Filter by direction (optional; in = from user, out = from bot)' },
          limit: { type: 'number', description: 'Max results (default 10, max 50)' },
          days: { type: 'number', description: 'Only messages from the last N days (optional)' },
          date_from: { type: 'string', description: 'Only messages on/after this UTC date, YYYY-MM-DD or ISO datetime (optional)' },
          date_to: { type: 'string', description: 'Only messages on/before this UTC date, YYYY-MM-DD or ISO datetime (optional)' },
          mode: { type: 'string', enum: ['hybrid', 'semantic', 'fts'], description: 'Retrieval mode (default hybrid = vector + full-text fusion)' },
          recency_boost: { type: 'boolean', description: 'Boost fresher messages (default true). Set false for pure relevance.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'telegram_get_recent',
      description: 'Get recent messages from a chat',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'number', description: 'Telegram chat ID' },
          limit: { type: 'number', description: 'Max messages (default 20)' },
        },
        required: ['chat_id'],
      },
    },
    {
      name: 'telegram_list_chats',
      description: 'List all chats the bot has interacted with',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'telegram_get_access_list',
      description: 'View all users with their access status and timezone',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['allowed', 'pending', 'denied'], description: 'Filter by status (optional)' },
        },
      },
    },
    {
      name: 'telegram_approve_user',
      description: 'Add a user to the allowlist',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'number', description: 'Telegram user ID to approve' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'telegram_deny_user',
      description: 'Deny a user (remove from allowlist/pending)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'number', description: 'Telegram user ID to deny' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'telegram_set_timezone',
      description: 'Set timezone for a user (IANA format, e.g. Europe/Moscow)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'number', description: 'Telegram user ID' },
          timezone: { type: 'string', description: 'IANA timezone (e.g. Europe/Moscow, America/New_York)' },
        },
        required: ['user_id', 'timezone'],
      },
    },
    {
      name: 'telegram_get_timezone',
      description: 'Get current timezone for a user',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'number', description: 'Telegram user ID' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'telegram_whoami',
      description: 'Return identity of the bot this telegram-mcp instance is talking through (id, username, first_name). Useful when multiple bots are configured per host.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'telegram_get_unanswered',
      description: 'Get incoming messages that have no bot reply after them (missed messages). Use at boot to detect messages missed during operator downtime.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          since_hours: { type: 'number', description: 'Look back N hours (default 24, max 168)' },
        },
      },
    },
  ];
}

export async function handleToolCall(bot: Bot, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'telegram_send_message': {
      const { chat_id, text, reply_to_message_id, parse_mode, buttons } = args as {
        chat_id: number; text: string; reply_to_message_id?: number; parse_mode?: string; buttons?: ButtonRows;
      };
      const prepared = prepareOutgoing(text, parse_mode);
      const kb = buildInlineKeyboard(buttons);
      const sent = await bot.api.sendMessage(chat_id, prepared.text, {
        reply_parameters: reply_to_message_id ? { message_id: reply_to_message_id } : undefined,
        parse_mode: prepared.parse_mode,
        reply_markup: kb,
      });
      saveMessage({
        telegram_message_id: sent.message_id,
        chat_id,
        chat_type: null,
        chat_title: null,
        user_id: null,
        username: null,
        display_name: 'Bot',
        text,
        direction: 'out',
        reply_to_message_id: reply_to_message_id ?? null,
        media_type: null,
        file_path: null,
        file_name: null,
      });
      recordOutgoing(chat_id, sent.message_id, reply_to_message_id ?? null);
      return { message_id: sent.message_id, chat_id, date: new Date(sent.date * 1000).toISOString() };
    }

    case 'telegram_send_rich_message': {
      const { chat_id, html, markdown, fallback_text, reply_to_message_id, buttons, is_rtl, skip_entity_detection, disable_notification } = args as {
        chat_id: number; html?: string; markdown?: string; fallback_text?: string;
        reply_to_message_id?: number; buttons?: ButtonRows; is_rtl?: boolean;
        skip_entity_detection?: boolean; disable_notification?: boolean;
      };
      const hasHtml = typeof html === 'string' && html.length > 0;
      const hasMd = typeof markdown === 'string' && markdown.length > 0;
      if (hasHtml === hasMd) {
        throw new Error('telegram_send_rich_message: provide exactly one of `html` or `markdown`');
      }
      const richMessage: Record<string, unknown> = hasHtml ? { html } : { markdown };
      if (is_rtl) richMessage.is_rtl = true;
      if (skip_entity_detection) richMessage.skip_entity_detection = true;
      const richKb = buildInlineKeyboard(buttons);
      const payload: Record<string, unknown> = { chat_id, rich_message: richMessage };
      if (disable_notification) payload.disable_notification = true;
      if (reply_to_message_id) payload.reply_parameters = { message_id: reply_to_message_id };
      if (richKb) payload.reply_markup = { inline_keyboard: richKb.inline_keyboard };

      const plainForDb = hasHtml ? richToPlain(html!) : (markdown as string);
      let sentMessageId: number;
      let degraded = false;
      let degradeError: string | undefined;

      const resp = await fetch(`${richApiBase()}/sendRichMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as { ok: boolean; result?: { message_id: number }; description?: string };

      if (data.ok && data.result) {
        sentMessageId = data.result.message_id;
      } else {
        // Method-level graceful degradation: fall back to a plain HTML text message.
        degraded = true;
        degradeError = data.description;
        const fallback = (typeof fallback_text === 'string' && fallback_text.length > 0)
          ? fallback_text
          : (hasHtml ? html! : (markdown as string));
        const prepared = prepareOutgoing(fallback, hasHtml ? 'HTML' : undefined);
        const sent = await bot.api.sendMessage(chat_id, prepared.text, {
          reply_parameters: reply_to_message_id ? { message_id: reply_to_message_id } : undefined,
          parse_mode: prepared.parse_mode,
          reply_markup: richKb,
        });
        sentMessageId = sent.message_id;
      }

      saveMessage({
        telegram_message_id: sentMessageId,
        chat_id,
        chat_type: null,
        chat_title: null,
        user_id: null,
        username: null,
        display_name: 'Bot',
        text: plainForDb,
        direction: 'out',
        reply_to_message_id: reply_to_message_id ?? null,
        media_type: null,
        file_path: null,
        file_name: null,
      });
      recordOutgoing(chat_id, sentMessageId, reply_to_message_id ?? null);
      return { message_id: sentMessageId, chat_id, rich: !degraded, degraded, error: degradeError };
    }

    case 'telegram_reply': {
      const { chat_id, text, parse_mode, buttons } = args as {
        chat_id: number; text: string; parse_mode?: string; buttons?: ButtonRows;
      };
      const lastMsgId = getLastIncomingMessageId(chat_id);
      const prepared = prepareOutgoing(text, parse_mode);
      const kb = buildInlineKeyboard(buttons);
      const sent = await bot.api.sendMessage(chat_id, prepared.text, {
        reply_parameters: lastMsgId ? { message_id: lastMsgId } : undefined,
        parse_mode: prepared.parse_mode,
        reply_markup: kb,
      });
      saveMessage({
        telegram_message_id: sent.message_id,
        chat_id,
        chat_type: null,
        chat_title: null,
        user_id: null,
        username: null,
        display_name: 'Bot',
        text,
        direction: 'out',
        reply_to_message_id: lastMsgId,
        media_type: null,
        file_path: null,
        file_name: null,
      });
      recordOutgoing(chat_id, sent.message_id, lastMsgId);
      return { message_id: sent.message_id };
    }

    case 'telegram_edit_message': {
      const { chat_id, message_id, text, parse_mode } = args as { chat_id: number; message_id: number; text: string; parse_mode?: string };
      const prepared = prepareOutgoing(text, parse_mode);
      await bot.api.editMessageText(chat_id, message_id, prepared.text, prepared.parse_mode ? { parse_mode: prepared.parse_mode } : undefined);
      return { ok: true };
    }

    case 'telegram_react': {
      const { chat_id, message_id, emoji } = args as { chat_id: number; message_id: number; emoji: string };
      await bot.api.setMessageReaction(chat_id, message_id, [{ type: 'emoji', emoji } as ReactionTypeEmoji]);
      return { ok: true };
    }

    case 'telegram_search_messages': {
      const { query, message_id, chat_id, direction, limit, days } = args as {
        query?: string; message_id?: number; chat_id?: number; direction?: 'in' | 'out'; limit?: number; days?: number;
      };
      // message_id mode: resolve a reply_to_message_id back to the original
      // message (automated alerts, etc.) without full-text search.
      if (message_id != null) {
        const msg = getMessageByTelegramId(message_id, chat_id);
        return { messages: msg ? [msg] : [], total: msg ? 1 : 0 };
      }
      if (!query) {
        return { messages: [], total: 0, error: 'query or message_id required' };
      }
      return searchMessages(query, chat_id, direction, limit, days);
    }

    case 'telegram_semantic_search': {
      const { query, chat_id, direction, limit, days, date_from, date_to, mode, recency_boost } = args as {
        query: string; chat_id?: number; direction?: 'in' | 'out'; limit?: number; days?: number;
        date_from?: string; date_to?: string; mode?: 'hybrid' | 'semantic' | 'fts'; recency_boost?: boolean;
      };
      if (!query || query.trim().length === 0) {
        return { results: [], error: 'query required' };
      }
      return semanticSearchMessages({ query, chat_id, direction, limit, days, date_from, date_to, mode, recency_boost });
    }

    case 'telegram_get_recent': {
      const { chat_id, limit } = args as { chat_id: number; limit?: number };
      return { messages: getRecent(chat_id, limit) };
    }

    case 'telegram_list_chats': {
      return { chats: listChats() };
    }

    case 'telegram_get_access_list': {
      const { status } = args as { status?: string };
      return { users: listUsers(status) };
    }

    case 'telegram_approve_user': {
      const { user_id } = args as { user_id: number };
      return { ok: approveUser(user_id), user_id };
    }

    case 'telegram_deny_user': {
      const { user_id } = args as { user_id: number };
      return { ok: denyUser(user_id), user_id };
    }

    case 'telegram_set_timezone': {
      const { user_id, timezone } = args as { user_id: number; timezone: string };
      const ok = setTimezone(user_id, timezone);
      if (!ok) throw new Error(`Invalid timezone: ${timezone}`);
      return { ok: true, user_id, timezone };
    }

    case 'telegram_get_timezone': {
      const { user_id } = args as { user_id: number };
      return { user_id, timezone: getTimezone(user_id) };
    }

    case 'telegram_whoami': {
      const me = await bot.api.getMe();
      return {
        id: me.id,
        username: me.username ?? null,
        first_name: me.first_name,
        is_bot: me.is_bot,
        can_join_groups: me.can_join_groups,
        can_read_all_group_messages: me.can_read_all_group_messages,
      };
    }

    case 'telegram_get_unanswered': {
      const { since_hours } = args as { since_hours?: number };
      const messages = getUnansweredMessages(since_hours ?? 24);
      return { count: messages.length, messages };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
