import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAge,
  shortId,
  formatSessionLine,
  buildStatusText,
  type SessionInfo,
} from '../src/session-status.js';

test('formatAge renders seconds/minutes/hours/days', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(45_000), '45s');
  assert.equal(formatAge(12 * 60_000), '12m');
  assert.equal(formatAge((3 * 3600 + 20 * 60) * 1000), '3h 20m');
  assert.equal(formatAge((2 * 24 + 4) * 3600 * 1000), '2d 4h');
});

test('formatAge clamps negative / non-finite to 0s', () => {
  assert.equal(formatAge(-5), '0s');
  assert.equal(formatAge(NaN), '0s');
});

test('shortId truncates long ids and passes short ones through', () => {
  assert.equal(shortId('abcdef12-3456-7890'), 'abcdef12');
  assert.equal(shortId('abc'), 'abc');
});

test('formatSessionLine: unbound admin session with client + age', () => {
  const now = 1_000_000_000;
  const info: SessionInfo = {
    id: 'a1b2c3d4-ffff',
    boundUserId: null,
    clientName: 'claude-code',
    clientVersion: '2.0.14',
    connectedAt: now - (3 * 3600 + 20 * 60) * 1000,
  };
  assert.equal(
    formatSessionLine(1, info, now),
    '1. a1b2c3d4 · admin · claude-code 2.0.14 · 3h 20m',
  );
});

test('formatSessionLine: bound user + missing client info degrades gracefully', () => {
  const now = 1_000_000_000;
  const info: SessionInfo = {
    id: 'e5f6',
    boundUserId: '123510069',
    connectedAt: now - 12 * 60_000,
  };
  assert.equal(formatSessionLine(2, info, now), '2. e5f6 · user 123510069 · client ? · 12m');
});

test('formatSessionLine: appends model + context when self-reported', () => {
  const now = 1_000_000_000;
  const info: SessionInfo = {
    id: 'deadbeef',
    boundUserId: null,
    clientName: 'claude-code',
    connectedAt: now - 60_000,
    model: 'claude-opus-4-8',
    contextTokens: [120_000, 200_000],
  };
  assert.equal(
    formatSessionLine(1, info, now),
    '1. deadbeef · admin · claude-code · 1m · claude-opus-4-8 · ctx 120k/200k (60%)',
  );
});

test('buildStatusText: zero sessions is terse, no note', () => {
  const text = buildStatusText({ sessions: [], uptimeSeconds: 3600 + 12 * 60, now: 1_000 });
  assert.equal(text, 'Bot: running\nUptime: 1h 12m\nClaude sessions: 0');
});

test('buildStatusText: sessions sorted oldest-first + MCP note when no rich data', () => {
  const now = 10_000_000;
  const sessions: SessionInfo[] = [
    { id: 'younger0', boundUserId: '111', clientName: 'claude-code', connectedAt: now - 60_000 },
    { id: 'older000', boundUserId: null, clientName: 'claude-code', connectedAt: now - 7_200_000 },
  ];
  const text = buildStatusText({ sessions, uptimeSeconds: 0, now });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Bot: running');
  assert.equal(lines[2], 'Claude sessions: 2');
  // older session listed first
  assert.match(lines[4], /^1\. older000 · admin/);
  assert.match(lines[5], /^2\. younger0 · user 111/);
  // limitation note present since nothing self-reported model/context
  assert.match(text, /model \/ context-fill не приходят по MCP/);
});

test('buildStatusText: no MCP note once any session reports model/context', () => {
  const now = 10_000_000;
  const sessions: SessionInfo[] = [
    { id: 'rich0000', boundUserId: null, connectedAt: now - 60_000, model: 'claude-opus-4-8' },
  ];
  const text = buildStatusText({ sessions, uptimeSeconds: 0, now });
  assert.doesNotMatch(text, /не приходят по MCP/);
});
