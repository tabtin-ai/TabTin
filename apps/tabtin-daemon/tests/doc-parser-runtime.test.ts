import { describe, expect, it, vi } from 'vitest';
import type { WorkerTaskRunner } from '@tabtin/local-docparse/workers';

import { DocParserRuntime } from '../src/platform/content/document/doc-parser-runner.js';

describe('DocParserRuntime', () => {
  it('lazily shares one worker pool and rejects resource resurrection after disposal', async () => {
    const first = createRunner('first');
    const second = createRunner('second');
    const create = vi.fn()
      .mockReturnValueOnce(first.runner)
      .mockReturnValueOnce(second.runner);
    const runtime = new DocParserRuntime(create);

    await runtime.runTask('parse-pdf', {} as never, {});
    await runtime.runTask('parse-pdf', {} as never, {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(first.runTask).toHaveBeenCalledTimes(2);

    await runtime.dispose();
    await runtime.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);

    await expect(runtime.runTask('parse-pdf', {} as never, {})).rejects.toThrow('disposed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.runTask).not.toHaveBeenCalled();
  });

  it('rejects new work while disposal is in flight and shares the disposal operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runner = createRunner('result');
    runner.dispose.mockReturnValue(gate);
    const runtime = new DocParserRuntime(() => runner.runner);
    await runtime.runTask('parse-pdf', {} as never, {});

    const firstDispose = runtime.dispose();
    const secondDispose = runtime.dispose();
    await expect(runtime.runTask('parse-pdf', {} as never, {})).rejects.toThrow('disposing');
    release();
    await Promise.all([firstDispose, secondDispose]);
    expect(runner.dispose).toHaveBeenCalledTimes(1);
  });
});

function createRunner(result: string) {
  const runTask = vi.fn().mockResolvedValue(result);
  const dispose = vi.fn().mockResolvedValue(undefined);
  return {
    runTask,
    dispose,
    runner: { runTask, dispose } as unknown as WorkerTaskRunner,
  };
}
