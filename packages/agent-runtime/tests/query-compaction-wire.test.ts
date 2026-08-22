/**
 * query.ts ↔ compaction orchestrator 接线契约。
 *
 * 不跑完整 query 循环——只锁死源码里 `runCompactionPhase` 透传字段，
 * 防止再次漏接 `timeBasedMicroCompact` / `lastAssistantTimestamp`。
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const runtimeSrc = join(dirname(fileURLToPath(import.meta.url)), '../src');

describe('ContextManager compaction wire-up ', () => {
  //  批次 3：buildCompactionOptions 随 ContextManager 实现迁至
  // compact/context-manager.ts（控制反转）；透传契约断言跟着走。
  it('passes timeBasedMicroCompact and lastAssistantTimestamp into runCompactionPhase', async () => {
    const source = await readFile(join(runtimeSrc, 'compact/context-manager.ts'), 'utf8');
    expect(source).toMatch(/timeBasedMicroCompact:\s*cfg\.timeBasedMicroCompact/);
    expect(source).toMatch(/lastAssistantTimestamp:\s*inferLastAssistantTimestamp\(state\.messages\)/);
    // LLM strip 现收在 tool-policies.applyToolResultPolicy（由 tool-phase 调用）；
    // /#6014 后 tool-phase.ts 不再内联 applyLlmStripKeys(er.result)。
    const toolPoliciesSource = await readFile(join(runtimeSrc, 'engine/tooling/tool-policies.ts'), 'utf8');
    expect(toolPoliciesSource).toMatch(/applyLlmStripKeys\(er\.result\)/);
  });

  it('passes pressureThresholds into runCompactionPhase ', async () => {
    const source = await readFile(join(runtimeSrc, 'compact/context-manager.ts'), 'utf8');
    expect(source).toMatch(/pressureThresholds:\s*cfg\.pressureThresholds/);
  });
});

describe('subagent compaction wire-up ', () => {
  it('fork-query forwards timeBasedMicroCompact into child EngineConfig', async () => {
    const source = await readFile(join(runtimeSrc, 'subagent/fork-query.ts'), 'utf8');
    expect(source).toMatch(/timeBasedMicroCompact:\s*config\.timeBasedMicroCompact/);
  });

  it('agent-tool forwards timeBasedMicroCompact into forkQuery', async () => {
    const source = await readFile(join(runtimeSrc, 'subagent/agent-tool.ts'), 'utf8');
    expect(source).toMatch(/timeBasedMicroCompact:\s*config\.timeBasedMicroCompact/);
  });
});

describe('subagent compaction wire-up ', () => {
  it('fork-query forwards pressureThresholds and contextBudget into child EngineConfig', async () => {
    const source = await readFile(join(runtimeSrc, 'subagent/fork-query.ts'), 'utf8');
    expect(source).toMatch(/pressureThresholds:\s*config\.pressureThresholds/);
    expect(source).toMatch(/contextBudget:\s*config\.contextBudget/);
  });

  it('agent-tool forwards pressureThresholds and contextBudget into forkQuery', async () => {
    const source = await readFile(join(runtimeSrc, 'subagent/agent-tool.ts'), 'utf8');
    expect(source).toMatch(/pressureThresholds:\s*config\.pressureThresholds/);
    expect(source).toMatch(/contextBudget:\s*config\.contextBudget/);
  });
});
