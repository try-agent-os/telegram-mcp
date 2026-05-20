import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamWatchdog } from '../src/watchdog.js';
import { loadSessionId, saveSessionId, clearSessionId } from '../src/session-store.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

describe('Simulated hang detection', () => {
  it('watchdog fires abort on simulated stream stall', async () => {
    const controller = new AbortController();
    let silenceDetected = false;

    const watchdog = new StreamWatchdog({
      silenceThresholdMs: 300,
      onSilenceDetected: (info) => {
        silenceDetected = true;
        controller.abort();
      },
    });

    watchdog.setSessionId('sim-hang-test');
    watchdog.recordEvent('assistant');
    watchdog.start();

    // Simulate a stream that yields 2 events then hangs
    const fakeStream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sim-hang-test' };
      yield { type: 'assistant', message: { role: 'assistant', content: 'hi' } };
      // Hang: no more events, watchdog should fire
      await new Promise(r => setTimeout(r, 800));
      yield { type: 'result', subtype: 'success', result: 'should not reach' };
    })();

    let eventCount = 0;
    let aborted = false;

    try {
      for await (const msg of fakeStream) {
        if (controller.signal.aborted) break;
        eventCount++;
        const m = msg as any;
        if (m.type === 'assistant' || m.type === 'system' || m.type === 'result') {
          watchdog.recordEvent(m.type);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') aborted = true;
    }

    watchdog.stop();

    assert.ok(silenceDetected, 'Watchdog should detect silence during hang');
    assert.ok(controller.signal.aborted, 'Controller should be aborted');
    assert.equal(eventCount, 2, 'Should only process 2 events before hang detection');
  });
});

describe('Session store', () => {
  const testFile = join(process.cwd(), '.session-state.json');

  it('saves and loads session_id', () => {
    saveSessionId('test-session-abc');
    const loaded = loadSessionId();
    assert.equal(loaded, 'test-session-abc');

    // Cleanup
    if (existsSync(testFile)) unlinkSync(testFile);
  });

  it('returns undefined when no file', () => {
    if (existsSync(testFile)) unlinkSync(testFile);
    const loaded = loadSessionId();
    assert.equal(loaded, undefined);
  });

  it('clears session_id', () => {
    saveSessionId('test-session-xyz');
    clearSessionId();
    const loaded = loadSessionId();
    assert.equal(loaded, undefined);

    // Cleanup
    if (existsSync(testFile)) unlinkSync(testFile);
  });
});
