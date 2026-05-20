/**
 * Door 1 — telegram-first entry point (Phase 0 PoC).
 *
 * Telegram bot is the root process. Spawns Claude via Agent SDK.
 * Watchdog monitors stream silence and aborts+resumes on hang.
 *
 * Usage: TELEGRAM_BOT_TOKEN=... npx tsx src/door1.ts
 *        or: node dist/door1.js (after tsc)
 */
import 'dotenv/config';
import { createBot, onIncomingMessage } from './bot.js';
import { initDb, seedAdmins } from './db.js';
import { runWithWatchdog } from './sdk-runner.js';
import { createTelegramMcpTools } from './sdk-mcp-tools.js';
import type { SilenceInfo } from './watchdog.js';

const SILENCE_THRESHOLD_MS = parseInt(process.env.WATCHDOG_SILENCE_MS ?? '60000', 10);

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[door1] TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }

  initDb();
  console.log('[door1] Database initialized');

  const rawAdminIds = process.env.TELEGRAM_ADMIN_USER_IDS || process.env.TELEGRAM_USER_ID || '';
  const adminIds = rawAdminIds.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  const adminUsernames = (process.env.TELEGRAM_ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (adminIds.length > 0) {
    seedAdmins(adminIds, adminUsernames);
    console.log(`[door1] Seeded ${adminIds.length} admin(s)`);
  }

  const startTime = Date.now();
  const bot = createBot(token, {
    getSessionCount: () => 1,
    getUptime: () => (Date.now() - startTime) / 1000,
  });

  const telegramMcp = createTelegramMcpTools(bot);

  let currentSessionId: string | undefined;
  let messageQueue: string[] = [];
  let isRunning = false;

  onIncomingMessage((event) => {
    const { text, username, displayName, chatId } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    console.log(`[door1] Incoming from ${from} in chat ${chatId}: ${text}`);

    messageQueue.push(text);

    if (!isRunning) {
      processQueue();
    }
  });

  async function processQueue() {
    if (isRunning || messageQueue.length === 0) return;
    isRunning = true;

    const prompt = messageQueue.join('\n');
    messageQueue = [];

    console.log(`[door1] Running Claude with prompt: ${prompt.slice(0, 100)}...`);

    try {
      const result = await runWithWatchdog(prompt, {
        silenceThresholdMs: SILENCE_THRESHOLD_MS,
        maxTurns: 10,
        permissionMode: 'bypassPermissions',
        mcpServer: telegramMcp,
        allowedTools: ['mcp__telegram__*', 'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
        onSessionStart: (sid) => {
          currentSessionId = sid;
          console.log(`[door1] Claude session: ${sid}`);
        },
        onSilence: (info: SilenceInfo) => {
          console.log(`[door1] Watchdog triggered: ${info.silenceDurationMs}ms silence after ${info.lastEventType}`);
        },
        onResult: (msg: any) => {
          if (msg.subtype === 'success' && msg.result) {
            console.log(`[door1] Claude result: ${msg.result.slice(0, 200)}`);
          }
        },
      });

      console.log(`[door1] Run complete: session=${result.sessionId}, resumes=${result.resumeCount}, silenceAbort=${result.abortedBySilence}`);
    } catch (err) {
      console.error('[door1] SDK runner error:', (err as Error).message);
    }

    isRunning = false;

    if (messageQueue.length > 0) {
      processQueue();
    }
  }

  await bot.start({
    allowed_updates: ['message', 'message_reaction', 'callback_query'],
    onStart: () => console.log('[door1] Bot started, listening for messages...'),
  });
}

main().catch(err => {
  console.error('[door1] Fatal:', err);
  process.exit(1);
});
