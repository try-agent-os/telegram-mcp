// model-flow recognition + owner-gate unit tests (sibling of clear-flow.test.ts).
//
// Covers the pure logic: /model command parsing, model_switch: callback parsing,
// alias charset validation, keyboard shape, the admin gate, and the env-config
// gate. The actual tmux injection (handleModelSwitch → OPERATOR_MODEL_INJECT_SCRIPT)
// is not unit-tested here (shells out to live tmux).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelCommand,
  parseModelCallback,
  isValidModelAlias,
  isModelAdmin,
  isModelConfigured,
  handleModelSwitch,
  labelForAlias,
  modelKeyboard,
  MODEL_CHOICES,
  MODEL_CALLBACK_PREFIX,
} from '../src/model-flow.ts';

process.env.TELEGRAM_ADMIN_USER_IDS = '999000111';

test('parseModelCommand: bare /model → menu (any case, optional @bot)', () => {
  assert.deepEqual(parseModelCommand('/model'), { kind: 'menu' });
  assert.deepEqual(parseModelCommand('  /model  '), { kind: 'menu' });
  assert.deepEqual(parseModelCommand('/MODEL'), { kind: 'menu' });
  assert.deepEqual(parseModelCommand('/model@examplebot'), { kind: 'menu' });
});

test('parseModelCommand: /model <alias> → switch with the alias verbatim', () => {
  assert.deepEqual(parseModelCommand('/model sonnet'), { kind: 'switch', alias: 'sonnet' });
  assert.deepEqual(parseModelCommand('/model claude-fable-5[1m]'), { kind: 'switch', alias: 'claude-fable-5[1m]' });
  assert.deepEqual(parseModelCommand('/model@examplebot opus'), { kind: 'switch', alias: 'opus' });
});

test('parseModelCommand rejects non-model text, extra args and bad aliases', () => {
  assert.equal(parseModelCommand('model'), null); // no leading slash → normal message
  assert.equal(parseModelCommand('/modelfoo'), null);
  assert.equal(parseModelCommand('please /model'), null);
  assert.equal(parseModelCommand('/model two words'), null); // extra arg → let it reach the agent
  assert.equal(parseModelCommand('/model $(rm -rf /)'), null); // shell metachars → rejected
  assert.equal(parseModelCommand(''), null);
  assert.equal(parseModelCommand(null), null);
  assert.equal(parseModelCommand(undefined), null);
});

test('isValidModelAlias: strict charset with optional [1m]-style suffix', () => {
  assert.equal(isValidModelAlias('claude-fable-5'), true);
  assert.equal(isValidModelAlias('claude-opus-4-8[1m]'), true);
  assert.equal(isValidModelAlias('opus'), true);
  assert.equal(isValidModelAlias('claude-haiku-4-5-20251001'), true);
  assert.equal(isValidModelAlias('a b'), false);
  assert.equal(isValidModelAlias('a;b'), false);
  assert.equal(isValidModelAlias('[1m]'), false); // suffix alone is not an alias
  assert.equal(isValidModelAlias('x[1m]y'), false); // suffix must be terminal
  assert.equal(isValidModelAlias(''), false);
});

test('parseModelCallback extracts a valid alias, rejects everything else', () => {
  assert.equal(parseModelCallback('model_switch:claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(parseModelCallback('model_switch:claude-fable-5[1m]'), 'claude-fable-5[1m]');
  assert.equal(parseModelCallback('model_switch:'), null);
  assert.equal(parseModelCallback('model_switch:bad alias'), null);
  assert.equal(parseModelCallback('some_other_callback'), null);
  assert.equal(parseModelCallback(''), null);
  assert.equal(parseModelCallback(null), null);
});

test('modelKeyboard: one button per choice, callback_data = prefix + alias', () => {
  const kb = modelKeyboard();
  assert.equal(kb.inline_keyboard.length, MODEL_CHOICES.length);
  for (const [i, row] of kb.inline_keyboard.entries()) {
    assert.equal(row.length, 1);
    assert.equal(row[0].text, MODEL_CHOICES[i].label);
    assert.equal(row[0].callback_data, `${MODEL_CALLBACK_PREFIX}${MODEL_CHOICES[i].alias}`);
    // Telegram hard limit: callback_data must fit in 64 bytes.
    assert.ok(Buffer.byteLength(row[0].callback_data) <= 64);
    // Every button alias must survive the same validation used on the tap path.
    assert.equal(parseModelCallback(row[0].callback_data), MODEL_CHOICES[i].alias);
  }
});

test('labelForAlias: known alias → button label, unknown → alias itself', () => {
  assert.equal(labelForAlias('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(labelForAlias('opus'), 'opus');
});

test('isModelAdmin gates on the owner allowlist', () => {
  assert.equal(isModelAdmin(999000111), true);
  assert.equal(isModelAdmin(999), false);
});

test('not configured: no OPERATOR_MODEL_INJECT_SCRIPT → gate closed, handleModelSwitch refuses', async () => {
  const prev = process.env.OPERATOR_MODEL_INJECT_SCRIPT;
  delete process.env.OPERATOR_MODEL_INJECT_SCRIPT;
  try {
    assert.equal(isModelConfigured(), false);
    const res = await handleModelSwitch('claude-sonnet-5');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /not configured/);
  } finally {
    if (prev !== undefined) process.env.OPERATOR_MODEL_INJECT_SCRIPT = prev;
  }
});

test('invalid alias is rejected before the config gate', async () => {
  const res = await handleModelSwitch('bad alias');
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /invalid model alias/);
});

test('configured: OPERATOR_MODEL_INJECT_SCRIPT set → gate open', () => {
  const prev = process.env.OPERATOR_MODEL_INJECT_SCRIPT;
  process.env.OPERATOR_MODEL_INJECT_SCRIPT = '/usr/local/bin/example-model-inject.sh';
  try {
    assert.equal(isModelConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.OPERATOR_MODEL_INJECT_SCRIPT;
    else process.env.OPERATOR_MODEL_INJECT_SCRIPT = prev;
  }
});
