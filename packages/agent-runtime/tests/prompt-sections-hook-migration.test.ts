/**
 * （Wave 1）—— prompt sections / host 消息注入迁到 beforeModel 默认策略
 * 栈后的回归守门：
 *
 *   1. state 上的静态索引段 / 动态提示段信号仍以迁移前的**段名与顺序**进入
 *      LLM_REQUEST 快照（sections 列表）与 system prompt 文本；
 *   2. 静态段在 dynamic boundary 之前、动态段在 boundary 之后（prompt cache
 *      前缀稳定性依赖）；
 *   3. system prompt 文本中的 section marker 格式与迁移前 byte 一致。
 */

import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../src/engine/contracts/model-llm.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  EngineConfig,
  EngineState,
} from '../src/engine/contracts/kernel.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../src/engine/contracts/wire-protocol.js';

function makeCapturingProvider(): { provider: LLMProvider; captured: LLMRequest[] } {
  const captured: LLMRequest[] = [];
  const provider: LLMProvider = {
    async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      captured.push({ model: req.model, messages: req.messages, system: req.system, maxTokens: req.maxTokens });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
  };
  return { provider, captured };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function flattenSystem(system: LLMRequest['system']): string {
  if (!system) return '';
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
}

describe('#3941 · prompt sections 迁 beforeModel 后的段名 / 顺序守门', () => {
  it('静态索引段 + 动态提示段按迁移前顺序进入 system 与 LLM_REQUEST sections', async () => {
    const { provider, captured } = makeCapturingProvider();
    const config: EngineConfig = {
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/sections-hook-test', threadId: 'sections-hook-test' },
      model: 'test-model',
      systemPrompt: 'base system prompt',
      hooks: {
        beforeModel: async (ctx) => {
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.skills_index,
            '<skills>skill-a</skills>',
            'skills-index',
            { placement: 'static' },
          );
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.mcp_servers,
            '<mcp_servers>srv-1</mcp_servers>',
            'mcp-cap',
            { placement: 'static' },
          );
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.cli_commands,
            '<cli_commands>cmd-1</cli_commands>',
            'cli-cap',
            { placement: 'static' },
          );
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.convergence_hint,
            'convergence body',
            'token-budget',
          );
        },
      },
    };
    const runtime = createRuntime(config);
    const events = await collect(runtime.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const llmReqEvents = events.filter((e) => e.type === 'agent.stream.llm_request');
    expect(llmReqEvents.length).toBeGreaterThan(0);
    const sections = (llmReqEvents[0]!.payload as {
      system: { sections: Array<{ name: string; source: string }> };
    }).system.sections;
    const nonBase = sections.filter((s) => s.source !== 'config' && s.source !== 'base-prompt');
    // 静态顺序：skills_index → mcp_servers → cli_commands → tool_call_metadata → convergence_hint
    expect(nonBase.map((s) => `${s.name}:${s.source}`)).toEqual([
      'skills_index:skills-index',
      'mcp_servers:mcp-cap',
      'cli_commands:cli-cap',
      'tool_call_metadata:agent-runtime',
      'convergence_hint:token-budget',
    ]);

    const systemText = flattenSystem(captured[0]!.system);
    // 静态段在 dynamic boundary 之前，动态段在其后
    const boundaryIdx = systemText.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    for (const marker of [
      '<!-- section:skills_index source:skills-index -->',
      '<!-- section:mcp_servers source:mcp-cap -->',
      '<!-- section:cli_commands source:cli-cap -->',
      '<!-- section:tool_call_metadata source:agent-runtime -->',
    ]) {
      const idx = systemText.indexOf(marker);
      expect(idx, marker).toBeGreaterThan(-1);
      expect(idx, `${marker} 应在 boundary 之前`).toBeLessThan(boundaryIdx);
    }
    const dynIdx = systemText.indexOf('<!-- section:convergence_hint source:token-budget -->');
    expect(dynIdx).toBeGreaterThan(boundaryIdx);
  });

  it('run observations 注入的 user message 仍先于当轮 LLM 请求（notice + messages）', async () => {
    const { provider, captured } = makeCapturingProvider();
    const config: EngineConfig = {
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/sections-hook-test-2', threadId: 'sections-hook-test-2' },
      model: 'test-model',
      getRecentRunObservations: async () => [
        { type: 'autofill', timestamp: Date.now(), humanReadable: 'login succeeded on example.com' },
      ],
    };
    const runtime = createRuntime(config);
    const events = await collect(runtime.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const notice = events.find(
      (e) => e.type === 'agent.stream.system_notice'
        && (e.payload as { notice_type?: string }).notice_type === 'run_observation_injected',
    );
    expect(notice).toBeTruthy();
    const sentMessages = JSON.stringify(captured[0]!.messages);
    expect(sentMessages).toContain('run_observations');
    expect(sentMessages).toContain('login succeeded on example.com');
  });
});
