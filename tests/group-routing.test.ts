import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideGroupEngagement,
  BotExchangeTracker,
  parseCoordinationChats,
  isPrimaryHostEnv,
  MAX_BOT_EXCHANGE_DEPTH,
  type RoutingInput,
} from '../src/group-routing.ts';

// Defaults for a human message with no mention on the PRIMARY host.
function input(over: Partial<RoutingInput>): RoutingInput {
  return {
    isFromBot: false,
    addressesThisBot: false,
    hasAnyMention: false,
    isPrimaryHost: true,
    botExchangeDepth: 0,
    primaryHostOnline: true,
    ...over,
  };
}

// ── env parsing ────────────────────────────────────────────────────────────
test('parseCoordinationChats parses comma-separated ids', () => {
  const s = parseCoordinationChats(' -1000000001 , 123 ');
  assert.ok(s.has(-1000000001));
  assert.ok(s.has(123));
  assert.equal(s.size, 2);
});

test('parseCoordinationChats handles empty/undefined', () => {
  assert.equal(parseCoordinationChats(undefined).size, 0);
  assert.equal(parseCoordinationChats('').size, 0);
});

test('isPrimaryHostEnv truthy variants', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(isPrimaryHostEnv(v), true, v);
  for (const v of ['0', 'false', '', undefined, 'no']) assert.equal(isPrimaryHostEnv(v), false, String(v));
});

// ── Criterion 1: human, no mention → exactly ONE bot (the primary) engages ───
test('criterion 1: human no-mention → primary engages, backup defers', () => {
  const primary = decideGroupEngagement(input({ isPrimaryHost: true }));
  assert.equal(primary.engage, true);
  assert.equal(primary.reason, 'primary-host-default');

  const backup = decideGroupEngagement(input({ isPrimaryHost: false, primaryHostOnline: true }));
  assert.equal(backup.engage, false);
  assert.equal(backup.deferBackup, true);
  assert.equal(backup.reason, 'backup-host-defer');
  // Exactly one engages.
  assert.equal(Number(primary.engage) + Number(backup.engage), 1);
});

// ── Criterion 2: @mention of the OTHER bot → addressee engages, other silent ─
test('criterion 2: mention routes only to the addressee', () => {
  // From the addressed bot's perspective (the backup): it is addressed.
  const addressee = decideGroupEngagement(input({ addressesThisBot: true, hasAnyMention: true }));
  assert.equal(addressee.engage, true);
  assert.equal(addressee.reason, 'mentioned');

  // From the non-addressed bot's perspective (the primary): a mention exists but not for us.
  const other = decideGroupEngagement(input({ addressesThisBot: false, hasAnyMention: true, isPrimaryHost: true }));
  assert.equal(other.engage, false);
  assert.equal(other.reason, 'mention-other');
});

// ── Criterion 3: cross-agent (bot→bot) @mention → only the addressee ─────────
test('criterion 3: bot→bot mention engages addressee only', () => {
  // Bot B receives "bot A @ bot B ..." → engage (cross-agent, directed, depth 1).
  const picked = decideGroupEngagement(
    input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: 1 }),
  );
  assert.equal(picked.engage, true);
  assert.equal(picked.crossAgent, true);
  assert.equal(picked.reason, 'cross-agent-mention');

  // A non-addressed bot seeing that same message stays silent.
  const bystander = decideGroupEngagement(
    input({ isFromBot: true, addressesThisBot: false, hasAnyMention: true, botExchangeDepth: 1 }),
  );
  assert.equal(bystander.engage, false);
  assert.equal(bystander.reason, 'mention-other');

  // Un-addressed bot chatter (no mention) is always ignored — the loop breaker.
  const chatter = decideGroupEngagement(input({ isFromBot: true, botExchangeDepth: 1 }));
  assert.equal(chatter.engage, false);
  assert.equal(chatter.reason, 'bot-no-mention');
});

// ── Criterion 4 / Rule 5: anti-loop depth guard ─────────────────────────────
test('criterion 4: bot↔bot depth > MAX → skip with depthExceeded', () => {
  // depth 1..3 still engage when directed at us.
  for (let d = 1; d <= MAX_BOT_EXCHANGE_DEPTH; d++) {
    const v = decideGroupEngagement(
      input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: d }),
    );
    assert.equal(v.engage, true, `depth ${d} should engage`);
    assert.equal(v.depthExceeded, false);
  }
  // depth 4 → guard trips even though it is directed at us.
  const tripped = decideGroupEngagement(
    input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: 4 }),
  );
  assert.equal(tripped.engage, false);
  assert.equal(tripped.depthExceeded, true);
});

// ── Criterion 5: primary offline → backup takes over the no-mention default ──
test('criterion 5: backup engages when primary offline', () => {
  const v = decideGroupEngagement(input({ isPrimaryHost: false, primaryHostOnline: false }));
  assert.equal(v.engage, true);
  assert.equal(v.reason, 'backup-failover-primary-offline');
});

// ── BotExchangeTracker: reply-chain depth across alternating hosts ───────────
test('tracker: human resets, bot chain increments along replies', () => {
  const t = new BotExchangeTracker();
  const chat = -1000000001;
  // Human seed message H (id 100).
  assert.equal(t.observe(chat, 100, null, false), 0);
  // m1 botA@botB replies to H → depth 1.
  assert.equal(t.observe(chat, 101, 100, true), 1);
  // m2 botB@botA replies to m1 → depth 2.
  assert.equal(t.observe(chat, 102, 101, true), 2);
  // m3 botA@botB replies to m2 → depth 3.
  assert.equal(t.observe(chat, 103, 102, true), 3);
  // m4 botB@botA replies to m3 → depth 4 (would exceed guard).
  assert.equal(t.observe(chat, 104, 103, true), 4);

  // A fresh human message resets the chain.
  assert.equal(t.observe(chat, 105, null, false), 0);
  assert.equal(t.observe(chat, 106, 105, true), 1);
});

test('tracker: end-to-end depth-4 loop trips the guard exactly once', () => {
  // Simulate the cross-host chain. Each host records its OWN outgoing sends
  // (observeOutgoing) and the OTHER bot's incoming messages (observe).
  const botA = new BotExchangeTracker();
  const botB = new BotExchangeTracker();
  const chat = -1000000001;

  // Human seeds the conversation (both observe it).
  botA.observe(chat, 1, null, false);
  botB.observe(chat, 1, null, false);

  // m1: botA@botB (botA sends, replying to human msg 1).
  const d1 = botA.observeOutgoing(chat, 2, 1);
  assert.equal(d1, 1);
  // botB receives m1.
  const bSeesM1 = botB.observe(chat, 2, 1, true);
  const v1 = decideGroupEngagement(input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: bSeesM1 }));
  assert.equal(v1.engage, true);

  // m2: botB@botA (botB sends, replying to m1).
  botB.observeOutgoing(chat, 3, 2);
  const aSeesM2 = botA.observe(chat, 3, 2, true);
  const v2 = decideGroupEngagement(input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: aSeesM2 }));
  assert.equal(aSeesM2, 2);
  assert.equal(v2.engage, true);

  // m3: botA@botB (replying to m2).
  botA.observeOutgoing(chat, 4, 3);
  const bSeesM3 = botB.observe(chat, 4, 3, true);
  const v3 = decideGroupEngagement(input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: bSeesM3 }));
  assert.equal(bSeesM3, 3);
  assert.equal(v3.engage, true);

  // m4: botB@botA (replying to m3).
  botB.observeOutgoing(chat, 5, 4);
  const aSeesM4 = botA.observe(chat, 5, 4, true);
  const v4 = decideGroupEngagement(input({ isFromBot: true, addressesThisBot: true, hasAnyMention: true, botExchangeDepth: aSeesM4 }));
  assert.equal(aSeesM4, 4);
  assert.equal(v4.engage, false);
  assert.equal(v4.depthExceeded, true); // one bot skips with "depth exceeded"
});

test('tracker: per-chat cap evicts oldest entries', () => {
  const t = new BotExchangeTracker(3);
  const chat = 1;
  t.observe(chat, 10, null, false);
  t.observe(chat, 11, null, false);
  t.observe(chat, 12, null, false);
  t.observe(chat, 13, null, false); // evicts id 10
  // id 10 gone → a bot reply to it can't read a parent depth, starts at 1.
  assert.equal(t.observe(chat, 14, 10, true), 1);
});
