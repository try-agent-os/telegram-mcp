import { getUser, upsertUser, getDefaultPolicy } from './db.js';

const DEFAULT_TIMEZONE = 'Europe/Lisbon';

export function checkAccess(userId: number): 'allowed' | 'pending' | 'denied' {
  const user = getUser(userId);
  if (user) return user.status;

  // First contact — apply default policy
  const policy = getDefaultPolicy();
  const status = policy === 'allow' ? 'allowed' : policy === 'deny' ? 'denied' : 'pending';
  upsertUser(userId, { status: status as 'allowed' | 'pending' | 'denied' });
  return status as 'allowed' | 'pending' | 'denied';
}

export function approveUser(userId: number): boolean {
  upsertUser(userId, { status: 'allowed' });
  return true;
}

export function denyUser(userId: number): boolean {
  upsertUser(userId, { status: 'denied' });
  return true;
}

export function getTimezone(userId: number): string {
  const user = getUser(userId);
  return user?.timezone ?? DEFAULT_TIMEZONE;
}

export function setTimezone(userId: number, tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    return false;
  }
  upsertUser(userId, { timezone: tz });
  return true;
}

export function touchUser(userId: number, username: string | null, displayName: string | null): void {
  upsertUser(userId, { username: username ?? undefined, display_name: displayName ?? undefined });
}
