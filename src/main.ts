/**
 * Telegram-first entry point (Phase 0 PoC).
 *
 * Telegram bot is the root process. Spawns Claude via Agent SDK.
 * Watchdog monitors stream silence and aborts+resumes on hang.
 * Multi-turn: new messages fed into running session via streamInput().
 *
 * Usage: TELEGRAM_BOT_TOKEN=... npx tsx src/main.ts
 *        or: node dist/main.js (after tsc)
 */
import 'dotenv/config';
import { createBot, onIncomingMessage } from './bot.js';
import { initDb, seedAdmins } from './db.js';
import { SessionRunner } from './session-runner.js';
import { createTelegramMcpTools } from './sdk-mcp-tools.js';
import { loadSessionId, saveSessionId, clearSessionId } from './session-store.js';

const SILENCE_THRESHOLD_MS = parseInt(process.env.WATCHDOG_SILENCE_MS ?? '60000', 10);

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[main] TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  initDb();
  console.log('[main] Database initialized');

  const rawAdminIds = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const adminIds = rawAdminIds.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const adminUsernames = (process.env.TELEGRAM_ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (adminIds.length > 0) {
    seedAdmins(adminIds, adminUsernames);
    console.log(`[main] Seeded ${adminIds.length} admin(s)`);
  }

  const startTime = Date.now();
  const bot = createBot(token, {
    getSessionCount: () => session.isActive ? 1 : 0,
    getUptime: () => (Date.now() - startTime) / 1000,
  });

  const telegramMcp = createTelegramMcpTools(bot);

  const session = new SessionRunner({
    silenceThresholdMs: SILENCE_THRESHOLD_MS,
    maxTurns: 50,
    permissionMode: 'bypassPermissions',
    mcpServer: telegramMcp,
    allowedTools: ['mcp__telegram__*', 'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
  });

  session.on('sessionStart', (sid) => {
    saveSessionId(sid);
    console.log(`[main] Session persisted: ${sid}`);
  });

  session.on('result', (msg: any) => {
    if (msg.subtype === 'success' && msg.result) {
      console.log(`[main] Claude result: ${msg.result.slice(0, 200)}`);
    }
  });

  session.on('silence', (info) => {
    console.log(`[main] Watchdog: ${info.silenceDurationMs}ms silence after ${info.lastEventType}`);
  });

  session.on('closed', () => {
    console.log('[main] Session closed');
  });

  session.on('error', (err) => {
    console.error('[main] Session error:', err.message);
  });

  let firstMessage = true;

  onIncomingMessage(async (event) => {
    const { text, username, displayName, chatId } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.log(`[main] Incoming from ${from} in chat ${chatId}: ${text}`);

    try {
      if (!session.isActive) {
        const savedSessionId = firstMessage ? loadSessionId() : undefined;
        firstMessage = false;

        console.log(
          savedSessionId
            ? `[main] Resuming session ${savedSessionId}`
            : '[main] Starting new session'
        );

        await session.start(text, savedSessionId ?? undefined);
      } else {
        await session.sendMessage(text);
      }
    } catch (err) {
      console.error('[main] Error handling message:', (err as Error).message);
      session.close();
      clearSessionId();

      try {
        console.log('[main] Starting fresh session after error');
        await session.start(text);
      } catch (retryErr) {
        console.error('[main] Failed to start fresh session:', (retryErr as Error).message);
      }
    }
  });

  await bot.start({
    allowed_updates: ['message', 'message_reaction', 'callback_query'],
    onStart: () => console.log('[main] Bot started, listening for messages...'),
  });
}

main().catch(err => {
  console.error('[main] Fatal:', err);
  process.exit(1);
});
