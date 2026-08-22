/**
 * **W5 L36（2026-05-14）契约钉死**：
 *   Daemon `agentToolDeps` 透传 `readFileState` / `imageReadFileState` /
 *   `localDocReadFileState` 三件套，且与 EngineConfig 共享同一引用，让
 *   父 runtime → fork 子 Agent 能继承父的 dedup 状态。
 *
 * **历史 BUG 复现**：W1 / W2 / W4 沿用同款 BUG —— Daemon EngineConfig 用
 * `new Map()` 内联构造三件套，agentToolDeps 完全不传。子 Agent fork 时
 * `agent-tool.ts::executeChildAgent` 从 `agentToolDeps` 拿 readFileState/...
 * 是 undefined → forkQuery 拿到 undefined → 子 EngineConfig 拿到 undefined
 * dedup state → 子 Agent 反复 read 父已读文件，bypass W2 dedup 主线收益。
 *
 * **测试策略**：本 BUG 在 createRuntimeForSession 装配阶段（构造时机）发生，
 * 整个方法依赖大量真实组件（SessionStorage / DaemonToolProvider / mergedTool
 * Provider / TokenManager / 多层 ServerCallbacks 等等），mock 完整链路成本极高。
 * 我们走 source-level contract 钉死：grep DaemonAgentHost.ts 源码确保
 *   (1) const 提前声明 readFileState / imageReadFileState / localDocReadFileState
 *   (2) agentToolDeps 字段块内引用三个 const（同一引用，不是 inline `new Map()`）
 *   (3) EngineConfig 字段块内引用三个 const（同一引用，不是 inline `new Map()`）
 * 任一字段被退化为 inline `new Map()` 或被删除会立即 fail。
 *
 * 参考反思 §八 #15 "反向 grep 同模式两端" + W4 "L59 adapter test 红线 tokenize"
 * 同款 source-level 契约测试模式。
 *
 * **配套测试**：
 *   - `packages/agent-runtime/tests/fork-readfilestate.test.ts` 已覆盖 forkQuery
 *     端透传逻辑（父→子 shallow clone 隔离），W2 主线钉死。
 *   - 本测试只钉 daemon host 端"const 引用共享"——剩下的引擎层 W2 主线测试已经
 *     覆盖透传链路全程。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_HOST_PATH = resolve(
  __dirname,
  '../src/application/agent/daemon-agent-host.ts',
);
// Agent Host 归位：live runtime 装配（含 createRuntimeForSession 内的 agentToolDeps /
// EngineConfig 三件套装配）已迁入 daemon-runtime-assembly.ts。契约 grep 覆盖两文件。
const DAEMON_RUNTIME_ASSEMBLY_PATH = resolve(
  __dirname,
  '../src/application/agent/runtime/daemon-runtime-assembly.ts',
);

function readDaemonHostSource(): string {
  return (
    readFileSync(DAEMON_HOST_PATH, 'utf-8') +
    '\n' +
    readFileSync(DAEMON_RUNTIME_ASSEMBLY_PATH, 'utf-8')
  );
}

describe('DaemonAgentHost agentToolDeps + EngineConfig share dedup state (W5 L36)', () => {
  const source = readDaemonHostSource();

  it('declares readFileState / imageReadFileState / localDocReadFileState as const before agentToolDeps construction', () => {
    expect(source).toMatch(
      /const\s+readFileState\s*:\s*import\(['"]@tabtin\/agent-runtime\/engine['"]\)\.ReadFileState\s*=\s*new\s+Map\(\)/,
    );
    expect(source).toMatch(
      /const\s+imageReadFileState\s*:\s*import\(['"]@tabtin\/agent-runtime['"]\)\.ImageReadFileState\s*=\s*new\s+Map\(\)/,
    );
    expect(source).toMatch(
      /const\s+localDocReadFileState\s*:\s*import\(['"]@tabtin\/agent-runtime['"]\)\.LocalDocReadFileState\s*=\s*new\s+Map\(\)/,
    );
  });

  it('agentToolDeps + EngineConfig 块内**绝不**用 inline `new Map()` 构造三件套（必须复用 const 引用）', () => {
    // 全文不允许出现 `readFileState: new Map()` / `imageReadFileState: new Map()` /
    // `localDocReadFileState: new Map()` —— 任一退化为 inline 立即 fail。
    expect(source).not.toMatch(/\breadFileState\s*:\s*new\s+Map\(\)/);
    expect(source).not.toMatch(/\bimageReadFileState\s*:\s*new\s+Map\(\)/);
    expect(source).not.toMatch(/\blocalDocReadFileState\s*:\s*new\s+Map\(\)/);
  });

  it('agentToolDeps 块包含三件套字段（shorthand 引用 const）', () => {
    // 找 agentToolDeps: { ... } 块（非贪婪截断到首个匹配的 `},`）
    // agent tool deps block 通常很大，保守地匹配前 12000 字符。
    const agentToolDepsMatch = source.match(/agentToolDeps\s*:\s*\{([\s\S]{0,12000}?)\n\s{6}\},/);
    expect(agentToolDepsMatch).not.toBeNull();
    const block = agentToolDepsMatch![1];
    // shorthand 引用：字段名 + 逗号/换行（不是 `: 表达式`）
    expect(block).toMatch(/(^|[\s,{])readFileState\s*,/);
    expect(block).toMatch(/(^|[\s,{])imageReadFileState\s*,/);
    expect(block).toMatch(/(^|[\s,{])localDocReadFileState\s*,/);
  });

  it('EngineConfig 块包含三件套字段（shorthand 引用 const，与 agentToolDeps 同源）', () => {
    // 找 const config: EngineConfig = { ... } 块
    // window 12000：与上方 agentToolDeps 块同口径。per-file 回退迁移给 EngineConfig
    // 加了 `fileHistory` 字段 + 注释后，块体已从 ~7986 长到 ~8147 字符，原 8000 窗口
    // 刚好越界（lazy 匹配找不到块闭合 `\n    };` → null）。放宽到 12000 保住"截到整块"
    // 的意图，断言本身（三件套 shorthand）不变。
    const engineConfigMatch = source.match(
      /const\s+config\s*:\s*EngineConfig\s*=\s*\{([\s\S]{0,12000}?)\n\s{4}\};/,
    );
    expect(engineConfigMatch).not.toBeNull();
    const block = engineConfigMatch![1];
    expect(block).toMatch(/(^|[\s,{])readFileState\s*,/);
    expect(block).toMatch(/(^|[\s,{])imageReadFileState\s*,/);
    expect(block).toMatch(/(^|[\s,{])localDocReadFileState\s*,/);
  });

  it('注释引用 W5 L36 与历史 BUG 上下文（防"代码改对了但注释丢失"导致下次 reviewer 看不到 context）', () => {
    expect(source).toContain('W5 L36');
    expect(source).toMatch(/共享同一引用|share.*same.*reference/);
  });
});
