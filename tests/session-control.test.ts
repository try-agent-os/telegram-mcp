// session-control unit tests — per-user /clear and /model request-file writing.
//
// Covers the env gate (isSessionControlEnabled mirrors MULTIUSER_AUTOSPAWN),
// atomic request-file writing into MULTIUSER_REQUEST_DIR/session-control/, the
// alias validation gate, and the misconfigured (no request dir) path. Writes go
// to a real tmp dir so the atomic tmp+rename path is exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSessionControlEnabled,
  requestClear,
  requestModel,
} from '../src/session-control.ts';

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('isSessionControlEnabled: follows MULTIUSER_AUTOSPAWN', () => {
  withEnv({ MULTIUSER_AUTOSPAWN: '1' }, () => assert.equal(isSessionControlEnabled(), true));
  withEnv({ MULTIUSER_AUTOSPAWN: 'true' }, () => assert.equal(isSessionControlEnabled(), true));
  withEnv({ MULTIUSER_AUTOSPAWN: undefined }, () => assert.equal(isSessionControlEnabled(), false));
  withEnv({ MULTIUSER_AUTOSPAWN: '0' }, () => assert.equal(isSessionControlEnabled(), false));
});

test('requestClear: writes <uid>.clear atomically with uid in body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-clear-'));
  withEnv({ MULTIUSER_REQUEST_DIR: dir }, () => {
    assert.equal(requestClear(4242), true);
    const f = path.join(dir, 'session-control', '4242.clear');
    assert.ok(fs.existsSync(f), 'clear request file exists');
    const body = fs.readFileSync(f, 'utf8');
    assert.equal(body.split('\n')[0], '4242');
    assert.ok(!fs.existsSync(`${f}.tmp`), 'no leftover tmp file');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requestModel: writes <uid>.model with uid + alias in body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-model-'));
  withEnv({ MULTIUSER_REQUEST_DIR: dir }, () => {
    assert.equal(requestModel(777, 'opus'), true);
    const f = path.join(dir, 'session-control', '777.model');
    assert.ok(fs.existsSync(f), 'model request file exists');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    assert.equal(lines[0], '777');
    assert.equal(lines[1], 'opus');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requestModel: rejects an invalid alias without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bad-'));
  withEnv({ MULTIUSER_REQUEST_DIR: dir }, () => {
    assert.equal(requestModel(1, 'rm -rf /'), false);
    assert.ok(!fs.existsSync(path.join(dir, 'session-control', '1.model')));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('requestClear / requestModel: return false when MULTIUSER_REQUEST_DIR unset', () => {
  withEnv({ MULTIUSER_REQUEST_DIR: undefined }, () => {
    assert.equal(requestClear(5), false);
    assert.equal(requestModel(5, 'sonnet'), false);
  });
});
