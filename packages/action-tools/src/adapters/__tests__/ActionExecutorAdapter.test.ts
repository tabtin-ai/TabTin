import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) => {
    if (vars) return `${key}:${JSON.stringify(vars)}`;
    return key;
  },
}));

import { ActionExecutorAdapter } from '../ActionExecutorAdapter';
import type { AgentTool } from '../../types';

function makeTool(name: string, result: any): AgentTool<any, any> {
  return {
    name,
    riskLevel: 'safe',
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('ActionExecutorAdapter', () => {
  describe('EF-02: no stdout pollution without logger', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should NOT call console.log/error during executeAction', async () => {
      const adapter = new ActionExecutorAdapter();
      const tool = makeTool('test_tool', { success: true, data: {} });
      adapter.registerTool(tool);

      await adapter.executeAction({
        task_id: 't1',
        type: 'test_tool',
        params: { foo: 'bar' },
        thread_id: 'th1',
      });

      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should NOT call console.log/error on execution failure', async () => {
      const adapter = new ActionExecutorAdapter();
      const failTool = makeTool('fail_tool', {});
      failTool.execute = vi.fn().mockRejectedValue(new Error('boom'));
      adapter.registerTool(failTool);

      const result = await adapter.executeAction({
        task_id: 't2',
        type: 'fail_tool',
        params: {},
        thread_id: 'th2',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  describe('EF-02: logger callback injection', () => {
    it('should call logger.debug when logger is provided', async () => {
      const debugFn = vi.fn();
      const adapter = new ActionExecutorAdapter({ logger: { debug: debugFn } });
      const tool = makeTool('my_tool', { success: true, data: { x: 1 } });
      adapter.registerTool(tool);

      await adapter.executeAction({
        task_id: 't3',
        type: 'my_tool',
        params: { key: 'val' },
        thread_id: 'th3',
        run_id: 'r3',
      });

      expect(debugFn).toHaveBeenCalled();
      const firstCall = debugFn.mock.calls[0];
      expect(firstCall[0]).toContain('执行动作');
    });

    it('should call logger.debug on failure when logger provided', async () => {
      const debugFn = vi.fn();
      const adapter = new ActionExecutorAdapter({ logger: { debug: debugFn } });
      const failTool = makeTool('boom_tool', {});
      failTool.execute = vi.fn().mockRejectedValue(new Error('kaboom'));
      adapter.registerTool(failTool);

      await adapter.executeAction({
        task_id: 't4',
        type: 'boom_tool',
        params: {},
        thread_id: 'th4',
      });

      const failCall = debugFn.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('执行失败')
      );
      expect(failCall).toBeTruthy();
    });

    it('should call logger.debug during transformResult for request_snapshot', async () => {
      const debugFn = vi.fn();
      const adapter = new ActionExecutorAdapter({ logger: { debug: debugFn } });
      const tool = makeTool('request_snapshot', {
        success: true,
        data: { snapshot: { url: 'http://test' } },
      });
      adapter.registerTool(tool);

      await adapter.executeAction({
        task_id: 't5',
        type: 'request_snapshot',
        params: {},
        thread_id: 'th5',
      });

      const snapshotCall = debugFn.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('snapshot')
      );
      expect(snapshotCall).toBeTruthy();
    });
  });

  describe('constructor backward compatibility', () => {
    it('works without arguments (no-arg constructor)', () => {
      const adapter = new ActionExecutorAdapter();
      expect(adapter.getRegisteredTools()).toEqual([]);
    });

    it('works with empty options', () => {
      const adapter = new ActionExecutorAdapter({});
      expect(adapter.getRegisteredTools()).toEqual([]);
    });
  });

  describe('parameter passthrough', () => {
    it('preserves arbitrary action params such as timeout_ms when enriching metadata', async () => {
      const adapter = new ActionExecutorAdapter();
      const tool = makeTool('download_resource', { success: true, data: {} });
      adapter.registerTool(tool);

      await adapter.executeAction({
        task_id: 'download-1',
        type: 'download_resource',
        params: {
          timeline: { scenes: [] },
          timeout_ms: 1_800_000,
        },
        thread_id: 'thread-1',
      });

      expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({
        timeline: { scenes: [] },
        timeout_ms: 1_800_000,
        thread_id: 'thread-1',
      }));
    });
  });
});
