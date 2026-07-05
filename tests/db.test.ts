import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb,
  saveMessage,
  getMessageByTelegramId,
  getUnansweredMessages,
  getUnansweredMessagesForUser,
  bumpReplayCount,
  REPLAY_MAX,
} from '../src/db.js';

// Fixture: a DB created by an OLD version of the schema — the base messages
// table only, no media_type/file_path/file_name/chat_type/chat_title and no
// replay_count. initDb() must open it and bring it up to date via the
// existence-guarded ALTERs, idempotently.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-mcp-db-test-'));
const dbPath = path.join(tmpDir, 'messages.db');
// TELEGRAM_MCP_DB_PATH is read at initDb() time, so setting it here (after the
// hoisted import of src/db.js already evaluated) still takes effect.
process.env.TELEGRAM_MCP_DB_PATH = dbPath;

const OLD_SCHEMA = `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_message_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    display_name TEXT,
    text TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
    reply_to_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const NEW_COLUMNS = ['media_type', 'file_path', 'file_name', 'chat_type', 'chat_title', 'replay_count'];

function messageColumns(): string[] {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const cols = probe.pragma('table_info(messages)') as { name: string }[];
    return cols.map((c) => c.name);
  } finally {
    probe.close();
  }
}

test('initDb: opens an old-schema DB and adds missing columns (guarded ALTERs)', () => {
  // Build the legacy fixture with one pre-existing row.
  const fixture = new Database(dbPath);
  fixture.prepare(OLD_SCHEMA).run();
  fixture.prepare(`
    INSERT INTO messages (telegram_message_id, chat_id, user_id, username, display_name, text, direction, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(9001, 1111, 1111, 'testuser', 'Test User', 'legacy hello', 'in', null);
  fixture.close();

  const before = messageColumns();
  for (const col of NEW_COLUMNS) {
    assert.ok(!before.includes(col), `fixture must not already have ${col}`);
  }

  initDb();

  const after = messageColumns();
  for (const col of NEW_COLUMNS) {
    assert.ok(after.includes(col), `initDb must add column ${col}`);
  }

  // The legacy row survived the migration untouched.
  const legacy = getMessageByTelegramId(9001, 1111);
  assert.ok(legacy, 'legacy row must still resolve');
  assert.equal(legacy!.text, 'legacy hello');
});

test('initDb: re-opening an already-migrated DB is a no-op (idempotent)', () => {
  const before = messageColumns();
  initDb(); // second open — guarded ALTERs must all skip
  const after = messageColumns();
  assert.deepEqual(after, before);
});

test('replay circuit breaker: unanswered rows surface until REPLAY_MAX bumps', () => {
  // The legacy IN row has no OUT reply after it → unanswered.
  const unanswered = getUnansweredMessages(24);
  const row = unanswered.find((m) => m.telegram_message_id === 9001);
  assert.ok(row, 'legacy IN row must be reported unanswered');

  // Per-user variant scopes by user_id.
  assert.ok(
    getUnansweredMessagesForUser(1111, 24).some((m) => m.telegram_message_id === 9001),
    'per-user query must include own row',
  );
  assert.equal(getUnansweredMessagesForUser(2222, 24).length, 0, 'other user sees nothing');

  // Bump replay_count REPLAY_MAX times → circuit breaker excludes the row.
  for (let i = 0; i < REPLAY_MAX; i++) bumpReplayCount(row!.id!);
  assert.ok(
    !getUnansweredMessages(24).some((m) => m.telegram_message_id === 9001),
    'row must drop out after REPLAY_MAX replays',
  );
  assert.equal(getUnansweredMessagesForUser(1111, 24).length, 0);
});

test('unanswered: an OUT reply after the IN row answers it', () => {
  saveMessage({
    telegram_message_id: 9002,
    chat_id: 3333,
    chat_type: 'private',
    chat_title: null,
    user_id: 3333,
    username: 'other',
    display_name: 'Other User',
    text: 'ping',
    direction: 'in',
    reply_to_message_id: null,
    media_type: null,
    file_path: null,
    file_name: null,
  });
  // Backdate the IN row: created_at is second-resolution and the answered
  // check uses a strict `>` comparison, so same-second IN/OUT would not count.
  const probe = new Database(dbPath);
  probe.prepare(`UPDATE messages SET created_at = datetime('now', '-60 seconds') WHERE telegram_message_id = 9002`).run();
  probe.close();

  assert.ok(getUnansweredMessagesForUser(3333, 24).length === 1);

  saveMessage({
    telegram_message_id: 9003,
    chat_id: 3333,
    chat_type: 'private',
    chat_title: null,
    user_id: null,
    username: null,
    display_name: 'Bot',
    text: 'pong',
    direction: 'out',
    reply_to_message_id: 9002,
    media_type: null,
    file_path: null,
    file_name: null,
  });
  assert.equal(getUnansweredMessagesForUser(3333, 24).length, 0, 'OUT reply answers the row');
});
