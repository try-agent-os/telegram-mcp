// Console launch wiring for grammY.
//   - setChatMenuButton: a persistent "Console" web_app button next to the chat
//     input (primary entry point). web_app buttons open the Mini App inside
//     Telegram's in-app webview with NO "Open this link?" confirmation dialog.
//   - /console command: replies with an inline web_app button (secondary entry).
//
// Both point at CONSOLE_URL — a PUBLIC https origin supplied by the operator
// (a cloudflared tunnel or a custom domain). No domain is baked in: when
// CONSOLE_URL is unset or not a public https URL, the in-chat button/command are
// skipped (Telegram rejects web_app URLs that aren't public https — http://localhost
// will not work). The Console backend still runs and is reachable locally at
// http://localhost:PORT/console. See the Console section of README.md for the
// setup paths (local-only / quick tunnel / custom domain).
import { Bot, InlineKeyboard, type Context } from 'grammy';

let consoleUrl = process.env.CONSOLE_URL ?? '';
let botRef: Bot | null = null;

/** True only for a public https URL Telegram will accept for a web_app button. */
export function isPublicHttps(u: string): boolean {
  if (!/^https:\/\//i.test(u)) return false;
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host !== '' && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

/** Register the /console command. Call before bot message handlers. */
export function consoleCommand(bot: Bot): void {
  bot.command('console', async (ctx: Context) => {
    if (!isPublicHttps(consoleUrl)) {
      await ctx.reply(
        'Console is not publicly exposed yet. Set CONSOLE_URL to a public HTTPS URL ' +
          '(cloudflared tunnel or your own domain) to open the Mini App. See the Console section of README.md.',
      );
      return;
    }
    await ctx.reply('AgentOS Console — live service status:', {
      reply_markup: new InlineKeyboard().webApp('Open Console', consoleUrl),
    });
  });
}

/**
 * Set the persistent chat Menu Button. Idempotent — safe to call on every
 * startup. Fire-and-forget with its own error log so a transient Bot API hiccup
 * never crashes startup. Silently skips registration (with an explanatory log)
 * when CONSOLE_URL is unset / non-public-https.
 */
export function installConsoleMenuButton(bot: Bot): void {
  botRef = bot;
  if (!isPublicHttps(consoleUrl)) {
    console.log(
      `[console] CONSOLE_URL ${consoleUrl ? `("${consoleUrl}") is not a public HTTPS URL` : 'is unset'}` +
        ' → chat menu button skipped (Console still reachable locally at /console). See the Console section of README.md.',
    );
    return;
  }
  registerMenuButton(consoleUrl);
}

function registerMenuButton(url: string): void {
  if (!botRef) return;
  botRef.api
    .setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Console', web_app: { url } },
    })
    .then(() => console.log(`[console] chat menu button set -> ${url}`))
    .catch((err: Error) => console.error('[console] setChatMenuButton failed:', err.message));
}

/**
 * Update the Console URL at runtime and (re)register the menu button. Used by the
 * loopback quick-tunnel callback (POST /console/internal/tunnel-url) so an
 * ephemeral *.trycloudflare.com URL — which changes on every cloudflared restart —
 * is picked up without restarting the bot. Returns false (and changes nothing) for
 * non-public-https URLs.
 */
export function updateConsoleUrl(url: string): boolean {
  if (!isPublicHttps(url)) return false;
  consoleUrl = url;
  registerMenuButton(url);
  return true;
}
