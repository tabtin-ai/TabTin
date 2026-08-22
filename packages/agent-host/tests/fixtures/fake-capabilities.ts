/**
 * 宿主 Cap 单测的最小上下文 / 假 session fixture（ 迁移配套）。
 *
 * 原来住在 agent-runtime 的 `capability/__tests__/fixtures/fake-capabilities.ts`；
 * CliCap / McpCap / SkillsCap 从 agent-runtime 的 capability/core 迁到本宿主包后，
 * 配套单测也迁来，这里给一份极简版本，只覆盖被迁移测试用到的 helper：
 *   - makeFakeSession：最小 BackendSession（bind / clone 测试用）
 *   - makeBeforeModelCtx / sectionContent：捕获 beforeModel 的 appendSystemSection
 *   - makeRunCtx / makeIterationCtx：beforeRun / beforeIteration 的最小 ctx
 *
 * 跨包契约类型统一从 `@tabtin/agent-runtime` 的公共出口 import（host 依赖 runtime，单向合法）。
 */

import type {
  AgentHomeLayout,
  BackendSession,
  BackendSessionCapabilities,
  ExecOptions,
  ExecResult,
} from '@tabtin/agent-runtime/capability';
import type {
  EngineState,
  IterationHookContext,
  RunHookContext,
  SystemSectionName,
} from '@tabtin/agent-runtime/engine';

/**
 * 极简 mock BackendSession —— 仅满足 bind / clone 测试需要。
 * 不实现任何真实 IO，未支持的方法直接 throw。
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
  } as unknown as BackendSession;
}

/**  批次 10：捕获 beforeModel 的 appendSystemSection 调用。 */
export interface CapturedSystemSection {
  name: SystemSectionName;
  content: string;
  source: string;
  placement?: string;
}

/**
 * beforeModel 用的最小上下文：把 appendSystemSection 的入参收集到 sections，
 * 供 sectionContent() 断言。BeforeModelContext 未从包公共面导出，这里用结构化
 * 类型等价还原（字段与引擎契约一致，被迁测试只读 sections）。
 */
export interface MockBeforeModelContext {
  state: EngineState;
  iteration: number;
  sections: CapturedSystemSection[];
  appendSystemSection: (
    name: SystemSectionName,
    content: string,
    source: string,
    opts?: { placement?: 'static' | 'dynamic' },
  ) => void;
  setGraceTurn: () => void;
  isGraceTurn: () => boolean;
  restrictToolsForTurn: (toolNames: readonly string[]) => void;
  requestTerminate: () => void;
  emitEvent: () => void;
  emitNotice: () => void;
}

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

/** beforeRun / afterRun 用的最小 RunHookContext。 */
export function makeRunCtx(state: EngineState): RunHookContext {
  return {
    state,
    runId: 'test-run',
    emitEvent: () => {},
    emitNotice: () => {},
  } as unknown as RunHookContext;
}

/** beforeIteration / afterIteration 用的最小 IterationHookContext。 */
export function makeIterationCtx(state: EngineState, iteration = 0): IterationHookContext {
  return {
    state,
    iteration,
    runId: 'test-run',
    emitEvent: () => {},
    emitNotice: () => {},
  } as unknown as IterationHookContext;
}
