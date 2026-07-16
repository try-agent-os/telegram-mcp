// One-off backfill: embed every not-yet-indexed message into semantic.db.
// Run: TELEGRAM_MCP_DB_PATH=... node dist/semantic-backfill.js
// Safe to run while the service is up (WAL + duplicate-rowid tolerance), but
// cleanest before first deploy of the semantic search feature.
import { initSemantic, indexPending, countIndexState } from './semantic.js';

async function main() {
  initSemantic();
  const start = countIndexState();
  console.log(`[backfill] indexed=${start.indexed} pending=${start.pending}`);
  const t0 = Date.now();
  let total = 0;
  for (;;) {
    const n = await indexPending(256, 16, (process.env.BACKFILL_ORDER === 'desc' ? 'desc' : 'asc'));
    if (n === 0) break;
    total += n;
    const rate = total / ((Date.now() - t0) / 1000);
    console.log(`[backfill] +${n} (total ${total}, ${rate.toFixed(1)}/s)`);
  }
  const end = countIndexState();
  console.log(`[backfill] done in ${((Date.now() - t0) / 1000).toFixed(0)}s: indexed=${end.indexed} pending=${end.pending}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
