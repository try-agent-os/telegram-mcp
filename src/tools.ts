import type { Bot } from 'grammy';
import { saveMessage, searchMessages, getRecent, listChats, getLastIncomingMessageId, listUsers } from './db.js';
import { approveUser, denyUser, getTimezone, setTimezone } from './access.js';

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
        },
        required: ['chat_id', 'text'],
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
      description: 'Full-text search across message history',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          chat_id: { type: 'number', description: 'Filter by chat ID (optional)' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'Filter by direction (optional)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
          days: { type: 'number', description: 'Search last N days (optional)' },
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
  ];
}

export async function handleToolCall(bot: Bot, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'telegram_send_message': {
      const { chat_id, text, reply_to_message_id, parse_mode } = args as {
        chat_id: number; text: string; reply_to_message_id?: number; parse_mode?: string;
      };
      const sent = await bot.api.sendMessage(chat_id, text, {
        reply_parameters: reply_to_message_id ? { message_id: reply_to_message_id } : undefined,
        parse_mode: parse_mode as 'HTML' | 'MarkdownV2' | undefined,
      });
      saveMessage({
        telegram_message_id: sent.message_id,
        chat_id,
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
      return { message_id: sent.message_id, chat_id, date: new Date(sent.date * 1000).toISOString() };
    }

    case 'telegram_reply': {
      const { chat_id, text, parse_mode } = args as { chat_id: number; text: string; parse_mode?: string };
      const lastMsgId = getLastIncomingMessageId(chat_id);
      const sent = await bot.api.sendMessage(chat_id, text, {
        reply_parameters: lastMsgId ? { message_id: lastMsgId } : undefined,
        parse_mode: parse_mode as 'HTML' | 'MarkdownV2' | undefined,
      });
      saveMessage({
        telegram_message_id: sent.message_id,
        chat_id,
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
      return { message_id: sent.message_id };
    }

    case 'telegram_edit_message': {
      const { chat_id, message_id, text } = args as { chat_id: number; message_id: number; text: string };
      await bot.api.editMessageText(chat_id, message_id, text);
      return { ok: true };
    }

    case 'telegram_react': {
      const { chat_id, message_id, emoji } = args as { chat_id: number; message_id: number; emoji: string };
      await bot.api.setMessageReaction(chat_id, message_id, [{ type: 'emoji', emoji: emoji as any }]);
      return { ok: true };
    }

    case 'telegram_search_messages': {
      const { query, chat_id, direction, limit, days } = args as {
        query: string; chat_id?: number; direction?: 'in' | 'out'; limit?: number; days?: number;
      };
      return searchMessages(query, chat_id, direction, limit, days);
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
