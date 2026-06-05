# telegram-mcp

Telegram bot + MCP server in a single Node.js process. Lets a Claude Code agent talk to a Telegram bot — read incoming messages (text, voice, media, forwarded URLs), send/edit/react, and search the full message history via FTS5.

Built for [AgentOS](https://github.com/try-agent-os) but works as a standalone MCP server for any Claude Code setup.

## Features

- **Bidirectional**: bot receives messages from users, MCP exposes tools for the agent to send/reply/react
- **Persistent history**: SQLite + FTS5 full-text search over every incoming/outgoing message
- **Voice transcription (pluggable backend)**: voice messages auto-transcribed; the backend is token-driven via `OPENAI_API_KEY` — set it for OpenAI cloud (`gpt-4o-transcribe`) speed, leave it unset for on-device privacy (a resident `whisper-server` over HTTP when `WHISPER_SERVER_URL` is set, else local `whisper-cli` via [`nodejs-whisper`](https://github.com/ChetanXpro/nodejs-whisper), whisper.cpp)
- **URL transcription**: YouTube/Instagram/TikTok/etc. links in text messages get auto-transcribed via `yt-dlp` + the selected transcription backend
- **Media support**: photos, voice, documents, stickers, forwarded posts
- **Access control**: per-user allow/deny/pending policy stored in SQLite, managed via `/status` bot commands or MCP tools
- **Per-user timezone**: timestamps localized in channel push payloads
- **Inline buttons**: send messages with URL or callback buttons via the `telegram_send_message` tool

## Stack

- [grammY](https://grammy.dev/) — Telegram bot framework (long polling)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server (stdio)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — SQLite + FTS5
- [nodejs-whisper](https://github.com/ChetanXpro/nodejs-whisper) — local whisper.cpp transcription
- TypeScript, Node.js 20+

## Quick start

```bash
git clone git@github.com:try-agent-os/telegram-mcp.git
cd telegram-mcp
npm install
cp .env.example .env
# put your bot token from @BotFather into .env
npm run build
npm start
```

For voice/URL transcription you always need `ffmpeg` and `yt-dlp`. The rest depends on the backend.

### Transcription backend

Selection is token-driven: set `OPENAI_API_KEY` to send audio to the OpenAI cloud backend (speed), or leave it unset to stay on-device (privacy). When `OPENAI_API_KEY` is absent, the local backend is chosen by `WHISPER_SERVER_URL`: set → `whisper-server` (resident model over HTTP), otherwise → `whisper-cli` (per-call whisper.cpp).

| Env var | Backend | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | openai | **present → cloud backend; absent → local backend** |
| `OPENAI_API_BASE` | openai | API base, default `https://api.openai.com/v1` |
| `OPENAI_TRANSCRIBE_MODEL` | openai | default `gpt-4o-transcribe` (use `whisper-1` to fall back) |
| `WHISPER_SERVER_URL` | whisper-server | base URL of a running [whisper-server](https://github.com/ggerganov/whisper.cpp) (model resident in RAM) |
| `WHISPER_MODEL` | whisper-cli | local whisper.cpp model name, default `medium` |
| `TELEGRAM_MCP_MEDIA_DIR` | all | scratch dir for extracted audio, default `/tmp/telegram-mcp` |

For the local `whisper-cli` backend you also need `cmake` and the whisper `medium` model. See [SETUP.md](SETUP.md) for the full install (including the launchd plist for running as a user agent on macOS).

## Use as MCP server in Claude Code

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp/dist/index.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "<your bot token>"
      }
    }
  }
}
```

The bot starts when the MCP server is launched — both run in the same process.

## MCP tools

| Tool | Description |
|---|---|
| `telegram_send_message` | Send a message to a chat (supports inline URL/callback buttons, auto-converts Markdown to HTML when `parse_mode` is unspecified) |
| `telegram_reply` | Reply to the latest incoming message |
| `telegram_edit_message` | Edit a message previously sent by the bot |
| `telegram_react` | React to a message with an emoji |
| `telegram_search_messages` | Full-text search over message history (FTS5) |
| `telegram_get_recent` | Get recent messages from a chat |
| `telegram_list_chats` | List all chats the bot has seen |
| `telegram_get_access_list` | View the current access policy (allowed / pending / denied users) |
| `telegram_approve_user` | Approve a pending user |
| `telegram_deny_user` | Deny a user |

## Bot commands (for users talking to the bot)

| Command | What it does |
|---|---|
| `/help` | Show help |
| `/id` | Show your Telegram user ID (useful for whitelisting) |
| `/status` | Show your access status |
| `/tz` | Set your timezone (inline picker) |

## Access control

Users are stored in SQLite with one of three statuses:
- **allowed** — can talk to the bot
- **pending** — first contact, awaiting human approval
- **denied** — blocked

Default policy for unknown users is configurable (`pending` / `allow` / `deny`). Manage via the bot commands above or via `telegram_approve_user` / `telegram_deny_user` MCP tools.

## Channel push

When an allowed user sends a message, the MCP server emits a notification on stdio so Claude Code (or any MCP client supporting channel push) can react in real time. Payload includes message text, author, chat, local time in the user's timezone, and any transcription result.

Group / supergroup messages include `chat_type` (`group` / `supergroup`) and `chat_title` in the meta payload, and the content is prefixed with `[@speaker in "Chat Title"]` so the agent can disambiguate multiple speakers in a single conversation.

## Group and supergroup chats

The bot works in Telegram groups and supergroups, not just private DMs.

**Engagement policy.** To avoid spamming a group full of humans, the bot only forwards a message to the connected Claude Code session ("notifies the agent") when one of the following is true:

1. The message contains an `@<bot_username>` mention (either typed `mention` or clicked-from-list `text_mention` entity).
2. The message is a reply to one of the bot's own previous messages.
3. The message is a slash command (`/status`, `/help`, …, including the `/cmd@botname` form).

All other group messages are silently ingested into `messages.db` (so the agent has full chat-history context when it IS addressed later) but no `claude/channel` notification is emitted.

Private chats keep the legacy behaviour — every message notifies the agent. Channel posts are persisted but never trigger a notification (no real conversation expected there).

**BotFather privacy mode.** Telegram's default for new bots is "privacy mode ON", which means the bot only receives messages that mention it, reply to its messages, or are slash commands — exactly the same subset this code engages on. If you want the bot to also receive (and silently ingest) every other group message for history context, disable privacy mode:

```
/setprivacy → @your_bot → Disable
```

in a chat with @BotFather. With privacy mode left on, ingestion is limited to messages the bot was already going to engage with, so the silent-history-context feature is effectively a no-op — but everything else works.

**Access control in groups.** The per-user allow/pending/deny gate runs in private chats only. In a group the bot's mere presence (it was added by an admin) is treated as implicit access for every member; only an explicit pre-existing `denied` record blocks a particular user. This keeps the users table from filling up with `pending` rows for every group member who happens to send a message.

## Project layout

```
src/
  index.ts          — entry: starts MCP server + grammY bot
  bot.ts            — grammY setup, message handlers, channel push
  db.ts             — SQLite schema, CRUD, FTS5 search
  access.ts         — access policy (allowlist/pending/deny)
  group-policy.ts   — pure mention/reply/slash-command detector for group chats
  tools.ts          — MCP tool definitions
  media-pipeline.ts — voice/URL → whisper transcription
  commands/         — /help, /id, /status, /tz bot commands
  types.ts          — shared types
tests/
  group-policy.test.ts — node:test unit tests for the group engagement policy
deploy/
  com.novostudio.telegram-mcp.plist — launchd template (macOS)
```

## Tests

```bash
npm test
```

Runs `node:test` against `tests/*.test.ts` via tsx. Currently covers the group / supergroup engagement policy (mention, reply-to-bot, and slash-command detection).

## License

MIT — see [LICENSE](LICENSE).

## Related

- [AgentOS](https://github.com/try-agent-os) — the agent system this was built for
- [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol spec
