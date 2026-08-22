/**
 * Interaction undo scheduler
 *
 * Coalesces rapid interaction updates (keyboard nudge / wheel) into one
 * transaction by delaying commit until interaction stays idle for delayMs.
 */

export interface InteractionUndoScheduler {
  bump: () => void;
  flush: () => void;
  dispose: () => void;
}

interface CreateSchedulerOptions {
  begin: () => void;
  commit: () => void;
  delayMs: number;
}

export function createInteractionUndoScheduler(
  options: CreateSchedulerOptions,
): InteractionUndoScheduler {
  const { begin, commit, delayMs } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const commitIfStarted = () => {
    if (!started) return;
    started = false;
    commit();
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    commitIfStarted();
  };

  const bump = () => {
    if (!started) {
      begin();
      started = true;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      commitIfStarted();
    }, delayMs);
  };

  const dispose = () => {
    flush();
  };

  return { bump, flush, dispose };
}
