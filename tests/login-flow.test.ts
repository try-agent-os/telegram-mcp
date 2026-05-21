// Tests for src/login-flow.ts — admin gating + pending-state state machine.
//
// We can't easily test the tmux/claude-auth integration here (it needs a
// real script + live claude binary), so we focus on the pure parts:
//   - isLoginAdmin parses TELEGRAM_ADMIN_USER_IDS / TELEGRAM_USER_ID
//   - submitLogin without an active session returns a typed failure
//   - cancelLogin is safe to call on a non-existent chat (no throw)

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';

const ORIG_ADMINS = process.env.TELEGRAM_ADMIN_USER_IDS;
const ORIG_LEGACY = process.env.TELEGRAM_USER_ID;
const ORIG_SCRIPT = process.env.CLAUDE_LOGIN_PIPE;

// Point at a script that always fails fast — keeps tests hermetic so we
// don't need a real claude-login-pipe.sh on the test host.
const FAKE_SCRIPT = '/bin/false';

before(() => {
  process.env.CLAUDE_LOGIN_PIPE = FAKE_SCRIPT;
});

after(() => {
  if (ORIG_ADMINS === undefined) delete process.env.TELEGRAM_ADMIN_USER_IDS;
  else process.env.TELEGRAM_ADMIN_USER_IDS = ORIG_ADMINS;
  if (ORIG_LEGACY === undefined) delete process.env.TELEGRAM_USER_ID;
  else process.env.TELEGRAM_USER_ID = ORIG_LEGACY;
  if (ORIG_SCRIPT === undefined) delete process.env.CLAUDE_LOGIN_PIPE;
  else process.env.CLAUDE_LOGIN_PIPE = ORIG_SCRIPT;
});

describe('login-flow admin gating', () => {
  it('isLoginAdmin: matches comma-separated IDs', async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = '111, 222 , 333';
    delete process.env.TELEGRAM_USER_ID;
    const { isLoginAdmin } = await import('../src/login-flow.js');
    assert.equal(isLoginAdmin(111), true);
    assert.equal(isLoginAdmin(222), true);
    assert.equal(isLoginAdmin(333), true);
    assert.equal(isLoginAdmin(444), false);
  });

  it('isLoginAdmin: falls back to TELEGRAM_USER_ID', async () => {
    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    process.env.TELEGRAM_USER_ID = '555';
    const { isLoginAdmin } = await import('../src/login-flow.js');
    assert.equal(isLoginAdmin(555), true);
    assert.equal(isLoginAdmin(111), false);
  });

  it('isLoginAdmin: empty env → nobody is admin', async () => {
    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    delete process.env.TELEGRAM_USER_ID;
    const { isLoginAdmin } = await import('../src/login-flow.js');
    assert.equal(isLoginAdmin(111), false);
  });
});

describe('login-flow state machine', () => {
  it('submitLogin: no active session returns typed failure', async () => {
    const { submitLogin, isLoginPending } = await import('../src/login-flow.js');
    assert.equal(isLoginPending(999), false);
    const r = await submitLogin(999, 'fake-code');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /no active login session/);
  });

  it('cancelLogin: safe on chat with no pending state', async () => {
    const { cancelLogin } = await import('../src/login-flow.js');
    await cancelLogin(12345); // must not throw
  });
});
