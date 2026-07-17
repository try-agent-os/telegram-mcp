import { Composer } from 'grammy';
import { checkAccess } from '../access.js';
import type { BotOptions } from '../bot.js';
import { buildStatusText } from '../session-status.js';

export function createStatusCommand(options?: BotOptions) {
  const composer = new Composer();

  composer.command('status', async (ctx) => {
    const userId = ctx.from!.id;
    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') {
      await ctx.reply('Access request submitted. Please wait for approval.');
      return;
    }

    const uptime = options?.getUptime?.() ?? 0;

    // Prefer the per-session breakdown when the entrypoint provides one (the SSE
    // bridge in index.ts). Fall back to the bare count for entrypoints that
    // don't track a session registry (main.ts SDK-spawn path).
    if (options?.getSessions) {
      const sessions = options.getSessions();
      await ctx.reply(
        buildStatusText({ sessions, uptimeSeconds: uptime, now: Date.now() }),
      );
      return;
    }

    const sessions = options?.getSessionCount?.() ?? 0;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    await ctx.reply(
      `Bot: running\n` +
      `Claude sessions: ${sessions}\n` +
      `Uptime: ${h}h ${m}m`
    );
  });

  return composer;
}
