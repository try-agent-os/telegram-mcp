import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { TelegramMessage, ChatInfo, MediaType, UserRecord, AccessPolicy } from './types.js';

const DB_PATH = path.join(process.cwd(), 'messages.db');
const ACCESS_JSON_PATH = path.join(process.cwd(), 'access.json');
const DEFAULT_TIMEZONE = 'Europe/Lisbon';

let db: Database.Database;

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
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
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content=messages,
      content_rowid=id,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;

    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('allowed', 'pending', 'denied')),
      timezone TEXT DEFAULT '${DEFAULT_TIMEZONE}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrate: add media columns if not present
  const cols = db.pragma('table_info(messages)') as { name: string }[];
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('media_type')) {
    db.exec(`ALTER TABLE messages ADD COLUMN media_type TEXT`);
  }
  if (!colNames.includes('file_path')) {
    db.exec(`ALTER TABLE messages ADD COLUMN file_path TEXT`);
  }
  if (!colNames.includes('file_name')) {
    db.exec(`ALTER TABLE messages ADD COLUMN file_name TEXT`);
  }
  // Group/supergroup support — track chat type so the channel-push consumer can
  // distinguish private DMs from group/supergroup conversations and surface
  // chat title in the agent UI.
  if (!colNames.includes('chat_type')) {
    db.exec(`ALTER TABLE messages ADD COLUMN chat_type TEXT`);
  }
  if (!colNames.includes('chat_title')) {
    db.exec(`ALTER TABLE messages ADD COLUMN chat_title TEXT`);
  }

  // Insert default settings if missing
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('default_policy', 'pending')`).run();

  // Migrate from access.json if it exists and users table is empty
  migrateFromAccessJson();
}

function migrateFromAccessJson(): void {
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount > 0) return;
  if (!fs.existsSync(ACCESS_JSON_PATH)) return;

  try {
    const policy: AccessPolicy = JSON.parse(fs.readFileSync(ACCESS_JSON_PATH, 'utf-8'));
    const insert = db.prepare('INSERT OR IGNORE INTO users (user_id, status, timezone) VALUES (?, ?, ?)');

    const tx = db.transaction(() => {
      for (const uid of policy.allowlist ?? []) {
        const tz = policy.timezones?.[String(uid)] ?? DEFAULT_TIMEZONE;
        insert.run(uid, 'allowed', tz);
      }
      for (const uid of policy.pending ?? []) {
        insert.run(uid, 'pending', DEFAULT_TIMEZONE);
      }
      for (const uid of policy.denied ?? []) {
        insert.run(uid, 'denied', DEFAULT_TIMEZONE);
      }
      if (policy.default_policy) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(policy.default_policy, 'default_policy');
      }
    });
    tx();

    // Rename old file
    fs.renameSync(ACCESS_JSON_PATH, ACCESS_JSON_PATH + '.migrated');
    console.log('[db] Migrated access.json → SQLite users table');
  } catch (err) {
    console.error('[db] Failed to migrate access.json:', err);
  }
}

// --- Messages ---

export function saveMessage(msg: Omit<TelegramMessage, 'id' | 'created_at'>): TelegramMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (telegram_message_id, chat_id, chat_type, chat_title, user_id, username, display_name, text, direction, reply_to_message_id, media_type, file_path, file_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.telegram_message_id, msg.chat_id,
    msg.chat_type ?? null, msg.chat_title ?? null,
    msg.user_id,
    msg.username, msg.display_name, msg.text,
    msg.direction, msg.reply_to_message_id,
    msg.media_type ?? null, msg.file_path ?? null, msg.file_name ?? null
  );
  return { ...msg, id: result.lastInsertRowid as number, created_at: new Date().toISOString() };
}

export function searchMessages(query: string, chatId?: number, direction?: 'in' | 'out', limit = 20, days?: number): { messages: TelegramMessage[]; total: number } {
  let sql = `
    SELECT m.* FROM messages m
    JOIN messages_fts fts ON m.id = fts.rowid
    WHERE messages_fts MATCH ?
  `;
  const params: (string | number)[] = [query];

  if (chatId) {
    sql += ' AND m.chat_id = ?';
    params.push(chatId);
  }
  if (direction) {
    sql += ' AND m.direction = ?';
    params.push(direction);
  }
  if (days) {
    sql += ` AND m.created_at >= datetime('now', '-${days} days')`;
  }

  const countSql = sql.replace('SELECT m.*', 'SELECT COUNT(*) as cnt');
  const total = (db.prepare(countSql).get(...params) as { cnt: number }).cnt;

  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);

  const messages = db.prepare(sql).all(...params) as TelegramMessage[];
  return { messages, total };
}

export function getRecent(chatId: number, limit = 20): TelegramMessage[] {
  return db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(chatId, limit) as TelegramMessage[];
}

export function listChats(): ChatInfo[] {
  return db.prepare(`
    SELECT
      m.chat_id,
      MAX(m.username) as username,
      MAX(m.display_name) as display_name,
      MAX(m.created_at) as last_message_at,
      COUNT(*) as message_count,
      COALESCE(u.status, 'unknown') as access_status
    FROM messages m
    LEFT JOIN users u ON m.chat_id = u.user_id
    GROUP BY m.chat_id
    ORDER BY last_message_at DESC
  `).all() as ChatInfo[];
}

export function getLastIncomingMessageId(chatId: number): number | null {
  const row = db.prepare(
    "SELECT telegram_message_id FROM messages WHERE chat_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1"
  ).get(chatId) as { telegram_message_id: number } | undefined;
  return row?.telegram_message_id ?? null;
}

// --- Users ---

export function getUser(userId: number): UserRecord | null {
  return (db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRecord) ?? null;
}

export function upsertUser(userId: number, fields: Partial<Pick<UserRecord, 'username' | 'display_name' | 'status' | 'timezone'>>): void {
  const existing = getUser(userId);
  if (existing) {
    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const vals: (string | number | null)[] = [];
    if (fields.username !== undefined) { sets.push('username = ?'); vals.push(fields.username ?? null); }
    if (fields.display_name !== undefined) { sets.push('display_name = ?'); vals.push(fields.display_name ?? null); }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status); }
    if (fields.timezone !== undefined) { sets.push('timezone = ?'); vals.push(fields.timezone); }
    if (vals.length > 0) {
      vals.push(userId);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
    }
  } else {
    db.prepare(`
      INSERT INTO users (user_id, username, display_name, status, timezone)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      fields.username ?? null,
      fields.display_name ?? null,
      fields.status ?? getDefaultPolicy(),
      fields.timezone ?? DEFAULT_TIMEZONE,
    );
  }
}

export function listUsers(status?: string): UserRecord[] {
  if (status) {
    return db.prepare('SELECT * FROM users WHERE status = ? ORDER BY updated_at DESC').all(status) as UserRecord[];
  }
  return db.prepare('SELECT * FROM users ORDER BY updated_at DESC').all() as UserRecord[];
}

// Seed admin user IDs as 'allowed'. Idempotent — existing rows get upgraded
// from 'pending'/'denied' to 'allowed'. Called once at startup from env
// (TELEGRAM_ADMIN_USER_IDS, comma-separated) so a fresh install grants the
// wizard-detected admins access without a manual `/approve` round-trip.
export function seedAdmins(userIds: number[], usernames: string[] = []): void {
  if (userIds.length === 0) return;
  const tx = db.transaction(() => {
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const uname = usernames[i] ?? null;
      const existing = getUser(uid);
      if (existing) {
        if (existing.status !== 'allowed') {
          db.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
            .run('allowed', uid);
        }
        if (uname && existing.username !== uname) {
          db.prepare('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
            .run(uname, uid);
        }
      } else {
        db.prepare(`
          INSERT INTO users (user_id, username, display_name, status, timezone)
          VALUES (?, ?, ?, ?, ?)
        `).run(uid, uname, null, 'allowed', DEFAULT_TIMEZONE);
      }
    }
  });
  tx();
}

// --- Settings ---

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getDefaultPolicy(): string {
  return getSetting('default_policy') ?? 'pending';
}
