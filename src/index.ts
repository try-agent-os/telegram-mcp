import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDb } from './db.js';
import { createBot, onIncomingMessage } from './bot.js';
import { getToolDefinitions, handleToolCall } from './tools.js';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  // Init SQLite
  initDb();
  console.error('[telegram-mcp] Database initialized');

  // Create grammY bot
  const bot = createBot(token);

  // Create MCP server
  const server = new McpServer({
    name: 'telegram',
    version: '0.1.0',
  });

  // Register tools from definitions
  for (const tool of getToolDefinitions()) {
    // Build Zod schema from JSON Schema properties
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
      }
    );
  }

  // Handle incoming Telegram messages -- log to stderr so Claude sees them
  onIncomingMessage((chatId, text, username, displayName, messageId) => {
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.error(`[Telegram] ${from} (chat ${chatId}, msg ${messageId}):\n> ${text}`);
  });

  // Start bot (non-blocking)
  bot.start({
    onStart: () => console.error('[telegram-mcp] Bot started, listening for messages...'),
  });

  // Start MCP server (blocks on stdio)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[telegram-mcp] MCP server connected');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
