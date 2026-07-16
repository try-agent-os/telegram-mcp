# Semantic message search (`telegram_semantic_search`)

Meaning-based search over the full Telegram message history, hybrid with the
existing FTS5 full-text index. Built for queries where exact words are unknown
or garbled by voice-note ASR ("когда перечислял долги", "что решали про домены").

## Architecture

- **Embedding model:** `onnx-community/embeddinggemma-300m-ONNX` (q8, 768 dims,
  multilingual incl. ru/en cross-lingual) via `@huggingface/transformers`
  (transformers.js, onnxruntime-node, CPU). Fully local — message text never
  leaves the machine, zero API cost. Same model the hub's MemPalace runs.
- **Vector store:** `sqlite-vec` (vec0 virtual table) in a **separate**
  `semantic.db` next to `messages.db` (rowid = `messages.id`). The prod DB is
  untouched, so consumers that don't load the extension keep working.
- **Retrieval:** hybrid by default — KNN over embeddings + BM25 over the
  existing `messages_fts` table (ATTACHed), fused with Reciprocal Rank Fusion
  (k=60), optional date filters (`days` / `date_from` / `date_to`), mild
  recency boost (`* (1 + 0.3*exp(-age_days/30))`, disable with
  `recency_boost:false`). `mode: semantic|fts` for single-arm debugging.
- **Indexing:** incremental + idempotent. "Indexed" == rowid present in
  `message_vec`, so the sweep is "embed everything not in the vec table".
  The service runs a background sweep at startup (catch-up after downtime)
  and every 60s. One-off backfill: `node dist/semantic-backfill.js`.

## Env

| Var | Default | Meaning |
|-----|---------|---------|
| `TELEGRAM_MCP_SEMANTIC_DB_PATH` | `<dir of messages.db>/semantic.db` | vector index location |
| `TELEGRAM_MCP_HF_CACHE` | `<dir of semantic.db>/hf-cache` | model cache (~350 MB, lazy download on first run) |

## Tool

```
telegram_semantic_search({
  query: "список моих долгов и что поставить на паузу",
  days: 30,               // optional; or date_from/date_to (YYYY-MM-DD, UTC)
  chat_id: 123510069,     // optional
  direction: "in",        // optional
  limit: 10,
  mode: "hybrid",         // default
})
```

Returns `results[]` with full message metadata (chat_id, created_at, direction,
display_name, text, media_type), fused `score`, `matched_by` (which arms hit),
plus `indexed`/`pending` index-state counters.

## Notes / limits

- Only messages with `length(text) >= 3` are indexed (media without captions
  are not searchable semantically).
- Documents are truncated to 2000 chars before embedding.
- ORT threads capped at 4 (uncapped onnxruntime oversubscribes cores and
  throughput collapses ~5x — observed with MemPalace on the hub).
- The model (~400 MB RSS) is lazy-loaded on first search or first pending
  index sweep, then kept in memory by the service.
