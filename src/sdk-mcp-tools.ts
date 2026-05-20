import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Bot } from 'grammy';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

export function createTelegramMcpTools(bot: Bot): McpSdkServerConfigWithInstance {
  const sendMessage = tool(
    'send_message',
    'Send a text message to a Telegram chat. Supports Telegram HTML formatting.',
    {
      chat_id: z.string().describe('Telegram chat ID (numeric string)'),
      text: z.string().describe('Message text to send'),
      reply_to_message_id: z.number().optional().describe('Message ID to reply to'),
    },
    async (args) => {
      try {
        const opts: { reply_parameters?: { message_id: number } } = {};
        if (args.reply_to_message_id) {
          opts.reply_parameters = { message_id: args.reply_to_message_id };
        }
        const result = await bot.api.sendMessage(args.chat_id, args.text, {
          parse_mode: 'HTML',
          ...opts,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              message_id: result.message_id,
              chat_id: result.chat.id,
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
      const { getRecent: dbGetRecent } = await import('./db.js');
      if (!args.chat_id) {
        return {
          content: [{ type: 'text' as const, text: 'Error: chat_id is required for get_recent' }],
          isError: true,
        };
      }
      const messages = dbGetRecent(Number(args.chat_id), args.limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(messages, null, 2),
        }],
      };
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
      const { searchMessages: dbSearch } = await import('./db.js');
      const chatIdNum = args.chat_id ? Number(args.chat_id) : undefined;
      const { messages, total } = dbSearch(args.query, chatIdNum, undefined, args.limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ messages, total }, null, 2),
        }],
      };
    },
    { annotations: { readOnlyHint: true, openWorldHint: false } }
  );

  return createSdkMcpServer({
    name: 'telegram',
    version: '0.1.0',
    tools: [sendMessage, getRecent, searchMessages],
  });
}
