/**
 * DynamicToolManager 单元测试：recoverFromMessages iteration calibration。
 */

import { describe, it, expect } from 'vitest';
import {
  createMockToolProvider,
} from './test-utils.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';

describe('DynamicToolManager.recoverFromMessages iteration calibration', () => {
  // Wave 2g review：防御性测试——确保 `currentIteration` 被正确传给 activate，
  // 这样未来如果 state.iteration 跨 session 持久化，resume 时恢复的工具不会
  // 立即被 evictStale 吞掉。
  it('uses currentIteration arg for lastUsedIteration (so evictStale does not immediately drop it)', async () => {
    const { DynamicToolManager } = await import('../src/engine/tooling/dynamic-tool-manager.js');
    const mgr = new DynamicToolManager();
    const tool: Tool = {
      name: 'dyn',
      description: 'Dynamic tool',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      execute: async () => ({ content: 'ok' }),
    };
    const provider = createMockToolProvider([tool]);
    const staticNames = new Set<string>(); // dyn 不在 static

    const messages: Array<{
      role: 'assistant'; content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>;
    }> = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'dyn', input: {} }],
      },
    ];

    // 模拟"resume 时当前 iteration=15"
    const recovered = mgr.recoverFromMessages(messages as never, provider, staticNames, 15);
    expect(recovered).toEqual(['dyn']);

    // 立刻调 evictStale(15) 不应驱逐——因为 lastUsedIteration=15，ttl=8，
    // 15-15=0 < 8
    const evicted = mgr.evictStale(15, 8);
    expect(evicted).toEqual([]);

    // 走到 iteration=23（15 + 8）才刚够驱逐
    const evicted2 = mgr.evictStale(23, 8);
    expect(evicted2).toEqual(['dyn']);
  });
});
