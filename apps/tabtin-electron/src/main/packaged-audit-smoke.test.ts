import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installPackagedAuditSmokeExit } from './packaged-audit-smoke';

describe('packaged audit smoke mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits through app.exit after Electron is ready', async () => {
    const app = {
      whenReady: vi.fn(() => Promise.resolve()),
      exit: vi.fn(),
      quit: vi.fn(),
    };
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const installed = installPackagedAuditSmokeExit({
      app,
      env: { TABTIN_PACKAGED_AUDIT_SMOKE: '1' },
      log,
      delayMs: 25,
    });

    expect(installed).toBe(true);

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(25);

    expect(app.exit).toHaveBeenCalledWith(0);
    expect(app.quit).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('packaged audit smoke'),
    );
  });
});
