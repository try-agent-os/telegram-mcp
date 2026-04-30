# telegram-mcp

Telegram bot + MCP server in a single Node.js process. Lets a Claude Code agent talk to a Telegram bot — read incoming messages (text, voice, media, forwarded URLs), send/edit/react, and search the full message history via FTS5.

Built for [AgentOS](https://github.com/try-agent-os) but works as a standalone MCP server for any Claude Code setup.

## Features

- **Bidirectional**: bot receives messages from users, MCP exposes tools for the agent to send/reply/react
- **Persistent history**: SQLite + FTS5 full-text search over every incoming/outgoing message
- **Local voice transcription**: voice messages auto-transcribed via [`nodejs-whisper`](https://github.com/ChetanXpro/nodejs-whisper) (whisper.cpp, runs on-device, ~1.3x realtime on Apple Silicon)
- **URL transcription**: YouTube/Instagram/TikTok/etc. links in text messages get auto-transcribed via `yt-dlp` + whisper
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

For voice transcription you also need `cmake`, `ffmpeg`, `yt-dlp` and the whisper `medium` model. See [SETUP.md](SETUP.md) for the full install (including the launchd plist for running as a user agent on macOS).

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

## Project layout

```
src/
  index.ts          — entry: starts MCP server + grammY bot
  bot.ts            — grammY setup, message handlers, channel push
  db.ts             — SQLite schema, CRUD, FTS5 search
  access.ts         — access policy (allowlist/pending/deny)
  tools.ts          — MCP tool definitions
  media-pipeline.ts — voice/URL → whisper transcription
  commands/         — /help, /id, /status, /tz bot commands
  types.ts          — shared types
deploy/
  com.novostudio.telegram-mcp.plist — launchd template (macOS)
```

## License

MIT — see [LICENSE](LICENSE).

## Related

- [AgentOS](https://github.com/try-agent-os) — the agent system this was built for
- [Model Context Protocol](https://modelcontextprotocol.io/) — the protocol spec
