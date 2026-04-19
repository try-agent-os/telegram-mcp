import { Composer, InlineKeyboard } from 'grammy';
import { checkAccess, getTimezone, setTimezone } from '../access.js';

const TZ_OPTIONS: Record<string, [string, string][]> = {
  Europe: [
    ['Lisbon', 'Europe/Lisbon'], ['London', 'Europe/London'],
    ['Berlin', 'Europe/Berlin'], ['Moscow', 'Europe/Moscow'],
    ['Istanbul', 'Europe/Istanbul'], ['Kyiv', 'Europe/Kyiv'],
  ],
  America: [
    ['New York', 'America/New_York'], ['Chicago', 'America/Chicago'],
    ['Denver', 'America/Denver'], ['Los Angeles', 'America/Los_Angeles'],
    ['São Paulo', 'America/Sao_Paulo'], ['Toronto', 'America/Toronto'],
  ],
  Asia: [
    ['Dubai', 'Asia/Dubai'], ['Kolkata', 'Asia/Kolkata'],
    ['Bangkok', 'Asia/Bangkok'], ['Singapore', 'Asia/Singapore'],
    ['Tokyo', 'Asia/Tokyo'], ['Shanghai', 'Asia/Shanghai'],
  ],
  Pacific: [
    ['Auckland', 'Pacific/Auckland'], ['Sydney', 'Australia/Sydney'],
    ['Honolulu', 'Pacific/Honolulu'], ['Fiji', 'Pacific/Fiji'],
  ],
  Other: [
    ['UTC', 'UTC'], ['GMT', 'Etc/GMT'],
    ['Africa/Cairo', 'Africa/Cairo'], ['Africa/Lagos', 'Africa/Lagos'],
  ],
};

const composer = new Composer();

composer.command(['tz', 'timezone'], async (ctx) => {
  const userId = ctx.from!.id;
  const access = checkAccess(userId);
  if (access === 'denied') return;
  if (access === 'pending') {
    await ctx.reply('Access request submitted. Please wait for approval.');
    return;
  }

  const arg = ctx.match?.trim();
  if (arg) {
    if (setTimezone(userId, arg)) {
      await ctx.reply(`Timezone set to ${arg}`);
    } else {
      await ctx.reply(`Invalid timezone: ${arg}\nExample: /tz Europe/Moscow`);
    }
    return;
  }

  const current = getTimezone(userId);
  const kb = new InlineKeyboard()
    .text('Europe', 'tz_region:Europe').text('America', 'tz_region:America').row()
    .text('Asia', 'tz_region:Asia').text('Pacific', 'tz_region:Pacific').row()
    .text('Other', 'tz_region:Other');
  await ctx.reply(`Current: ${current}\nSelect region:`, { reply_markup: kb });
});

composer.callbackQuery(/^tz_region:/, async (ctx) => {
  const region = ctx.callbackQuery.data.replace('tz_region:', '');
  const options = TZ_OPTIONS[region];
  if (!options) { await ctx.answerCallbackQuery('Unknown region'); return; }

  const kb = new InlineKeyboard();
  for (let i = 0; i < options.length; i += 2) {
    const row = options.slice(i, i + 2);
    for (const [label, tz] of row) {
      kb.text(label, `tz_set:${tz}`);
    }
    kb.row();
  }
  kb.text('< Back', 'tz_back').text('Type manually', 'tz_custom');

  await ctx.editMessageText(`Select timezone (${region}):`, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

composer.callbackQuery(/^tz_set:/, async (ctx) => {
  const userId = ctx.callbackQuery.from.id;
  const tz = ctx.callbackQuery.data.replace('tz_set:', '');
  if (setTimezone(userId, tz)) {
    await ctx.editMessageText(`Timezone set to ${tz}`);
  } else {
    await ctx.editMessageText(`Invalid timezone: ${tz}`);
  }
  await ctx.answerCallbackQuery();
});

composer.callbackQuery('tz_back', async (ctx) => {
  const userId = ctx.callbackQuery.from.id;
  const current = getTimezone(userId);
  const kb = new InlineKeyboard()
    .text('Europe', 'tz_region:Europe').text('America', 'tz_region:America').row()
    .text('Asia', 'tz_region:Asia').text('Pacific', 'tz_region:Pacific').row()
    .text('Other', 'tz_region:Other');
  await ctx.editMessageText(`Current: ${current}\nSelect region:`, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

composer.callbackQuery('tz_custom', async (ctx) => {
  await ctx.editMessageText('Send timezone as text:\n/tz Europe/Moscow');
  await ctx.answerCallbackQuery();
});

export default composer;
