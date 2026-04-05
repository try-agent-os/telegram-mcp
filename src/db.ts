import Database from 'better-sqlite3';
import path from 'path';
import type { TelegramMessage, ChatInfo } from './types.js';

const DB_PATH = path.join(process.cwd(), 'messages.db');

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
  `);
}

export function saveMessage(msg: Omit<TelegramMessage, 'id' | 'created_at'>): TelegramMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (telegram_message_id, chat_id, user_id, username, display_name, text, direction, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.telegram_message_id, msg.chat_id, msg.user_id,
    msg.username, msg.display_name, msg.text,
    msg.direction, msg.reply_to_message_id
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
      chat_id,
      MAX(username) as username,
      MAX(display_name) as display_name,
      MAX(created_at) as last_message_at,
      COUNT(*) as message_count
    FROM messages
    GROUP BY chat_id
    ORDER BY last_message_at DESC
  `).all() as ChatInfo[];
}

export function getLastIncomingMessageId(chatId: number): number | null {
  const row = db.prepare(
    "SELECT telegram_message_id FROM messages WHERE chat_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1"
  ).get(chatId) as { telegram_message_id: number } | undefined;
  return row?.telegram_message_id ?? null;
}
