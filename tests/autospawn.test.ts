import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutospawnEnabled, maybeAutospawn } from '../src/autospawn.ts';

// Phase 2 ingress hook. The flag gate is the load-bearing safety property: a
// SHARED telegram-mcp dist may serve a single-operator bot (no flag) AND a
// multi-user bot (flag on). With the flag OFF, the hook must be a no-op so the
// single-operator instance keeps its behavior even after the dist is rebuilt.

// ── flag parsing ─────────────────────────────────────────────────────────────
test('isAutospawnEnabled: OFF by default and for falsey values', () => {
  assert.equal(isAutospawnEnabled({}), false);
  for (const v of ['', '0', 'false', 'no', 'off', 'nope'])
    assert.equal(isAutospawnEnabled({ MULTIUSER_AUTOSPAWN: v }), false, v);
});

test('isAutospawnEnabled: ON for truthy values', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On '])
    assert.equal(isAutospawnEnabled({ MULTIUSER_AUTOSPAWN: v }), true, v);
});

// ── (single-operator-safe) flag OFF → no ensure() call ───────────────────────
test('single-operator-safe: flag OFF → ensure() is NEVER called', () => {
  const calls: number[] = [];
  const ensure = (uid: number) => calls.push(uid);
  // Even an allowed-looking user does nothing while the flag is off.
  const ran = maybeAutospawn(1000001, { enabled: false, ensure });
  assert.equal(ran, false);
  assert.deepEqual(calls, []);
});

test('single-operator-safe: flag absent (default) → no ensure() call', () => {
  const calls: number[] = [];
  // enabled omitted → reads env; clear the var to simulate the default unit.
  const prev = process.env.MULTIUSER_AUTOSPAWN;
  delete process.env.MULTIUSER_AUTOSPAWN;
  try {
    const ran = maybeAutospawn(777, { ensure: (u) => calls.push(u) });
    assert.equal(ran, false);
    assert.deepEqual(calls, []);
  } finally {
    if (prev !== undefined) process.env.MULTIUSER_AUTOSPAWN = prev;
  }
});

// ── (multiuser) flag ON → ensure() called for the (already-allowed) user ─────
test('multiuser: flag ON → ensure() called with the user_id', () => {
  const calls: number[] = [];
  const ran = maybeAutospawn(555, { enabled: true, ensure: (u) => calls.push(u) });
  assert.equal(ran, true);
  assert.deepEqual(calls, [555]);
});

test('multiuser: owner and cofounder both ensure() when allowed (model choice is the dispatcher\'s job)', () => {
  // maybeAutospawn does not pick the model — it only ensures a session exists.
  // The dispatcher decides per-user session parameters. Here we just prove the
  // hook fires for each allowed user_id it's given.
  const calls: number[] = [];
  maybeAutospawn(1000001, { enabled: true, ensure: (u) => calls.push(u) }); // owner
  maybeAutospawn(222, { enabled: true, ensure: (u) => calls.push(u) });     // cofounder
  assert.deepEqual(calls, [1000001, 222]);
});

// ── access semantics: the gate (not this hook) excludes denied/pending ───────
// maybeAutospawn is only ever called AFTER the access gate passes for an allowed
// private user (bot.ts gateAccess: denied/pending return before the call). This
// test documents that contract: the hook itself does no access check, so a
// caller that (incorrectly) called it for a denied user with the flag on would
// spawn — which is why the call site is placed strictly on the allowed path.
test('contract: hook does not re-check access — caller must gate (documented)', () => {
  const calls: number[] = [];
  // Simulating a denied user: the CALLER must not call us. If it did, we'd run.
  // We assert the documented behavior so a future refactor that moves the call
  // site has a tripwire.
  maybeAutospawn(999, { enabled: true, ensure: (u) => calls.push(u) });
  assert.deepEqual(calls, [999], 'hook runs whatever it is given; access is the gate\'s job');
});

// ── resilience: a throwing ensure() must not break ingress ───────────────────
test('resilience: ensure() throwing is swallowed (ingress never breaks)', () => {
  const ran = maybeAutospawn(1, {
    enabled: true,
    ensure: () => { throw new Error('dispatcher down'); },
  });
  // Still returns true (it attempted) and does not throw out to the caller.
  assert.equal(ran, true);
});
