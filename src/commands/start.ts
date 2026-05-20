import { Composer, type Context } from 'grammy';

const start = new Composer<Context>();

start.command('start', async (ctx) => {
  await ctx.reply('Phase 0 Door 1 PoC bot online');
});

export default start;
