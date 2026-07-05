// Console launch wiring for grammY.
//   - setChatMenuButton: a persistent "Console" web_app button next to the chat
//     input (primary entry point). web_app buttons open the Mini App inside
//     Telegram's in-app webview with NO "Open this link?" confirmation dialog.
//   - /console command: replies with an inline web_app button (secondary entry).
// Both point at the same HTTPS URL (console.vasily.dev).
import { Bot, InlineKeyboard, type Context } from 'grammy';

const CONSOLE_URL = process.env.CONSOLE_URL ?? 'https://console.vasily.dev';

/** Register the /console command. Call before bot message handlers. */
export function consoleCommand(bot: Bot): void {
  bot.command('console', async (ctx: Context) => {
    await ctx.reply('AgentOS Console — live service status:', {
      reply_markup: new InlineKeyboard().webApp('Open Console', CONSOLE_URL),
    });
  });
}

/**
 * Set the persistent chat Menu Button. Idempotent — safe to call on every
 * startup. Fire-and-forget with its own error log so a transient Bot API hiccup
 * never crashes startup.
 */
export function installConsoleMenuButton(bot: Bot): void {
  bot.api
    .setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Console', web_app: { url: CONSOLE_URL } },
    })
    .then(() => console.log(`[console] chat menu button set -> ${CONSOLE_URL}`))
    .catch((err: Error) => console.error('[console] setChatMenuButton failed:', err.message));
}
