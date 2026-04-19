import { Composer } from 'grammy';
import { checkAccess } from '../access.js';
import type { BotOptions } from '../bot.js';

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

    const sessions = options?.getSessionCount?.() ?? 0;
    const uptime = options?.getUptime?.() ?? 0;
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
