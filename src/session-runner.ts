import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, McpSdkServerConfigWithInstance, Query } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { StreamWatchdog, eventTypeFromMessage, isTrackableEvent } from './watchdog.js';
import type { SilenceInfo } from './watchdog.js';

export interface SessionRunnerOptions {
  silenceThresholdMs?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  model?: string;
  cwd?: string;
  systemPrompt?: string;
  mcpServer?: McpSdkServerConfigWithInstance;
  allowedTools?: string[];
}

export interface SessionRunnerEvents {
  message: [msg: any];
  result: [msg: any];
  sessionStart: [sessionId: string];
  silence: [info: SilenceInfo];
  error: [err: Error];
  closed: [];
}

export class SessionRunner extends EventEmitter<SessionRunnerEvents> {
  private q: Query | null = null;
  private sessionId: string | undefined;
  private watchdog: StreamWatchdog;
  private controller: AbortController;
  private consuming = false;
  private abortedBySilence = false;
  private resumeCount = 0;
  private readonly maxResumes = 3;
  private lastPrompt: string = '';
  private readonly options: SessionRunnerOptions;

  constructor(options: SessionRunnerOptions = {}) {
    super();
    this.options = options;
    this.controller = new AbortController();
    this.watchdog = new StreamWatchdog({
      silenceThresholdMs: options.silenceThresholdMs ?? 60_000,
      onSilenceDetected: (info: SilenceInfo) => {
        console.log(
          `[session] Silence: ${info.silenceDurationMs}ms since ${info.lastEventType} (session: ${info.sessionId})`
        );
        this.abortedBySilence = true;
        this.controller.abort();
        this.emit('silence', info);
      },
    });
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get isActive(): boolean {
    return this.q !== null && this.consuming;
  }

  async start(prompt: string, resumeSessionId?: string): Promise<void> {
    if (this.q) {
      throw new Error('Session already running. Call close() first.');
    }

    this.lastPrompt = prompt;
    this.resumeCount = 0;
    this.abortedBySilence = false;
    this.startQuery(prompt, resumeSessionId);
  }

  private startQuery(prompt: string, resumeSessionId?: string): void {
    this.controller = new AbortController();
    const opts = this.buildQueryOptions(resumeSessionId);

    this.q = query({
      prompt: resumeSessionId ? `Continue from where you left off.\n\n${prompt}` : prompt,
      options: opts,
    });

    this.watchdog.reset();
    this.watchdog.start();
    this.consuming = true;
    this.consumeStream();
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.q) {
      throw new Error('No active session. Call start() first.');
    }

    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };

    this.watchdog.recordEvent('user_input');
    console.log(`[session] Sending message: ${text.slice(0, 100)}...`);

    await this.q.streamInput((async function* () {
      yield msg;
    })());
  }

  close(): void {
    this.watchdog.stop();
    if (this.q) {
      this.q.close();
      this.q = null;
    }
    this.consuming = false;
  }

  async closeGraceful(gracefulTimeoutMs: number = 8_000): Promise<void> {
    this.watchdog.stop();

    if (!this.q) {
      this.consuming = false;
      this.emit('closed');
      return;
    }

    this.q.close();

    const phase1 = await Promise.race([
      new Promise<true>(resolve => this.once('closed', () => resolve(true))),
      new Promise<false>(resolve => setTimeout(() => resolve(false), gracefulTimeoutMs)),
    ]);

    if (phase1) {
      this.q = null;
      this.consuming = false;
      return;
    }

    console.log('[session] Graceful close timed out, aborting...');
    this.controller.abort();

    const phase2 = await Promise.race([
      new Promise<true>(resolve => this.once('closed', () => resolve(true))),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!phase2) {
      console.warn('[session] Abort timed out, forcing cleanup');
    }

    this.q = null;
    this.consuming = false;
  }

  private buildQueryOptions(resumeSessionId?: string): Record<string, any> {
    const {
      maxTurns = 50,
      maxBudgetUsd = parseFloat(process.env.MAX_BUDGET_USD || '5'),
      permissionMode = 'bypassPermissions',
      model,
      cwd,
      systemPrompt,
      mcpServer,
      allowedTools = [],
    } = this.options;

    const opts: Record<string, any> = {
      abortController: this.controller,
      maxTurns,
      maxBudgetUsd,
      permissionMode,
    };

    if (permissionMode === 'bypassPermissions') {
      opts.allowDangerouslySkipPermissions = true;
    }
    if (model) opts.model = model;
    if (cwd) opts.cwd = cwd;
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (allowedTools.length > 0) opts.allowedTools = allowedTools;
    if (mcpServer) opts.mcpServers = { telegram: mcpServer };
    if (resumeSessionId) opts.resume = resumeSessionId;

    return opts;
  }

  private async consumeStream(): Promise<void> {
    if (!this.q) return;

    try {
      for await (const msg of this.q) {
        const m = msg as any;
        const eventType = eventTypeFromMessage(m);

        if (isTrackableEvent(eventType)) {
          this.watchdog.recordEvent(eventType);
        }

        if (m.type === 'system' && m.subtype === 'init') {
          this.sessionId = m.session_id;
          this.watchdog.setSessionId(this.sessionId!);
          this.emit('sessionStart', this.sessionId!);
          console.log(`[session] Started: ${this.sessionId}`);
        }

        if (m.type === 'result') {
          this.emit('result', m);
          console.log(
            `[session] Result: subtype=${m.subtype}, turns=${m.num_turns}, cost=$${m.total_cost_usd?.toFixed(4)}`
          );
        }

        this.emit('message', m);
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || this.controller.signal.aborted) {
        console.log('[session] Aborted (watchdog or manual)');
      } else {
        console.error('[session] Stream error:', err.message);
        this.emit('error', err);
      }
    } finally {
      this.watchdog.stop();
      this.consuming = false;
      this.q = null;

      if (this.abortedBySilence && this.resumeCount < this.maxResumes && this.sessionId) {
        this.resumeCount++;
        this.abortedBySilence = false;
        console.log(`[session] Auto-resuming session ${this.sessionId} (attempt ${this.resumeCount}/${this.maxResumes})`);
        this.startQuery(this.lastPrompt, this.sessionId);
        return;
      }

      this.emit('closed');
    }
  }
}
