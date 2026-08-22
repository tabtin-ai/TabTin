/**
 * 验证码运行时硬门禁（captcha-wall-gate）单测——对齐 login-wall-gate 契约。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMRequest,
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type { Tool } from '../src/engine/contracts/tools.js';
import type { EngineConfig } from '../src/engine/contracts/kernel.js';
import type { EffectivePolicy, MemoStore } from '@tabtin/security-policy';

function makeMemoStore(): MemoStore {
  return {
    lookup: () => null,
    putAlways: async () => undefined,
    putThread: () => undefined,
  };
}

function makePolicy(): EffectivePolicy {
  return {
    approvalMode: 'auto',
    workspace: {
      sources: {
        sandbox: '/tmp/sandbox',
        workingDir: '',
        sessionApprovedPaths: [],
        attachedFiles: [],
      },
      allowedPaths: ['/tmp/sandbox'],
      allowedFiles: [],
      spaceSessionId: 'sess-captcha-gate-test',
    },
    memo: { generation: 0, entries: {} },
    executionLimits: {},
    planModeGuardActive: false,
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: undefined as unknown as LLMProvider,
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/captcha-wall-gate-test', threadId: 'test-session-captcha-gate' },
    model: 'test-model',
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => makePolicy(),
      memoStore: makeMemoStore(),
    }),
    ...overrides,
  };
}

function makeRecordingProvider(
  chunkSequences: LLMResponseChunk[][],
): { provider: LLMProvider; capturedRequests: LLMRequest[] } {
  const capturedRequests: LLMRequest[] = [];
  let idx = 0;
  const provider: LLMProvider = {
    async *createStream(req: LLMRequest): AsyncIterable<LLMResponseChunk> {
      capturedRequests.push({
        model: req.model,
        messages: JSON.parse(JSON.stringify(req.messages)),
        tools: req.tools ? JSON.parse(JSON.stringify(req.tools)) : undefined,
        toolChoice: req.toolChoice,
        system: req.system,
        maxTokens: req.maxTokens,
      });
      const chunks = chunkSequences[idx++] ?? [
        { type: 'text_delta', text: 'fallback' },
        { type: 'stop', stopReason: 'end_turn' },
      ];
      for (const c of chunks) yield c;
    },
  };
  return { provider, capturedRequests };
}

function makeStaticTool(name: string, output: string): Tool {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: async () => ({ content: output }),
  };
}

const CAPTCHA_WALL_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: JSON.stringify({
    data: {
      page_url: 'https://www.google.com/search?q=agent',
      captcha_required: {
        reason: '页面需要完成验证码（recaptcha-v2）',
        type: 'recaptcha-v2',
        hint: '检测到人机验证（CAPTCHA）：立即停下。',
      },
      observed_elements: [{ ref: 'e1', text: '验证' }],
    },
    ok: true,
  }, null, 2),
});

const NORMAL_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: JSON.stringify({ data: { page_url: 'https://example.com/', observed_elements: [] }, ok: true }),
});

const toolCallTurn = (id: string, name: string): LLMResponseChunk[] => [
  { type: 'tool_use', toolUse: { id, name, input: {} } },
  { type: 'stop', stopReason: 'tool_use' },
];

const finalTurn = (text: string): LLMResponseChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'end_turn' },
];

describe('captcha-wall-gate — 验证码运行时硬门禁', () => {
  it('工具结果带 captcha_required：下一轮只留 ask_user，并注入 <captcha_wall_gate>', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('请完成验证'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', CAPTCHA_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: 'Google 搜 agent产品' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const second = capturedRequests[1]!;
    expect((second.tools ?? []).map((t) => t.name)).toEqual(['ask_user']);
    expect(second.toolChoice).toBe('required');
    const flat = JSON.stringify(second.messages);
    expect(flat).toContain('<captcha_wall_gate>');
    expect(flat).toContain('google.com');
    expect(flat).toContain('页面需要完成验证码（recaptcha-v2）');

    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'captcha_wall_gate_engaged',
    );
    expect(notice).toBeUndefined();
  });

  it('CONNECTION_TIMEOUT 的 error.detail.captcha_required 也能挂上门禁', async () => {
    const timeoutWithCaptcha = JSON.stringify({
      status: 'completed',
      exit_code: 7,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'CONNECTION_TIMEOUT',
          message: 'Electron browser act 执行超过 25s',
          detail: {
            tabId: 'tab-1',
            timeoutMs: 25000,
            page_url: 'https://www.google.com/sorry/index',
            captcha_required: {
              reason: '页面需要完成验证码（recaptcha-v2）',
              type: 'recaptcha-v2',
              hint: '检测到人机验证（CAPTCHA）：立即停下。',
            },
          },
        },
      }, null, 2),
    });
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-to', 'run_terminal_command'),
      finalTurn('请完成验证'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', timeoutWithCaptcha),
        makeStaticTool('ask_user', 'answered'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: '继续搜' }));

    const second = capturedRequests[1]!;
    expect((second.tools ?? []).map((t) => t.name)).toEqual(['ask_user']);
    expect(JSON.stringify(second.messages)).toContain('<captcha_wall_gate>');
  });

  it('无 captcha_required：工具面不受限', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('done'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', NORMAL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    const second = capturedRequests[1]!;
    expect((second.tools ?? []).map((t) => t.name)).toContain('run_terminal_command');
    expect(JSON.stringify(second.messages)).not.toContain('<captcha_wall_gate>');
  });

  it('ask_user 出结果后解除门禁，同域不再重复拦', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      toolCallTurn('tu-2', 'ask_user'),
      toolCallTurn('tu-3', 'run_terminal_command'),
      finalTurn('done'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', CAPTCHA_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', '已完成验证'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: '搜一下' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(4);
    // ask_user 之后：工具面恢复（不再 force ask_user）
    const third = capturedRequests[2]!;
    expect((third.tools ?? []).map((t) => t.name)).toContain('run_terminal_command');
    expect(third.toolChoice).toBeUndefined();
    // 同域再撞 captcha_required：免再拦
    const fourth = capturedRequests[3]!;
    expect((fourth.tools ?? []).map((t) => t.name)).toContain('web_search');
    expect(fourth.toolChoice).toBeUndefined();
  });
});
