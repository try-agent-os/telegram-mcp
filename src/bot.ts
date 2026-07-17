import { Bot, Context } from 'grammy';
import type { Message, MessageEntity, MessageOrigin } from '@grammyjs/types';
import { createWriteStream, mkdirSync } from 'fs';
import https from 'https';
import path from 'path';
import { checkAccess, touchUser } from './access.js';
import { createCommands } from './commands/index.js';
import { getUser, saveMessage } from './db.js';
import { maybeAutospawn } from './autospawn.js';
import type { SessionInfo } from './session-status.js';
import {
  shouldNotifyAgent,
  isMentionedInText,
  isReplyToBot,
  type BotIdentity,
  type PolicyEntity,
  type PolicyMessage,
} from './group-policy.js';
import {
  decideGroupEngagement,
  parseCoordinationChats,
  isPrimaryHostEnv,
  botExchangeTracker,
} from './group-routing.js';
import { extractMediaUrl, processUrl, processVideo, transcribeVoice } from './media-pipeline.js';
import { isLoginAdmin, isLoginPending, submitLogin } from './login-flow.js';
import { isClearCommand, isClearAdmin, handleClear } from './clear-flow.js';
import { isSessionControlEnabled, requestClear, requestModel } from './session-control.js';
import {
  parseModelCommand,
  parseModelCallback,
  isModelAdmin,
  handleModelSwitch,
  labelForAlias,
  modelKeyboard,
} from './model-flow.js';
import { consoleCommand, installConsoleMenuButton } from './console/menu-button.js';
import { registerBotCommands } from './command-menu.js';
import type { ChatType, IncomingMessageEvent, MediaType } from './types.js';

export interface ReactionEvent {
  chatId: number;
  messageId: number;
  emoji: string;
  action: 'added' | 'removed';
  username: string | null;
  displayName: string | null;
  userId: number | null;
}

// Inline-keyboard button tap (callback_query). The operator presents choices /
// "go" gates as inline buttons; a tap arrives here, is pushed to the operator
// session as a self-describing `[button] <data>` channel notification, and the
// originating message is edited to lock the choice in.
export interface CallbackEvent {
  chatId: number;
  // message_id of the message that HELD the buttons (so the operator can map
  // the tap back to the prompt it offered).
  messageId: number;
  data: string;
  userId: number;
  username: string | null;
  displayName: string | null;
}

const MEDIA_DIR = process.env.TELEGRAM_MCP_MEDIA_DIR ?? '/tmp/telegram-mcp';

// Multi-agent coordination groups. These are dedicated agent-coordination
// chats where several agent bots co-exist with BotFather Group Privacy OFF,
// so every bot sees every message. Instead of a blanket "always engage"
// (which would make N bots each reply once → duplicates), messages here go
// through decideGroupEngagement() so exactly one bot responds.
// Comma-separated chat IDs in TELEGRAM_ALWAYS_ENGAGE_CHAT_IDS.
const COORD_CHATS = parseCoordinationChats(process.env.TELEGRAM_ALWAYS_ENGAGE_CHAT_IDS);
// TELEGRAM_GROUP_PRIMARY_HOST: this host owns the human-no-mention default
// (primary=true, backup=false). Backup defers and only takes over via the
// grace-window failover below if the primary did not respond.
const IS_PRIMARY_HOST = isPrimaryHostEnv(process.env.TELEGRAM_GROUP_PRIMARY_HOST);
// Backup-host failover grace window: after a human-no-mention message the backup
// waits this long; if it observes NO message from the primary bot in the chat
// meanwhile, it engages. 0 disables failover. Default 7s.
const BACKUP_GRACE_MS = Number(process.env.TELEGRAM_BACKUP_GRACE_MS ?? 7000);

let messageCallback: ((event: IncomingMessageEvent) => void) | null = null;
let reactionCallback: ((event: ReactionEvent) => void) | null = null;
let callbackCallback: ((event: CallbackEvent) => void) | null = null;

export function onIncomingMessage(cb: typeof messageCallback): void {
  messageCallback = cb;
}

export function onReaction(cb: typeof reactionCallback): void {
  reactionCallback = cb;
}

export function onCallbackQuery(cb: typeof callbackCallback): void {
  callbackCallback = cb;
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

function getForwardFrom(origin: MessageOrigin | undefined): string | null {
  if (!origin) return null;

  if (origin.type === 'user') {
    const u = origin.sender_user;
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
    return u.username ? `@${u.username} (${name})` : name || 'Unknown user';
  }
  if (origin.type === 'hidden_user') return origin.sender_user_name ?? 'Hidden user';
  if (origin.type === 'chat') {
    const c = origin.sender_chat;
    return c.title ?? c.username ?? 'Unknown chat';
  }
  if (origin.type === 'channel') {
    const c = origin.chat;
    return c.title ?? c.username ?? 'Unknown channel';
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

// Channel-push / DB text for a bare location pin. The operator reads these
// coordinates straight out of the message content (e.g. to query Google Maps /
// Overpass for nearby places). Live locations are tagged so a moving fix is
// distinguishable from a static drop. e.g. `[location: 38.6296,-9.1156]`.
export function formatLocationText(lat: number, lon: number, isLive = false): string {
  return `[location${isLive ? ' live' : ''}: ${lat},${lon}]`;
}

// Channel-push / DB text for a venue (named place with title + optional
// address). e.g. `[venue: "Sunset Amora" — Av. da Liberdade 1 | 38.6296,-9.1156]`.
export function formatVenueText(title: string, address: string | null, lat: number, lon: number): string {
  return `[venue: "${title}"${address ? ` — ${address}` : ''} | ${lat},${lon}]`;
}

export interface BotOptions {
  getSessionCount: () => number;
  getUptime: () => number;
  /**
   * Per-session breakdown for `/status`. Optional so the SDK-spawn entrypoint
   * (main.ts) that has no SSE session registry can omit it and fall back to the
   * bare count. See session-status.ts for the field-availability caveats.
   */
  getSessions?: () => SessionInfo[];
}

// Optional override: chat ids listed in `TELEGRAM_ALWAYS_ENGAGE_GROUPS` (comma-
// separated) are notified on every message regardless of mention/reply/slash.
// Channels are still excluded (broadcast posts, see shouldNotifyAgent). Parsed
// once at bot construction; set is empty when the env var is absent or blank.
function parseAlwaysEngageGroups(raw: string | undefined): ReadonlySet<number> {
  if (!raw) return new Set();
  const ids = raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n !== 0);
  return new Set(ids);
}

export function createBot(token: string, options?: BotOptions): Bot {
  const bot = new Bot(token);
  const alwaysEngageGroups = parseAlwaysEngageGroups(process.env.TELEGRAM_ALWAYS_ENGAGE_GROUPS);
  if (alwaysEngageGroups.size > 0) {
    console.log(`[bot] TELEGRAM_ALWAYS_ENGAGE_GROUPS active for ${alwaysEngageGroups.size} chat(s):`, [...alwaysEngageGroups].join(','));
  }

  // Register the "/" command menu (dynamic per enabled host features, owner-gated
  // extras scoped to admin chats). Non-throwing — never blocks bot startup.
  void registerBotCommands(bot);

  // Register commands before message handlers so they take priority
  bot.use(createCommands(options));

  // Console Mini App: /console inline button + persistent chat Menu Button.
  consoleCommand(bot);
  installConsoleMenuButton(bot);

  function getBaseFields(msg: Message) {
    const userId = msg.from!.id;
    const chatId = msg.chat.id;
    const chatType = msg.chat.type as ChatType;
    // Group/supergroup/channel chats expose `title`; private chats expose only
    // first_name/last_name on the chat object (we already capture those via from.*).
    const chatTitle =
      chatType === 'private'
        ? null
        : (msg.chat as { title?: string }).title ?? null;
    const username = msg.from?.username ?? null;
    const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null;
    const isForward = !!msg.forward_origin;
    const forwardFrom = getForwardFrom(msg.forward_origin);
    const isForum = !!(msg.chat as { is_forum?: boolean }).is_forum;
    const messageThreadId = msg.message_thread_id ?? null;
    return { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId };
  }

  // Adapter: turn a grammY/Bot-API Message into the framework-agnostic shape
  // the group-policy module consumes. Centralised so every handler uses the
  // same projection (text vs caption, entities vs caption_entities, etc.).
  function toPolicyMessage(msg: Message): PolicyMessage {
    const rawEntities = (msg.entities ?? msg.caption_entities ?? []) as MessageEntity[];
    const entities: PolicyEntity[] = rawEntities.map(e => {
      const base: PolicyEntity = { type: e.type, offset: e.offset, length: e.length };
      // text_mention carries an embedded User; pull the id so we can match
      // against THIS bot without relying on the surface username text.
      if (e.type === 'text_mention') {
        const u = (e as MessageEntity.TextMentionMessageEntity).user;
        base.user = { id: u.id, username: u.username ?? null };
      }
      return base;
    });
    return {
      text: msg.text ?? msg.caption ?? '',
      entities,
      replyToUserId: msg.reply_to_message?.from?.id ?? null,
    };
  }

  function getBotIdentity(ctx: Context): BotIdentity | null {
    // ctx.me is populated once bot.init() has run (grammY calls init inside
    // bot.start()). Before that — or in pathological cases — bail out and let
    // the caller fall back to "always notify" so we never silently drop
    // private DMs because of a missing identity.
    const me = ctx.me;
    if (!me || !me.username) return null;
    return { id: me.id, username: me.username };
  }

  // Gate per-user access ONLY in private chats. In groups/supergroups/channels
  // the bot's mere presence (added by an admin) is treated as implicit access:
  // - Don't auto-create new user records as 'pending' for every group member
  //   who happens to send a message.
  // - Never reply with "Access request submitted" or "Access denied" inside a
  //   group — that would spam the chat. Just drop the message silently.
  // - Do still respect an explicit 'denied' status if the user has one (set
  //   manually via /deny in private earlier) to allow per-person blocks.
  // Returns true if the handler should continue processing the message.
  async function gateAccess(ctx: Context, userId: number, chatType: ChatType): Promise<boolean> {
    if (chatType === 'private') {
      const access = checkAccess(userId);
      if (access === 'denied') return false;
      if (access === 'pending') {
        await ctx.reply('Access request submitted. Please wait for approval.');
        return false;
      }
      // Phase 2 ingress hook: ALLOWED private-chat user → lazily ensure their
      // isolated per-user session exists (the Phase-1 routing filter then
      // delivers only to it). Gated behind MULTIUSER_AUTOSPAWN (default OFF) so
      // single-operator installs are unaffected — see src/autospawn.ts. Only
      // allowed users reach here (denied/pending returned above), never groups
      // (the non-private branch below). Fire-and-forget; never blocks ingress.
      maybeAutospawn(userId);
      return true;
    }
    // Non-private: only block users with a pre-existing 'denied' record.
    // Don't auto-create a record (that would mark every group member as pending
    // and pollute the users table).
    const existing = getUser(userId);
    if (existing && existing.status === 'denied') return false;
    return true;
  }

  // Persist every incoming message to the local SQLite store; only forward to
  // the agent (claude/channel notification) when `notify` is true. In group
  // chats `notify` reflects whether the bot was explicitly addressed
  // (mention / reply / slash command) — see shouldNotifyAgent. Storing
  // un-notified messages preserves chat-history context for future agent
  // invocations without spamming the live session.
  function dispatchEvent(event: IncomingMessageEvent, notify: boolean = true): void {
    saveMessage({
      telegram_message_id: event.messageId,
      chat_id: event.chatId,
      chat_type: event.chatType,
      chat_title: event.chatTitle,
      user_id: null,
      username: event.username,
      display_name: event.displayName,
      text: event.text,
      direction: 'in',
      reply_to_message_id: event.replyToMessageId,
      media_type: event.mediaType,
      file_path: event.filePath,
      file_name: event.fileName,
      latitude: event.latitude ?? null,
      longitude: event.longitude ?? null,
      venue_title: event.venueTitle ?? null,
      venue_address: event.venueAddress ?? null,
    });

    if (notify && messageCallback) messageCallback(event);
  }

  // ── Multi-agent coordination-group routing ──────────────────────────────
  // Pending backup-failover timers per chat. Cleared when the primary bot is
  // observed responding (any bot message in the chat cancels them).
  const pendingBackup = new Map<number, Set<NodeJS.Timeout>>();

  function cancelPendingBackup(chatId: number): void {
    const set = pendingBackup.get(chatId);
    if (!set) return;
    for (const t of set) clearTimeout(t);
    pendingBackup.delete(chatId);
  }

  function scheduleBackup(event: IncomingMessageEvent): void {
    const chatId = event.chatId;
    const timer = setTimeout(() => {
      const set = pendingBackup.get(chatId);
      if (set) set.delete(timer);
      // Primary never responded within the grace window — take over.
      if (messageCallback) messageCallback(event);
    }, BACKUP_GRACE_MS);
    let set = pendingBackup.get(chatId);
    if (!set) { set = new Set(); pendingBackup.set(chatId, set); }
    set.add(timer);
  }

  interface RouteVerdict { notify: boolean; deferBackup: boolean }

  // Decide engagement for one incoming message. Private → always notify;
  // non-coordination groups → legacy mention/reply/slash policy (with the
  // TELEGRAM_ALWAYS_ENGAGE_GROUPS override honoured via shouldNotifyAgent);
  // coordination groups → full multi-agent protocol (decideGroupEngagement)
  // + bot↔bot depth tracking.
  function routeMessage(ctx: Context, msg: Message, chatId: number, chatType: ChatType): RouteVerdict {
    if (chatType === 'private') return { notify: true, deferBackup: false };

    const botId = getBotIdentity(ctx);
    const isCoord = (chatType === 'group' || chatType === 'supergroup') && COORD_CHATS.has(chatId);

    if (!isCoord) {
      const notify = botId
        ? shouldNotifyAgent(chatType, toPolicyMessage(msg), botId, { chatId, alwaysEngage: alwaysEngageGroups })
        : false;
      return { notify, deferBackup: false };
    }

    const policy = toPolicyMessage(msg);
    const isFromBot = !!msg.from?.is_bot;
    const replyToMsgId = msg.reply_to_message?.message_id ?? null;
    // Record this message in the bot↔bot reply chain (also for human messages,
    // which reset depth to 0). Must run exactly once per observed message.
    const depth = botExchangeTracker.observe(chatId, msg.message_id, replyToMsgId, isFromBot);
    // A response from the other (primary) bot cancels any backup failover.
    if (isFromBot) cancelPendingBackup(chatId);

    const addressesThisBot = botId
      ? isMentionedInText(policy, botId) || isReplyToBot(policy, botId)
      : false;
    const hasAnyMention = policy.entities.some(
      (e) => e.type === 'mention' || e.type === 'text_mention',
    );

    const verdict = decideGroupEngagement({
      isFromBot,
      addressesThisBot,
      hasAnyMention,
      isPrimaryHost: IS_PRIMARY_HOST,
      botExchangeDepth: depth,
      // Live failover is handled by the grace-window timer (deferBackup), which
      // observes the primary's actual response — more reliable than a static
      // liveness flag, so we report the primary as online to the pure decision.
      primaryHostOnline: true,
    });

    if (verdict.depthExceeded) {
      void ctx.api
        .sendMessage(chatId, '⏹️ bot-exchange depth exceeded — stopping to avoid a loop.')
        .catch(() => { /* best-effort notice */ });
    }

    return { notify: verdict.engage, deferBackup: verdict.deferBackup };
  }

  // Dispatch honouring a coordination route: persist always; notify now if
  // engaged; otherwise (backup defer) schedule a grace-window failover.
  function dispatchRouted(event: IncomingMessageEvent, route: RouteVerdict): void {
    if (route.notify) {
      dispatchEvent(event, true);
      return;
    }
    dispatchEvent(event, false);
    if (route.deferBackup && BACKUP_GRACE_MS > 0) scheduleBackup(event);
  }

  // Text messages with per-(chat,user) debounced batching.
  // Share+caption in Telegram lands as two messages <500ms apart; without batching
  // Claude sees them as independent prompts and replies twice.
  const TEXT_BATCH_WINDOW_MS = 1500;

  interface BufferedTextMsg {
    text: string;
    messageId: number;
    replyToMessageId: number | null;
    quotedText: string | null;
    userId: number;
    username: string | null;
    displayName: string | null;
    isForward: boolean;
    forwardFrom: string | null;
    chatId: number;
    chatType: ChatType;
    chatTitle: string | null;
    messageThreadId: number | null;
    isForum: boolean;
    // Per-message group-policy verdict. The batch as a whole notifies the
    // agent if ANY of its parts was addressed to the bot (mention / reply /
    // slash command). This handles the share+caption pattern where the
    // caption mentions the bot but the link itself does not.
    notify: boolean;
    // Coordination-group backup-host defer: not engaged now, but eligible for
    // the grace-window failover if the primary doesn't respond.
    deferBackup: boolean;
  }

  interface TextBatch {
    messages: BufferedTextMsg[];
    timer: NodeJS.Timeout;
  }

  const textBatches = new Map<string, TextBatch>();

  async function flushTextBatch(key: string): Promise<void> {
    const batch = textBatches.get(key);
    if (!batch) return;
    textBatches.delete(key);

    const combined = batch.messages.map(m => m.text).join('\n');
    const last = batch.messages[batch.messages.length - 1];
    const notify = batch.messages.some(m => m.notify);
    const deferBackup = !notify && batch.messages.some(m => m.deferBackup);

    let text = combined;
    const url = extractMediaUrl(combined);
    if (url) {
      const transcribed = await processUrl(url, last.messageId);
      if (transcribed) text = `${combined}\n\n${transcribed}`;
    }

    dispatchRouted({
      userId: last.userId,
      chatId: last.chatId,
      chatType: last.chatType,
      chatTitle: last.chatTitle,
      text,
      username: last.username,
      displayName: last.displayName,
      messageId: last.messageId,
      replyToMessageId: last.replyToMessageId,
      quotedText: last.quotedText,
      mediaType: url ? 'url' : null,
      filePath: null,
      fileName: null,
      isForward: last.isForward,
      forwardFrom: last.forwardFrom,
      caption: null,
      messageThreadId: last.messageThreadId,
      isForum: last.isForum,
    }, { notify, deferBackup });
  }

  bot.on('message:text', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    // /login follow-up: if there's a pending OAuth flow for this chat and the
    // user just sent free-form text (not another slash command), treat it as
    // the verification code. Handled inline here, not as a command, because
    // the code itself is opaque — we can't know what it'll look like. Must
    // run BEFORE batching so a single code isn't combined with a stray
    // follow-up text into one payload sent to the agent.
    if (
      chatType === 'private' &&
      isLoginAdmin(userId) &&
      isLoginPending(chatId) &&
      !msg.text!.startsWith('/')
    ) {
      const code = msg.text!.trim();
      const result = await submitLogin(chatId, code);
      if (result.ok) {
        await ctx.reply('✅ Залогинен. Токен обновлен, operator/dispatcher подхватят через симлинк.');
      } else {
        await ctx.reply(`❌ Login failed: ${result.error}\n\nПопробуй /login снова.`);
      }
      return; // do NOT dispatch the code to the agent
    }

    if (!await gateAccess(ctx, userId, chatType)) return;

    if (chatType === 'private') touchUser(userId, username, displayName);

    // /clear interception (owner-only, private chat): clear the operator's Claude
    // context IN-PLACE by injecting a NATIVE `/clear` into its tmux session, rather
    // than letting `/clear` reach the agent as a normal channel-push (the agent
    // can't clear its own context from inside the conversation). No restart, MCP
    // connections stay alive. We persist the IN (thread history) and an OUT ack so
    // watchdog gap signals see a reply and do NOT trigger a restart.
    if (chatType === 'private' && isClearCommand(msg.text)) {
      // Unified semantics: /clear always clears the caller's OWN session.
      //  - Multi-user instance (session control on): EVERY user, including the
      //    owner, has their own bound session (<slug>-user-<uid>) → per-user clear.
      //  - Single-operator install (hub): only the admin has a session, and it is
      //    the operator session → operator inject. Non-admin → fall through.
      const sessionControl = isSessionControlEnabled();
      const clearAdmin = isClearAdmin(userId);
      if (sessionControl || clearAdmin) {
        saveMessage({
          telegram_message_id: msg.message_id, chat_id: chatId, chat_type: chatType,
          chat_title: chatTitle, user_id: null, username, display_name: displayName,
          text: msg.text!, direction: 'in', reply_to_message_id: msg.reply_to_message?.message_id ?? null,
          media_type: null, file_path: null, file_name: null,
        });
        let ackText: string;
        if (sessionControl) {
          const ok = requestClear(userId);
          ackText = ok
            ? '🧹 Твоя сессия очищается (native /clear).'
            : '⚠️ Не смог очистить сессию: per-user session control недоступен.';
        } else {
          const result = await handleClear();
          ackText = result.ok
            ? '🧹 Контекст очищен (native /clear, сессия жива — MCP не рвался).'
            : `⚠️ Не смог очистить контекст: ${result.error ?? 'unknown error'}`;
        }
        const sent = await ctx.reply(ackText);
        saveMessage({
          telegram_message_id: sent.message_id, chat_id: chatId, chat_type: chatType,
          chat_title: chatTitle, user_id: null, username: null, display_name: null,
          text: ackText, direction: 'out', reply_to_message_id: msg.message_id,
          media_type: null, file_path: null, file_name: null,
        });
        return; // handled here — do NOT dispatch /clear to the agent
      }
    }

    // /model interception (owner-only, private chat) — sibling of /clear above.
    // Bare `/model` → inline model-picker buttons (taps handled in the
    // callback_query handler below, never forwarded to the agent).
    // `/model <alias>` → inject a NATIVE `/model <alias>` into the operator tmux
    // session right away. In-place switch, no restart, MCP connections stay alive.
    // Unified semantics (same as /clear): on a multi-user instance every user
    // (incl. owner) drives THEIR OWN per-user session; on the hub only the admin
    // drives the operator session. Both use the same picker.
    const sessionControl = chatType === 'private' && isSessionControlEnabled();
    const modelAdmin = chatType === 'private' && isModelAdmin(userId);
    const modelPerUser = sessionControl;
    const modelCmd = modelPerUser || modelAdmin ? parseModelCommand(msg.text) : null;
    if (modelCmd) {
      saveMessage({
        telegram_message_id: msg.message_id, chat_id: chatId, chat_type: chatType,
        chat_title: chatTitle, user_id: null, username, display_name: displayName,
        text: msg.text!, direction: 'in', reply_to_message_id: msg.reply_to_message?.message_id ?? null,
        media_type: null, file_path: null, file_name: null,
      });
      let ackText: string;
      let sent;
      if (modelCmd.kind === 'menu') {
        ackText = modelPerUser ? 'Выбери модель для своей сессии:' : 'Выбери модель для сессии оператора:';
        sent = await ctx.reply(ackText, { reply_markup: modelKeyboard() });
      } else if (modelPerUser) {
        const ok = requestModel(userId, modelCmd.alias);
        ackText = ok
          ? `✅ Модель твоей сессии: ${labelForAlias(modelCmd.alias)} (native /model ${modelCmd.alias})`
          : '⚠️ Не смог переключить модель: per-user session control недоступен.';
        sent = await ctx.reply(ackText);
      } else {
        const result = await handleModelSwitch(modelCmd.alias);
        ackText = result.ok
          ? `✅ Модель: ${labelForAlias(modelCmd.alias)} (native /model ${modelCmd.alias}, сессия жива)`
          : `⚠️ Не смог переключить модель: ${result.error ?? 'unknown error'}`;
        sent = await ctx.reply(ackText);
      }
      saveMessage({
        telegram_message_id: sent.message_id, chat_id: chatId, chat_type: chatType,
        chat_title: chatTitle, user_id: null, username: null, display_name: null,
        text: ackText, direction: 'out', reply_to_message_id: msg.message_id,
        media_type: null, file_path: null, file_name: null,
      });
      return; // handled here — do NOT dispatch /model to the agent
    }

    // Decide whether this message should trigger the agent. Private chats
    // always notify; groups only when explicitly addressed (or via the
    // always-engage override / coordination protocol) — see routeMessage.
    const route = routeMessage(ctx, msg, chatId, chatType);

    const buffered: BufferedTextMsg = {
      text: msg.text!,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      userId,
      username,
      displayName,
      isForward,
      forwardFrom,
      chatId,
      chatType,
      chatTitle,
      messageThreadId,
      isForum,
      notify: route.notify,
      deferBackup: route.deferBackup,
    };

    const key = `${chatId}:${userId}`;
    const existing = textBatches.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(buffered);
      existing.timer = setTimeout(() => { void flushTextBatch(key); }, TEXT_BATCH_WINDOW_MS);
    } else {
      const timer = setTimeout(() => { void flushTextBatch(key); }, TEXT_BATCH_WINDOW_MS);
      textBatches.set(key, { messages: [buffered], timer });
    }
  });

  // Voice messages
  bot.on('message:voice', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

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
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'voice', filePath, fileName: null,
      isForward, forwardFrom, caption,
      messageThreadId, isForum,
    }, notify);
  });

  // Video notes (round videos)
  bot.on('message:video_note', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

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
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'video_note', filePath, fileName: null,
      isForward, forwardFrom, caption: null,
      messageThreadId, isForum,
    }, notify);
  });

  // Photos
  bot.on('message:photo', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

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
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'photo', filePath, fileName: null,
      isForward, forwardFrom, caption,
      messageThreadId, isForum,
    }, notify);
  });

  // Documents (PDF, files, etc.)
  bot.on('message:document', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

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
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'document', filePath, fileName: originalName,
      isForward, forwardFrom, caption,
      messageThreadId, isForum,
    }, notify);
  });

  // Videos
  bot.on('message:video', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

    const video = msg.video!;
    const caption = msg.caption ?? null;
    const localName = `video_${msg.message_id}.mp4`;
    let filePath: string | null = null;
    let text: string;

    try {
      filePath = await downloadFile(token, video.file_id, localName);
      const transcription = await processVideo(filePath, msg.message_id);
      if (transcription) {
        text = transcription;
        if (caption) text += `\n${caption}`;
      } else {
        text = buildText('video', filePath, caption);
        text += ` (${video.duration}s)`;
      }
    } catch (err) {
      console.error('[bot] video download error:', err);
      text = `[video: download failed, ${video.duration}s]`;
      if (caption) text += `\n${caption}`;
    }

    dispatchEvent({
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'video', filePath, fileName: video.file_name ?? null,
      isForward, forwardFrom, caption,
      messageThreadId, isForum,
    }, notify);
  });

  // Stickers
  bot.on('message:sticker', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

    const sticker = msg.sticker!;
    const emoji = sticker.emoji ?? '?';
    const text = `[sticker: ${emoji}]`;

    dispatchEvent({
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'sticker', filePath: null, fileName: null,
      isForward, forwardFrom, caption: null,
      messageThreadId, isForum,
    }, notify);
  });

  // Venues (a pin with a named place — title + address). Bot-API venue messages
  // ALSO carry a `location` field, so this MUST be registered BEFORE the
  // message:location handler below; otherwise a venue would be double-ingested
  // as a bare location. grammY stops the middleware chain when this filter
  // matches and the handler returns without next(), so location never runs.
  bot.on('message:venue', async (ctx: Context) => {
    const msg = ctx.message!;
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

    const venue = msg.venue!;
    const lat = venue.location.latitude;
    const lon = venue.location.longitude;
    const title = venue.title;
    const address = venue.address ?? null;
    const text = formatVenueText(title, address, lat, lon);

    dispatchEvent({
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'venue', filePath: null, fileName: null,
      latitude: lat, longitude: lon, venueTitle: title, venueAddress: address,
      isForward, forwardFrom, caption: null,
      messageThreadId, isForum,
    }, notify);
  });

  // Location pins (bare geo, no named place). Guard against venue messages,
  // which also match message:location — they are handled above and never reach
  // here, but the explicit guard keeps this correct regardless of registration
  // order. Live locations (live_period set) are tagged so the operator knows the
  // coordinate is a moving fix.
  bot.on('message:location', async (ctx: Context) => {
    const msg = ctx.message!;
    if (msg.venue) return; // belongs to the venue handler
    const { userId, chatId, chatType, chatTitle, username, displayName, isForward, forwardFrom, isForum, messageThreadId } = getBaseFields(msg);

    if (!await gateAccess(ctx, userId, chatType)) return;

    const notify = routeMessage(ctx, msg, chatId, chatType).notify;

    const loc = msg.location!;
    const lat = loc.latitude;
    const lon = loc.longitude;
    const text = formatLocationText(lat, lon, !!loc.live_period);

    dispatchEvent({
      userId, chatId, chatType, chatTitle, text, username, displayName,
      messageId: msg.message_id,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
      quotedText: (msg as { quote?: { text?: string } }).quote?.text ?? null,
      mediaType: 'location', filePath: null, fileName: null,
      latitude: lat, longitude: lon, venueTitle: null, venueAddress: null,
      isForward, forwardFrom, caption: null,
      messageThreadId, isForum,
    }, notify);
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

    // Skip if user not in allowlist (anonymous reactions have no user).
    // Use a read-only check (getUser, not checkAccess) so we don't auto-create
    // 'pending' records for every group member who reacts to a message — that
    // would pollute the users table when the bot sits in a group of dozens.
    if (userId !== null) {
      const existing = getUser(userId);
      if (existing && existing.status === 'denied') return;
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

  // Inline-keyboard button taps (callback_query). The operator attaches inline
  // callback buttons when it offers a choice or a "go" gate; the user taps
  // instead of typing. We:
  //   1. gate access with the SAME owner/allowlist check used for messages,
  //   2. answer the callback immediately to clear the client spinner (+ toast),
  //   3. edit the originating message to lock the choice in (strip the keyboard,
  //      append the chosen label) so it can't be tapped twice,
  //   4. push a self-describing `[button] <data>` notification to the operator.
  bot.on('callback_query:data', async (ctx: Context) => {
    const cq = ctx.callbackQuery!;
    const from = cq.from;
    const userId = from.id;
    const msg = cq.message;
    const chatId = msg?.chat.id ?? from.id;
    const chatType = (msg?.chat.type ?? 'private') as ChatType;
    const data = cq.data ?? '';

    // Access gate — never let a non-owner/denied user drive a callback.
    if (!await gateAccess(ctx, userId, chatType)) {
      try { await ctx.answerCallbackQuery({ text: 'Access denied.', show_alert: false }); } catch { /* ignore */ }
      return;
    }

    // model_switch:<alias> interception (owner-only) — a tap on the /model picker.
    // Handled entirely here: inject the native `/model <alias>` into the operator
    // tmux session and edit the picker message into an ack. NOT forwarded to the
    // agent as a channel-push (the agent can't switch its own model from inside
    // the conversation).
    const modelAlias = parseModelCallback(data);
    if (modelAlias !== null) {
      // Unified semantics: multi-user instance → the tapping user's OWN per-user
      // session (any allowed user, incl. owner); hub → admin drives the operator
      // session; hub non-admin → deny.
      const modelPerUser = isSessionControlEnabled();
      const modelAdmin = isModelAdmin(userId);
      if (!modelPerUser && !modelAdmin) {
        try { await ctx.answerCallbackQuery({ text: 'Access denied.', show_alert: false }); } catch { /* ignore */ }
        return;
      }
      const label = labelForAlias(modelAlias);
      let ackText: string;
      let ok: boolean;
      if (modelPerUser) {
        ok = requestModel(userId, modelAlias);
        ackText = ok
          ? `✅ Модель твоей сессии: ${label} (native /model ${modelAlias})`
          : '⚠️ Не смог переключить модель: per-user session control недоступен.';
      } else {
        const result = await handleModelSwitch(modelAlias);
        ok = result.ok;
        ackText = result.ok
          ? `✅ Модель: ${label} (native /model ${modelAlias}, сессия жива)`
          : `⚠️ Не смог переключить модель: ${result.error ?? 'unknown error'}`;
      }
      try {
        await ctx.answerCallbackQuery({ text: ok ? `✓ ${label}` : '⚠️ Ошибка', show_alert: !ok });
      } catch (err) {
        console.error('[bot] answerCallbackQuery failed:', (err as Error).message);
      }
      // Lock the picker in: replace its text with the ack (also drops the keyboard).
      try {
        await ctx.editMessageText(ackText);
      } catch {
        try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ignore */ }
      }
      saveMessage({
        telegram_message_id: msg?.message_id ?? 0,
        chat_id: chatId,
        chat_type: chatType,
        chat_title: null,
        user_id: null,
        username: from.username ?? null,
        display_name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
        text: `[button] ${data} → ${ackText}`,
        direction: 'in',
        reply_to_message_id: msg?.message_id ?? null,
        media_type: null,
        file_path: null,
        file_name: null,
      });
      return; // handled here — do NOT forward the tap to the agent
    }

    // Clear the client's loading spinner immediately (Telegram shows a spinner on
    // the button until answered; un-answered callbacks spin for ~30s).
    try {
      await ctx.answerCallbackQuery({ text: `✓ ${data}`.slice(0, 200) });
    } catch (err) {
      console.error('[bot] answerCallbackQuery failed:', (err as Error).message);
    }

    const username = from.username ?? null;
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
    const messageId = msg?.message_id ?? 0;

    // Lock the choice in: remove the inline keyboard and mark the picked option
    // on the original message text. Robust to "message is not modified" and to
    // messages we can't edit (too old / no text). Done best-effort.
    if (msg && messageId) {
      const baseText =
        'text' in msg && typeof msg.text === 'string'
          ? msg.text
          : 'caption' in msg && typeof (msg as { caption?: string }).caption === 'string'
            ? (msg as { caption?: string }).caption!
            : '';
      const chosenLine = `\n\n✅ Выбрано: ${data}`;
      try {
        if (baseText) {
          await ctx.editMessageText(`${baseText}${chosenLine}`);
        } else {
          // No editable text body — just strip the keyboard so it can't re-fire.
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        }
      } catch (err) {
        const m = (err as Error).message ?? '';
        if (!/message is not modified/i.test(m)) {
          // Fallback: at least try to drop the keyboard.
          try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ignore */ }
        }
      }
    }

    // Persist as an inbound message for history/replay parity with typed msgs.
    saveMessage({
      telegram_message_id: messageId,
      chat_id: chatId,
      chat_type: chatType,
      chat_title: chatType === 'private' ? null : (msg?.chat as { title?: string })?.title ?? null,
      user_id: null,
      username,
      display_name: displayName,
      text: `[button] ${data}`,
      direction: 'in',
      reply_to_message_id: messageId,
      media_type: null,
      file_path: null,
      file_name: null,
    });

    if (callbackCallback) {
      callbackCallback({ chatId, messageId, data, userId, username, displayName });
    }
  });

  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
