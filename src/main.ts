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
import { buildSessionKey } from './types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Bot } from 'grammy';

const SILENCE_THRESHOLD_MS = parseInt(process.env.WATCHDOG_SILENCE_MS ?? '60000', 10);
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS ?? '1800000', 10); // 30 min

interface ChatSession {
  runner: SessionRunner;
  lastActivity: number;
  firstMessage: boolean;
  chatId: number;
}

function createSessionRunner(
  bot: Bot,
  chatId: number,
): { runner: SessionRunner; mcp: McpSdkServerConfigWithInstance } {
  const mcp = createTelegramMcpTools(bot, String(chatId));
  const runner = new SessionRunner({
    silenceThresholdMs: SILENCE_THRESHOLD_MS,
    maxTurns: 50,
    permissionMode: 'bypassPermissions',
    mcpServer: mcp,
    allowedTools: ['mcp__telegram__*', 'Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'],
  });
  return { runner, mcp };
}

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

  const sessions = new Map<string, ChatSession>();
  const startTime = Date.now();

  const bot = createBot(token, {
    getSessionCount: () => {
      let active = 0;
      for (const s of sessions.values()) if (s.runner.isActive) active++;
      return active;
    },
    getUptime: () => (Date.now() - startTime) / 1000,
  });

  const idleCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, cs] of sessions) {
      if (now - cs.lastActivity > SESSION_IDLE_MS) {
        console.log(`[main] Cleaning idle session: ${key}`);
        cs.runner.close();
        sessions.delete(key);
      }
    }
  }, 60_000);

  function getOrCreateSession(sessionKey: string, chatId: number): ChatSession {
    let cs = sessions.get(sessionKey);
    if (!cs) {
      const { runner } = createSessionRunner(bot, chatId);

      runner.on('sessionStart', (sid) => {
        saveSessionId(sid);
        console.log(`[main] Session persisted (${sessionKey}): ${sid}`);
      });

      runner.on('result', (msg: any) => {
        if (msg.subtype === 'success' && msg.result) {
          console.log(`[main] Claude result (${sessionKey}): ${msg.result.slice(0, 200)}`);
        }
      });

      runner.on('silence', (info) => {
        console.log(`[main] Watchdog (${sessionKey}): ${info.silenceDurationMs}ms silence after ${info.lastEventType}`);
      });

      runner.on('closed', () => {
        console.log(`[main] Session closed (${sessionKey})`);
      });

      runner.on('error', (err) => {
        console.error(`[main] Session error (${sessionKey}):`, err.message);
      });

      cs = { runner, lastActivity: Date.now(), firstMessage: true, chatId };
      sessions.set(sessionKey, cs);
    }
    cs.lastActivity = Date.now();
    return cs;
  }

  onIncomingMessage(async (event) => {
    const { text, username, displayName, chatId, chatType, userId, messageThreadId, isForum } = event;
    const from = username ? `@${username}` : displayName ?? 'Unknown';
    const sessionKey = buildSessionKey(chatId, chatType, messageThreadId ?? null, isForum, userId);
    console.log(`[main] Incoming from ${from} in chat ${chatId} (key: ${sessionKey}): ${text}`);

    const cs = getOrCreateSession(sessionKey, chatId);
    const { runner } = cs;

    try {
      if (!runner.isActive) {
        const savedSessionId = cs.firstMessage ? loadSessionId() : undefined;
        cs.firstMessage = false;

        console.log(
          savedSessionId
            ? `[main] Resuming session ${savedSessionId} (${sessionKey})`
            : `[main] Starting new session (${sessionKey})`
        );

        await runner.start(text, savedSessionId ?? undefined);
      } else {
        await runner.sendMessage(text);
      }
    } catch (err) {
      console.error(`[main] Error handling message (${sessionKey}):`, (err as Error).message);
      runner.close();
      clearSessionId();
      sessions.delete(sessionKey);

      try {
        console.log(`[main] Starting fresh session after error (${sessionKey})`);
        const freshCs = getOrCreateSession(sessionKey, chatId);
        freshCs.firstMessage = false;
        await freshCs.runner.start(text);
      } catch (retryErr) {
        console.error(`[main] Failed to start fresh session (${sessionKey}):`, (retryErr as Error).message);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('[main] SIGINT received, cleaning up...');
    clearInterval(idleCleanup);
    for (const [key, cs] of sessions) {
      console.log(`[main] Closing session: ${key}`);
      cs.runner.close();
    }
    sessions.clear();
    process.exit(0);
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
