# Telegram MCP Server

Telegram bot + MCP server for Claude Code. Single process, stable connection.

## Stack
- Node.js + TypeScript
- grammY (Telegram bot framework)
- @modelcontextprotocol/sdk (MCP server)
- better-sqlite3 (SQLite + FTS5)
- nodejs-whisper (local voice transcription via whisper.cpp)

## Commands
```bash
npm run build    # tsc
npm run dev      # tsx src/index.ts
npm start        # node dist/index.js
```

## Structure
```
src/
  index.ts    — entry: MCP server + grammY bot startup
  bot.ts      — grammY setup, message handler
  db.ts       — SQLite init, CRUD, FTS search
  access.ts   — access policy (allowlist/pending/deny)
  tools.ts    — MCP tool definitions
  types.ts    — shared types
```

## Environment Variables
- `TELEGRAM_BOT_TOKEN` — bot token (required)

## Setup prerequisites

See `SETUP.md` for full instructions. Key things to keep in mind when making changes or deploying:

- **System deps**: `cmake`, `ffmpeg` must be installed (not npm deps). Missing cmake → whisper.cpp won't build → voice transcription silently fails.
- **Whisper model**: `ggml-medium.bin` (~1.5GB) must be downloaded into `node_modules/nodejs-whisper/cpp/whisper.cpp/models/`. Not in git, not auto-downloaded in non-TTY. See SETUP.md for the command.
- **whisper.cpp build**: happens on first `transcribeVoice()` call (~30s cold). To avoid a cold first voice message, pre-build after install.
- **Transcription flow**: voice → `/tmp/telegram-mcp/voice_X.ogg` → nodejs-whisper converts to WAV → whisper-cli transcribes → timestamps stripped by `parseWhisperOutput()` in `bot.ts`.
- **Performance**: ~1.3x realtime on Apple Silicon with Metal. Longer voice messages take proportionally longer — user waits synchronously.
