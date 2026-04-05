# Telegram MCP Server

Telegram bot + MCP server for Claude Code. Single process, stable connection.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN
```

## Usage

### As MCP server (Claude Code)

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/telegram-mcp",
      "env": {
        "TELEGRAM_BOT_TOKEN": "your-token"
      }
    }
  }
}
```

### Development

```bash
npm run dev     # Run with tsx (hot reload)
npm run build   # Compile TypeScript
npm start       # Run compiled version
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `telegram_send_message` | Send a message to a chat |
| `telegram_reply` | Reply to the latest incoming message |
| `telegram_edit_message` | Edit a sent message |
| `telegram_react` | React to a message with emoji |
| `telegram_search_messages` | Full-text search message history |
| `telegram_get_recent` | Get recent messages from a chat |
| `telegram_list_chats` | List all bot chats |
| `telegram_get_access_list` | View access policy |
| `telegram_approve_user` | Approve a pending user |
| `telegram_deny_user` | Deny a user |

## Access Control

Users are managed via `access.json`:
- `allowlist` -- approved users
- `pending` -- awaiting approval
- `denied` -- blocked users
- `default_policy` -- what happens to unknown users (`pending`, `allow`, `deny`)

## Architecture

- **grammY** -- Telegram bot (long polling)
- **@modelcontextprotocol/sdk** -- MCP server (stdio)
- **better-sqlite3** -- Message history with FTS5 full-text search
