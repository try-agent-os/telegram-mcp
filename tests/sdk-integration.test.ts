/**
 * Integration test: verify Agent SDK query() works end-to-end.
 *
 * Requires: Claude auth configured (~/.claude/.credentials.json or ANTHROPIC_API_KEY).
 * Run: node --import tsx --test tests/sdk-integration.test.ts
 * Timeout: 60s per test (Claude needs time to respond).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '@anthropic-ai/claude-agent-sdk';

describe('Agent SDK Integration', () => {
  it('should complete a basic query and return a result', async () => {
    let sessionId: string | undefined;
    let resultMessage: any = null;
    let gotInit = false;

    for await (const msg of query({
      prompt: 'Reply with exactly: WATCHDOG_TEST_OK',
      options: {
        maxTurns: 2,
        permissionMode: 'bypassPermissions',
        allowedTools: [],
      },
    })) {
      const m = msg as any;

      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        gotInit = true;
        console.log(`  [test] Session initialized: ${sessionId}`);
      }

      if (m.type === 'result') {
        resultMessage = m;
        console.log(`  [test] Result: subtype=${m.subtype}, cost=$${m.total_cost_usd?.toFixed(4)}`);
      }
    }

    assert.ok(gotInit, 'Should receive system init message');
    assert.ok(sessionId, 'Should capture session_id');
    assert.ok(resultMessage, 'Should receive a result message');
    assert.equal(resultMessage.subtype, 'success', 'Result should be success');
    assert.ok(
      resultMessage.result?.includes('WATCHDOG_TEST_OK'),
      `Result should contain WATCHDOG_TEST_OK, got: ${resultMessage.result?.slice(0, 100)}`
    );
  }, { timeout: 120_000 });

  it('should support abort via AbortController', async () => {
    const controller = new AbortController();
    let gotInit = false;
    let gotAbort = false;

    // Abort after init
    setTimeout(() => controller.abort(), 3000);

    try {
      for await (const msg of query({
        prompt: 'Write a very long essay about the history of computing.',
        options: {
          maxTurns: 20,
          permissionMode: 'bypassPermissions',
          abortController: controller,
          allowedTools: [],
        },
      })) {
        const m = msg as any;
        if (m.type === 'system' && m.subtype === 'init') {
          gotInit = true;
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        gotAbort = true;
      } else {
        throw err;
      }
    }

    assert.ok(gotInit, 'Should receive init before abort');
    assert.ok(gotAbort || controller.signal.aborted, 'Should abort successfully');
  }, { timeout: 30_000 });
});
