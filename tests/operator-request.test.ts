// Tests for the owner-path request/result-file transport (operator-request.ts).
// The bot writes a <id>.req; a stand-in "consumer" writes the matching <id>.res;
// operatorRequest() must resolve with the parsed result and clean up both files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isOperatorRequestEnabled,
  operatorRequest,
} from '../src/operator-request.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opreq-'));
}

// A tiny consumer: poll the kind dir for a *.req, echo a result, remove nothing
// (operatorRequest removes the req after reading the res, matching the real
// consumer which deletes the req itself; here we let the bot side clean up).
function spawnConsumer(base: string, kind: string, result: object): NodeJS.Timeout {
  const dir = path.join(base, kind);
  return setInterval(() => {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.req'));
    } catch {
      return;
    }
    for (const f of files) {
      const id = f.replace(/\.req$/, '');
      const resPath = path.join(dir, `${id}.res`);
      if (fs.existsSync(resPath)) continue;
      const tmp = `${resPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result));
      fs.renameSync(tmp, resPath); // atomic, mirrors the real consumer
    }
  }, 20);
}

test('isOperatorRequestEnabled reflects OPERATOR_REQUEST_DIR', () => {
  assert.equal(isOperatorRequestEnabled({}), false);
  assert.equal(isOperatorRequestEnabled({ OPERATOR_REQUEST_DIR: '  ' }), false);
  assert.equal(isOperatorRequestEnabled({ OPERATOR_REQUEST_DIR: '/x' }), true);
});

test('operatorRequest returns failure when dir unset', async () => {
  const r = await operatorRequest('clear', { env: {} });
  assert.equal(r.ok, false);
  assert.match(r.error!, /OPERATOR_REQUEST_DIR/);
});

test('clear round-trip: consumer result is returned and files cleaned up', async () => {
  const base = tmpDir();
  const consumer = spawnConsumer(base, 'clear', { ok: true });
  try {
    const r = await operatorRequest('clear', {
      env: { OPERATOR_REQUEST_DIR: base },
      timeoutMs: 3000,
      pollMs: 20,
    });
    assert.equal(r.ok, true);
    // No leftover .req/.res in the kind dir.
    const left = fs.readdirSync(path.join(base, 'clear'));
    assert.deepEqual(left, []);
  } finally {
    clearInterval(consumer);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('login-start round-trip carries url + restarted through', async () => {
  const base = tmpDir();
  const consumer = spawnConsumer(base, 'login-start', {
    ok: true,
    url: 'https://claude.ai/oauth/xyz',
    restarted: true,
  });
  try {
    const r = await operatorRequest('login-start', {
      env: { OPERATOR_REQUEST_DIR: base },
      timeoutMs: 3000,
      pollMs: 20,
    });
    assert.equal(r.ok, true);
    assert.equal(r.url, 'https://claude.ai/oauth/xyz');
    assert.equal(r.restarted, true);
  } finally {
    clearInterval(consumer);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('consumer failure result is surfaced as {ok:false,error}', async () => {
  const base = tmpDir();
  const consumer = spawnConsumer(base, 'model', { ok: false, error: 'bad alias' });
  try {
    const r = await operatorRequest('model', {
      arg: 'claude-opus',
      env: { OPERATOR_REQUEST_DIR: base },
      timeoutMs: 3000,
      pollMs: 20,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad alias');
  } finally {
    clearInterval(consumer);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('timeout with no consumer returns failure and removes the request', async () => {
  const base = tmpDir();
  try {
    const r = await operatorRequest('clear', {
      env: { OPERATOR_REQUEST_DIR: base },
      timeoutMs: 300,
      pollMs: 20,
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /timed out/);
    const left = fs.readdirSync(path.join(base, 'clear'));
    assert.deepEqual(left, []); // stale request dropped, no replay
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('request body is atomic JSON with id/kind/arg', async () => {
  const base = tmpDir();
  const dir = path.join(base, 'model');
  // Capture the request the bot writes by racing a reader that copies then answers.
  let captured: any = null;
  const consumer = setInterval(() => {
    let files: string[];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.req')); } catch { return; }
    for (const f of files) {
      if (!captured) captured = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const id = f.replace(/\.req$/, '');
      const resPath = path.join(dir, `${id}.res`);
      const tmp = `${resPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ok: true }));
      fs.renameSync(tmp, resPath);
    }
  }, 20);
  try {
    await operatorRequest('model', {
      arg: 'claude-sonnet-5',
      env: { OPERATOR_REQUEST_DIR: base },
      timeoutMs: 3000,
      pollMs: 20,
    });
    assert.equal(captured.kind, 'model');
    assert.equal(captured.arg, 'claude-sonnet-5');
    assert.equal(typeof captured.id, 'string');
  } finally {
    clearInterval(consumer);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
