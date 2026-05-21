import { Composer, type Context } from 'grammy';
import { checkAccess } from '../access.js';

const start = new Composer<Context>();

// /start — entry point for new chats. Show what the bot is and how to use it.
// Plain text (no markdown parse_mode) so the user sees what we send literally.
start.command('start', async (ctx) => {
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
  const botName = me?.first_name || me?.username || 'AgentOS bot';

  const lines = [
    `${botName} готов к работе.`,
    '',
    'Это Telegram-интерфейс к Claude Code через MCP — мост между тобой и оператором AgentOS на сервере.',
    '',
    'Команды:',
    '/login — обновить OAuth токен Claude (только для админов)',
    '/login_cancel — отменить незавершенный /login',
    '/status — статус бота и активных Claude-сессий',
    '/id — показать твой Telegram user ID',
    '/tz <zone> — выставить часовой пояс (например, /tz Europe/Lisbon)',
    '/help — справка по командам',
    '',
    'Любое текстовое сообщение уйдет оператору AgentOS — он сам решит, ответить или маршрутизировать дальше.',
  ];

  await ctx.reply(lines.join('\n'), { link_preview_options: { is_disabled: true } });
});

export default start;
