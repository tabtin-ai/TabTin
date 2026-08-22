/**
 * Fake Capabilities —— 仅服务于 capability/__tests__ 的测试 fixture。
 *
 * **不是真实 Capability 实现**。真实的 7 个 Capability（FileSystem /
 * Shell / Skills / TabData / TabDoc / Audit / Cost）由 W2 实施。
 *
 * **设计原则**：
 *   - 最小化逻辑（仅满足测试断言所需）
 *   - 暴露 hook 调用记录（让测试断言"按 caps 顺序调用"）
 *   - 不依赖任何真实 BackendSession 实现（测试也不需要）
 */

import type {
  SystemSectionName,
} from '../../../engine/contracts/wire-protocol.js';
import type {
  Tool,
  ToolResult,
} from '../../../engine/contracts/tools.js';
import type {
  BeforeModelContext,
  EngineHooks,
  EngineState,
  IterationHookContext,
  RunHookContext,
  ToolHookContext,
} from '../../../engine/contracts/kernel.js';
import { CapabilityBase } from '../../base.js';
import type {
  AgentHomeLayout,
  BackendSession,
  BackendSessionCapabilities,
  ExecOptions,
  ExecResult,
} from '../../backend-session.js';

/**
 * 极简 mock BackendSession —— 仅满足 bind / clone 测试需要。
 *
 * 不实现任何真实 IO，所有方法 throw 提示"测试 fixture 不支持此操作"。
 * 测试需要更多功能时，应在测试内部局部 mock，避免本 fixture 越长。
 */
export function makeFakeSession(sessionId: string): BackendSession {
  const agentHome: AgentHomeLayout = {
    scratchpad: `/tmp/fake/${sessionId}/scratchpad`,
    output: `/tmp/fake/${sessionId}/output`,
    sessions: `/tmp/fake/${sessionId}/sessions`,
    skills: `/tmp/fake/${sessionId}/skills`,
  };
  const capabilities: BackendSessionCapabilities = {
    supportsInteractive: false,
    supportsSandbox: false,
    supportsNetworkIsolation: false,
    supportsFileSystemIsolation: false,
    latencyClass: 'local',
    platforms: ['darwin'],
    supportsPersistence: false,
    supportsHibernate: false,
    supportsCheckpoint: false,
    supportsMount: false,
    supportsBackground: false,
  };
  const notSupported = (name: string) => () => {
    throw new Error(`fake session: ${name} not supported in test fixture`);
  };
  return {
    sessionId,
    backendType: 'local',
    capabilities,
    agentHome,
    read: notSupported('read'),
    write: notSupported('write'),
    mkdir: notSupported('mkdir'),
    rm: notSupported('rm'),
    exists: notSupported('exists'),
    ls: notSupported('ls'),
    exec: async (_command: string, _opts?: ExecOptions): Promise<ExecResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
    }),
    running: async () => true,
    shutdown: async () => {
      /* noop */
    },
  };
}

/**
 * 共享调用记录 —— 让测试可断言"两个 cap 的 hooks 按顺序调用"。
 */
export interface HookCallRecorder {
  calls: Array<{ cap: string; hook: string; iteration?: number }>;
}

export function makeRecorder(): HookCallRecorder {
  return { calls: [] };
}

/**  批次 10：捕获 beforeModel 的 appendSystemSection 调用。 */
export interface CapturedSystemSection {
  name: SystemSectionName;
  content: string;
  source: string;
  placement?: string;
}

export type MockBeforeModelContext = BeforeModelContext & {
  sections: CapturedSystemSection[];
};

export function makeBeforeModelCtx(
  state: EngineState,
  iteration = 0,
): MockBeforeModelContext {
  const sections: CapturedSystemSection[] = [];
  return {
    state,
    iteration,
    sections,
    appendSystemSection: (name, content, source, opts) => {
      sections.push({ name, content, source, placement: opts?.placement });
    },
    setGraceTurn: () => {},
    isGraceTurn: () => false,
    restrictToolsForTurn: () => {},
    requestTerminate: () => {},
    emitEvent: () => {},
    emitNotice: () => {},
  };
}

export function sectionContent(
  sections: CapturedSystemSection[],
  name: SystemSectionName,
): string | undefined {
  return sections.find((s) => s.name === name)?.content;
}

// ───  批次 11：单代 ctx 契约的轻量 ctx 构造 helper ────────────────
//
// 测试直接调 hooks 时用这三个 helper 构造最小 ctx（emit 落空即可——
// 需要断言事件的测试自行覆盖 emitEvent / emitNotice）。

/** beforeRun / afterRun 用的最小 RunHookContext。 */
export function makeRunCtx(state: EngineState): RunHookContext {
  return {
    state,
    runId: 'test-run',
    emitEvent: () => {},
    emitNotice: () => {},
  };
}

/**
 * beforeIteration / afterIteration 用的最小 IterationHookContext。
 *
 *  Phase 0：`requestForceFinal(reason)` 是 IterationHookContext 硬契约
 * （force_final 显式通道，替代旧 `state.__force_final__` 黑板偷渡）。可选
 * `onForceFinal` 让测试捕获收尾原因；缺省时 no-op。
 */
export function makeIterationCtx(
  state: EngineState,
  iteration = 0,
  onForceFinal?: (reason: string) => void,
): IterationHookContext {
  return {
    state,
    iteration,
    runId: 'test-run',
    emitEvent: () => {},
    emitNotice: () => {},
    requestForceFinal: (reason: string) => onForceFinal?.(reason),
  };
}

/** beforeTool / afterTool 用的最小 ToolHookContext（result 仅 afterTool 传）。 */
export function makeToolCtx(
  state: EngineState,
  tool: Tool,
  input: unknown,
  result?: ToolResult,
): ToolHookContext {
  return {
    state,
    tool,
    input,
    result,
    emitEvent: () => {},
    emitNotice: () => {},
  };
}

/**
 * FakeFileSystemCap —— core 类，提供两个工具 + hooks。
 * 用于 prepareAgentTools / composeCapabilityHooks 测试。
 */
export class FakeFileSystemCap extends CapabilityBase {
  readonly type = 'filesystem';
  readonly category = 'core' as const;

  /** 暴露给测试断言：clone 后是否被重置 */
  internalState: { counter: number } = { counter: 0 };

  constructor(private readonly recorder?: HookCallRecorder) {
    super();
  }

  tools(): Tool[] {
    return [
      {
        name: 'list_directory',
        description: 'List a directory',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        isReadOnly: true,
        execute: async () => ({ content: 'fake' }),
      },
      {
        name: 'mkdir',
        description: 'Create a directory',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        isReadOnly: false,
        execute: async () => ({ content: 'fake' }),
      },
    ];
  }

  hooks(): EngineHooks {
    const rec = this.recorder;
    return {
      beforeRun: async (_ctx: RunHookContext) => {
        rec?.calls.push({ cap: this.type, hook: 'beforeRun' });
      },
      beforeIteration: async (ctx: IterationHookContext) => {
        rec?.calls.push({ cap: this.type, hook: 'beforeIteration', iteration: ctx.iteration });
      },
    };
  }

  sampling_params(_current: Record<string, unknown>): Record<string, unknown> {
    return { temperature: 0.3, fs_extra: { from: this.type } };
  }
}

/**
 * FakeShellCap —— 依赖 filesystem。用于 validateDependencies 测试。
 */
export class FakeShellCap extends CapabilityBase {
  readonly type = 'shell';
  readonly category = 'core' as const;

  constructor(private readonly recorder?: HookCallRecorder) {
    super();
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set(['filesystem']);
  }

  tools(): Tool[] {
    return [
      {
        name: 'exec_command',
        description: 'Run a shell command',
        inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } },
        isReadOnly: false,
        execute: async () => ({ content: 'ok' }),
      },
    ];
  }

  hooks(): EngineHooks {
    const rec = this.recorder;
    return {
      beforeRun: async (_ctx: RunHookContext) => {
        rec?.calls.push({ cap: this.type, hook: 'beforeRun' });
      },
      beforeIteration: async (ctx: IterationHookContext) => {
        rec?.calls.push({ cap: this.type, hook: 'beforeIteration', iteration: ctx.iteration });
      },
    };
  }

  sampling_params(_current: Record<string, unknown>): Record<string, unknown> {
    return { fs_extra: { extra: 'shell' }, max_tokens: 4096 };
  }
}

/**
 * FakeMemoryCap —— app 类，依赖 filesystem，用于多依赖 / on_session_stop 测试。
 */
export class FakeMemoryCap extends CapabilityBase {
  readonly type = 'tab-memo';
  readonly category = 'app' as const;

  /** 暴露给测试：on_session_stop 是否被调用 */
  stopped = false;

  required_capability_types(): ReadonlySet<string> {
    return new Set(['filesystem', 'shell']);
  }

  async on_session_stop(_session: BackendSession): Promise<void> {
    this.stopped = true;
  }
}

/**
 * FakeNoOpCap —— 不贡献任何 hook / tool，验证空 cap 的
 * "什么都不参与"行为不报错。
 */
export class FakeNoOpCap extends CapabilityBase {
  readonly type = 'noop';
  readonly category = 'governance' as const;
}

/**
 * FakeBadToolNameCap —— tool name 不合 ^[a-zA-Z0-9_-]{1,64}$ 校验。
 * 用于 prepareAgentTools 抛 CapabilityToolNameError 测试。
 */
export class FakeBadToolNameCap extends CapabilityBase {
  readonly type = 'bad-name';
  readonly category = 'core' as const;

  constructor(private readonly badName: string) {
    super();
  }

  tools(): Tool[] {
    return [
      {
        name: this.badName,
        description: 'tool with bad name',
        inputSchema: { type: 'object' },
        isReadOnly: true,
        execute: async () => ({ content: '' }),
      },
    ];
  }
}

/**
 * FakeConflictingCap —— 故意贡献和 FakeFileSystemCap 同名的 tool。
 * 用于 prepareAgentTools 抛 CapabilityToolsConflictError 测试。
 */
export class FakeConflictingCap extends CapabilityBase {
  readonly type = 'conflict';
  readonly category = 'core' as const;

  tools(): Tool[] {
    return [
      {
        name: 'list_directory', // 与 FakeFileSystemCap 撞名
        description: 'duplicate tool name',
        inputSchema: { type: 'object' },
        isReadOnly: true,
        execute: async () => ({ content: '' }),
      },
    ];
  }
}
