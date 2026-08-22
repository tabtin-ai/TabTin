/**
 * `buildUsagePayload` 单测 —— context-ring 用量字段回归守门。
 *
 * 这个函数把 `EngineState` 字段映射到 wire 层 `UsageReport`，是 ring 用量
 * 路径的关键节点：
 *
 *   - turn 累加字段（input_tokens / output_tokens / cache_*）来自 state.total*
 *     —— 计费 / 统计语义；
 *   - per-call 字段（last_input_tokens / last_cache_read_input_tokens /
 *     last_cache_creation_input_tokens）来自 state._lastUsageAnchor
 *     —— 当前上下文规模语义，作为当前上下文用量分子。
 *
 * 这次改造之前的事故（context_tokens 字段在编排迁移时漏迁，导致 ring 永远
 * 不显示）就是因为「字段映射」层没有任何测试守门——一个 silent fallback
 * 演化半年才被发现。本测试集刻意用 `__forTesting` export 直接覆盖这一层，
 * 不依赖整条 engine 状态机 mock。
 *
 * 覆盖场景：
 *   1. anchor 完全缺失（runtime 还没 receive 第一个 usage chunk）
 *   2. anchor 存在 + 三字段全有真值
 *   3. anchor.inputTokens === 0（100% prompt cache hit 极端 case）
 *   4. anchor 存在 + cache 字段 undefined（provider 不返回 cache 分项）
 *   5. cache 字段为 0（provider 返回 0，区别于 undefined）
 *   6. turn 累加值与 anchor 值并存且不相等（多 LLM 调用 turn 验证语义分离）
 */

import { describe, expect, it } from 'vitest';
//  批次 6：buildUsagePayload 的真实归属是 wire/done-payloads（query.ts
// 的 __forTesting 转口已随 loop.ts 收官删除），直接从领域文件导入。
import { buildUsagePayload } from '../src/engine/wire/done-payloads.js';

/**
 * 构造一个最小可用的 EngineState mock —— 只填测试关心的字段，其他用 unknown
 * 让 cast 通过。`buildUsagePayload` 实现里只读了 token / cost / charge_status
 * 那一组字段，所以这个 mock 足够。
 */
function mkState(overrides: Record<string, unknown> = {}) {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalReasoningTokens: 0,
    creditsCharged: 0,
    compactInputTokens: 0,
    compactOutputTokens: 0,
    _lastChargeStatus: undefined,
    _lastUsageAnchor: undefined,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('buildUsagePayload — context-ring 字段映射守门', () => {
  it('anchor 缺失：last_* 三字段全 undefined（不能伪造成 0）', () => {
    const state = mkState({
      totalInputTokens: 1000,
      totalOutputTokens: 500,
    });
    const payload = buildUsagePayload(state);
    expect(payload.input_tokens).toBe(1000);
    expect(payload.output_tokens).toBe(500);
    // 关键：anchor 不存在时 last_* 必须是 undefined，不能是 0。
    // 0 会让 renderer extractMessageUsage 误以为「字段存在但是 0」走 last_* 路径
    // → 跟没 last_* 兜底走 turn 累加路径产生不一致。
    expect(payload.last_input_tokens).toBeUndefined();
    expect(payload.last_cache_read_input_tokens).toBeUndefined();
    expect(payload.last_cache_creation_input_tokens).toBeUndefined();
  });

  it('anchor 完整：last_* 三字段透传 anchor 值', () => {
    const state = mkState({
      totalInputTokens: 3000, // turn 累加 = 3 次 LLM 调用之和
      totalOutputTokens: 600,
      _lastUsageAnchor: {
        inputTokens: 1200, // 最后一次 LLM 看到的 input
        cacheReadTokens: 200,
        cacheCreationTokens: 50,
        messageCount: 5,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    // turn 累加保留（计费）
    expect(payload.input_tokens).toBe(3000);
    // 最近一次（上下文规模）
    expect(payload.last_input_tokens).toBe(1200);
    expect(payload.last_cache_read_input_tokens).toBe(200);
    expect(payload.last_cache_creation_input_tokens).toBe(50);
  });

  it('anchor.inputTokens === 0 合法（100% prompt cache hit）：必须传 0 不能吞', () => {
    // 历史 bug 回归：之前用 `||` 兜底会把合法 0 变 undefined → renderer
    // 走 turn 累加 fallback → 跨 turn 比较时数值跳变。换成 `??` 后必须保 0。
    const state = mkState({
      totalInputTokens: 0,
      _lastUsageAnchor: {
        inputTokens: 0,
        cacheReadTokens: 1500, // 100% cache hit：input 全归 cache_read
        cacheCreationTokens: 0,
        messageCount: 3,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    expect(payload.last_input_tokens).toBe(0); // 不是 undefined
    expect(payload.last_cache_read_input_tokens).toBe(1500);
    expect(payload.last_cache_creation_input_tokens).toBe(0); // 也不是 undefined
  });

  it('anchor 存在但 cache 字段 undefined：last_cache_* 也是 undefined（provider 不上报）', () => {
    const state = mkState({
      _lastUsageAnchor: {
        inputTokens: 800,
        cacheReadTokens: undefined,
        cacheCreationTokens: undefined,
        messageCount: 2,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    expect(payload.last_input_tokens).toBe(800);
    expect(payload.last_cache_read_input_tokens).toBeUndefined();
    expect(payload.last_cache_creation_input_tokens).toBeUndefined();
  });

  it('turn 累加 vs anchor：多 LLM 调用 turn 中两套字段语义分离', () => {
    // 真实场景：单 turn 内 3 次 LLM 调用，每次喂入逐渐增长（含历史 + tool_result）
    //   1st call: input=500
    //   2nd call: input=900 (含第 1 次的 tool_result)
    //   3rd call: input=1300 (含前两次的 tool_result)
    //   accum: 500 + 900 + 1300 = 2700
    //   last (3rd call's anchor): 1300 — 这是用户当前真实上下文规模
    const state = mkState({
      totalInputTokens: 2700,
      totalOutputTokens: 450,
      _lastUsageAnchor: {
        inputTokens: 1300,
        messageCount: 7,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    // 计费视角：本 turn 总 input 消耗 = 2700
    expect(payload.input_tokens).toBe(2700);
    // 上下文视角：最后一次喂进的是 1300（ring 应显示 1300/window）
    expect(payload.last_input_tokens).toBe(1300);
    // 两个数字相差 2x —— 如果 ring 错用了 turn 累加，会虚高 2x
  });

  it('charge_status 与 last_* 字段相互独立', () => {
    // 防御回归：曾经有担心「last_* 添加是否影响计费 charge_status 透传」
    const state = mkState({
      _lastChargeStatus: 'success',
      _lastUsageAnchor: {
        inputTokens: 500,
        messageCount: 1,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    expect(payload.charge_status).toBe('success');
    expect(payload.last_input_tokens).toBe(500);
  });

  it('compact / reasoning / cost 字段与 last_* 共存且不互相干扰', () => {
    const state = mkState({
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalCacheReadTokens: 300,
      totalCacheCreationTokens: 100,
      totalReasoningTokens: 80,
      compactInputTokens: 1500,
      compactOutputTokens: 300,
      creditsCharged: 0.0123,
      _lastUsageAnchor: {
        inputTokens: 1000,
        cacheReadTokens: 300,
        cacheCreationTokens: 100,
        messageCount: 4,
        timestamp: Date.now(),
      },
    });
    const payload = buildUsagePayload(state);
    expect(payload.input_tokens).toBe(1000);
    expect(payload.cache_read_input_tokens).toBe(300);
    expect(payload.cache_creation_input_tokens).toBe(100);
    expect(payload.reasoning_tokens).toBe(80);
    expect(payload.compact_input_tokens).toBe(1500);
    expect(payload.compact_output_tokens).toBe(300);
    expect(payload.cost_usd).toBe(0.0123);
    expect(payload.last_input_tokens).toBe(1000);
    expect(payload.last_cache_read_input_tokens).toBe(300);
    expect(payload.last_cache_creation_input_tokens).toBe(100);
  });
});
