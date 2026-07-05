// Console initData auth — validates Telegram Mini App initData on EVERY request.
//
// Algorithm (core.telegram.org/bots/webapps, HMAC path):
//   secret_key       = HMAC_SHA256(key="WebAppData", msg=<bot_token>)
//   data_check_string= all fields except `hash` (signature INCLUDED), sorted by
//                      key, joined as `<key>=<value>` with '\n'
//   valid  <=>  HMAC_SHA256(key=secret_key, msg=data_check_string) === hash
//
// We implement this with node:crypto rather than @telegram-apps/init-data-node
// to avoid an external dependency (the package has ESM/CJS scope churn — see the
// design doc §3). The algorithm is small and stable; constant-time compared.
//
// After a valid signature we lock to a single owner user_id and enforce
// auth_date freshness. Forging a request requires the bot token, which never
// leaves the server.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
// Single-owner lock. Sourced from env only — no hardcoded personal id (this file
// is mirrored to the public upstream). Unset/invalid => 0, which no real user
// has, so the gate fails closed (every request 403s) until configured.
const OWNER_ID = Number(process.env.CONSOLE_OWNER_ID ?? '0');
const MAX_AGE_SEC = Number(process.env.CONSOLE_INITDATA_MAX_AGE ?? '3600');

export interface InitDataResult {
  ok: boolean;
  reason?: 'no_init_data' | 'bad_hash' | 'stale' | 'not_owner' | 'no_token' | 'malformed';
  userId?: number;
  user?: Record<string, unknown>;
}

/**
 * Validate a raw initData query string. Pure function — no Express coupling, so
 * it can be unit-tested directly.
 */
export function validateInitData(raw: string, now: number = Date.now()): InitDataResult {
  if (!BOT_TOKEN) return { ok: false, reason: 'no_token' };
  if (!raw) return { ok: false, reason: 'no_init_data' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'malformed' };

  // data_check_string: every field except `hash`, sorted by key. NB: the newer
  // Mini App initData carries a `signature` field (Ed25519, for 3rd-party
  // validation) — but Telegram's HMAC `hash` IS computed over signature too, so
  // it must stay in the check string. Excluding it yields bad_hash. (Verified
  // empirically against the live client via brute-force diag, 2026-05-23.)
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time compare (both hex strings of equal length expected).
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_hash' };
  }

  // Freshness.
  const authDate = Number(params.get('auth_date') ?? '0');
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'stale' };
  if (Math.floor(now / 1000) - authDate > MAX_AGE_SEC) return { ok: false, reason: 'stale' };

  // Owner lock.
  let user: Record<string, unknown> | undefined;
  try {
    const userRaw = params.get('user');
    if (userRaw) user = JSON.parse(userRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const userId = Number(user?.id);
  if (!Number.isFinite(userId) || userId !== OWNER_ID) {
    return { ok: false, reason: 'not_owner', userId };
  }

  return { ok: true, userId, user };
}

/**
 * Express middleware: require valid, fresh, owner-locked initData.
 * Client sends it as `Authorization: tma <initDataRaw>`.
 *   - missing/invalid signature, stale, or no token  -> 401
 *   - valid signature but wrong user_id              -> 403
 */
export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('authorization') ?? '';
  const sp = auth.indexOf(' ');
  const scheme = sp === -1 ? auth : auth.slice(0, sp);
  const raw = sp === -1 ? '' : auth.slice(sp + 1);
  if (scheme !== 'tma' || !raw) {
    res.status(401).json({ error: 'no_init_data' });
    return;
  }
  const result = validateInitData(raw);
  if (!result.ok) {
    const code = result.reason === 'not_owner' ? 403 : 401;
    // Log every rejection with safe metadata only (never the token or signature)
    // — auth failures on a single-owner gate are worth a security trail.
    try {
      const p = new URLSearchParams(raw);
      const keys = [...p.keys()].sort().join(',');
      const authDate = Number(p.get('auth_date') ?? '0');
      const ageSec = authDate > 0 ? Math.floor(Date.now() / 1000) - authDate : -1;
      console.error(`[console][auth] reject reason=${result.reason} code=${code} userId=${result.userId ?? '-'} keys=[${keys}] auth_date_age_sec=${ageSec} owner=${OWNER_ID} hasToken=${BOT_TOKEN ? 'y' : 'n'}`);
    } catch (e) {
      console.error(`[console][auth] reject reason=${result.reason} (diag parse failed)`);
    }
    res.status(code).json({ error: result.reason ?? 'invalid_init_data' });
    return;
  }
  (req as Request & { tgUser?: unknown }).tgUser = result.user;
  next();
}
