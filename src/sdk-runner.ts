import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { StreamWatchdog, eventTypeFromMessage, isTrackableEvent } from './watchdog.js';
import type { WatchdogOptions, SilenceInfo } from './watchdog.js';

export interface SDKRunnerOptions {
  silenceThresholdMs?: number;
  maxTurns?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  model?: string;
  cwd?: string;
  systemPrompt?: string;
  mcpServer?: McpSdkServerConfigWithInstance;
  allowedTools?: string[];
  onMessage?: (msg: any) => void;
  onSilence?: (info: SilenceInfo) => void;
  onResult?: (result: any) => void;
  onSessionStart?: (sessionId: string) => void;
}

export interface RunResult {
  sessionId: string | undefined;
  result: any;
  abortedBySilence: boolean;
  resumeCount: number;
}

export async function runWithWatchdog(
  prompt: string,
  options: SDKRunnerOptions = {}
): Promise<RunResult> {
  const {
    silenceThresholdMs = 60_000,
    maxTurns = 10,
    permissionMode = 'bypassPermissions',
    model,
    cwd,
    systemPrompt,
    mcpServer,
    allowedTools = [],
    onMessage,
    onSilence,
    onResult,
    onSessionStart,
  } = options;

  let sessionId: string | undefined;
  let lastResult: any = null;
  let resumeCount = 0;
  let abortedBySilence = false;
  const maxResumes = 3;

  async function runQuery(resumeSessionId?: string): Promise<void> {
    const controller = new AbortController();

    const watchdog = new StreamWatchdog({
      silenceThresholdMs,
      onSilenceDetected: (info: SilenceInfo) => {
        console.log(
          `[watchdog] Silence detected: ${info.silenceDurationMs}ms since last ${info.lastEventType} event (session: ${info.sessionId})`
        );
        onSilence?.(info);
        abortedBySilence = true;
        controller.abort();
      },
    });

    const queryOpts: Record<string, any> = {
      abortController: controller,
      maxTurns,
      permissionMode,
    };

    if (permissionMode === 'bypassPermissions') {
      queryOpts.allowDangerouslySkipPermissions = true;
    }
    if (model) queryOpts.model = model;
    if (cwd) queryOpts.cwd = cwd;
    if (systemPrompt) queryOpts.systemPrompt = systemPrompt;
    if (allowedTools.length > 0) queryOpts.allowedTools = allowedTools;
    if (mcpServer) {
      queryOpts.mcpServers = { telegram: mcpServer };
    }

    if (resumeSessionId) {
      queryOpts.resume = resumeSessionId;
    }

    const q = query({
      prompt: resumeSessionId ? 'Continue from where you left off.' : prompt,
      options: queryOpts,
    });

    watchdog.start();

    try {
      for await (const msg of q) {
        const eventType = eventTypeFromMessage(msg as any);

        if (isTrackableEvent(eventType)) {
          watchdog.recordEvent(eventType);
        }

        if ((msg as any).type === 'system' && (msg as any).subtype === 'init') {
          sessionId = (msg as any).session_id;
          watchdog.setSessionId(sessionId!);
          onSessionStart?.(sessionId!);
          console.log(`[sdk-runner] Session started: ${sessionId}`);
        }

        if ((msg as any).type === 'result') {
          lastResult = msg;
          onResult?.(msg);
          console.log(
            `[sdk-runner] Result: subtype=${(msg as any).subtype}, turns=${(msg as any).num_turns}, cost=$${(msg as any).total_cost_usd?.toFixed(4)}`
          );
        }

        onMessage?.(msg);
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || controller.signal.aborted) {
        console.log('[sdk-runner] Query aborted (watchdog or manual)');
      } else {
        throw err;
      }
    } finally {
      watchdog.stop();
    }
  }

  await runQuery();

  while (abortedBySilence && resumeCount < maxResumes && sessionId) {
    resumeCount++;
    abortedBySilence = false;
    console.log(`[sdk-runner] Resuming session ${sessionId} (attempt ${resumeCount}/${maxResumes})`);
    await runQuery(sessionId);
  }

  return {
    sessionId,
    result: lastResult,
    abortedBySilence,
    resumeCount,
  };
}
