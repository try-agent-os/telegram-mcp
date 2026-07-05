// clear-flow recognition + owner-gate unit tests.
//
// Covers the pure logic that decides whether an incoming text is the `/clear`
// command, whether the sender is allowed to inject it, and the env-config gate.
// The actual tmux injection (handleClear → OPERATOR_CLEAR_INJECT_SCRIPT) is not
// unit-tested here because it shells out to a live tmux server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// clear-flow reads its env (allowlist + inject script) at CALL time (not import
// time), so a plain static import is fine; set env before the gated tests run.
import { isClearCommand, isClearAdmin, isClearConfigured, handleClear } from '../src/clear-flow.ts';

process.env.TELEGRAM_ADMIN_USER_IDS = '999000111';

test('isClearCommand matches a bare /clear (any case, optional @bot)', () => {
  assert.equal(isClearCommand('/clear'), true);
  assert.equal(isClearCommand('  /clear  '), true);
  assert.equal(isClearCommand('/CLEAR'), true);
  assert.equal(isClearCommand('/clear@examplebot'), true);
});

test('isClearCommand rejects non-clear text and /clear with args', () => {
  assert.equal(isClearCommand('/clear all'), false);
  assert.equal(isClearCommand('clear'), false); // no leading slash → normal message
  assert.equal(isClearCommand('/clearfoo'), false);
  assert.equal(isClearCommand('please /clear'), false);
  assert.equal(isClearCommand(''), false);
  assert.equal(isClearCommand(null), false);
  assert.equal(isClearCommand(undefined), false);
});

test('isClearAdmin gates on the owner allowlist', () => {
  assert.equal(isClearAdmin(999000111), true);
  assert.equal(isClearAdmin(999), false);
});

test('not configured: no OPERATOR_CLEAR_INJECT_SCRIPT → gate closed, handleClear refuses', async () => {
  const prev = process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
  delete process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
  try {
    assert.equal(isClearConfigured(), false);
    const res = await handleClear();
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /not configured/);
  } finally {
    if (prev !== undefined) process.env.OPERATOR_CLEAR_INJECT_SCRIPT = prev;
  }
});

test('configured: OPERATOR_CLEAR_INJECT_SCRIPT set → gate open', () => {
  const prev = process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
  process.env.OPERATOR_CLEAR_INJECT_SCRIPT = '/usr/local/bin/example-clear-inject.sh';
  try {
    assert.equal(isClearConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
    else process.env.OPERATOR_CLEAR_INJECT_SCRIPT = prev;
  }
});
