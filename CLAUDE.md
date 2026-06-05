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
- `TELEGRAM_ADMIN_USER_IDS` — comma-separated Telegram user IDs auto-seeded as `allowed` on startup (multi-admin). Empty = no auto-seed; access must be granted via `/start` + manual `/approve`. Legacy: `TELEGRAM_USER_ID` (single-admin) is honored as fallback.
- `TELEGRAM_ADMIN_USERNAMES` — comma-separated usernames parallel to the IDs (display only).
- `TELEGRAM_MCP_MEDIA_DIR` — where to write voice/video temp files. Default `/tmp/telegram-mcp`. Set to a persistent state dir on production hosts.
- `WHISPER_MODEL` — `tiny | small | medium | large`. Default `medium`. Determines which `ggml-<name>.bin` is loaded by `nodejs-whisper`.
- `WHISPER_SERVER_URL` — optional. When set, transcription POSTs to that whisper-server `/inference` endpoint instead of spawning whisper-cli per call. Saves the model-load overhead per call (~1-3s).

## Setup prerequisites

See `SETUP.md` for full instructions. Key things to keep in mind when making changes or deploying:

- **System deps**: `cmake`, `ffmpeg` must be installed (not npm deps). Missing cmake → whisper.cpp won't build → voice transcription silently fails. On Linux droplets `libopenblas-dev` + `pkg-config` make the CPU encoder ~1.7x faster.
- **Whisper model**: `ggml-<WHISPER_MODEL>.bin` must be downloaded into `node_modules/nodejs-whisper/cpp/whisper.cpp/models/`. Not in git, not auto-downloaded in non-TTY. See SETUP.md for the command. `small` (244MB) is the sweet spot for CPU; `medium` (1.5GB) is the historical default for GPU/Metal hosts.
- **whisper.cpp build**: happens on first `transcribeVoice()` call (~30s cold). To avoid a cold first voice message, pre-build after install (`cmake -B build -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS && cmake --build build -j`).
- **Transcription paths** (in `src/media-pipeline.ts`):
  - `transcribeViaServer()` — when `WHISPER_SERVER_URL` is set. POSTs audio (multipart, `file` field, `language=auto`, `response_format=text`) via `fs.openAsBlob()` + `fetch()`. Model resident in RAM in the server process.
  - `transcribeViaCli()` — fallback. Spawns `whisper-cli` per call via `nodejs-whisper`, parses `[hh:mm:ss --> ...]` timestamps out via `parseWhisperOutput()`.
- **Performance**: Mac (Metal, per-call CLI, medium): ~1.3x realtime. Linux droplet (CPU, small + OpenBLAS + whisper-server): ~2-4x realtime. Longer messages take proportionally longer — user waits synchronously.
