import { Composer } from 'grammy';
import { checkAccess } from '../access.js';

const composer = new Composer();

composer.command('help', async (ctx) => {
  const userId = ctx.from!.id;
  const access = checkAccess(userId);
  if (access === 'denied') return;
  if (access === 'pending') {
    await ctx.reply('Access request submitted. Please wait for approval.');
    return;
  }

  await ctx.reply(
    `/tz <zone> — set timezone (e.g. /tz Europe/Moscow)\n` +
    `/tz — view current timezone\n` +
    `/status — bot & Claude connection status\n` +
    `/id — show your Telegram user ID\n` +
    `/help — this message`
  );
});

export default composer;
