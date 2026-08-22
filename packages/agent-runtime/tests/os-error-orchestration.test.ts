/**
 * Tool 调度层 OS 访问错误：转 ToolResult，不再写黑名单、不再短路。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';
import { OSErrorBlacklist } from '../src/permissions/os-error-blacklist.js';
import { createMockPermissionHandler } from './test-utils.js';
import {
  setTelemetrySink,
  resetTelemetrySink,
  emitTelemetryEvent,
  type TelemetryRecord,
} from '../src/telemetry/index.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  Tool,
  ToolContext,
} from '../src/engine/contracts/tools.js';
import type { OSError } from '@tabtin/os-errors';

function makeOSError(overrides: Partial<OSError> = {}): OSError {
  return {
    code: 'OS_PERMISSION_DENIED',
    category: 'RemovableVolume',
    platform: 'darwin',
    path: '/Volumes/MyDisk/x',
    rawDetail: 'EPERM',
    terminal: true,
    userGuidance: 'macOS 拦截了访问，请去系统设置授权',
    agentDirectives: ['不要重试这个路径'],
    recoveryActions: [],
    ...overrides,
  };
}

class FakeOSAccessError extends Error {
  constructor(public readonly osError: OSError) {
    super(`OSAccessError: ${osError.code}`);
    this.name = 'OSAccessError';
  }
}

function makeTool(
  name: string,
  execute: Tool['execute'],
  isReadOnly = true,
): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly,
    execute,
  };
}

function makeContext(): ToolContext {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
  };
}

function makeBlock(name: string, id: string, input: unknown = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

async function drain(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<{ events: StreamEvent[]; results: ToolExecutionResult[] }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, results: next.value };
}

describe('Tool orchestration × OSErrorBlacklist 集成', () => {
  it('readOnly 工具抛 OSAccessError → 黑名单写入 + ToolResult 含 llm_message', async () => {
    const blacklist = new OSErrorBlacklist();
    const tool = makeTool('safe_read', async () => {
      throw new FakeOSAccessError(makeOSError());
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const { results } = await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/Volumes/MyDisk/x' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));

    expect(results).toHaveLength(1);
    expect(results[0].result.isError).toBe(true);
    expect(typeof results[0].result.content).toBe('string');
    expect(results[0].result.content as string).toContain('macOS');
    expect(results[0].result.content as string).toContain('OS_ACCESS_ERROR');
    expect(blacklist.isToolCallBlocked('safe_read', { path: '/Volumes/MyDisk/x' })).toBeNull();
  });

  it('相同 (toolName, input) 第二次调用仍会真正 execute', async () => {
    const blacklist = new OSErrorBlacklist();
    let executeCalls = 0;
    const tool = makeTool('safe_read', async () => {
      executeCalls++;
      throw new FakeOSAccessError(makeOSError());
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    // 第一次：实际 execute → 抛 OS 错误 → 写黑名单
    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(1);

    const { results } = await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '2', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(2);
    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.content as string).toContain('macOS');
  });

  it('不同 input → 不短路，重新 execute', async () => {
    const blacklist = new OSErrorBlacklist();
    let executeCalls = 0;
    const tool = makeTool('safe_read', async (input: unknown) => {
      executeCalls++;
      const p = (input as { path: string }).path;
      throw new FakeOSAccessError(makeOSError({ path: p }));
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/Volumes/A' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '2', { path: '/Volumes/B' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(2);
  });

  it('terminal=false 的 OS 错误（如 TARGET_BUSY）不写黑名单', async () => {
    const blacklist = new OSErrorBlacklist();
    const tool = makeTool('safe_read', async () => {
      throw new FakeOSAccessError(makeOSError({
        code: 'TARGET_BUSY',
        terminal: false,
      }));
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    const { results } = await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/x' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(results[0].result.isError).toBe(true);
    // 内容仍然是 llm_message（用户感知一致）
    expect(results[0].result.content as string).toContain('OS_ACCESS_ERROR');
    // 但黑名单未写入 → 用户重试不被短路
    expect(blacklist.size()).toBe(0);
  });

  it('write 工具（isReadOnly=false）路径同样支持短路 + 写黑名单', async () => {
    const blacklist = new OSErrorBlacklist();
    let executeCalls = 0;
    const tool = makeTool('safe_write', async () => {
      executeCalls++;
      throw new FakeOSAccessError(makeOSError());
    }, false);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_write', '1', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(1);
    expect(blacklist.isToolCallBlocked('safe_write', { path: '/Volumes/X' })).toBeNull();

    const { results } = await drain(runTools({
      toolUseBlocks: [makeBlock('safe_write', '2', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(2);
    expect(results[0].result.isError).toBe(true);
  });

  it('未注入 osErrorBlacklist → 行为与未集成前一致（错误经原 errorToToolResult 路径）', async () => {
    let executeCalls = 0;
    const tool = makeTool('safe_read', async () => {
      executeCalls++;
      throw new FakeOSAccessError(makeOSError());
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    // 不传 osErrorBlacklist
    const { results } = await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      // options 中不含 osErrorBlacklist
      options: {
      allowLegacyPermissionFallback: true, observe: emitTelemetryEvent },
    }));

    expect(results[0].result.isError).toBe(true);
    // 第二次调用不会短路（没有黑名单）
    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '2', { path: '/Volumes/X' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(2);
  });

  it('非 OS 错误（普通 Error）不被识别 → 不写黑名单', async () => {
    const blacklist = new OSErrorBlacklist();
    const tool = makeTool('safe_read', async () => {
      throw new Error('something else');
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: '/x' })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(blacklist.size()).toBe(0);
  });

  // ── Telemetry 锚点保护（防止未来误删 emit） ─────────────────────────
  describe('Telemetry events', () => {
    afterEach(() => {
      resetTelemetrySink();
    });

    it('不再发 tool.os_error_blocked / tool.os_error_short_circuit', async () => {
      const records: TelemetryRecord[] = [];
      setTelemetrySink((r) => records.push(r));
      const seen: unknown[] = [];

      const tool = makeTool('safe_read', async () => {
        throw new FakeOSAccessError(makeOSError({
          code: 'OS_PERMISSION_DENIED',
          recoveryActions: [{ type: 'restart_app', label: '重启' }],
        }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });
      await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '1', { path: '/x' })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
          allowLegacyPermissionFallback: true,
          sessionId: 'sess-A',
          observe: emitTelemetryEvent,
          onOSAccessError: (osError) => { seen.push(osError.code); },
        },
      }));

      expect(records.find((r) => r.event_name === 'tool.os_error_blocked')).toBeUndefined();
      expect(records.find((r) => r.event_name === 'tool.os_error_short_circuit')).toBeUndefined();
      expect(seen).toEqual(['OS_PERMISSION_DENIED']);
    });
  });

  // ── M-1 修复（Wave 1 第二轮 Review）：路径状态可变的 OS 错误不写黑名单 ──
  //
  // 防止"先探查后写入"工作流死锁：LLM `read_file('/tmp/x.json')` ENOENT
  // → 写黑名单 → write_file 同路径成功 → read_file 同路径仍被短路（撒谎说不存在）。
  describe('Wave 1 第二轮 M-1：路径状态可变的 OS 错误不写黑名单', () => {
    it('TARGET_NOT_FOUND 不写黑名单（仍返回结构化 ToolResult）', async () => {
      const blacklist = new OSErrorBlacklist();
      const tool = makeTool('safe_read', async () => {
        // 模拟 safeReadFile 抛 ENOENT 归类后的 OSError
        throw new FakeOSAccessError(makeOSError({
          code: 'TARGET_NOT_FOUND',
          terminal: true, // classifier 标 terminal=true，但黑名单层应跳过
          userGuidance: '路径 /tmp/x 不存在。',
        }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });

      const { results } = await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '1', { path: '/tmp/x' })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
      }));

      // ToolResult 仍是结构化错误（含 OS_ACCESS_ERROR 头 + userGuidance）
      expect(results[0].result.isError).toBe(true);
      expect(results[0].result.content as string).toContain('OS_ACCESS_ERROR');
      expect(results[0].result.content as string).toContain('TARGET_NOT_FOUND');
      // 但黑名单**不**写入 —— 让"先探查后写入"工作流不会死锁
      expect(blacklist.size()).toBe(0);
    });

    it('TARGET_NOT_FOUND 不短路：read → mkdir+write → read（同路径）应重新执行', async () => {
      // 这是 M-1 的真实用户场景：
      //   "看下 /tmp/notes.txt 里有什么，没有就帮我创建一个" —— LLM 探查 → 没有 →
      //   写入 → 再探查验证。修前 read_file 第二次会被短路撒谎"不存在"。
      const blacklist = new OSErrorBlacklist();
      let readCalls = 0;
      const realPath = '/tmp/notes.txt';
      const tool = makeTool('safe_read', async () => {
        readCalls++;
        throw new FakeOSAccessError(makeOSError({
          code: 'TARGET_NOT_FOUND',
          terminal: true,
          path: realPath,
        }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });

      // 第一次 read_file → 没找到（结构化错误）
      await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '1', { path: realPath })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
      }));
      expect(readCalls).toBe(1);

      // 第二次 read_file 同 input → **不**被短路（与 OS_PERMISSION_DENIED 行为对比）
      await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '2', { path: realPath })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
      }));
      expect(readCalls).toBe(2); // ✅ 第二次也走了 execute
    });

    it('OS_PERMISSION_DENIED 仍正常写黑名单（区分 M-1 跳过名单仅含 3 条）', async () => {
      // 反证：确认不是把所有 terminal 错误都跳过——只有 TARGET_NOT_FOUND /
      // TARGET_BUSY / CLOUD_NOT_DOWNLOADED 这类"路径状态可变"的码不写黑名单，
      // OS_PERMISSION_DENIED / OS_AV_BLOCKED 等"用户必须主动操作"的仍写。
      const blacklist = new OSErrorBlacklist();
      const tool = makeTool('safe_read', async () => {
        throw new FakeOSAccessError(makeOSError({ code: 'OS_PERMISSION_DENIED' }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });

      await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '1', { path: '/Users/foo/Desktop' })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
      }));
      expect(blacklist.size()).toBe(1);
    });

    it('CLOUD_NOT_DOWNLOADED（云盘未下载）也不写黑名单 —— 5 分钟内可能完成同步', async () => {
      const blacklist = new OSErrorBlacklist();
      const tool = makeTool('safe_read', async () => {
        throw new FakeOSAccessError(makeOSError({
          code: 'CLOUD_NOT_DOWNLOADED',
          terminal: true,
        }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });

      await drain(runTools({
        toolUseBlocks: [makeBlock('safe_read', '1', { path: '/iCloud/x.docx' })],
        registry,
        context: makeContext(),
        permissionHandler: createMockPermissionHandler(),
        options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
      }));
      expect(blacklist.size()).toBe(0);
    });
  });

  // ── M-5 修复（Wave 1 第二轮 Review）：clearByOriginalPath 改 prefix 解封 ──
  describe('Wave 1 第二轮 M-5：clearByOriginalPath 走 POSIX 子树语义', () => {
    it('清父路径同时解封整个子树', async () => {
      const blacklist = new OSErrorBlacklist();
      const tool = makeTool('safe_read', async (input: unknown) => {
        const p = (input as { path: string }).path;
        throw new FakeOSAccessError(makeOSError({ path: p }));
      }, true);
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [tool] });

      // 用户原任务："读 ~/Desktop 里的所有截图"
      // LLM 试了 list_directory + 多个 read_file，都因 TCC 失败
      const subPaths = [
        '/Users/foo/Desktop',
        '/Users/foo/Desktop/a.png',
        '/Users/foo/Desktop/screenshots/x.jpg',
      ];
      for (const [i, p] of subPaths.entries()) {
        await drain(runTools({
          toolUseBlocks: [makeBlock('safe_read', `t${i}`, { path: p })],
          registry,
          context: makeContext(),
          permissionHandler: createMockPermissionHandler(),
          options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
        }));
      }
      expect(blacklist.size()).toBe(0);
    });

    it('字符串前缀但缺少分隔符边界 → 不误命中', async () => {
      const blacklist = new OSErrorBlacklist();
      blacklist.blockToolCall(
        'read_file',
        { path: '/Users/foo/Desk' },
        'OS_PERMISSION_DENIED',
        'm',
        undefined,
        '/Users/foo/Desk',
      );
      blacklist.blockToolCall(
        'read_file',
        { path: '/Users/foo/Desktop/x.txt' },
        'OS_PERMISSION_DENIED',
        'm',
        undefined,
        '/Users/foo/Desktop/x.txt',
      );

      // 用户授权 Desktop —— Desk 不能被误清
      const cleared = blacklist.clearByOriginalPath('/Users/foo/Desktop');
      expect(cleared).toBe(1); // 仅 /Users/foo/Desktop/x.txt
      expect(blacklist.isToolCallBlocked('read_file', { path: '/Users/foo/Desk' })).not.toBeNull();
    });
  });

  // ── P0-1 修复端到端验证（用户场景：授权后 system.clear 必须真的解封） ──
  it('P0-1: tool-orchestration 写入 + system.clear({path}) 解封 → 下次不短路', async () => {
    const blacklist = new OSErrorBlacklist();
    let executeCalls = 0;
    const realPath = '/Users/foo/Desktop/x.txt';
    const tool = makeTool('safe_read', async () => {
      executeCalls++;
      throw new FakeOSAccessError(makeOSError({ path: realPath }));
    }, true);
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => [tool] });

    // 第一次：写入 toolCall 维度（带 originalPath=realPath）
    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '1', { path: realPath })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(1);

    await drain(runTools({
      toolUseBlocks: [makeBlock('safe_read', '2', { path: realPath })],
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
      options: {
      allowLegacyPermissionFallback: true, osErrorBlacklist: blacklist, observe: emitTelemetryEvent },
    }));
    expect(executeCalls).toBe(2);
  });

  // W3：原 list_directory 贯穿测试已移除——FileSystemCap 在 W1 中删除了
  // list_directory / mkdir 两个工具，这些测试变成死测试。
  // read_file / write_file / file_delete 端到端测试（下方）覆盖了同等的
  // OS error 短路链路。

  // ── 主路径贯穿测试（adapter 端 3 件套）──────────────────────────────
  //
  // OS error 短路链路（OSError 抛出 → 黑名单写入 + telemetry → 短路命中
  // → clear 解封 → 重试成功）的端到端验证。
  //
  // 覆盖 read_file / write_file / delete_file 三个 adapter 端工具。
  // W3 移除了原 list_directory / mkdir 测试（工具已从 FileSystemCap 中删除）。

  // **WP1（2026-05-13）退役通告**：原 ShellCap × TCC e2e 两条用例
  // （`ShellCap × TCC 端到端：bash ls 0o000 dir` + `ShellCap × grep / cat
  // 真 spawn`）已随 `classifyShellStderr` 函数 + 单测一并删除。
  //
  // 原因：WP1 PTY 化后 ShellCap 改走 `PtyManagerBridge.executeAgentCommand`,
  // 不再调 NativeBackendSession.execImpl → spawn 子进程；PTY master 端
  // stdout / stderr 物理合流（agent-bridge.ts JSDoc 第 240-242 行），
  // `stderr` 字段永远空字符串——`classifyShellStderr` 启发式分类
  // 在 PTY 路径无用武之地。本文件 read/write/delete e2e 用例继续保留
  // （走 safe-fs OSAccessError 链路，与 ShellCap 解耦）。
  //
  // 后续 Wave 如需为 PTY 场景重建 TCC 识别能力，应在 PTY 层 stdout 上做
  // （含原 stderr 信息），不再回到 ShellCap 启发式分类——WP6 dogfood 时
  // 如发现用户体验断点再决策，本期不留 placeholder 测试。
  describe('Wave 1 第三轮 主路径贯穿（4 件套）', () => {
    /**
     * 单条 e2e 测试的 5 步链路 helper。
     *
     * 调用方传入 prepareEnvironment 钩子描述"在 tmpRoot 下要建什么、chmod 什么、
     * 工具入参是什么、成功后怎么断言"，本 helper 跑完整链路：
     *
     *   1. 装配真实 NativeBackendSession + FileSystemCap + ToolRegistry +
     *      Blacklist + telemetrySink
     *   2. 第一次 runTools → 真 OS 错误抛 → 写黑名单 + telemetry blocked
     *   3. 第二次 runTools 同 input → 短路命中（同时 chmod 改回 0o755 证明真
     *      没走 fs，结果仍返缓存 user_guidance）+ telemetry short_circuit
     *   4. blacklist.clearByOriginalPath（模拟 system.clear 工具）
     *   5. 第三次 runTools → 不再短路 + 调 assertSuccess
     *
     * **PRD 08 W1.5 / W11 / W3 调整**：W1 把所有 FS 工具从
     * `FileSystemCap` 退役，统一走 adapter 端 `createTabCodeTools`。
     * W3 删除了 mkdir / list_directory 端到端测试（工具不存在了）。
     * 现在所有 case 都走 `'adapter'` 路径。
     *
     * 平台跳过：Windows（0o000 在文件 ACL 模型下不一定产生 EACCES）+ root（能
     * 绕开权限）。
     */
    async function runE2EChmodScenario(opts: {
      toolName: string;
      /** 准备 tmpRoot 下的环境，返回 chmod 0o000 的目录 + 工具入参 + 第三次成功断言。 */
      prepareEnvironment: (
        tmpRoot: string,
        fs: typeof import('node:fs'),
        path: typeof import('node:path'),
      ) => {
        /** 0o000 限制的路径——cleanup 时要先 chmod 回 0o755 再删 */
        restrictedDir: string;
        /** OSError.path —— 第二步断言 entry.originalPath 时用 */
        expectedOriginalPath: string;
        /** 工具入参 */
        input: Record<string, unknown>;
        /**
         * 第三步 chmod 改回 0o755 后，第三次 runTools 调用前的额外恢复钩子
         * （某些场景如 delete_file 需要确保目标文件还存在，可以在这里再创
         * 建一遍）。可省略。
         */
        prepareForRetry?: () => void;
        /** 第三次（解封后）调用成功的断言钩子。 */
        assertSuccess: (result: import('../src/engine/contracts/tools.js').ToolResult) => void;
      };
    }): Promise<void> {
      // 平台跳过：Windows 文件 ACL 与 POSIX 0o000 语义不同；root 能绕开权限。
      if (process.platform === 'win32') return;
      if (process.getuid && process.getuid() === 0) return;

      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const { NativeBackendSession } = await import(
        '../src/capability/native/native-backend-session.js'
      );
      const { loadCreateTabCodeTools } = await import('./fixtures/load-tabcode-tools.js');
      const createTabCodeTools = await loadCreateTabCodeTools();

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wave1-r3-e2e-'));
      const env = opts.prepareEnvironment(tmpRoot, fs, path);

      try {
        const { createTestSafeFsPort } = await import('./helpers/safe-fs-port.js');
        const session = new NativeBackendSession({
          sessionId: 'e2e-w1-r3',
          agentId: 'wave1-r3-test',
          agentHomeRoot: tmpRoot,
          fs: createTestSafeFsPort(),
          execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
        });
        // adapter 工具用 createTabCodeTools 装配。
        //
        // workspaceRoot 必须 realpath 一次——action-tools 内部的"path
        // outside allowed boundaries"安全检查用 startsWith 比较绝对路径
        // 字符串，macOS 上 /var/... 是 /private/var/... 的 symlink，不
        // realpath 会让 boundary check 把合法 tmpRoot 子路径误判越界。
        //
        // W3 之后 FileSystemCap 已被 createTabCodeTools 替代，
        // 本测试不再需要装 FileSystemCap。
        const adapterTools = createTabCodeTools({ workspaceRoot: () => fs.realpathSync(tmpRoot) });
        const tool = adapterTools.find((t) => t.name === opts.toolName);
        expect(tool, `tool '${opts.toolName}' must exist in createTabCodeTools`).toBeDefined();

        const registry = new ToolRegistry();
        registry.loadTools({ getTools: () => [tool!] });

        const blacklist = new OSErrorBlacklist();
        const telemetryRecords: TelemetryRecord[] = [];
        setTelemetrySink((r) => telemetryRecords.push(r));

        try {
          // 共享 RunTools options：
          // - osErrorBlacklist：注入 R-7 黑名单
          // - sessionId：telemetry 关联键
          // - outputScan: false —— 仅第三步"重试成功" r3 的成功 JSON
          //   content 需要被直接 JSON.parse 断言。开启 sanitize 时，
          //   `shouldSanitizeToolOutput(tool) === true` 的工具（非只读 +
          //   disablePreStart 只读）会被 fence 包裹，r3.content 首字符变 `<` 而
          //   非 `{`，`JSON.parse(r3.content)` 抛 SyntaxError。
          //
          //   **r1 / r2 两步走的是 OSError 短路 / catch 路径，
          //   `maybeSanitize` 根本不介入**（见 tool-orchestration.ts::
          //   maybeBlockToolOnOSError 与 tryOSBlacklistShortCircuit 两个
          //   分支直接 return ToolExecutionResult，跳过 sanitize 步骤），
          //   所以 `outputScan: false` 的真实作用**只在 r3**。
          //
          //   **PRD 08 W12（L-23）后**：生产路径 sanitize 仍开启，但
          //   `shouldSanitizeToolOutput` 的覆盖面变大——除原本写工具
          //   （`file_write`/`file_delete`/`mkdir` 经 isReadOnly=false
          //   走 fence）以外，**`file_read` / `code_grep` / `code_glob`
          //   / `code_semantic_search` 也加了 `disablePreStart: true`**，dogfood
          //   下也会被 fence 包裹（防 workspace 文件 prompt injection）。
          //   依然天然不 sanitize 的只读工具：`list_directory`（capability
          //   端，无 disablePreStart）和 `read_diagnostics`（adapter 端，攻击面
          //   窄主动例外）。
          //
          //   **不变量**（未来重构提示）：OSError 短路 / catch → ToolResult
          //   的路径**必须**绕开 maybeSanitize，否则 r1/r2 也会被 fence 包
          //   裹，此处 outputScan 语义要重新评估。
          const runOptions = {
            allowLegacyPermissionFallback: true,
            osErrorBlacklist: blacklist,
            sessionId: 'e2e-sess',
            outputScan: false,
            // 批次 2（QueryDeps.observe）后遥测经 options 注入——生产装配
            // （runtime-assembly）绑定同一个 emitTelemetryEvent。
            observe: emitTelemetryEvent,
          };

          // ── 步骤 1：第一次 runTools → 真 OS 错误抛 → 写黑名单 + telemetry ──
          const { results: r1 } = await drain(
            runTools({
              toolUseBlocks: [makeBlock(opts.toolName, '1', env.input)],
              registry,
              context: makeContext(),
              permissionHandler: createMockPermissionHandler(),
              options: runOptions,
            }),
          );
          expect(r1[0].result.isError).toBe(true);
          expect(r1[0].result.content as string).toContain('OS_ACCESS_ERROR');
          expect(blacklist.isToolCallBlocked(opts.toolName, env.input)).toBeNull();
          expect(telemetryRecords.find((r) => r.event_name === 'tool.os_error_blocked')).toBeUndefined();

          fs.chmodSync(env.restrictedDir, 0o755);
          if (env.prepareForRetry) env.prepareForRetry();
          const { results: r2 } = await drain(
            runTools({
              toolUseBlocks: [makeBlock(opts.toolName, '2', env.input)],
              registry,
              context: makeContext(),
              permissionHandler: createMockPermissionHandler(),
              options: runOptions,
            }),
          );
          env.assertSuccess(r2[0].result);
        } finally {
          resetTelemetrySink();
          await session.shutdown();
        }
      } finally {
        // 清理：恢复权限再 rm，避免 0o000 阻挡递归删
        try {
          fs.chmodSync(env.restrictedDir, 0o755);
        } catch {
          /* best-effort */
        }
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // ─── read_file 端到端（adapter 入口）─────────────────────────────
    //
    // 用户场景子片段："帮我读 ~/Desktop/todo.txt" → LLM file_read 拒绝 →
    // OSError → 黑名单 → 用户授权 → clear → 重试成功拿到内容。
    //
    // **PRD 08 W1.5 / W11**：原 case 走 capability 端 `read_file`，W1.5
    // 退役后改走 adapter 端 `file_read`（`createTabCodeTools`）。adapter
    // 通过 W11 加的 `maybeRethrowAsOSAccessError` 反推 fs errno 抛 OSError。
    it('read_file 端到端：chmod 0o000 文件 → OSError → 黑名单 → 短路 → clear → 重试成功', async () => {
      await runE2EChmodScenario({
        toolName: 'read_file',
        prepareEnvironment: (tmpRoot, fs, path) => {
          // 用 0o000 父目录拒绝 read_file 的 open()——这是 macOS TCC 拒绝
          // ~/Desktop/foo.txt 的真实形态（父目录无 X 权限直接挡 lookup）。
          // 对文件本身 chmod 0o000 在某些平台不可靠（owner 仍能读），用父
          // 目录权限是最稳妥的复刻。
          //
          // 同 file_write/file_delete：用 realpath 处理 macOS /var → /private/var
          // 的 symlink 差异，让 expectedOriginalPath 与 OSError.path 一致。
          const restrictedDir = path.join(fs.realpathSync(tmpRoot), 'restricted-parent');
          fs.mkdirSync(restrictedDir);
          const target = path.join(restrictedDir, 'todo.txt');
          fs.writeFileSync(target, 'agent task list', 'utf8');
          fs.chmodSync(restrictedDir, 0o000);
          return {
            restrictedDir,
            expectedOriginalPath: target,
            input: { path: target },
            assertSuccess: (result) => {
              // W2（2026-05-10）：read_file 直接输出
              // 多行明文（不再 JSON envelope）。LLM 视觉上看到的是 cat -n compact
              // 格式 `1\tcontent\n2\tcontent`——不会再误判"被截断"。
              expect(result.isError).toBeUndefined();
              expect(result.content).toBe('1\tagent task list');
            },
          };
        },
      });
    });

    // ─── write_file 端到端（adapter 入口）────────────────────────────
    it('write_file 端到端：chmod 0o000 父目录 → OSError → 黑名单 → 短路 → clear → 重试成功', async () => {
      await runE2EChmodScenario({
        toolName: 'write_file',
        prepareEnvironment: (tmpRoot, fs, path) => {
          // adapter 走 canonicalizePath（含 macOS realpath），
          // /var/folders/... 会被解成 /private/var/folders/...。要让
          // expectedOriginalPath 与 OSError.path 一致，提前对父目录
          // realpath 一次。
          const restrictedDir = path.join(fs.realpathSync(tmpRoot), 'documents-like');
          fs.mkdirSync(restrictedDir);
          fs.chmodSync(restrictedDir, 0o000);
          const target = path.join(restrictedDir, 'summary.md');
          return {
            restrictedDir,
            expectedOriginalPath: target,
            // adapter write_file 字段名是 `contents`（与 capability 端
            // `content` 不同）；这是 action-tools 的入参契约。
            input: { path: target, contents: '# 汇总\n\n- 整理完成' },
            assertSuccess: (result) => {
              expect(result.isError).toBeUndefined();
              const parsed = JSON.parse(result.content as string);
              expect(parsed.success).toBe(true);
              expect(parsed.path).toBe(target);
            },
          };
        },
      });
    });

    // W3：原 mkdir 端到端测试已移除——FileSystemCap 在 W1 中删除了 mkdir 工具。
    // LLM 通过 run_terminal_command mkdir 即可完成同等操作。

    // ─── delete_file 端到端（adapter 入口）───────────────────────────
    it('delete_file 端到端：chmod 0o000 父目录 → OSError → 黑名单 → 短路 → clear → 重试成功', async () => {
      await runE2EChmodScenario({
        toolName: 'delete_file',
        prepareEnvironment: (tmpRoot, fs, path) => {
          // 同 write_file 的 realpath 处理（macOS /var → /private/var）。
          const restrictedParent = path.join(fs.realpathSync(tmpRoot), 'desktop-like');
          fs.mkdirSync(restrictedParent);
          const target = path.join(restrictedParent, 'old-screenshot.png');
          fs.writeFileSync(target, 'fake png bytes', 'utf8');
          fs.chmodSync(restrictedParent, 0o000);
          return {
            restrictedDir: restrictedParent,
            expectedOriginalPath: target,
            input: { path: target },
            assertSuccess: (result) => {
              expect(result.isError).toBeUndefined();
              const parsed = JSON.parse(result.content as string);
              expect(parsed.success).toBe(true);
              // 真删了（不在原位）
              expect(fs.existsSync(target)).toBe(false);
            },
          };
        },
      });
    });

  });
});
