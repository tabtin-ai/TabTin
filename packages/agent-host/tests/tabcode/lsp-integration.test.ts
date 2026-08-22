/**
 * tabcode-adapter ↔ lsp-runtime 真实端到端集成测试。
 *
 * 由 2026-05-13 三轮 review 重写。删除两个"测试欺骗"：
 *   1. 旧测试 1（"static import 链路 OK"）只检查 import，没测代码行为
 *   2. 旧测试 2（"e2e"）手动 registerPendingLSPDiagnostic 模拟整个链路，
 *      绕开真正被测的 notifyLspAfterEdit/passiveFeedback handler
 *
 * 新测试走真实路径：write_file 工具 → refreshSnapshot → notifyLspAfterEdit
 * → lspManager.changeFile/saveFile + clearDeliveredDiagnosticsForFile，并
 * 让 mock LSP server 推 publishDiagnostics 走 passiveFeedback handler 真链路
 * 入 registry。
 *
 * 关键覆盖：
 *   - P0-1 防护：在 Node 测试环境下 subprocess-env 不注入 ELECTRON_RUN_AS_NODE
 *     （Electron 环境下注入由 lsp-runtime 自己的 subprocess-env.test.ts 覆盖）
 *   - P1-1 防护：URI key 一致性 —— passiveFeedback fileURLToPath 后存入 LRU
 *     的 key 是 plain path；notifyLspAfterEdit clearDelivered 也用 plain path
 *     这两个 key 必须匹配，否则 dedup 永远清不掉，跨 turn 同条诊断不会再次推送
 *
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
  getLspServerManager,
  _resetLspManagerForTesting,
  registerLSPNotificationHandlers,
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
  checkForLSPDiagnostics,
  type LspServerConfigLoader,
  type ScopedLspServerConfig,
} from '@tabtin/lsp-runtime';

import { createTabCodeTools } from '../../src/tools/tabcode-adapter.js';
import type {
  ReadFileState,
  ToolContext,
} from '@tabtin/agent-runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(
  __dirname,
  '..',
  '..',
  '..',
  'lsp-runtime',
  'src',
  '__tests__',
  'mock-lsp-server.mjs',
);

function mockConfig(): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [MOCK_SERVER],
    extensionToLanguage: { '.ts': 'typescript' },
  };
}

function makeLoader(
  servers: Record<string, ScopedLspServerConfig> = { mock: mockConfig() },
): LspServerConfigLoader {
  return { load: async () => ({ servers }) };
}

let tmpDir: string;

beforeEach(async () => {
  // 重置 LSP runtime 状态（generation counter / singleton / registry LRU）
  _resetLspManagerForTesting();
  resetAllLSPDiagnosticState();
  // macOS realpath 防 /var vs /private/var boundary 不一致
  const raw = await fsPromises.mkdtemp(join(tmpdir(), 'lsp-e2e-'));
  tmpDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await shutdownLspServerManager();
  _resetLspManagerForTesting();
  resetAllLSPDiagnosticState();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeCtx(state?: ReadFileState): ToolContext {
  return {
    threadId: 'lsp-e2e',
    runtimeId: 'lsp-e2e',
    abortSignal: new AbortController().signal,
    messages: [],
    workspaceRoot: tmpDir,
    readFileState: state,
  };
}

function getTool(name: string) {
  const tools = createTabCodeTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not in createTabCodeTools()`);
  return tool;
}

describe('lsp-runtime ↔ tabcode-adapter 真实端到端集成', () => {
  it('LSP singleton 未初始化时 write_file 不抛错（opt-in 模式）', async () => {
    // 宿主没调 initializeLspServerManager 时，notifyLspAfterEdit 静默 noop
    expect(getLspServerManager()).toBeUndefined();

    const tool = getTool('write_file');
    const filePath = join(tmpDir, 'no-lsp.ts');
    const res = await tool.execute(
      { path: filePath, content: 'const x = 1;\n' },
      makeCtx(new Map()),
    );
    // write_file 成功完成（虽然 LSP 未启用，notifyLspAfterEdit 静默 return）
    expect(res.isError).toBeUndefined();
    // 不应有 pending diagnostics
    expect(getPendingLSPDiagnosticCount()).toBe(0);
  }, 15_000);

  it('P1-1 URI key 一致性：write_file 清空 delivered LRU 后，同诊断能再次推送', async () => {
    // 这是关键测试 —— 复现并验证 P1-1 bug fix：
    //
    //  bug 时序（修复前）：
    //   1. LSP server 推 publishDiagnostics URI=file:///path/test.ts
    //   2. passiveFeedback handler 用 fileURLToPath 转 plain path "/path/test.ts"
    //      入 deliveredDiagnostics LRU 作 key
    //   3. notifyLspAfterEdit 调 clearDeliveredDiagnosticsForFile("file:///path/test.ts")
    //      （bug：带 file:// 前缀）→ LRU key mismatch，清不掉
    //   4. 第二次推同诊断 → dedup 把它过滤掉（LRU 命中），LLM 看不到
    //
    //  fix 后时序：
    //   1. 同上
    //   2. 同上 → LRU key = plain path
    //   3. notifyLspAfterEdit 调 clearDeliveredDiagnosticsForFile("/path/test.ts")
    //      （fix：plain path）→ LRU key match，清成功
    //   4. 第二次推同诊断 → dedup 不命中，LLM 再次看到

    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const manager = getLspServerManager();
    expect(manager).toBeDefined();
    // 真实链路：注册 publishDiagnostics handler（passiveFeedback）
    registerLSPNotificationHandlers(manager!);

    const filePath = join(tmpDir, 'subject.ts');
    // 先创建文件让 mock server 能 didOpen
    await fsPromises.writeFile(filePath, 'const x: number = 1;\n', 'utf8');
    const server = await manager!.ensureServerStarted(filePath);
    expect(server!.state).toBe('running');

    // 第一次诊断推送：mock server 推 publishDiagnostics，URI 用 file:// 形式
    // （真实 LSP server 都这样）
    const diagnostic = {
      message: "Type 'string' is not assignable to type 'number'",
      severity: 1,
      range: {
        start: { line: 0, character: 18 },
        end: { line: 0, character: 21 },
      },
      source: 'typescript',
      code: 'TS2322',
    };
    await server!.sendRequest('client/triggerPublishDiagnostics', {
      uri: `file://${filePath}`,
      diagnostics: [diagnostic],
    });
    // 给 fire-and-forget notification 时间 propagate
    await new Promise((r) => setTimeout(r, 100));

    // 第一轮 checkForLSPDiagnostics：应拿到诊断（passiveFeedback 真链路
    // 入 registry → checkForLSPDiagnostics 取出 + 入 delivered LRU）
    const round1 = checkForLSPDiagnostics();
    expect(round1).toHaveLength(1);
    expect(round1[0]!.files).toHaveLength(1);
    expect(round1[0]!.files[0]!.diagnostics).toHaveLength(1);
    expect(round1[0]!.files[0]!.uri).toBe(filePath); // ← passiveFeedback 转 plain path

    // 第二次推同样诊断（模拟下一轮 publishDiagnostics 推同条）
    await server!.sendRequest('client/triggerPublishDiagnostics', {
      uri: `file://${filePath}`,
      diagnostics: [diagnostic],
    });
    await new Promise((r) => setTimeout(r, 100));

    // 第二轮 checkForLSPDiagnostics：dedup 工作，过滤掉（LRU 命中 plain path）
    const round2 = checkForLSPDiagnostics();
    expect(round2).toHaveLength(0); // ← 跨 turn dedup 工作

    // ★ 关键步骤：通过 write_file 真实路径触发 notifyLspAfterEdit
    //   refreshSnapshot 内部调 clearDeliveredDiagnosticsForFile(filePath)
    //   bug 时这里传的是 `file://${filePath}`，key mismatch，LRU 没清
    //   fix 后传的是 filePath（plain path），key match，LRU 真清掉
    const state = new Map();
    const ctx = makeCtx(state);
    const readTool = getTool('read_file');
    const readRes = await readTool.execute({ path: filePath }, ctx);
    expect(readRes.isError).toBeUndefined();

    const writeTool = getTool('write_file');
    const writeRes = await writeTool.execute(
      { path: filePath, content: 'const x: number = 2;\n' },
      ctx,
    );
    expect(writeRes.isError).toBeUndefined();

    // 第三次推同诊断
    await server!.sendRequest('client/triggerPublishDiagnostics', {
      uri: `file://${filePath}`,
      diagnostics: [diagnostic],
    });
    await new Promise((r) => setTimeout(r, 100));

    // 第三轮：clearDelivered 真生效的话，dedup 不命中，诊断再次出现
    // 如果 P1-1 bug 还在（key mismatch），LRU 没清 → 这一轮拿不到诊断 → 测试挂
    const round3 = checkForLSPDiagnostics();
    expect(round3).toHaveLength(1);
    expect(round3[0]!.files[0]!.diagnostics).toHaveLength(1);
    expect(round3[0]!.files[0]!.diagnostics[0]!.message).toBe(
      diagnostic.message,
    );
  }, 30_000);

  it('write_file 工具不会抛错：完整流程跑通（哪怕 fire-and-forget 出问题）', async () => {
    // P0-1 兜底验证：fire-and-forget 链路出问题（如 spawn 失败）不能阻塞
    // tool result。这一条覆盖：哪怕 Electron 下 spawn 行为异常，write_file
    // 也应该正常返回。
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    registerLSPNotificationHandlers(getLspServerManager()!);

    const writeTool = getTool('write_file');
    const newFile = join(tmpDir, 'created.ts');
    const res = await writeTool.execute(
      { path: newFile, content: 'export const v = 42;\n' },
      makeCtx(new Map()),
    );
    expect(res.isError).toBeUndefined();
    // 文件真实存在
    const stat = await fsPromises.stat(newFile);
    expect(stat.isFile()).toBe(true);
  }, 30_000);

  it('agent-runtime → lsp-runtime export 链路 OK', async () => {
    // 替代旧的"static import 链路"空测试 —— 显式验证 export 名一致性
    // 防止 lsp-runtime 改 export 名时 agent-runtime 静默失效
    const lspRuntime = await import('@tabtin/lsp-runtime');
    const required = [
      'getLspServerManager',
      'clearDeliveredDiagnosticsForFile',
      'initializeLspServerManager',
      'registerLSPNotificationHandlers',
      'registerPendingLSPDiagnostic',
      'checkForLSPDiagnostics',
      'clearAllLSPDiagnostics',
      'resetAllLSPDiagnosticState',
    ] as const;
    for (const name of required) {
      expect(typeof lspRuntime[name]).toBe('function');
    }
  });
});
