import { Bot, Context } from 'grammy';
import { checkAccess } from './access.js';
import { saveMessage, getLastIncomingMessageId } from './db.js';

let messageCallback: ((chatId: number, text: string, username: string | null, displayName: string | null, messageId: number) => void) | null = null;

export function onIncomingMessage(cb: typeof messageCallback): void {
  messageCallback = cb;
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message!;
    const userId = msg.from!.id;
    const chatId = msg.chat.id;
    const username = msg.from!.username ?? null;
    const displayName = [msg.from!.first_name, msg.from!.last_name].filter(Boolean).join(' ') || null;
    const text = msg.text!;

    const access = checkAccess(userId);

    if (access === 'denied') return;

    if (access === 'pending') {
      await ctx.reply('Запрос на доступ отправлен. Ожидайте подтверждения.');
      return;
    }

    // Save to DB
    saveMessage({
      telegram_message_id: msg.message_id,
      chat_id: chatId,
      user_id: userId,
      username,
      display_name: displayName,
      text,
      direction: 'in',
      reply_to_message_id: msg.reply_to_message?.message_id ?? null,
    });

    // Notify Claude via callback
    if (messageCallback) {
      messageCallback(chatId, text, username, displayName, msg.message_id);
    }
  });

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
