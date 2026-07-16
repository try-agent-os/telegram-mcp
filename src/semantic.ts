// Semantic message search — local embeddings + hybrid (vector + FTS5) retrieval.
//
// Why: the plain FTS5 tool (telegram_search_messages) needs exact word matches.
// Voice-note transcripts have ASR errors and people paraphrase, so recall on
// "meaning" queries is poor. This module adds a vector index over message text
// using a LOCAL embedding model (onnx-community/embeddinggemma-300m-ONNX, the
// same model the hub's MemPalace runs) — nothing leaves the machine, zero API
// cost.
//
// Storage: a SEPARATE sqlite file (semantic.db by default, next to messages.db)
// holding a sqlite-vec vec0 virtual table keyed by messages.id. Keeping it out
// of messages.db means every existing consumer of the prod DB keeps working
// without loading the sqlite-vec extension.
//
// Retrieval: hybrid by default — KNN over embeddings + BM25 over the existing
// messages_fts table (attached), fused with Reciprocal Rank Fusion, optional
// date-range filters and a mild recency boost. Pure-vector and pure-fts modes
// are available for debugging.
//
// Indexing: incremental and idempotent — "indexed" == rowid present in
// message_vec, so the sweep is simply "embed every message not yet in the vec
// table". startBackgroundIndexer() runs that sweep at startup (catch-up after
// downtime) and then periodically; a one-off backfill entry point lives in
// semantic-backfill.ts.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import type { TelegramMessage } from './types.js';

const EMBED_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const DIMS = 768;
// EmbeddingGemma prescribed prompt prefixes (asymmetric retrieval).
const QUERY_PREFIX = 'task: search result | query: ';
const DOC_PREFIX = 'title: none | text: ';
// Truncate long documents before embedding (~500-700 tokens worth of chars).
const DOC_MAX_CHARS = 2000;
const RRF_K = 60;

function resolveSemanticDbPath(): string {
  const fromEnv = process.env.TELEGRAM_MCP_SEMANTIC_DB_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const msgDb = process.env.TELEGRAM_MCP_DB_PATH;
  const dir = msgDb && msgDb.trim().length > 0 ? path.dirname(msgDb) : process.cwd();
  return path.join(dir, 'semantic.db');
}

function resolveMessagesDbPath(): string {
  const fromEnv = process.env.TELEGRAM_MCP_DB_PATH;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv : path.join(process.cwd(), 'messages.db');
}

function resolveHfCacheDir(): string {
  const fromEnv = process.env.TELEGRAM_MCP_HF_CACHE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(path.dirname(resolveSemanticDbPath()), 'hf-cache');
}

let sdb: Database.Database | null = null;

export function initSemantic(): Database.Database {
  if (sdb) return sdb;
  const db = new Database(resolveSemanticDbPath());
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_vec USING vec0(
      embedding FLOAT[${DIMS}]
    );
  `);
  // Attach the prod messages DB read-mostly for joins (messages + messages_fts).
  const msgPath = resolveMessagesDbPath().replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${msgPath}' AS msgs`);
  sdb = db;
  return db;
}

// --- Embedder (lazy singleton) ----------------------------------------------

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;
let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      (env as { cacheDir: string }).cacheDir = resolveHfCacheDir();
      const extractor = await pipeline('feature-extraction', EMBED_MODEL, {
        dtype: 'q8',
        device: 'cpu',
        // Cap ORT threads — uncapped onnxruntime oversubscribes cores and
        // throughput collapses (observed on the hub with MemPalace).
        session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
      } as Record<string, unknown>);
      console.log('[semantic] embedding model loaded');
      return extractor as unknown as Extractor;
    })();
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

async function embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]> {
  const extractor = await getExtractor();
  const prefix = kind === 'query' ? QUERY_PREFIX : DOC_PREFIX;
  const prepared = texts.map(t => prefix + t.slice(0, DOC_MAX_CHARS));
  const out = await extractor(prepared, { pooling: 'mean', normalize: true });
  return out.tolist();
}

function toBuffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// --- Incremental indexing ----------------------------------------------------

export function countIndexState(): { indexed: number; pending: number } {
  const db = initSemantic();
  const indexed = (db.prepare('SELECT COUNT(*) c FROM message_vec').get() as { c: number }).c;
  const pending = (db.prepare(`
    SELECT COUNT(*) c FROM msgs.messages m
    WHERE LENGTH(COALESCE(m.text, '')) >= 3
      AND m.id NOT IN (SELECT rowid FROM message_vec)
  `).get() as { c: number }).c;
  return { indexed, pending };
}

// Embed and index up to maxRows not-yet-indexed messages. Returns rows indexed.
export async function indexPending(maxRows = 512, batchSize = 16): Promise<number> {
  const db = initSemantic();
  const rows = db.prepare(`
    SELECT m.id, m.text FROM msgs.messages m
    WHERE LENGTH(COALESCE(m.text, '')) >= 3
      AND m.id NOT IN (SELECT rowid FROM message_vec)
    ORDER BY m.id
    LIMIT ?
  `).all(maxRows) as { id: number; text: string }[];
  if (rows.length === 0) return 0;

  const insert = db.prepare('INSERT INTO message_vec(rowid, embedding) VALUES (?, ?)');
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await embed(batch.map(r => r.text), 'document');
    for (let j = 0; j < batch.length; j++) {
      try {
        // BigInt rowid: sqlite-vec rejects a JS number bind (arrives as
        // float64) with "Only integers are allowed for primary key values".
        insert.run(BigInt(batch[j].id), toBuffer(vecs[j]));
        done++;
      } catch (err) {
        // Duplicate rowid (concurrent indexer) — safe to ignore.
        if (!/UNIQUE constraint failed/i.test((err as Error).message)) throw err;
      }
    }
  }
  return done;
}

let indexerTimer: ReturnType<typeof setInterval> | null = null;
let indexerBusy = false;

// Catch-up sweep at startup + periodic incremental indexing. Non-fatal on
// error (logs and retries next tick). The embedding model is only loaded when
// there is actually something to index (or on first search).
export function startBackgroundIndexer(intervalMs = 60_000, initialDelayMs = 20_000): void {
  const tick = async () => {
    if (indexerBusy) return;
    indexerBusy = true;
    try {
      let total = 0;
      // Loop until drained so a post-downtime backlog clears in one sweep.
      for (;;) {
        const n = await indexPending(512);
        total += n;
        if (n < 512) break;
      }
      if (total > 0) console.log(`[semantic] indexed ${total} new message(s)`);
    } catch (err) {
      console.error(`[semantic] index sweep failed: ${(err as Error).message}`);
    } finally {
      indexerBusy = false;
    }
  };
  setTimeout(tick, initialDelayMs);
  if (!indexerTimer) indexerTimer = setInterval(tick, intervalMs);
}

// --- Hybrid search -----------------------------------------------------------

export interface SemanticSearchOptions {
  query: string;
  chat_id?: number;
  direction?: 'in' | 'out';
  limit?: number;
  days?: number;          // last N days shortcut
  date_from?: string;     // 'YYYY-MM-DD' or ISO datetime (UTC)
  date_to?: string;       // 'YYYY-MM-DD' or ISO datetime (UTC)
  mode?: 'hybrid' | 'semantic' | 'fts';
  recency_boost?: boolean; // default true — mild boost for fresher messages
}

export interface SemanticSearchResult extends TelegramMessage {
  score: number;
  matched_by: string[];
}

// created_at in messages is 'YYYY-MM-DD HH:MM:SS' UTC. Normalize incoming
// bounds to the same comparable format.
function normalizeDate(d: string, endOfDay: boolean): string {
  const trimmed = d.trim().replace('T', ' ').replace(/Z$/, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return endOfDay ? `${trimmed} 23:59:59` : `${trimmed} 00:00:00`;
  }
  return trimmed;
}

function buildFilters(opts: SemanticSearchOptions, alias: string): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.chat_id != null) { clauses.push(`${alias}.chat_id = ?`); params.push(opts.chat_id); }
  if (opts.direction) { clauses.push(`${alias}.direction = ?`); params.push(opts.direction); }
  if (opts.days != null && opts.days > 0) {
    clauses.push(`${alias}.created_at >= datetime('now', '-' || ? || ' days')`);
    params.push(Math.floor(opts.days));
  }
  if (opts.date_from) { clauses.push(`${alias}.created_at >= ?`); params.push(normalizeDate(opts.date_from, false)); }
  if (opts.date_to) { clauses.push(`${alias}.created_at <= ?`); params.push(normalizeDate(opts.date_to, true)); }
  return { sql: clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '', params };
}

// FTS5 MATCH syntax chokes on raw user text (quotes, hyphens, cyrillic + ":").
// Quote every token and OR them so partial term overlap still ranks.
function ftsQueryFromText(q: string): string {
  const tokens = q.split(/\s+/).map(t => t.replace(/["']/g, '')).filter(t => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t}"`).join(' OR ');
}

export async function semanticSearchMessages(opts: SemanticSearchOptions): Promise<{
  results: SemanticSearchResult[];
  indexed: number;
  pending: number;
  mode: string;
}> {
  const db = initSemantic();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const mode = opts.mode ?? 'hybrid';
  const recencyBoost = opts.recency_boost !== false;
  // Overfetch per arm so post-KNN filters (dates/chat) don't starve results.
  const candidates = Math.max(200, limit * 20);

  type Arm = { id: number; rank: number }[];
  const arms: Record<string, Arm> = {};
  const rowById = new Map<number, TelegramMessage>();

  if (mode !== 'fts') {
    const [qvec] = await embed([opts.query], 'query');
    const filters = buildFilters(opts, 'm');
    const rows = db.prepare(`
      WITH knn AS (
        SELECT rowid AS id, distance FROM message_vec
        WHERE embedding MATCH ? AND k = ?
      )
      SELECT m.*, knn.distance FROM knn
      JOIN msgs.messages m ON m.id = knn.id
      WHERE 1=1 ${filters.sql}
      ORDER BY knn.distance
      LIMIT ?
    `).all(toBuffer(qvec), candidates, ...filters.params, candidates) as (TelegramMessage & { distance: number })[];
    arms.semantic = rows.map((r, i) => { rowById.set(r.id!, r); return { id: r.id!, rank: i }; });
  }

  if (mode !== 'semantic') {
    const filters = buildFilters(opts, 'm');
    try {
      const rows = db.prepare(`
        SELECT m.*, f.rank AS fts_rank FROM msgs.messages_fts f
        JOIN msgs.messages m ON m.id = f.rowid
        WHERE messages_fts MATCH ? ${filters.sql}
        ORDER BY f.rank
        LIMIT ?
      `).all(ftsQueryFromText(opts.query), ...filters.params, candidates) as (TelegramMessage & { fts_rank: number })[];
      arms.fts = rows.map((r, i) => { rowById.set(r.id!, r); return { id: r.id!, rank: i }; });
    } catch (err) {
      // A pathological FTS query must not kill the semantic arm.
      console.error(`[semantic] fts arm failed: ${(err as Error).message}`);
      arms.fts = [];
    }
  }

  // Reciprocal Rank Fusion across arms.
  const fused = new Map<number, { score: number; matched: string[] }>();
  for (const [name, arm] of Object.entries(arms)) {
    for (const { id, rank } of arm) {
      const entry = fused.get(id) ?? { score: 0, matched: [] };
      entry.score += 1 / (RRF_K + rank);
      entry.matched.push(name);
      fused.set(id, entry);
    }
  }

  const nowMs = Date.now();
  const results: SemanticSearchResult[] = [];
  for (const [id, { score, matched }] of fused) {
    const row = rowById.get(id);
    if (!row) continue;
    let final = score;
    if (recencyBoost && row.created_at) {
      const ageDays = Math.max(0, (nowMs - Date.parse(row.created_at + 'Z')) / 86_400_000);
      final *= 1 + 0.3 * Math.exp(-ageDays / 30);
    }
    results.push({ ...row, score: Number(final.toFixed(6)), matched_by: matched });
  }
  results.sort((a, b) => b.score - a.score);

  const state = countIndexState();
  return { results: results.slice(0, limit), ...state, mode };
}
