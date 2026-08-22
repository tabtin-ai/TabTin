import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../src/platform/system/process/process-manager.js';
import { ConfigManager } from '../src/platform/system/config/config-manager.js';
import type { Logger } from '../src/platform/observability/logging/logger.js';

describe('ProcessManager lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('is idempotent and removes every process listener on cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'tabtin-process-manager-'));
    roots.push(root);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const manager = new ProcessManager(new ConfigManager(root), logger, vi.fn());
    const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2', 'uncaughtException', 'unhandledRejection'] as const;
    const before = Object.fromEntries(events.map((event) => [event, process.listenerCount(event)]));

    manager.setup();
    manager.setup();
    for (const event of events) expect(process.listenerCount(event)).toBe(before[event] + 1);

    manager.cleanup();
    for (const event of events) expect(process.listenerCount(event)).toBe(before[event]);
  });
});
