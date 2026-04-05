import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { z } from 'zod';
import { initDb } from './db.js';
import { createBot, onIncomingMessage } from './bot.js';
import { getToolDefinitions, handleToolCall } from './tools.js';
import type { Bot } from 'grammy';

const PORT = parseInt(process.env.PORT ?? '3848', 10);

function createMcpServer(bot: Bot): McpServer {
  const server = new McpServer(
    { name: 'telegram', version: '0.1.0' },
    { capabilities: {} },
  );

  for (const tool of getToolDefinitions()) {
    const zodShape: Record<string, z.ZodTypeAny> = {};
    const props = tool.inputSchema.properties ?? {};
    const required = new Set(tool.inputSchema.required ?? []);

    for (const [key, prop] of Object.entries(props) as [string, { type: string; description?: string; enum?: string[] }][]) {
      let field: z.ZodTypeAny;
      switch (prop.type) {
        case 'number':
        case 'integer':
          field = z.number();
          break;
        case 'boolean':
          field = z.boolean();
          break;
        case 'array':
          field = z.array(z.string());
          break;
        default:
          field = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      }
      if (prop.description) {
        field = field.describe(prop.description);
      }
      zodShape[key] = required.has(key) ? field : field.optional();
    }

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        try {
          const result = await handleToolCall(bot, tool.name, args);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }

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

  // Handle incoming Telegram messages
  onIncomingMessage((chatId, text, username, displayName, messageId) => {
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.log(`[Telegram] ${from} (chat ${chatId}, msg ${messageId}):\n> ${text}`);
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
    };

    const server = createMcpServer(bot);
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
