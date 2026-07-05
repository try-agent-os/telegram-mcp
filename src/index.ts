import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { initDb, seedAdmins, getUnansweredMessages, getUnansweredMessagesForUser, bumpReplayCount } from './db.js';
import { createBot, onIncomingMessage, onReaction } from './bot.js';
import { getToolDefinitions, handleToolCall } from './tools.js';
import { getTimezone } from './access.js';
import { mountConsole, publicGuard } from './console/routes.js';
import { SessionRegistry, parseBindUserId } from './user-routing.js';
import type { Bot } from 'grammy';

const PORT = parseInt(process.env.PORT ?? '3848', 10);

// Track active MCP server instances for channel push
const activeSessions = new Map<string, Server>();

// Per-user session routing. A session can bind a user_id at /sse connect
// (?user_id=). Until ANY session binds, this is inert and every push goes to
// every session (legacy single-operator broadcast). Once bound, pushes are
// routed by meta.user_id. See src/user-routing.ts.
const sessionRegistry = new SessionRegistry();

// Push a channel notification only to the session(s) routeTargets() selects.
// Centralizes the routing decision so all push paths (message/reaction/replay)
// stay consistent. `isAdminOrSystem` forces delivery to the unbound
// admin/operator sink regardless of user_id.
function pushToTargets(
  params: { method: string; params: { content: string; meta: Record<string, string> } },
  opts: { userId?: string | number | null; isAdminOrSystem?: boolean; label: string },
): void {
  const targets = sessionRegistry.routeTargets(
    activeSessions.keys(),
    opts.userId,
    opts.isAdminOrSystem ?? false,
  );
  for (const sid of targets) {
    const server = activeSessions.get(sid);
    if (!server) continue;
    server.notification(params).catch((err: Error) => {
      console.error(`[channel] Failed to push ${opts.label} to session ${sid}: ${err.message}`);
    });
  }
}

function getLocalISO(tz: string): string {
  return getTimeMetadata(tz).local_date;
}

// saga #513: emit redundant time fields so LLMs never have to do timezone math.
// epoch = unix seconds (canonical for arithmetic), utc_date = `Z`-suffixed ISO,
// local_date = ISO with offset, local_human = short readable form with abbrev.
function getTimeMetadata(tz: string): {
  epoch: string;
  utc_date: string;
  local_date: string;
  local_human: string;
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const p = (type: string) => parts.find(p => p.type === type)!.value;
  const gmtOffset = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  const offset = gmtOffset === 'GMT' ? '+00:00' : gmtOffset.replace('GMT', '');
  const local_date = `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}${offset}`;

  const humanParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'short',
  }).formatToParts(now);
  const hp = (type: string) => humanParts.find(p => p.type === type)?.value ?? '';
  const local_human = `${hp('weekday')} ${hp('year')}-${hp('month')}-${hp('day')} ${hp('hour')}:${hp('minute')} ${hp('timeZoneName')}`;

  return {
    epoch: String(Math.floor(now.getTime() / 1000)),
    utc_date: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    local_date,
    local_human,
  };
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

  // Seed admins from env (multi-admin support).
  // TELEGRAM_ADMIN_USER_IDS = comma-separated numeric IDs (preferred).
  // TELEGRAM_USER_ID = legacy single-admin fallback.
  // TELEGRAM_ADMIN_USERNAMES = parallel comma-separated usernames (display only).
  const rawAdminIds = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const adminIds = rawAdminIds
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const adminUsernames = (process.env.TELEGRAM_ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (adminIds.length > 0) {
    seedAdmins(adminIds, adminUsernames);
    console.log(`[telegram-mcp] Seeded ${adminIds.length} admin(s) as allowed: ${adminIds.join(',')}`);
  } else {
    console.log('[telegram-mcp] No admin IDs in env (TELEGRAM_ADMIN_USER_IDS / TELEGRAM_USER_ID empty). Default policy: pending.');
  }

  // Create grammY bot
  const startTime = Date.now();
  const bot = createBot(token, {
    getSessionCount: () => activeSessions.size,
    getUptime: () => (Date.now() - startTime) / 1000,
  });

  // Handle incoming Telegram messages — push to all connected Claude sessions
  onIncomingMessage((event) => {
    const { userId, chatId, chatType, chatTitle, text, username, displayName, messageId, replyToMessageId, quotedText, mediaType, isForward, forwardFrom } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    const replyInfo = replyToMessageId ? ` [reply to msg ${replyToMessageId}${quotedText ? ` quoted: "${quotedText.slice(0, 40)}"` : ''}]` : '';
    const typeInfo = mediaType ? ` [${mediaType}]` : '';
    const fwdInfo = isForward && forwardFrom ? ` [fwd from: ${forwardFrom}]` : '';
    const chatLabel = chatType === 'private' ? `chat ${chatId}` : `${chatType} ${chatId}${chatTitle ? ` "${chatTitle}"` : ''}`;
    console.log(`[Telegram] ${from}${typeInfo}${fwdInfo} (${chatLabel}, msg ${messageId}${replyInfo}):\n> ${text}`);

    // Build content with reply/forward/quote context
    let content = text;
    if (replyToMessageId) {
      const quoteSuffix = quotedText ? ` quoted="${quotedText.replace(/"/g, '\\"')}"` : '';
      content = `[reply to msg_id=${replyToMessageId}${quoteSuffix}] ${content}`;
    }
    if (isForward && forwardFrom) content = `[forwarded from ${forwardFrom}] ${content}`;
    // For group/supergroup messages prefix the speaker so the agent can
    // distinguish between members in a multi-person chat. Private chats keep
    // the existing terse format (the chat_id == user_id, single speaker).
    if (chatType !== 'private') {
      content = `[${from}${chatTitle ? ` in "${chatTitle}"` : ''}] ${content}`;
    }

    const tz = getTimezone(userId);

    // Push via claude/channel notification, routed by user_id (or broadcast
    // while no session is bound — see pushToTargets / SessionRegistry).
    // notification() is async — its throw ("Not connected") becomes a
    // rejected Promise, handled inside pushToTargets via .catch().
    // Group/supergroup messages have no single owning user; route them as
    // admin/system so the operator/admin sink always sees them.
    pushToTargets({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: String(chatId),
          chat_type: chatType,
          chat_title: chatTitle ?? '',
          message_id: String(messageId),
          reply_to_message_id: replyToMessageId ? String(replyToMessageId) : '',
          quoted_text: quotedText ?? '',
          user: username ?? String(chatId),
          user_id: String(userId),
          media_type: mediaType ?? '',
          is_forward: isForward ? 'true' : 'false',
          forward_from: forwardFrom ?? '',
          ...getTimeMetadata(tz),
          timezone: tz,
        },
      },
    }, { userId, isAdminOrSystem: chatType !== 'private', label: 'message' });
  });

  // Handle incoming reactions — push to all connected Claude sessions
  onReaction((event) => {
    const { chatId, messageId, emoji, action, username, displayName } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.log(`[Telegram] ${from} ${action === 'added' ? 'added' : 'removed'} reaction ${emoji} on msg ${messageId} in chat ${chatId}`);

    const content = `[reaction: ${emoji}] on message_id=${messageId}`;
    const reactUserId = event.userId ? String(event.userId) : String(chatId);
    const reactTz = event.userId ? getTimezone(event.userId) : getTimezone(chatId);

    pushToTargets({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: String(chatId),
          message_id: String(messageId),
          reaction: emoji,
          reaction_action: action,
          user: username ?? String(chatId),
          user_id: reactUserId,
          ...getTimeMetadata(reactTz),
          timezone: reactTz,
        },
      },
    }, { userId: reactUserId, label: 'reaction' });
  });

  // Express app with SSE transport
  const app = express();

  // SECURITY: the Console public URL points at this same :3848. The public guard
  // runs FIRST so requests arriving via the cloudflared tunnel can only reach
  // /console* — the MCP transport (/sse, /messages), /emergency and /health
  // 404 for them. Local clients (Host=localhost) pass through untouched.
  app.use(publicGuard);

  app.use(express.json());

  // Console Mini App: static SPA at /console + owner-gated /console/api/*.
  mountConsole(app);

  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    // Per-user binding: a per-user dispatcher connects with /sse?user_id=<id>
    // so this session receives ONLY that user's traffic. No param => unbound =>
    // admin/operator sink (the single-operator case and the owner-oversight
    // session). While zero sessions bind, routing is inert and every push
    // broadcasts (legacy behavior).
    const boundUserId = parseBindUserId(req.query.user_id);
    sessionRegistry.connect(sessionId, boundUserId || null);
    console.log(`[connect] session=${sessionId}${boundUserId ? ` user_id=${boundUserId}` : ' (unbound/admin)'}`);

    transport.onclose = () => {
      console.log(`[disconnect] session=${sessionId}`);
      transports.delete(sessionId);
      activeSessions.delete(sessionId);
      sessionRegistry.disconnect(sessionId);
    };

    const server = createMcpServer(bot);
    activeSessions.set(sessionId, server);
    await server.connect(transport);

    // Replay messages that arrived while no session was connected (operator restart / SSE drop).
    // Delay 3s to let Claude Code finish its session handshake before receiving pushes.
    //
    // Per-user routing: a session bound to a user_id replays ONLY that user's
    // unanswered backlog (getUnansweredMessagesForUser) — otherwise a freshly
    // spawned per-user session would receive the whole instance's missed
    // traffic. An unbound (admin) session replays the global backlog exactly
    // as before. Each replayed push still goes through pushToTargets so the
    // routing filter applies (a global-backlog row for a user who has their own
    // bound session won't be mis-delivered to the admin session).
    setTimeout(() => {
      const missed = boundUserId
        ? getUnansweredMessagesForUser(Number(boundUserId), 24)
        : getUnansweredMessages(24);
      if (missed.length === 0) return;
      console.log(`[replay] session=${sessionId}${boundUserId ? ` user_id=${boundUserId}` : ''}: replaying ${missed.length} unanswered message(s)`);
      for (const msg of missed) {
        const tz = getTimezone(msg.user_id ?? msg.chat_id);
        pushToTargets({
          method: 'notifications/claude/channel',
          params: {
            content: `[MISSED at ${msg.created_at} UTC] ${msg.text ?? ''}`,
            meta: {
              chat_id: String(msg.chat_id),
              chat_type: msg.chat_type ?? 'private',
              chat_title: msg.chat_title ?? '',
              message_id: String(msg.telegram_message_id),
              reply_to_message_id: msg.reply_to_message_id ? String(msg.reply_to_message_id) : '',
              quoted_text: '',
              user: msg.username ?? String(msg.chat_id),
              user_id: msg.user_id ? String(msg.user_id) : String(msg.chat_id),
              media_type: msg.media_type ?? '',
              is_forward: 'false',
              forward_from: '',
              missed: 'true',
              ...getTimeMetadata(tz),
              timezone: tz,
            },
          },
        }, { userId: msg.user_id ?? msg.chat_id, label: `replay msg ${msg.id}` });
        // Bump replay_count so the circuit breaker in getUnansweredMessages
        // eventually stops re-surfacing this row if no OUT reply ever lands.
        try { bumpReplayCount(msg.id); } catch (e) {
          console.error(`[replay] Failed to bump replay_count for msg ${msg.id}: ${(e as Error).message}`);
        }
      }
    }, 3000);
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
    allowed_updates: ['message', 'message_reaction', 'callback_query'],
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
