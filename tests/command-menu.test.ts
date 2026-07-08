// command-menu unit tests — pure command-list builder + env-driven flag/admin parsing.
//
// Covers buildBotCommands (base commands always, owner extras gated by flags),
// currentCommandFlags (env → flags), and parseAdminIds (allowlist parsing with
// legacy fallback). The actual setMyCommands API calls (registerBotCommands) are
// not unit-tested here (they hit the live Bot API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBotCommands,
  currentCommandFlags,
  parseAdminIds,
  BASE_COMMANDS,
} from '../src/command-menu.ts';

test('buildBotCommands: no features → base commands only', () => {
  const cmds = buildBotCommands({ clearInject: false, modelInject: false });
  assert.deepEqual(cmds.map(c => c.command), BASE_COMMANDS.map(c => c.command));
  assert.equal(cmds.some(c => c.command === 'clear'), false);
  assert.equal(cmds.some(c => c.command === 'model'), false);
});

test('buildBotCommands: clear flag adds /clear only', () => {
  const cmds = buildBotCommands({ clearInject: true, modelInject: false }).map(c => c.command);
  assert.ok(cmds.includes('clear'));
  assert.ok(!cmds.includes('model'));
});

test('buildBotCommands: model flag adds /model only', () => {
  const cmds = buildBotCommands({ clearInject: false, modelInject: true }).map(c => c.command);
  assert.ok(cmds.includes('model'));
  assert.ok(!cmds.includes('clear'));
});

test('buildBotCommands: both flags → base + /clear + /model, base preserved and first', () => {
  const cmds = buildBotCommands({ clearInject: true, modelInject: true });
  assert.deepEqual(cmds.slice(0, BASE_COMMANDS.length).map(c => c.command), BASE_COMMANDS.map(c => c.command));
  const tail = cmds.slice(BASE_COMMANDS.length).map(c => c.command);
  assert.deepEqual(tail, ['clear', 'model']);
  // Every command has a non-empty English description.
  for (const c of cmds) assert.ok(c.description.length > 0);
});

test('currentCommandFlags: reflects OPERATOR_*_INJECT_SCRIPT env', () => {
  const savedClear = process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
  const savedModel = process.env.OPERATOR_MODEL_INJECT_SCRIPT;
  try {
    delete process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
    delete process.env.OPERATOR_MODEL_INJECT_SCRIPT;
    assert.deepEqual(currentCommandFlags(), { clearInject: false, modelInject: false });

    process.env.OPERATOR_CLEAR_INJECT_SCRIPT = '/usr/local/bin/clear-inject.sh';
    process.env.OPERATOR_MODEL_INJECT_SCRIPT = '/usr/local/bin/model-inject.sh';
    assert.deepEqual(currentCommandFlags(), { clearInject: true, modelInject: true });
  } finally {
    if (savedClear === undefined) delete process.env.OPERATOR_CLEAR_INJECT_SCRIPT;
    else process.env.OPERATOR_CLEAR_INJECT_SCRIPT = savedClear;
    if (savedModel === undefined) delete process.env.OPERATOR_MODEL_INJECT_SCRIPT;
    else process.env.OPERATOR_MODEL_INJECT_SCRIPT = savedModel;
  }
});

test('parseAdminIds: comma list, legacy fallback, and empty', () => {
  const savedAdmin = process.env.TELEGRAM_ADMIN_USER_IDS;
  const savedUser = process.env.TELEGRAM_USER_ID;
  try {
    process.env.TELEGRAM_ADMIN_USER_IDS = '111, 222 ,333';
    delete process.env.TELEGRAM_USER_ID;
    assert.deepEqual(parseAdminIds(), [111, 222, 333]);

    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    process.env.TELEGRAM_USER_ID = '444';
    assert.deepEqual(parseAdminIds(), [444]);

    delete process.env.TELEGRAM_USER_ID;
    assert.deepEqual(parseAdminIds(), []);
  } finally {
    if (savedAdmin === undefined) delete process.env.TELEGRAM_ADMIN_USER_IDS;
    else process.env.TELEGRAM_ADMIN_USER_IDS = savedAdmin;
    if (savedUser === undefined) delete process.env.TELEGRAM_USER_ID;
    else process.env.TELEGRAM_USER_ID = savedUser;
  }
});
