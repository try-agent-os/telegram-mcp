# Phase 0 PoC — Watchdog + Agent SDK Runner

Status: **working** (11 unit + 2 integration tests pass)
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

### 2. SDK Runner (`src/sdk-runner.ts`) — one-shot queries

`runWithWatchdog(prompt, options)` — runs a single Claude query with watchdog supervision.

- Spawns Claude via `query()` from `@anthropic-ai/claude-agent-sdk`
- Iterates the async stream, feeding events to watchdog
- On silence timeout: `controller.abort()` + auto-resume with same `session_id`
- Max 3 resume attempts before giving up
- Captures `session_id` from `system/init` message
- Supports in-process MCP tools via `mcpServers` option
- Sets `allowDangerouslySkipPermissions: true` when `bypassPermissions` mode is used

### 2b. SessionRunner (`src/session-runner.ts`) — persistent multi-turn

`new SessionRunner(options)` — maintains a long-lived query session.

- `start(prompt, resumeSessionId?)` — starts or resumes a query
- `sendMessage(text)` — feeds new messages via `q.streamInput()` (no new query per message)
- `close()` — terminates the session
- EventEmitter: `sessionStart`, `result`, `message`, `silence`, `error`, `closed`
- Watchdog monitors the entire session lifecycle, not just a single turn

### 2c. Session Store (`src/session-store.ts`)

Persists session_id to `.session-state.json` for resume after process restart.

- `saveSessionId(id)` / `loadSessionId()` / `clearSessionId()`

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
- Creates in-process MCP tools + SessionRunner
- First message: starts session (or resumes from saved session_id)
- Subsequent messages: fed via `sendMessage()` → `streamInput()`
- On error: closes session, clears state, starts fresh

### 5. Tests

**Unit tests** (11 total, all pass):
- `tests/sdk-runner.test.ts` (7): watchdog events, silence detection, reset, event mapping
- `tests/session-runner.test.ts` (4): simulated hang detection, session store save/load/clear

**Integration test** (`tests/sdk-integration.test.ts`): 2/2 pass (requires Claude auth)
- Basic query completes with session_id and result
- AbortController works mid-query

## What works

- [x] `npm install @anthropic-ai/claude-agent-sdk` pulls native binary
- [x] TypeScript compiles clean (`tsc --noEmit`)
- [x] StreamWatchdog detects silence and fires callback
- [x] SDK runner abort+resume loop
- [x] In-process MCP tools register with correct types
- [x] Door 1 entrypoint wires everything together
- [x] All 11 unit + 2 integration tests pass
- [x] SessionRunner with streamInput() multi-turn
- [x] Session persistence (save/load/clear session_id)
- [x] Simulated hang test (fake stream stall → watchdog abort)

## What's not tested yet

- [ ] End-to-end with real bot token (need token from Vasily)

## Key findings

1. **Agent SDK bundles Claude binary** — confirmed. `npm install` is sufficient, no separate `claude` CLI needed.
2. **`bypassPermissions` requires `allowDangerouslySkipPermissions: true`** — SDK enforces this safety flag.
3. **Watchdog check interval matters for tests** — `Math.max(1000, ...)` floor was too high for short thresholds. Fixed to `Math.max(100, Math.min(1000, threshold/3))`.
4. **In-process MCP via `createSdkMcpServer()`** works cleanly — tools defined with `tool()` helper, zod v4 schemas, annotations for read-only/destructive hints.

## Next steps

1. Get bot token for end-to-end test
2. Auth relay (OAuth `/login` URL forwarding to Telegram chat)
