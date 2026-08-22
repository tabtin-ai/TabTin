/**
 * 登录墙运行时硬门禁（login-wall-gate）单测。
 *
 * 背景：BlockDetector 已能确定性探测登录墙并在浏览器工具结果里投影
 * `login_required`（reason + 拦截 hint），但纯提示词约束压不住模型——
 * 真实 dogfood（XHS-2 export）里模型在 thinking 承认「弹出了登录框」后
 * 仍静默绕道 Google/知乎，拿别处内容冒充本站结果。
 *
 * 本门禁把「停下来问用户」从软约束变成系统强制：
 *   1. afterToolResult 侦测工具结果里的确定性 `login_required` 标记；
 *   2. 下一轮 beforeModel 注入 <login_wall_gate> 指引 + 工具面收窄到只剩
 *      ask_user——模型物理上无法静默绕道；
 *   3. ask_user 有了结果（用户答复/跳过/超时）即解除，且同域 run 内免再拦
 *      （误报的代价被钉在「多问一次」，不会卡死任务）;
 *   4. scheduled 无人值守档降级为注入提醒，不收窄工具（没人回答卡片，
 *      硬门禁会让自动化永远挂住）。
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
      spaceSessionId: 'sess-login-gate-test',
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
    sessionConfig: { sessionDir: '/tmp/login-wall-gate-test', threadId: 'test-session-login-gate' },
    model: 'test-model',
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => makePolicy(),
      memoStore: makeMemoStore(),
    }),
    ...overrides,
  };
}

/** Provider：记录每轮 LLMRequest（messages + tools），按序回放 chunk。 */
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

/**
 * 仿真 `tabtin browser open` 撞登录墙时 run_terminal_command 的真实输出形态
 * （stdout 是内嵌 JSON 字符串，login_required 键以转义形式出现——对齐
 * XHS-2 export 实测样本）。
 */
const LOGIN_WALL_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: JSON.stringify({
    data: {
      finalUrl: 'https://www.xiaohongshu.com/explore',
      login_required: {
        reason: '页面弹出登录浮层',
        hint: '检测到登录墙：立即停下并把选择权交给用户。',
      },
      observed_elements: [{ ref: 'e1', text: '输入手机号' }],
    },
    ok: true,
  }, null, 2),
});

const LARGE_LOGIN_WALL_TAB_ID = 'view-cs-scope-conversation_login-wall-1';
const LARGE_LOGIN_WALL_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: '{ "data": { "finalUrl": "https://www.xiaohongshu.com/explore", ... } }',
  control_signals: {
    login_required: {
      domain: 'xiaohongshu.com',
      reason: '页面弹出登录浮层',
      tab_id: LARGE_LOGIN_WALL_TAB_ID,
    },
  },
  stdout_truncated: true,
  full_output_path: '/tmp/tabtin-tool-results/login-wall/stdout.log',
});

const LEGACY_STRUCTURE_ONLY_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: JSON.stringify({
    __tabtin_output_summary: 'structure_only',
    structure: {
      data: {
        finalUrl: 'string',
        login_required: { reason: 'string', tab_id: 'string' },
      },
      ok: 'boolean',
    },
  }),
  stdout_truncated: true,
  full_output_path: '/tmp/tabtin-tool-results/login-wall/legacy-stdout.log',
});

const NORMAL_TERMINAL_OUTPUT = JSON.stringify({
  status: 'completed',
  exit_code: 0,
  stdout: JSON.stringify({ data: { finalUrl: 'https://example.com/', observed_elements: [] }, ok: true }),
});

const toolCallTurn = (id: string, name: string): LLMResponseChunk[] => [
  { type: 'tool_use', toolUse: { id, name, input: {} } },
  { type: 'stop', stopReason: 'tool_use' },
];

const finalTurn = (text: string): LLMResponseChunk[] => [
  { type: 'text_delta', text },
  { type: 'stop', stopReason: 'end_turn' },
];

describe('login-wall-gate — 登录墙运行时硬门禁', () => {
  it('大浏览器 JSON 截断后，登录接力仍从 control_signals 拿到真实域名和 tab_id', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('请选择登录或换源'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LARGE_LOGIN_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
      ]),
    }));

    await collect(rt.query({ hostRunId: 'test-run', prompt: '打开小红书' }));

    const second = capturedRequests[1]!;
    const flat = JSON.stringify(second.messages);
    expect(flat).toContain(
      `<login_wall_gate domain=\\"xiaohongshu.com\\" tab_id=\\"${LARGE_LOGIN_WALL_TAB_ID}\\">`,
    );
    expect(flat).not.toContain('<login_wall_gate domain=\\"unknown\\" tab_id=\\"string\\">');
  });

  it('旧结构摘要没有显式控制信号时，不把类型占位符误判成登录墙', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('继续处理完整输出'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LEGACY_STRUCTURE_ONLY_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
      ]),
    }));

    await collect(rt.query({ hostRunId: 'test-run', prompt: '打开网页' }));

    const second = capturedRequests[1]!;
    expect((second.tools ?? []).map((tool) => tool.name)).toContain('run_terminal_command');
    expect(JSON.stringify(second.messages)).not.toContain('<login_wall_gate');
  });

  it('工具结果带 login_required：下一轮工具面收窄到只剩 ask_user，并注入 <login_wall_gate> 指引', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('请选择登录或换源'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LOGIN_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    const events = await collect(rt.query({ hostRunId: 'test-run', prompt: '小红书搜索 cursor 技巧' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const second = capturedRequests[1]!;
    // 工具面只剩 ask_user——绕道用的 web_search / run_terminal_command 都被扣下
    expect((second.tools ?? []).map((t) => t.name)).toEqual(['ask_user']);
    // 协议层强制必调工具（tbao-1 dogfood：Kimi 曾把 ask_user 调用写成正文伪 XML
    // 后 end_turn——tool_choice: required 让上游 API 强制产出真 tool_use）
    expect(second.toolChoice).toBe('required');
    // 强制指引进入 LLM 上下文
    const flat = JSON.stringify(second.messages);
    expect(flat).toContain('<login_wall_gate domain=\\"xiaohongshu.com\\">');
    expect(flat).toContain('xiaohongshu.com');
    expect(flat).toContain('页面弹出登录浮层');
    expect(flat).toContain(
      '① 手动完成登录：本机使用 TabTin 浏览器当前标签页；若你正在其他设备遥控，用登录卡片上的「在本机登录并接力」完成，之后你复用同一 --tab-id 继续在本站获取；',
    );

    // 用户侧静默：门禁属内部机制，不发 system_notice（用户只看到 ask_user 卡片；
    // 排障走 telemetry login_wall_gate.engaged）
    const notice = events.find(
      (e) =>
        e.type === 'agent.stream.system_notice' &&
        (e.payload as Record<string, unknown>).notice_type === 'login_wall_gate_engaged',
    );
    expect(notice).toBeUndefined();
  });

  it('无 login_required 信号：工具面不受限、无注入（零行为变更）', async () => {
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
    expect(second.toolChoice).toBeUndefined();
    expect(JSON.stringify(second.messages)).not.toContain('<login_wall_gate>');
  });

  it('ask_user 出结果后解除门禁，同域 run 内不再重复拦', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'), // 撞墙
      toolCallTurn('tu-2', 'ask_user'),             // 被收窄后问用户
      toolCallTurn('tu-3', 'run_terminal_command'), // 用户答复后重试同域，仍撞墙
      finalTurn('按用户选择继续'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LOGIN_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'User has answered: 改用其他来源'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(4);
    // 第 3 轮（ask_user 结果之后）：工具面恢复、强制解除
    const third = capturedRequests[2]!;
    expect((third.tools ?? []).map((t) => t.name)).toContain('run_terminal_command');
    expect(third.toolChoice).toBeUndefined();
    // 第 4 轮：同域再撞 login_required，不再收窄（免再拦）
    const fourth = capturedRequests[3]!;
    expect((fourth.tools ?? []).map((t) => t.name)).toContain('web_search');
    expect(fourth.toolChoice).toBeUndefined();
  });

  it('同批并行 ask_user 不误解除门禁：撞墙当轮的无关 ask_user 结果不算数', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      // 第 1 轮：并行调用（只读工具可并行）——撞墙的浏览器命令 + 无关 ask_user
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'run_terminal_command', input: {} } },
        { type: 'tool_use', toolUse: { id: 'tu-2', name: 'ask_user', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      toolCallTurn('tu-3', 'ask_user'), // 门禁强制弹出的登录卡片
      finalTurn('按用户选择继续'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LOGIN_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    expect(capturedRequests.length).toBeGreaterThanOrEqual(3);
    // 第 2 轮：门禁必须仍然生效——同批的无关 ask_user 不解除（此前会被误解除，
    // 退回 dogfood 已证明压不住的纯提示词路径）
    const second = capturedRequests[1]!;
    expect((second.tools ?? []).map((t) => t.name)).toEqual(['ask_user']);
    expect(second.toolChoice).toBe('required');
    expect(JSON.stringify(second.messages)).toContain('<login_wall_gate domain=\\"xiaohongshu.com\\">');
    // 第 3 轮：门禁生效后的 ask_user 出结果 → 正常解除
    const third = capturedRequests[2]!;
    expect((third.tools ?? []).map((t) => t.name)).toContain('web_search');
    expect(third.toolChoice).toBeUndefined();
  });

  it('scheduled 无人值守档：只注入提醒，不收窄工具面', async () => {
    const { provider, capturedRequests } = makeRecordingProvider([
      toolCallTurn('tu-1', 'run_terminal_command'),
      finalTurn('done'),
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      runtimeMode: 'scheduled',
      tools: createMockToolProvider([
        makeStaticTool('run_terminal_command', LOGIN_WALL_TERMINAL_OUTPUT),
        makeStaticTool('ask_user', 'answered'),
        makeStaticTool('web_search', 'results'),
      ]),
    }));
    await collect(rt.query({ hostRunId: 'test-run', prompt: 'go' }));

    const second = capturedRequests[1]!;
    // 工具面不收窄、不强制（无人回答卡片，强制 ask 会挂死自动化）
    expect((second.tools ?? []).map((t) => t.name)).toContain('web_search');
    expect(second.toolChoice).toBeUndefined();
    // 但提醒仍注入（无人值守：诚实标注来源）
    expect(JSON.stringify(second.messages)).toContain('<login_wall_gate>');
  });
});
