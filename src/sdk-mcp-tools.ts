import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Bot } from 'grammy';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

const TELEGRAM_MSG_LIMIT = 4096;

export function splitMessage(text: string, limit: number = TELEGRAM_MSG_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function createTelegramMcpTools(bot: Bot, sessionChatId?: string): McpSdkServerConfigWithInstance {
  const sendMessage = tool(
    'send_message',
    'Send a text message to a Telegram chat. Supports Telegram HTML formatting.',
    {
      chat_id: z.string().describe('Telegram chat ID (numeric string)'),
      text: z.string().describe('Message text to send'),
      reply_to_message_id: z.number().optional().describe('Message ID to reply to'),
    },
    async (args) => {
      if (sessionChatId && args.chat_id !== sessionChatId) {
        return {
          content: [{ type: 'text' as const, text: `Error: cannot send to chat ${args.chat_id} — session is scoped to chat ${sessionChatId}` }],
          isError: true,
        };
      }
      try {
        const opts: { reply_parameters?: { message_id: number } } = {};
        if (args.reply_to_message_id) {
          opts.reply_parameters = { message_id: args.reply_to_message_id };
        }
        const chunks = splitMessage(args.text);
        const results: { message_id: number; chat_id: number }[] = [];
        for (const chunk of chunks) {
          const result = await bot.api.sendMessage(args.chat_id, chunk, {
            parse_mode: 'HTML',
            ...(results.length === 0 ? opts : {}),
          });
          results.push({ message_id: result.message_id, chat_id: result.chat.id });
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              message_id: results[0].message_id,
              chat_id: results[0].chat_id,
              chunks_sent: results.length,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { destructiveHint: false, openWorldHint: true } }
  );

  const getRecent = tool(
    'get_recent',
    'Get recent messages from a Telegram chat. Returns messages in chronological order.',
    {
      chat_id: z.string().optional().describe('Chat ID to filter by. If omitted, returns from all chats.'),
      limit: z.number().int().min(1).max(100).default(20).describe('Number of messages to return'),
    },
    async (args) => {
      try {
        const { getRecent: dbGetRecent } = await import('./db.js');
        const targetChatId = args.chat_id ?? sessionChatId;
        if (!targetChatId) {
          return {
            content: [{ type: 'text' as const, text: 'Error: chat_id is required for get_recent' }],
            isError: true,
          };
        }
        if (sessionChatId && args.chat_id && args.chat_id !== sessionChatId) {
          return {
            content: [{ type: 'text' as const, text: `Error: cannot read chat ${args.chat_id} — session is scoped to chat ${sessionChatId}` }],
            isError: true,
          };
        }
        const messages = dbGetRecent(Number(targetChatId), args.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(messages, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } }
  );

  const searchMessages = tool(
    'search_messages',
    'Full-text search across stored Telegram messages using FTS5.',
    {
      query: z.string().describe('Search query string'),
      chat_id: z.string().optional().describe('Chat ID to filter by'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results to return'),
    },
    async (args) => {
      try {
        const { searchMessages: dbSearch } = await import('./db.js');
        const targetChatId = args.chat_id ?? sessionChatId;
        if (sessionChatId && args.chat_id && args.chat_id !== sessionChatId) {
          return {
            content: [{ type: 'text' as const, text: `Error: cannot search chat ${args.chat_id} — session is scoped to chat ${sessionChatId}` }],
            isError: true,
          };
        }
        const chatIdNum = targetChatId ? Number(targetChatId) : undefined;
        const { messages, total } = dbSearch(args.query, chatIdNum, undefined, args.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ messages, total }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } }
  );

  return createSdkMcpServer({
    name: 'telegram',
    version: '0.1.0',
    tools: [sendMessage, getRecent, searchMessages],
  });
}
