/**
 * toolRiskPolicy 缺省 fail-closed。
 */

import { describe, expect, it } from 'vitest';

import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';

describe('toolRiskPolicy required', () => {
  it('throws when toolRiskPolicy missing and no legacy opt-in', async () => {
    const registry = new ToolRegistry();
    const gen = runTools({
      toolUseBlocks: [],
      registry,
      context: {} as never,
      permissionHandler: {
        requestPermissionsBatch: async () => [],
      } as never,
    });
    await expect(gen.next()).rejects.toThrow(/toolRiskPolicy is required/);
  });

  it('allows empty tool list when allowLegacyPermissionFallback is set', async () => {
    const registry = new ToolRegistry();
    const gen = runTools({
      toolUseBlocks: [],
      registry,
      context: {} as never,
      permissionHandler: {
        requestPermissionsBatch: async () => [],
      } as never,
      options: { allowLegacyPermissionFallback: true },
    });
    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toEqual([]);
  });
});
