# cc-connect Pattern Port — Implementation Spec

Source: [cc-connect deep-dive](https://github.com/k-vasily/claude/blob/main/memory/research/cc-connect-deep-dive-2026-05-20.md)
ClickUp master task: https://app.clickup.com/t/86c9wxg0j
Date: 2026-05-20
Author: worker-steal-from-cc-connect

## License Constraint

cc-connect README shows MIT badge but **no LICENSE file in repo**. All patterns below are reimplemented from behavioral spec, not copied. For non-trivial logic, email `chg80333@gmail.com` if needed.

---

## Pattern #1: Honest Permission Flow via `canUseTool`

**ClickUp**: https://app.clickup.com/t/86c9wxhxy
**Priority**: High — fixes "bypassPermissions everywhere" security gap

### Current State

`session-runner.ts:108` defaults `permissionMode = 'bypassPermissions'` and sets `allowDangerouslySkipPermissions = true`. Every tool call auto-approved. No user visibility into what Claude does.

### Target Behavior

When Claude wants to use a tool (Bash, Edit, Write, etc.), the user sees a Telegram message asking for permission. User taps [Allow] or [Deny]. Response flows back to Claude.

### cc-connect Reference

`agent/claudecode/session.go:466-524` handles `control_request` with `subtype: "can_use_tool"`. Checks permission mode first (bypass -> auto-allow, dontAsk -> auto-deny, acceptEdits -> auto-allow Edit/Write/NotebookEdit/MultiEdit). For "default" mode, emits an event that the platform surfaces to the user.

Response format (`session.go:614-651`):
```json
{"type": "control_response", "response": {
  "subtype": "success", "request_id": "<id>",
  "response": {"behavior": "allow", "updatedInput": {}}
}}
```

### Implementation Plan (Agent SDK)

The Agent SDK exposes this via the `canUseTool` callback in query options — no need to parse stdio JSON ourselves.

**Step 1**: Add `canUseTool` callback to `SessionRunnerOptions`:

```typescript
interface SessionRunnerOptions {
  // ... existing fields ...
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionResult>;
}

interface PermissionRequest {
  toolName: string;
  input: Record<string, any>;
  requestId: string;
  sessionKey: string;
}

interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, any>;
  message?: string;
}
```

**Step 2**: In `buildQueryOptions()`, when `permissionMode !== 'bypassPermissions'`:

```typescript
if (this.options.onPermissionRequest) {
  opts.canUseTool = async (toolName: string, input: Record<string, any>) => {
    if (this.options.permissionMode === 'acceptEdits'
        && ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    return this.options.onPermissionRequest!({
      toolName, input,
      requestId: crypto.randomUUID(),
      sessionKey: this.sessionKey,
    });
  };
}
```

**Step 3**: In `bot.ts` or a new `permission-flow.ts`, wire Telegram inline keyboard:

```typescript
async function promptPermission(chatId: number, req: PermissionRequest): Promise<PermissionResult> {
  const preview = JSON.stringify(req.input, null, 2).slice(0, 500);
  const text = `Claude wants to use **${req.toolName}**:\n\`\`\`\n${preview}\n\`\`\``;
  await bot.api.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Allow', callback_data: `perm:allow:${req.requestId}` },
        { text: 'Deny', callback_data: `perm:deny:${req.requestId}` },
        { text: 'Allow All', callback_data: `perm:allowall:${req.requestId}` },
      ]]
    }
  });
  return pendingPermissions.waitFor(req.requestId, 120_000);
}
```

**Prerequisite**: Pattern #2 (per-chat sessions) — without it, one user's permission prompt could be answered by another.

**Effort**: ~2 days implementation + testing

---

## Pattern #2: Per-Chat SessionKey with Forum-Aware Logic

**ClickUp**: https://app.clickup.com/t/86c9wxhy2
**Priority**: High — prerequisite for patterns #1 and #3, fixes architect review critical

### Current State

Single global `SessionRunner`. All messages funnel to one Claude session regardless of chat. `session-store.ts` persists one session ID. Text batching in `bot.ts:327` uses `${chatId}:${userId}` as batch key — similar concept but not formalized.

`IncomingMessageEvent` in `types.ts` has no `messageThreadId` or `isForum` fields.

### cc-connect Reference

`platform/telegram/telegram.go:334-347` — thread ID filtering:
```go
isGroup := msg.Chat.Type == ChatTypeGroup || msg.Chat.Type == ChatTypeSupergroup
threadID := 0
if msg.Chat.IsForum || !isGroup {
    threadID = msg.MessageThreadID
}
```

Key insight: in regular supergroups, `MessageThreadID` is DROPPED (reply threads don't fragment sessions). In forum groups (`IsForum=true`), it's kept because topics are real sub-channels.

`telegram.go:548-559` — key construction with two modes:
- **Shared** (`share_session_in_channel = true`): one session per chat/topic
- **Per-user** (default): separate sessions per user per chat

### Implementation Plan

**Step 1**: Add fields to `IncomingMessageEvent` in `types.ts`:

```typescript
export interface IncomingMessageEvent {
  // ... existing fields ...
  messageThreadId: number | null;
  isForum: boolean;
}
```

**Step 2**: Add `buildSessionKey()` to `types.ts`:

```typescript
export interface SessionKeyOptions {
  shareSessionInGroup?: boolean; // default: true
}

export function buildSessionKey(
  chatId: number,
  chatType: ChatType,
  messageThreadId: number | null,
  isForum: boolean,
  userId: number,
  options: SessionKeyOptions = {}
): string {
  const { shareSessionInGroup = true } = options;

  // Filter threadId: keep only in forum topics, drop in regular supergroups
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const threadId = (isForum || !isGroup) ? messageThreadId : null;

  if (shareSessionInGroup) {
    if (threadId) return `telegram:${chatId}:${threadId}`;
    return `telegram:${chatId}`;
  }
  if (threadId) return `telegram:${chatId}:${threadId}:${userId}`;
  return `telegram:${chatId}:${userId}`;
}
```

**Step 3**: Extract `messageThreadId` and `isForum` in `bot.ts:getBaseFields()`:

```typescript
function getBaseFields(msg: Message) {
  // ... existing fields ...
  const isForum = !!(msg.chat as any).is_forum;
  const messageThreadId = msg.message_thread_id ?? null;
  return { ...existing, isForum, messageThreadId };
}
```

**Step 4**: Replace single `SessionRunner` with `Map<string, SessionRunner>` in a new `session-manager.ts`.

**Step 5**: Update `session-store.ts` to persist per-key (SQLite table instead of flat file).

**Step 6**: Update all message handlers in `bot.ts` to pass `isForum` and `messageThreadId`.

**Effort**: ~1 day implementation

---

## Pattern #3: Idle Reset + 3-Phase Graceful Shutdown

**ClickUp**: https://app.clickup.com/t/86c9wxhy8
**Priority**: High — prevents orphan processes and stale context

### Current State

`SessionRunner.close()` (`session-runner.ts:96-103`): calls `this.watchdog.stop()` + `this.q.close()` + sets `this.consuming = false`. Single chance, no escalation.

No idle timeout — sessions live forever with potentially stale context.

### cc-connect Reference

**Idle reset** — `engine.go:2145-2193`: triggered on every message, checks `time.Since(lastActivity) >= 30min`, closes old session, creates new one, notifies user.

**3-phase shutdown** — `session.go:705-747`:
```
Phase 1: Close stdin (8s graceful timeout)
Phase 2: SIGTERM process group (-PGID, 5s wait)
Phase 3: SIGKILL process group
```

Setup: `cmd.SysProcAttr.Setpgid = true` — child gets own process group.

### Implementation Plan

**Part A: 3-Phase Graceful Shutdown**

```typescript
async close(gracefulTimeoutMs: number = 8_000): Promise<void> {
  this.watchdog.stop();

  if (!this.q) {
    this.consuming = false;
    return;
  }

  // Phase 1: Graceful close via SDK
  this.q.close();

  const closed = await Promise.race([
    new Promise<true>(r => this.once('closed', () => r(true))),
    new Promise<false>(r => setTimeout(() => r(false), gracefulTimeoutMs)),
  ]);

  if (closed) { this.q = null; this.consuming = false; return; }

  // Phase 2: Force abort via AbortController
  console.log('[session] Graceful close timed out, aborting...');
  this.controller.abort();

  const aborted = await Promise.race([
    new Promise<true>(r => this.once('closed', () => r(true))),
    new Promise<false>(r => setTimeout(() => r(false), 5_000)),
  ]);

  if (!aborted) {
    console.warn('[session] Abort timed out, forcing cleanup');
  }

  this.q = null;
  this.consuming = false;
}
```

**Part B: Idle Reset**

Add to `SessionManager`:

```typescript
class SessionManager {
  private sessions = new Map<string, { runner: SessionRunner; lastActiveAt: number }>();
  private readonly resetOnIdleMs: number;

  checkIdleOnMessage(sessionKey: string): boolean {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return false;

    const idleMs = Date.now() - entry.lastActiveAt;
    if (idleMs >= this.resetOnIdleMs) {
      entry.runner.close();
      this.sessions.delete(sessionKey);
      return true; // caller should notify user and create fresh session
    }
    entry.lastActiveAt = Date.now();
    return false;
  }
}
```

**Effort**: ~1.5 days

---

## Pattern #4: Bridge Protocol v0 Spec

**ClickUp**: https://app.clickup.com/t/86c9wxhyc
**Priority**: Normal — future architecture, spec only now

### cc-connect Reference

`core/bridge.go` (~1400 LOC) + `docs/bridge-protocol.md`.
WebSocket at `ws://host:port/bridge/ws`, token auth.

Key message types:
- **Adapter->Daemon**: `register`, `message`, `card_action`, `preview_ack`, `ping`
- **Daemon->Adapter**: `register_ack`, `reply`, `reply_stream`, `card`, `buttons`, `typing_start/stop`, `error`, `pong`
- **Capabilities**: `text, image, file, audio, card, buttons, typing, update_message, preview, delete_message`

### Our Differences

1. We use Agent SDK (not subprocess) — bridge wraps SDK events, not CLI stream-json
2. We're Node.js — single-threaded, event-driven
3. We want MCP integration — bridge adapters should be able to expose MCP tools

### Spec Outline

To be written as `docs/bridge-protocol-v0.md`. Key decisions:

1. **Wire format**: JSON over WebSocket
2. **Session key**: Reuse `buildSessionKey()` from Pattern #2
3. **Capability negotiation**: Start with `text, typing, buttons, update_message`
4. **Streaming**: `reply_stream` with `delta` + `done` flag
5. **Permission flow**: `permission_request` / `permission_response` envelopes

**Do NOT copy cc-connect's wire format verbatim** — their doc is "draft, subject to change".

**Effort**: ~1 day for spec document

---

## Pattern #5: `run_as_user` OS-Level Multi-Tenant Isolation

**ClickUp**: https://app.clickup.com/t/86c9wxhyg
**Priority**: Normal — needed for AgentOS-as-a-service, spec only now

### cc-connect Reference

`core/runas.go` — spawn via `sudo -n -iu <target> --preserve-env=LANG,LC_ALL,... -- claude ...`

Why `-i`: runs target user's full login shell, sets HOME. Claude sees target's `~/.claude/settings.json`.

Env allowlist: only `LANG, LC_ALL, LC_CTYPE, LC_MESSAGES, TERM`.

**Preflight** (`runas.go:200-222`, cached 30s per user):
1. `sudo -n -iu <user> -- /usr/bin/true` must SUCCEED (supervisor can sudo)
2. `sudo -n -iu <user> -- sudo -n /usr/bin/true` must FAIL (target cannot escalate)

**Startup checks** (`runas_check.go:82-140`):
1. Same sudo pair (fatal)
2. `test -r <workDir> -a -w <workDir>` as target (fatal)
3. `find <workDir>` accessibility scan (warnings, 10s timeout, max 50 paths)

### Our Adaptation for Node.js

Use `execFileSync` (NOT `exec`) for preflight checks to avoid shell injection:

```typescript
import { execFileSync, spawn } from 'child_process';

function verifyRunAsUser(targetUser: string): void {
  // Check 1: Can sudo to target
  execFileSync('sudo', ['-n', '-iu', targetUser, '--', '/usr/bin/true'],
    { timeout: 5000 });

  // Check 2: Target CANNOT sudo back (must fail)
  let canEscalate = false;
  try {
    execFileSync('sudo', ['-n', '-iu', targetUser, '--',
      'sudo', '-n', '/usr/bin/true'], { timeout: 5000 });
    canEscalate = true;
  } catch { /* expected — target is properly isolated */ }

  if (canEscalate) {
    throw new Error(`SECURITY: ${targetUser} can sudo back — refusing to spawn`);
  }
}
```

### Architecture Decision

**Recommended**: Option A — full process isolation. SessionManager runs as supervisor, spawns isolated Node.js worker processes per tenant via `sudo -n -iu`. Workers communicate via local WebSocket (Bridge Protocol from Pattern #4).

**Effort**: ~3 days for implementation (after spec finalized)

---

## Implementation Priority Order

| # | Pattern | Effort | Dependencies | Priority |
|---|---------|--------|--------------|----------|
| 2 | SessionKey scheme | 1 day | None | Do first |
| 3 | Idle reset + shutdown | 1.5 days | #2 (per-session) | Do second |
| 1 | Permission flow | 2 days | #2 (per-session) | Do third |
| 4 | Bridge protocol spec | 1 day | None | Parallel |
| 5 | run_as_user spec | 1 day | #4 (informs architecture) | Last |

Total estimated effort: ~6.5 days for all 5 patterns.

**Quick wins** (can ship independently):
- `buildSessionKey()` function in types.ts (~2 hours)
- 3-phase `close()` in session-runner.ts (~4 hours)
- Idle reset timer (~3 hours)
