import { Composer, type Context } from 'grammy';
import { cancelLogin, isLoginAdmin, startLogin } from '../login-flow.js';

const composer = new Composer<Context>();

// /login — kick off a Claude OAuth re-login via tmux pipe. Sends the OAuth
// URL back to the user; the next text message from that chat is treated as
// the verification code (handled in bot.ts, not here, because it's not a
// slash command — just free-form text).
composer.command('login', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isLoginAdmin(userId)) {
    await ctx.reply('⛔ /login доступен только админам бота.');
    return;
  }

  await ctx.reply('🔐 Запускаю claude auth login, секунду…');

  const result = await startLogin(ctx.chat!.id);
  if (!result.ok) {
    await ctx.reply(`❌ Не удалось запустить login: ${result.error}`);
    return;
  }

  const prefix = result.operatorRestarted
    ? '⚙️ Operator был мертв — поднял.\n\n'
    : '';
  await ctx.reply(
    `${prefix}Открой ссылку, авторизуйся, скопируй код со страницы и пришли его СЛЕДУЮЩИМ сообщением (или /login_cancel чтобы отменить).\n\n${result.url}`,
    { link_preview_options: { is_disabled: true } },
  );
});

composer.command('login_cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isLoginAdmin(userId)) return;
  await cancelLogin(ctx.chat!.id);
  await ctx.reply('🚫 Login отменён.');
});

export default composer;
