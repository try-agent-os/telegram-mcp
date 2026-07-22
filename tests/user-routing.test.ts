import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry, normalizeUserId, parseBindUserId } from '../src/user-routing.ts';

// The push loops iterate activeSessions.keys(); the registry decides which of
// those ids actually receive a given message. These tests drive routeTargets()
// exactly the way index.ts does.

// ── normalizeUserId / parseBindUserId ───────────────────────────────────────
test('normalizeUserId: coerces to non-empty string, rejects empty/zero', () => {
  assert.equal(normalizeUserId(1000001), '1000001');
  assert.equal(normalizeUserId('1000001'), '1000001');
  assert.equal(normalizeUserId('  42 '), '42');
  assert.equal(normalizeUserId(null), '');
  assert.equal(normalizeUserId(undefined), '');
  assert.equal(normalizeUserId(''), '');
  assert.equal(normalizeUserId('0'), '');
  assert.equal(normalizeUserId(0), '');
});

test('parseBindUserId: handles express query shapes', () => {
  assert.equal(parseBindUserId('555'), '555');
  assert.equal(parseBindUserId(['555', '999']), '555'); // array → first
  assert.equal(parseBindUserId(undefined), '');
  assert.equal(parseBindUserId(''), '');
  assert.equal(parseBindUserId(42 as unknown), ''); // non-string scalar ignored
});

// ── (a) BACKWARD COMPAT: no binding → broadcast to ALL (single-operator) ────
test('single-operator safe: zero bindings → every message broadcasts to all sessions', () => {
  const reg = new SessionRegistry();
  // The classic deployment: a single unbound operator session.
  reg.connect('op');
  const all = ['op'];
  assert.deepEqual(reg.routeTargets(all, '1000001'), ['op']);
  assert.deepEqual(reg.routeTargets(all, null), ['op']);
  assert.deepEqual(reg.routeTargets(all, '999', /*admin*/ true), ['op']);
  assert.equal(reg.hasAnyBinding(), false);

  // Even with multiple unbound sessions and no bindings, behavior is the old
  // broadcast: every session gets every message.
  const reg2 = new SessionRegistry();
  reg2.connect('a');
  reg2.connect('b');
  assert.deepEqual(reg2.routeTargets(['a', 'b'], '777').sort(), ['a', 'b']);
});

// ── (b) ISOLATION: two bound users each receive only their own messages ──────
test('isolation: bound sessions receive only their own user_id traffic', () => {
  const reg = new SessionRegistry();
  reg.connect('admin');            // unbound owner/oversight session
  reg.connect('s-alice', '111');   // Alice's session
  reg.connect('s-bob', '222');     // Bob's session
  const all = ['admin', 's-alice', 's-bob'];

  // Alice's message → only Alice's session.
  assert.deepEqual(reg.routeTargets(all, '111'), ['s-alice']);
  // Bob's message → only Bob's session.
  assert.deepEqual(reg.routeTargets(all, '222'), ['s-bob']);
  // Crucially: Alice's session never sees Bob's traffic and vice-versa.
  assert.ok(!reg.routeTargets(all, '222').includes('s-alice'));
  assert.ok(!reg.routeTargets(all, '111').includes('s-bob'));
  // The admin session does NOT get a user's routed message either (privacy).
  assert.ok(!reg.routeTargets(all, '111').includes('admin'));
});

test('isolation: multiple sessions bound to the SAME user both receive', () => {
  // Respawn racing a stale session: both bound to user 111 → both get it.
  const reg = new SessionRegistry();
  reg.connect('s-old', '111');
  reg.connect('s-new', '111');
  assert.deepEqual(reg.routeTargets(['s-old', 's-new'], '111').sort(), ['s-new', 's-old']);
});

// ── (c) ADMIN/SYSTEM fallback ────────────────────────────────────────────────
test('admin/system traffic → unbound (admin) session, not a user session', () => {
  const reg = new SessionRegistry();
  reg.connect('admin');
  reg.connect('s-alice', '111');
  const all = ['admin', 's-alice'];

  // Worker report / peer relay / scheduled-reminder → admin sink only.
  assert.deepEqual(reg.routeTargets(all, null, /*admin*/ true), ['admin']);
  assert.deepEqual(reg.routeTargets(all, '111', /*admin*/ true), ['admin']);
  // A group/supergroup message (no owning user) is routed admin/system.
  assert.deepEqual(reg.routeTargets(all, '999', /*admin*/ true), ['admin']);
});

test('unknown user with no bound session → admin sink (fallback)', () => {
  const reg = new SessionRegistry();
  reg.connect('admin');
  reg.connect('s-alice', '111');
  const all = ['admin', 's-alice'];
  // A brand-new user 333 who has no session yet → operator/admin sees them.
  assert.deepEqual(reg.routeTargets(all, '333'), ['admin']);
});

test('safety: bound users exist but NO unbound admin session → never drop', () => {
  // If admin disconnected, system/unknown traffic must not vanish: fall back to
  // ALL sessions rather than silently dropping.
  const reg = new SessionRegistry();
  reg.connect('s-alice', '111');
  reg.connect('s-bob', '222');
  const all = ['s-alice', 's-bob'];
  // System message with no admin sink → all sessions.
  assert.deepEqual(reg.routeTargets(all, null, true).sort(), ['s-alice', 's-bob']);
  // Unknown user 333 with no admin sink → all sessions.
  assert.deepEqual(reg.routeTargets(all, '333').sort(), ['s-alice', 's-bob']);
  // But a KNOWN user still routes precisely.
  assert.deepEqual(reg.routeTargets(all, '111'), ['s-alice']);
});

// ── (d) MULTI-USER STRICT ISOLATION (MULTIUSER_AUTOSPAWN) ────────────────────
// On a multi-user instance the router must NEVER broadcast or fall a known
// user's private message back to the owner/admin session, even during a
// transient window where that user's sessions have all disconnected. Regression
// guard for the 2026-07-22 cross-user leak (Rita's CSV → owner session).
test('multiuser: known user with NO live session → nobody (queue), never owner', () => {
  const reg = new SessionRegistry();
  reg.connect('owner'); // the ONLY live session is the unbound owner/admin sink
  const all = ['owner'];
  // Rita (8113361116) — her per-user sessions all churned/disconnected. In
  // single-operator mode this would broadcast to 'owner' (the old leak); in
  // multi-user mode it must route to NOBODY (message stays queued as unanswered,
  // autospawn respawns her session which replays it on connect).
  assert.deepEqual(reg.routeTargets(all, '8113361116', false, /*multiUser*/ true), []);
  // And it certainly must not reach the owner.
  assert.ok(!reg.routeTargets(all, '8113361116', false, true).includes('owner'));
});

test('multiuser: even with zero bindings, a user message never broadcasts', () => {
  const reg = new SessionRegistry();
  reg.connect('owner');
  reg.connect('owner2');
  const all = ['owner', 'owner2'];
  // hasAnyBinding() is false here — single-operator mode would broadcast to all.
  // Multi-user mode routes strictly by user_id → nobody live for this user → [].
  assert.deepEqual(reg.routeTargets(all, '555', false, true), []);
});

test('multiuser: known user WITH a live session → only that session', () => {
  const reg = new SessionRegistry();
  reg.connect('owner');
  reg.connect('s-rita', '8113361116');
  const all = ['owner', 's-rita'];
  assert.deepEqual(reg.routeTargets(all, '8113361116', false, true), ['s-rita']);
  assert.ok(!reg.routeTargets(all, '8113361116', false, true).includes('owner'));
});

test('multiuser: admin/system traffic still reaches the owner sink', () => {
  const reg = new SessionRegistry();
  reg.connect('owner');
  reg.connect('s-rita', '8113361116');
  const all = ['owner', 's-rita'];
  // Worker reports / peer relays / group messages legitimately reach the owner.
  assert.deepEqual(reg.routeTargets(all, null, /*admin*/ true, /*multiUser*/ true), ['owner']);
  assert.deepEqual(reg.routeTargets(all, '999', true, true), ['owner']);
});

test('multiuser: unattributable non-admin message (no user_id) → owner sink', () => {
  const reg = new SessionRegistry();
  reg.connect('owner');
  reg.connect('s-rita', '8113361116');
  const all = ['owner', 's-rita'];
  // Pathological for private chats (they always carry a user_id); routed to the
  // admin sink rather than dropped, since it cannot leak to a specific user.
  assert.deepEqual(reg.routeTargets(all, null, false, true), ['owner']);
});

// ── lifecycle ────────────────────────────────────────────────────────────────
test('lifecycle: disconnect drops binding and reverts to broadcast when empty', () => {
  const reg = new SessionRegistry();
  reg.connect('admin');
  reg.connect('s-alice', '111');
  assert.equal(reg.hasAnyBinding(), true);

  // Alice's session drops → no bindings left → back to broadcast.
  reg.disconnect('s-alice');
  assert.equal(reg.hasAnyBinding(), false);
  assert.deepEqual(reg.routeTargets(['admin'], '111'), ['admin']);
});

test('lifecycle: late bind() of an already-connected session', () => {
  const reg = new SessionRegistry();
  reg.connect('s'); // connects unbound first
  assert.equal(reg.hasAnyBinding(), false);
  reg.bind('s', 444);
  assert.equal(reg.hasAnyBinding(), true);
  assert.deepEqual(reg.routeTargets(['s'], '444'), ['s']);
  assert.deepEqual(reg.sessionsForUser('444'), ['s']);
  assert.deepEqual(reg.unboundSessions(), []);
});

test('helpers: boundUser / unboundSessions / sessionsForUser', () => {
  const reg = new SessionRegistry();
  reg.connect('admin');
  reg.connect('s-alice', '111');
  assert.equal(reg.boundUser('s-alice'), '111');
  assert.equal(reg.boundUser('admin'), undefined);
  assert.deepEqual(reg.unboundSessions(), ['admin']);
  assert.deepEqual(reg.sessionsForUser('111'), ['s-alice']);
  assert.deepEqual(reg.sessionsForUser('nope'), []);
});
