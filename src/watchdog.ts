import type { Query } from '@anthropic-ai/claude-agent-sdk';

export interface WatchdogOptions {
  silenceThresholdMs: number;
  onSilenceDetected: (info: SilenceInfo) => void;
  onEvent?: (eventType: string) => void;
}

export interface SilenceInfo {
  sessionId: string | undefined;
  lastEventType: string;
  lastEventAt: number;
  silenceDurationMs: number;
}

export class StreamWatchdog {
  private lastEventAt: number = Date.now();
  private lastEventType: string = 'init';
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | undefined;
  private aborted = false;
  private readonly options: WatchdogOptions;

  constructor(options: WatchdogOptions) {
    this.options = options;
  }

  recordEvent(eventType: string): void {
    this.lastEventAt = Date.now();
    this.lastEventType = eventType;
    this.options.onEvent?.(eventType);
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  start(): void {
    if (this.timer) return;
    const checkInterval = Math.max(100, Math.min(1000, this.options.silenceThresholdMs / 3));
    this.timer = setInterval(() => {
      if (this.aborted) return;
      const now = Date.now();
      const silenceDuration = now - this.lastEventAt;
      if (silenceDuration >= this.options.silenceThresholdMs) {
        this.aborted = true;
        this.options.onSilenceDetected({
          sessionId: this.sessionId,
          lastEventType: this.lastEventType,
          lastEventAt: this.lastEventAt,
          silenceDurationMs: silenceDuration,
        });
      }
    }, checkInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.aborted = false;
    this.lastEventAt = Date.now();
    this.lastEventType = 'reset';
  }

  isAborted(): boolean {
    return this.aborted;
  }
}

const TRACKED_EVENT_TYPES = new Set([
  'assistant',
  'user',
  'result',
  'system',
  'partial_message',
  'status',
  'tool_use_summary',
  'rate_limit',
  'api_retry',
]);

export function eventTypeFromMessage(msg: { type: string; subtype?: string }): string {
  if (msg.type === 'system' && msg.subtype === 'api_retry') return 'system/api_retry';
  return msg.type;
}

export function isTrackableEvent(eventType: string): boolean {
  if (eventType === 'system/api_retry') return true;
  return TRACKED_EVENT_TYPES.has(eventType);
}
