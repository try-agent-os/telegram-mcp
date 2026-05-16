import { Composer } from 'grammy';
import { checkAccess } from '../access.js';

const composer = new Composer();

composer.command('whoami', async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') {
      await ctx.reply('Access request submitted. Please wait for approval.');
      return;
    }
  }

  const me = ctx.me;
  const lines = [
    `Bot identity:`,
    `• username: @${me.username}`,
    `• id: ${me.id}`,
    `• name: ${me.first_name}`,
    `• can_join_groups: ${me.can_join_groups}`,
    `• can_read_all_group_messages: ${me.can_read_all_group_messages}`,
  ];
  await ctx.reply(lines.join('\n'));
});

export default composer;
