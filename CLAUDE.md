# Telegram MCP Server

Telegram бот + MCP сервер для Claude Code. Один процесс, стабильное подключение.

## Стек
- Node.js + TypeScript
- grammY (Telegram bot framework)
- @modelcontextprotocol/sdk (MCP server)
- better-sqlite3 (SQLite + FTS5)

## Команды
```bash
npm run build    # tsc
npm run dev      # tsx src/index.ts
npm start        # node dist/index.js
```

## Структура
```
src/
  index.ts    — entry: MCP server + grammY bot startup
  bot.ts      — grammY setup, message handler
  db.ts       — SQLite init, CRUD, FTS search
  access.ts   — access policy (allowlist/pending/deny)
  tools.ts    — MCP tool definitions
  types.ts    — shared types
```

## Переменные окружения
- `TELEGRAM_BOT_TOKEN` — токен бота (обязательный)

## Спецификация
Полный spec: `/Users/vasily/Workspaces/novostudio/claude/docs/superpowers/specs/2026-04-05-telegram-mcp-design.md`
