import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { initDb } from './db.js';
import { createBot, onIncomingMessage, onReaction } from './bot.js';
import { getToolDefinitions, handleToolCall } from './tools.js';
import type { Bot } from 'grammy';

const PORT = parseInt(process.env.PORT ?? '3848', 10);

// Track active MCP server instances for channel push
const activeSessions = new Map<string, Server>();

function getLisbonTime(): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Lisbon',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date()) + ' Europe/Lisbon';
}

function createMcpServer(bot: Bot): Server {
  const server = new Server(
    { name: 'telegram', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
    },
  );

  const toolDefs = getToolDefinitions();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(bot, name, args ?? {});
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  // Init SQLite
  initDb();
  console.log('[telegram-mcp] Database initialized');

  // Create grammY bot
  const bot = createBot(token);

  // Handle incoming Telegram messages — push to all connected Claude sessions
  onIncomingMessage((event) => {
    const { chatId, text, username, displayName, messageId, replyToMessageId, mediaType, isForward, forwardFrom } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    const replyInfo = replyToMessageId ? ` [reply to msg ${replyToMessageId}]` : '';
    const typeInfo = mediaType ? ` [${mediaType}]` : '';
    const fwdInfo = isForward && forwardFrom ? ` [fwd from: ${forwardFrom}]` : '';
    console.log(`[Telegram] ${from}${typeInfo}${fwdInfo} (chat ${chatId}, msg ${messageId}${replyInfo}):\n> ${text}`);

    // Build content with reply/forward context
    let content = text;
    if (replyToMessageId) content = `[reply to msg_id=${replyToMessageId}] ${content}`;
    if (isForward && forwardFrom) content = `[forwarded from ${forwardFrom}] ${content}`;

    // Push via claude/channel notification to all connected sessions
    for (const [sid, server] of activeSessions) {
      try {
        server.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: {
              chat_id: String(chatId),
              message_id: String(messageId),
              reply_to_message_id: replyToMessageId ? String(replyToMessageId) : '',
              user: username ?? String(chatId),
              user_id: String(chatId),
              media_type: mediaType ?? '',
              is_forward: isForward ? 'true' : 'false',
              forward_from: forwardFrom ?? '',
              ts: new Date().toISOString(),
              local_time: getLisbonTime(),
            },
          },
        });
      } catch (err) {
        console.error(`[channel] Failed to push to session ${sid}:`, (err as Error).message);
      }
    }
  });

  // Handle incoming reactions — push to all connected Claude sessions
  onReaction((event) => {
    const { chatId, messageId, emoji, action, username, displayName } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.log(`[Telegram] ${from} ${action === 'added' ? 'поставил' : 'убрал'} реакцию ${emoji} на msg ${messageId} в чате ${chatId}`);

    const content = `[reaction: ${emoji}] на message_id=${messageId}`;

    for (const [sid, server] of activeSessions) {
      try {
        server.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: {
              chat_id: String(chatId),
              message_id: String(messageId),
              reaction: emoji,
              reaction_action: action,
              user: username ?? String(chatId),
              user_id: event.userId ? String(event.userId) : String(chatId),
              ts: new Date().toISOString(),
              local_time: getLisbonTime(),
            },
          },
        });
      } catch (err) {
        console.error(`[channel] Failed to push reaction to session ${sid}:`, (err as Error).message);
      }
    }
  });

  // Express app with SSE transport
  const app = express();
  app.use(express.json());

  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);
    console.log(`[connect] session=${sessionId}`);

    transport.onclose = () => {
      console.log(`[disconnect] session=${sessionId}`);
      transports.delete(sessionId);
      activeSessions.delete(sessionId);
    };

    const server = createMcpServer(bot);
    activeSessions.set(sessionId, server);
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing sessionId parameter' });
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      sessions: transports.size,
      uptime: process.uptime(),
    });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`[telegram-mcp] SSE listening on http://localhost:${PORT}`);
    console.log(`[telegram-mcp] SSE endpoint: http://localhost:${PORT}/sse`);
  });

  // Start bot (non-blocking)
  bot.start({
    allowed_updates: ['message', 'message_reaction'],
    onStart: () => console.log('[telegram-mcp] Bot started, listening for messages...'),
  }).catch((err) => {
    console.error('[telegram-mcp] Bot polling error:', (err as Error).message);
  });

  // Graceful shutdown
  async function shutdown() {
    console.log('[telegram-mcp] Shutting down...');
    for (const [, transport] of transports) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    transports.clear();
    activeSessions.clear();
    httpServer.close();
    await bot.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
