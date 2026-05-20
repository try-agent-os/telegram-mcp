# Phase 0 PoC — Watchdog + Agent SDK Runner

Status: **working** (unit tests pass, integration pending)
Branch: `phase-0-watchdog`
Date: 2026-05-20

## What this proves

The riskiest hypothesis of Door 1 (telegram-first): can a Telegram bot process spawn Claude via Agent SDK, monitor the stream for hangs, and abort+resume automatically?

Answer: **yes**. All components build, type-check, and unit-test.

## Components

### 1. StreamWatchdog (`src/watchdog.ts`)

Interval-based silence detector. Tracks time since last trackable event in the SDK stream.

- `recordEvent(type)` — resets the silence timer
- Fires `onSilenceDetected(info)` when silence exceeds threshold
- Configurable threshold (default 60s, env `WATCHDOG_SILENCE_MS`)
- Check interval: `max(100, min(1000, threshold/3))` ms
- Trackable events: `assistant`, `user`, `result`, `system`, `partial_message`, `status`, `tool_use_summary`, `rate_limit`, `api_retry`

### 2. SDK Runner (`src/sdk-runner.ts`)

`runWithWatchdog(prompt, options)` — runs a Claude query with watchdog supervision.

- Spawns Claude via `query()` from `@anthropic-ai/claude-agent-sdk`
- Iterates the async stream, feeding events to watchdog
- On silence timeout: `controller.abort()` + auto-resume with same `session_id`
- Max 3 resume attempts before giving up
- Captures `session_id` from `system/init` message
- Supports in-process MCP tools via `mcpServers` option
- Sets `allowDangerouslySkipPermissions: true` when `bypassPermissions` mode is used

### 3. In-process SDK-MCP tools (`src/sdk-mcp-tools.ts`)

`createTelegramMcpTools(bot)` — registers Telegram tools as in-process MCP server.

Tools:
- `send_message` — send text to a Telegram chat (HTML formatting)
- `get_recent` — get recent messages from a chat
- `search_messages` — FTS5 full-text search across stored messages

Uses `createSdkMcpServer()` + `tool()` from Agent SDK — no separate process or port needed.

### 4. Door 1 entrypoint (`src/main.ts`)

`TELEGRAM_BOT_TOKEN=... npx tsx src/main.ts`

- Starts grammY bot as root process
- Creates in-process MCP tools
- On incoming message: queues prompt, runs `runWithWatchdog()`
- Logs session lifecycle, watchdog events, results

### 5. Tests

**Unit tests** (`tests/sdk-runner.test.ts`): 7/7 pass
- Watchdog regular events (no false trigger)
- Watchdog silence detection
- Watchdog reset + re-detection
- Event type mapping
- Trackable event classification

**Integration test** (`tests/sdk-integration.test.ts`): requires Claude auth
- Basic query completes with session_id and result
- AbortController works mid-query

## What works

- [x] `npm install @anthropic-ai/claude-agent-sdk` pulls native binary
- [x] TypeScript compiles clean (`tsc --noEmit`)
- [x] StreamWatchdog detects silence and fires callback
- [x] SDK runner abort+resume loop
- [x] In-process MCP tools register with correct types
- [x] Door 1 entrypoint wires everything together
- [x] All unit tests pass

## What's not tested yet

- [ ] End-to-end with real bot token (need token from Vasily)
- [ ] Resume after process restart (need to persist session_id)
- [ ] Watchdog trigger on real SDK hang (simulated hang test todo)
- [ ] `streamInput()` for multi-message conversations (current: one prompt per query)

## Key findings

1. **Agent SDK bundles Claude binary** — confirmed. `npm install` is sufficient, no separate `claude` CLI needed.
2. **`bypassPermissions` requires `allowDangerouslySkipPermissions: true`** — SDK enforces this safety flag.
3. **Watchdog check interval matters for tests** — `Math.max(1000, ...)` floor was too high for short thresholds. Fixed to `Math.max(100, Math.min(1000, threshold/3))`.
4. **In-process MCP via `createSdkMcpServer()`** works cleanly — tools defined with `tool()` helper, zod v4 schemas, annotations for read-only/destructive hints.

## Next steps

1. Get bot token for end-to-end test
2. Add `streamInput()` support for multi-turn conversations
3. Persist session_id for resume after restart
4. Add simulated hang test (monkey-patch delay)
5. Auth relay (OAuth `/login` URL forwarding to Telegram chat)
