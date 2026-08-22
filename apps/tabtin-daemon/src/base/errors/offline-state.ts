interface OfflineStateLogger {
  info(message: string): void;
  warn(message: string): void;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT',
  'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPIPE', 'EAI_AGAIN', 'ECONNABORTED',
]);

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as any).code ?? (err as any).errno;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

export function isAuthError(statusOrErr: unknown): boolean {
  if (typeof statusOrErr === 'number') return statusOrErr === 401 || statusOrErr === 403;
  if (statusOrErr && typeof statusOrErr === 'object') {
    const status = (statusOrErr as any).status ?? (statusOrErr as any).statusCode;
    return status === 401 || status === 403;
  }
  return false;
}

/**
 * Deduplicates repeated offline/error log messages.
 * Transitions: online → offline (prints once) → online (prints recovery).
 * While offline, subsequent failures for the same operation are silently counted.
 */
export class OfflineState {
  private state: 'online' | 'offline' = 'online';
  private failures = new Map<string, { count: number; firstAt: number; lastMessage: string }>();
  private readonly logger: OfflineStateLogger;

  constructor(logger: OfflineStateLogger) {
    this.logger = logger;
  }

  fail(operation: string, message: string): void {
    const existing = this.failures.get(operation);
    if (existing) {
      existing.count++;
      existing.lastMessage = message;
    } else {
      this.failures.set(operation, { count: 1, firstAt: Date.now(), lastMessage: message });
    }

    if (this.state === 'online') {
      this.state = 'offline';
      this.logger.warn(`[Offline] ${operation}: ${message}`);
    }
  }

  recover(): void {
    if (this.state === 'offline') {
      const summary = Array.from(this.failures.entries())
        .map(([op, f]) => `${op}(×${f.count})`)
        .join(', ');
      this.logger.info(`[Online] Recovered — suppressed: ${summary}`);
      this.state = 'online';
      this.failures.clear();
    }
  }
}
