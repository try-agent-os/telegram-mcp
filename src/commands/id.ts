import { Composer } from 'grammy';
import { checkAccess } from '../access.js';

const composer = new Composer();

composer.command('id', async (ctx) => {
  const userId = ctx.from!.id;
  const access = checkAccess(userId);
  if (access === 'denied') return;
  if (access === 'pending') {
    await ctx.reply('Access request submitted. Please wait for approval.');
    return;
  }

  await ctx.reply(`Your user ID: ${userId}`);
});

export default composer;
