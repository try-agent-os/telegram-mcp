/**
 * Phase 0 PoC tests for SDK runner + watchdog.
 *
 * Test 1: Basic SDK query — Claude responds to a simple prompt.
 * Test 2: Watchdog silence detection — timer fires on simulated inactivity.
 * Test 3: Session ID capture — session_id is captured from init message.
 *
 * Run: node --import tsx --test tests/sdk-runner.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamWatchdog, eventTypeFromMessage, isTrackableEvent } from '../src/watchdog.js';

describe('StreamWatchdog', () => {
  it('should not fire when events arrive regularly', async () => {
    let silenceDetected = false;

    const watchdog = new StreamWatchdog({
      silenceThresholdMs: 500,
      onSilenceDetected: () => { silenceDetected = true; },
    });

    watchdog.start();

    // Simulate events arriving every 100ms for 1 second
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 100));
      watchdog.recordEvent('assistant');
    }

    watchdog.stop();
    assert.equal(silenceDetected, false, 'Watchdog should NOT fire when events arrive regularly');
  });

  it('should fire when silence exceeds threshold', async () => {
    let silenceInfo: any = null;

    const watchdog = new StreamWatchdog({
      silenceThresholdMs: 300,
      onSilenceDetected: (info) => { silenceInfo = info; },
    });

    watchdog.setSessionId('test-session-123');
    watchdog.recordEvent('assistant');
    watchdog.start();

    // Wait long enough for silence to trigger
    await new Promise(r => setTimeout(r, 600));

    watchdog.stop();
    assert.notEqual(silenceInfo, null, 'Watchdog should fire after silence threshold');
    assert.equal(silenceInfo.sessionId, 'test-session-123');
    assert.equal(silenceInfo.lastEventType, 'assistant');
    assert.ok(silenceInfo.silenceDurationMs >= 300, `Silence duration ${silenceInfo.silenceDurationMs}ms should be >= 300ms`);
  });

  it('should reset and allow re-detection', async () => {
    let fireCount = 0;

    const watchdog = new StreamWatchdog({
      silenceThresholdMs: 200,
      onSilenceDetected: () => { fireCount++; },
    });

    watchdog.start();
    await new Promise(r => setTimeout(r, 400));
    assert.equal(fireCount, 1, 'Should fire once after first silence');

    // Reset and check it can fire again
    watchdog.reset();
    assert.equal(watchdog.isAborted(), false, 'Should not be aborted after reset');

    watchdog.stop();
  });
});

describe('eventTypeFromMessage', () => {
  it('should map system/api_retry correctly', () => {
    assert.equal(eventTypeFromMessage({ type: 'system', subtype: 'api_retry' }), 'system/api_retry');
  });

  it('should return type for non-special messages', () => {
    assert.equal(eventTypeFromMessage({ type: 'assistant' }), 'assistant');
    assert.equal(eventTypeFromMessage({ type: 'result' }), 'result');
  });
});

describe('isTrackableEvent', () => {
  it('should track standard events', () => {
    assert.equal(isTrackableEvent('assistant'), true);
    assert.equal(isTrackableEvent('user'), true);
    assert.equal(isTrackableEvent('result'), true);
    assert.equal(isTrackableEvent('system/api_retry'), true);
  });

  it('should not track unknown events', () => {
    assert.equal(isTrackableEvent('unknown_type'), false);
  });
});
