// Komodo Core client — talks to the local Komodo API over loopback only.
// API model: POST /read/{NAME} and /execute/{NAME}, JSON body, auth via the
// X-Api-Key / X-Api-Secret header pair (a dedicated read-only service user key).
// Credentials live in server-side env only and never reach the client.
const BASE = process.env.KOMODO_HOST_LOCAL ?? 'http://localhost:9120';
const KEY = process.env.KOMODO_API_KEY ?? '';
const SECRET = process.env.KOMODO_API_SECRET ?? '';

// TG-login gateway creds. A FULL Komodo *user* login (not the read-only API-key
// pair above) is required to mint a UI session JWT — Komodo's web app keeps its
// session in localStorage (key mogh-auth-tokens-v1) under a real user, not via
// the X-Api-Key header. reuse a read-only/admin Komodo account here
// (KOMODO_GATEWAY_USER) rather than a dedicated gateway user; both values live
// only in server-side env — never in git, never on the client.
const GATEWAY_USER = process.env.KOMODO_GATEWAY_USER ?? '';
const GATEWAY_PASS = process.env.KOMODO_GATEWAY_PASS ?? '';

export const komodoConfigured = (): boolean => Boolean(KEY && SECRET);

/** True once the TG-login gateway creds are present — gates route mounting. */
export const komodoGatewayConfigured = (): boolean => Boolean(GATEWAY_USER && GATEWAY_PASS);

// Komodo JWT is an unencrypted HS-signed token; iat/exp are epoch MILLISECONDS
// (verified live 2026-05-24: exp-iat = 86_400_000 = 24h). `sub` is the 24-char
// Mongo ObjectId of the Komodo user — NOT the Telegram id.
export interface KomodoJwtClaims {
  sub: string;
  iat: number;
  exp: number;
}

/** Decode a JWT payload (no signature check — we only just minted it server-side). */
export function decodeJwtClaims(jwt: string): KomodoJwtClaims {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('malformed jwt');
  const json = Buffer.from(parts[1], 'base64url').toString('utf8');
  const claims = JSON.parse(json) as KomodoJwtClaims;
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('jwt has no sub');
  return claims;
}

/**
 * Log in to Komodo as the gateway user and return a fresh 24h session JWT plus
 * the Komodo user id (the JWT `sub` claim). The JWT is what the bootstrap page
 * seeds into localStorage so the SPA loads already authenticated. Creds never
 * leave the server; only the resulting JWT is handed to the (owner-locked)
 * client, once.
 */
export async function komodoLogin(): Promise<{ jwt: string; userId: string }> {
  if (!komodoGatewayConfigured()) throw new Error('komodo gateway not configured');
  const res = await fetch(`${BASE}/auth/login/LoginLocalUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: GATEWAY_USER, password: GATEWAY_PASS }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`komodo login -> ${res.status}`);
  const body = (await res.json()) as { data?: { jwt?: string }; jwt?: string };
  const jwt = body.data?.jwt ?? body.jwt;
  if (!jwt) throw new Error('komodo login: no jwt in response');
  const userId = decodeJwtClaims(jwt).sub;
  return { jwt, userId };
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': KEY,
    'X-Api-Secret': SECRET,
  };
}

export async function komoRead<T = unknown>(name: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}/read/${name}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`komodo /read/${name} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export interface StacksSummary {
  total: number;
  running: number;
  stopped: number;
  down: number;
  unhealthy: number;
  unknown: number;
}

export interface StackListItem {
  name: string;
  id?: string;
  info?: { state?: string; status?: string; services_count?: number };
}

export interface ServerListItem {
  name: string;
  id?: string;
  info?: { state?: string };
}
