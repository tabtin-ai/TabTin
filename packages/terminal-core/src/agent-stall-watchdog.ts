const DEFAULT_STALL_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
const DEFAULT_TAIL_CHARS = 4096;

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
  /password[:：]?\s*$/i,
  /passphrase[:：]?\s*$/i,
];

export function looksLikeInteractivePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split(/\r?\n/).pop() ?? '';
  return PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

export interface AgentPromptStallWatchdogOptions {
  intervalMs?: number;
  thresholdMs?: number;
  tailChars?: number;
  onStall: (tail: string) => void;
}

/**
 * Detects background commands that stop producing output while the last line
 * looks like an interactive prompt. It does not kill the process; callers add
 * a transcript/output-file hint so the LLM can stop and retry non-interactively.
 */
export class AgentPromptStallWatchdog {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly tailChars: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGrowthAt = Date.now();
  private tail = '';
  private fired = false;

  constructor(private readonly options: AgentPromptStallWatchdogOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_STALL_CHECK_INTERVAL_MS;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.tailChars = options.tailChars ?? DEFAULT_TAIL_CHARS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  recordOutput(data: string): void {
    if (!data) return;
    this.lastGrowthAt = Date.now();
    this.tail = (this.tail + data).slice(-this.tailChars);
  }

  private check(): void {
    if (this.fired) return;
    if (Date.now() - this.lastGrowthAt < this.thresholdMs) return;
    if (!looksLikeInteractivePrompt(this.tail)) {
      this.lastGrowthAt = Date.now();
      return;
    }
    this.fired = true;
    this.stop();
    this.options.onStall(this.tail);
  }
}
