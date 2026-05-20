import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_FILE = join(process.cwd(), '.session-state.json');

interface SessionState {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
}

export function loadSessionId(): string | undefined {
  if (!existsSync(STATE_FILE)) return undefined;
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SessionState;
    console.log(`[session-store] Found saved session: ${data.sessionId} (started ${data.startedAt})`);
    return data.sessionId;
  } catch {
    return undefined;
  }
}

export function saveSessionId(sessionId: string): void {
  const existing = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<SessionState>
    : {};

  const state: SessionState = {
    sessionId,
    startedAt: existing.startedAt ?? new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function clearSessionId(): void {
  if (existsSync(STATE_FILE)) {
    writeFileSync(STATE_FILE, '');
  }
}
