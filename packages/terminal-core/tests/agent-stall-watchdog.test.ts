import { describe, expect, it, vi } from 'vitest';
import { AgentPromptStallWatchdog, looksLikeInteractivePrompt } from '../src';

describe('AgentPromptStallWatchdog', () => {
  it('recognizes common interactive prompt tails', () => {
    expect(looksLikeInteractivePrompt('Overwrite?')).toBe(true);
    expect(looksLikeInteractivePrompt('Continue?')).toBe(true);
    expect(looksLikeInteractivePrompt('Password:')).toBe(true);
    expect(looksLikeInteractivePrompt('build completed')).toBe(false);
  });

  it('fires once when output stalls on an interactive prompt', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = new AgentPromptStallWatchdog({
      intervalMs: 10,
      thresholdMs: 50,
      onStall,
    });

    watchdog.start();
    watchdog.recordOutput('Install package? (y/n)');
    await vi.advanceTimersByTimeAsync(70);

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0]).toContain('(y/n)');

    await vi.advanceTimersByTimeAsync(100);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.stop();
    vi.useRealTimers();
  });
});
