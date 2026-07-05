// Komodo TG-login gateway — local verification of the bootstrap flow.
//
// Covers the binary criteria from the task:
//   - owner initData → enter mints a one-time ticket → redeem returns the JWT
//     exactly once → the localStorage object has the right shape
//   - non-owner user_id → 403; stale/missing initData → 401
//   - JWT decode shape {sub,iat,exp} with a 24h TTL
//
// komodoLogin() talks to the live Komodo API, so the enter handler is exercised
// with an injected fake login — the HTTP/JWT contract itself is verified live
// separately (see the ClickUp report). Env that the modules read at import time
// is set BEFORE the dynamic imports below.
import { BOT_TOKEN, OWNER_ID } from './_env.js'; // must precede the modules under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as session from '../src/console/komodo-session.js';
import * as komodo from '../src/console/komodo.js';

// --- helpers ---------------------------------------------------------------

// Build signed Telegram Mini App initData for a given user/auth_date, using the
// same HMAC algorithm validateInitData expects.
function buildInitData(user: Record<string, unknown>, authDate: number): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('user', JSON.stringify(user));
  const pairs = [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

// A fake Komodo JWT mirroring the real shape: header.payload.sig, payload base64url
// JSON {sub,iat,exp}, iat/exp in MILLISECONDS, 24h apart (matches live Komodo).
function fakeJwt(sub: string): string {
  const now = Date.now();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + 86_400_000 })).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(43)}`;
}

// Minimal Express req/res mocks capturing status, headers and body.
function mockRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    _type: '',
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    type(t: string) {
      this._type = t;
      return this;
    },
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    send(b: unknown) {
      this.body = b;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

const OWNER_USER = { id: OWNER_ID, first_name: 'Owner' };
const FAKE_USER_ID = '5f3a1b2c3d4e5f6a7b8c9d0e'; // 24-char ObjectId-shaped
const fakeLogin = async () => ({ jwt: fakeJwt(FAKE_USER_ID), userId: FAKE_USER_ID });

// Pull the embedded ticket back out of the bootstrap HTML.
function extractTicket(html: string): string {
  const m = html.match(/ticket:\s*"([^"]+)"/);
  assert.ok(m, 'bootstrap HTML must embed a ticket');
  return m![1];
}

// --- tests -----------------------------------------------------------------

test('owner enter → bootstrap → redeem once → correct localStorage object', async () => {
  const handler = session.makeKomodoEnterHandler(fakeLogin);
  const req: any = { query: { initData: buildInitData(OWNER_USER, Math.floor(Date.now() / 1000)) } };
  const res = mockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res._type, 'text/html');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const html = String(res.body);
  assert.ok(!html.includes(FAKE_USER_ID), 'JWT/userId must NOT appear in bootstrap HTML');

  const ticket = extractTicket(html);

  // First redeem returns the JWT + userId.
  const redeem = session.makeKomodoRedeemHandler();
  const r1 = mockRes();
  redeem({ body: { ticket } } as any, r1);
  assert.equal(r1.statusCode, 200);
  const out = r1.body as { jwt: string; userId: string };
  assert.equal(out.userId, FAKE_USER_ID);
  assert.ok(out.jwt.split('.').length === 3);

  // The localStorage object the page builds has the exact Komodo shape.
  const obj = session.buildAuthTokensObject(out.userId, out.jwt);
  assert.deepEqual(obj, {
    current: FAKE_USER_ID,
    tokens: [{ user_id: FAKE_USER_ID, jwt: out.jwt }],
  });

  // Second redeem of the SAME ticket → 401 (one-time).
  const r2 = mockRes();
  redeem({ body: { ticket } } as any, r2);
  assert.equal(r2.statusCode, 401);
});

test('non-owner user_id → 403', async () => {
  const handler = session.makeKomodoEnterHandler(fakeLogin);
  const req: any = {
    query: { initData: buildInitData({ id: 999, first_name: 'Mallory' }, Math.floor(Date.now() / 1000)) },
  };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
});

test('missing initData → 401', async () => {
  const handler = session.makeKomodoEnterHandler(fakeLogin);
  const res = mockRes();
  await handler({ query: {} } as any, res);
  assert.equal(res.statusCode, 401);
});

test('stale initData → 401', async () => {
  const handler = session.makeKomodoEnterHandler(fakeLogin);
  const stale = Math.floor(Date.now() / 1000) - 7200; // 2h old, > 1h max age
  const req: any = { query: { initData: buildInitData(OWNER_USER, stale) } };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('redeem with no ticket → 400, garbage ticket → 401', () => {
  const redeem = session.makeKomodoRedeemHandler();
  const r0 = mockRes();
  redeem({ body: {} } as any, r0);
  assert.equal(r0.statusCode, 400);

  const r1 = mockRes();
  redeem({ body: { ticket: 'not.a.realticket' } } as any, r1);
  assert.equal(r1.statusCode, 401);
});

test('JWT decode → {sub,iat,exp} with 24h TTL', () => {
  const jwt = fakeJwt(FAKE_USER_ID);
  const claims = komodo.decodeJwtClaims(jwt);
  assert.equal(claims.sub, FAKE_USER_ID);
  assert.equal(typeof claims.iat, 'number');
  assert.equal(typeof claims.exp, 'number');
  // Komodo iat/exp are in ms; 24h TTL.
  assert.equal((claims.exp - claims.iat) / 1000, 86_400);
});

test('expired ticket → redeem 401', async () => {
  // Mint a ticket then redeem with a clock far in the future.
  const ticket = session.mintTicket(fakeJwt(FAKE_USER_ID), FAKE_USER_ID);
  const future = Date.now() + 120_000; // 2 min later, TTL is 60s
  const out = session.redeemTicket(ticket, future);
  assert.equal(out, null);
});
