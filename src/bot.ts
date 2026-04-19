import { Bot, Context } from 'grammy';
import { createWriteStream, mkdirSync } from 'fs';
import https from 'https';
import path from 'path';
import { checkAccess, getTimezone, setTimezone } from './access.js';
import { saveMessage } from './db.js';
import type { IncomingMessageEvent, MediaType } from './types.js';

export interface ReactionEvent {
  chatId: number;
  messageId: number;
  emoji: string;
  action: 'added' | 'removed';
  username: string | null;
  displayName: string | null;
  userId: number | null;
}

const MEDIA_DIR = '/tmp/telegram-mcp';

let messageCallback: ((event: IncomingMessageEvent) => void) | null = null;
let reactionCallback: ((event: ReactionEvent) => void) | null = null;

export function onIncomingMessage(cb: typeof messageCallback): void {
  messageCallback = cb;
}

export function onReaction(cb: typeof reactionCallback): void {
  reactionCallback = cb;
}

function ensureMediaDir(): void {
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

async function downloadFile(token: string, fileId: string, destFileName: string): Promise<string> {
  ensureMediaDir();
  const destPath = path.join(MEDIA_DIR, destFileName);

  // Get file path from Telegram
  const fileInfo = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileData = await fileInfo.json() as { ok: boolean; result: { file_path: string } };
  if (!fileData.ok) throw new Error(`getFile failed for ${fileId}`);

  const telegramFilePath = fileData.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${telegramFilePath}`;

  // Download to disk
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(destPath);
    https.get(downloadUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });

  return destPath;
}

async function transcribeVoice(filePath: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const { readFileSync } = await import('fs');
    const audioData = readFileSync(filePath);
    const formData = new FormData();
    formData.append('file', new Blob([audioData], { type: 'audio/ogg' }), path.basename(filePath));
    formData.append('model', 'whisper-1');
    formData.append('language', 'ru');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      console.error(`[whisper] API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as { text: string };
    return data.text || null;
  } catch (err) {
    console.error('[whisper] transcription error:', err);
    return null;
  }
}

function getForwardFrom(msg: any): string | null {
  const origin = msg.forward_origin;
  if (!origin) return null;

  if (origin.type === 'user') {
    const u = origin.sender_user;
    const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ');
    return u?.username ? `@${u.username} (${name})` : name || 'Unknown user';
  }
  if (origin.type === 'hidden_user') return origin.sender_user_name ?? 'Hidden user';
  if (origin.type === 'chat') {
    const c = origin.sender_chat;
    return c?.title ?? c?.username ?? 'Unknown chat';
  }
  if (origin.type === 'channel') {
    const c = origin.chat;
    return c?.title ?? c?.username ?? 'Unknown channel';
  }
  return 'Forwarded';
}

function buildText(mediaType: MediaType | null, filePath: string | null, caption: string | null, extra?: string): string {
  let text = '';
  if (mediaType && filePath) {
    text = `[${mediaType}: ${filePath}]`;
  } else if (mediaType) {
    text = `[${mediaType}]`;
  }
  if (extra) text = extra;
  if (caption) text += caption ? (text ? `\n${caption}` : caption) : '';
  return text || '[empty]';
}

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  function getBaseFields(msg: any) {
    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    const username = msg.from?.username ?? null;
    const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null;
    const isForward = !!msg.forward_origin;
    const forwardFrom = getForwardFrom(msg);
    return { userId, chatId, username, displayName, isForward, forwardFrom };
  }

  function dispatchEvent(event: IncomingMessageEvent): void {
    saveMessage({
      telegram_message_id: event.messageId,
      chat_id: event.chatId,
      user_id: null,
      username: event.username,
      display_name: event.displayName,
      text: event.text,
      direction: 'in',
      reply_to_message_id: event.replyToMessageId,
      media_type: event.mediaType,
      file_path: event.filePath,
      file_name: event.fileName,
    });

    if (messageCallback) messageCallback(event);
  }

  // Text messages
  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') {
      await ctx.reply('Access request submitted. Please wait for approval.');
      return;
    }

    // Handle /timezone and /tz commands
    const tzMatch = msg.text!.match(/^\/(timezone|tz)\s+(.*)/);
    if (tzMatch) {
      const tz = tzMatch[2].trim();
      if (setTimezone(userId, tz)) {
        await ctx.reply(`Timezone set to ${tz}`);
      } else {
        await ctx.reply(`Invalid timezone: ${tz}\nExample: /tz Europe/Moscow`);
      }
      return;
    }
    if (msg.text === '/timezone' || msg.text === '/tz') {
      const current = getTimezone(userId);
      await ctx.reply(`Current timezone: ${current}\nUsage: /tz Europe/Moscow`);
      return;
    }

    const fs = await import('fs');
    const msgLogPath = 'messages.json';
    const previous = fs.existsSync(msgLogPath) ? JSON.parse(fs.readFileSync(msgLogPath, 'utf-8')) : [];
    fs.writeFileSync(msgLogPath, JSON.stringify([...previous, msg], null, 2) + '\n');

    dispatchEvent({
      userId,
      chatId,
      text: msg.text!,
      username,
      displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: null,
      filePath: null,
      fileName: null,
      isForward,
      forwardFrom,
      caption: null,
    });
  });

  // Voice messages
  bot.on('message:voice', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const voice = msg.voice!;
    const caption = msg.caption ?? null;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, voice.file_id, `voice_${msg.message_id}.ogg`);
      const transcription = await transcribeVoice(filePath);
      if (transcription) {
        text = `[voice transcription] ${transcription}`;
        if (caption) text += `\n${caption}`;
      } else {
        text = buildText('voice', filePath, caption);
        text += ` (${voice.duration}s)`;
      }
    } catch (err) {
      console.error('[bot] voice download error:', err);
      text = buildText('voice', null, caption);
      text += ` (${voice.duration}s, download failed)`;
    }

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'voice', filePath, fileName: null,
      isForward, forwardFrom, caption,
    });
  });

  // Video notes (round videos)
  bot.on('message:video_note', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const vn = msg.video_note!;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, vn.file_id, `videonote_${msg.message_id}.mp4`);
      text = buildText('video_note', filePath, null);
      text += ` (${vn.duration}s)`;
    } catch (err) {
      console.error('[bot] video_note download error:', err);
      text = `[video_note: download failed, ${vn.duration}s]`;
    }

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'video_note', filePath, fileName: null,
      isForward, forwardFrom, caption: null,
    });
  });

  // Photos
  bot.on('message:photo', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const photos = msg.photo!;
    const largest = photos[photos.length - 1]; // highest resolution
    const caption = msg.caption ?? null;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, largest.file_id, `photo_${msg.message_id}.jpg`);
      text = buildText('photo', filePath, caption);
    } catch (err) {
      console.error('[bot] photo download error:', err);
      text = buildText('photo', null, caption);
    }

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'photo', filePath, fileName: null,
      isForward, forwardFrom, caption,
    });
  });

  // Documents (PDF, files, etc.)
  bot.on('message:document', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const doc = msg.document!;
    const caption = msg.caption ?? null;
    const originalName = doc.file_name ?? `document_${msg.message_id}`;
    // Use original filename extension
    const ext = path.extname(originalName);
    const localName = `doc_${msg.message_id}${ext}`;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, doc.file_id, localName);
      text = `[document: ${filePath} (${originalName})]`;
      if (caption) text += `\n${caption}`;
    } catch (err) {
      console.error('[bot] document download error:', err);
      text = `[document: ${originalName}, download failed]`;
      if (caption) text += `\n${caption}`;
    }

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'document', filePath, fileName: originalName,
      isForward, forwardFrom, caption,
    });
  });

  // Videos
  bot.on('message:video', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const video = msg.video!;
    const caption = msg.caption ?? null;
    const localName = `video_${msg.message_id}.mp4`;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, video.file_id, localName);
      text = buildText('video', filePath, caption);
      text += ` (${video.duration}s)`;
    } catch (err) {
      console.error('[bot] video download error:', err);
      text = `[video: download failed, ${video.duration}s]`;
      if (caption) text += `\n${caption}`;
    }

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'video', filePath, fileName: video.file_name ?? null,
      isForward, forwardFrom, caption,
    });
  });

  // Stickers
  bot.on('message:sticker', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, username, displayName, isForward, forwardFrom } = getBaseFields(msg);

    const access = checkAccess(userId);
    if (access === 'denied') return;
    if (access === 'pending') { await ctx.reply('Access denied.'); return; }

    const sticker = msg.sticker!;
    const emoji = sticker.emoji ?? '?';
    const text = `[sticker: ${emoji}]`;

    dispatchEvent({
      userId, chatId, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      mediaType: 'sticker', filePath: null, fileName: null,
      isForward, forwardFrom, caption: null,
    });
  });

  // Reaction updates (Bot API 7.0+)
  bot.on('message_reaction', async (ctx) => {
    const update = ctx.messageReaction;
    const chatId = update.chat.id;
    const messageId = update.message_id;
    const user = update.user;
    const userId = user?.id ?? null;
    const username = user?.username ?? null;
    const displayName = user
      ? [user.first_name, user.last_name].filter(Boolean).join(' ') || null
      : null;

    // Skip if user not in allowlist (anonymous reactions have no user)
    if (userId !== null) {
      const access = checkAccess(userId);
      if (access === 'denied') return;
    }

    if (!reactionCallback) return;

    // Report added reactions (emojis in new_reaction but not in old_reaction)
    const oldEmojis = new Set(
      (update.old_reaction ?? [])
        .filter(r => r.type === 'emoji')
        .map(r => (r as { type: 'emoji'; emoji: string }).emoji)
    );
    const newEmojis = (update.new_reaction ?? [])
      .filter(r => r.type === 'emoji')
      .map(r => (r as { type: 'emoji'; emoji: string }).emoji);

    for (const emoji of newEmojis) {
      if (!oldEmojis.has(emoji)) {
        reactionCallback({ chatId, messageId, emoji, action: 'added', username, displayName, userId });
      }
    }

    // Report removed reactions
    const newEmojiSet = new Set(newEmojis);
    for (const emoji of oldEmojis) {
      if (!newEmojiSet.has(emoji)) {
        reactionCallback({ chatId, messageId, emoji, action: 'removed', username, displayName, userId });
      }
    }
  });

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
