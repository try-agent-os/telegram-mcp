# Telegram MCP Server

Telegram bot + MCP server for Claude Code. Single process, stable connection.

## Stack
- Node.js + TypeScript
- grammY (Telegram bot framework)
- @modelcontextprotocol/sdk (MCP server)
- better-sqlite3 (SQLite + FTS5)

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
