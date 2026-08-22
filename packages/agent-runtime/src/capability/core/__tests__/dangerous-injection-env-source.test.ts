/**
 * WP4 任务 C：env injection 风险词单源不变量测试。
 *
 * **业务背景**：早期总控文档 / PRD 用过 `DANGEROUS_INJECTION_ENV_KEYS` 这个
 * 字面，但实际全仓**从未存在**该标识符——真实单源是
 * `@tabtin/env-sanitize.DANGEROUS_INJECTION_VARS`，由 `@tabtin/terminal-core`
 * 经 `sanitizeEnv.ts` re-export 给两端 PtyManager 实现层（bridge 内部 spawn
 * 前调 sanitizeEnv 过滤）。
 *
 * **本测试作用**：把"单源不变量"固化为可命令验证的契约，防止：
 *   1. 任何 package 在 agent-runtime 边界内 inline 一份
 *      `new Set([...LD_PRELOAD, DYLD_INSERT_LIBRARIES, ...])`
 *   2. 历史字面 `DANGEROUS_INJECTION_ENV_KEYS` 被某个 Agent 误当成"应该新建
 *      的常量"加进 policy.ts —— 单源的真实物理位置在 env-sanitize 包，
 *      不在 terminal-core/policy.ts（policy.ts 管 sandbox/route/networkMode）
 *   3. ShellCap / agent-runtime 任何文件出现 `import * from '@tabtin/env-sanitize'`
 *      ——sanitize 在 bridge 实现层做，agent-runtime 上层不直接依赖
 *
 * **不变量**（3 条断言）：
 *   1. agent-runtime package.json 不列 `@tabtin/env-sanitize` 为依赖
 *      （prod 也不在 devDependencies）
 *   2. agent-runtime 任何源码不 inline 定义 LD_PRELOAD/DYLD_INSERT_LIBRARIES
 *      等 injection 风险词的 Set/Array（grep 文件树验证）
 *   3. agent-runtime 任何源码不出现 `from '@tabtin/env-sanitize'` import
 *
 * **不在本测试范围**：
 *   - `terminal-core/src/denylist.ts` 的 `export-env-injection` 正则是 shell
 *     命令注入检测（拦截 `export LD_PRELOAD=...` 这种命令），跟 env-sanitize
 *     的 process env 过滤是**完全不同的概念**——前者命令静态分析，后者
 *     进程 env 过滤，两者各有真实消费者，不该合并
 *   - `commandExecutor.ts` JSDoc 里 `LD_PRELOAD` 是注释例子，不是定义
 *   - terminal-core / pty-core 包内的检查由对应包自己测（不在 agent-runtime
 *     测试包内做跨包扫描，避免脆弱）
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath } from 'node:path';

describe('WP4-C: DANGEROUS_INJECTION_VARS 单源不变量', () => {
  it('agent-runtime/package.json 不依赖 @tabtin/env-sanitize（sanitize 必须经 bridge 实现层）', () => {
    const pkgPath = resolvePath(__dirname, '../../../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@tabtin/env-sanitize']).toBeUndefined();
    expect(pkg.devDependencies?.['@tabtin/env-sanitize']).toBeUndefined();
  });

  it('agent-runtime/src 不 inline 定义 LD_PRELOAD/DYLD/NODE_OPTIONS 等 injection 风险词 Set/Array', () => {
    const agentRuntimeSrc = resolvePath(__dirname, '../../../');
    const inlineHits: Array<{ file: string; lineNo: number; line: string }> = [];

    walkSourceFiles(agentRuntimeSrc, (file, lines) => {
      lines.forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        // 同行同时出现 LD_PRELOAD + DYLD_INSERT_LIBRARIES 字面 → 高概率
        // inline 风险词集合（注释里写"例如 LD_PRELOAD"不会两个 token 同行连写）。
        if (
          line.includes("'LD_PRELOAD'") &&
          line.includes("'DYLD_INSERT_LIBRARIES'")
        ) {
          inlineHits.push({ file, lineNo: idx + 1, line: line.trim() });
        }
        // 双引号变体兜底
        if (
          line.includes('"LD_PRELOAD"') &&
          line.includes('"DYLD_INSERT_LIBRARIES"')
        ) {
          inlineHits.push({ file, lineNo: idx + 1, line: line.trim() });
        }
      });
    });

    expect(
      inlineHits,
      `inline injection env Set 违反单源不变量:\n${inlineHits
        .map((h) => `  ${h.file}:${h.lineNo}\n    ${h.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('agent-runtime/src 不出现 from "@tabtin/env-sanitize" import', () => {
    const agentRuntimeSrc = resolvePath(__dirname, '../../../');
    const importHits: Array<{ file: string; lineNo: number; line: string }> = [];

    walkSourceFiles(agentRuntimeSrc, (file, lines) => {
      lines.forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (
          /from\s+['"]@tabtin\/env-sanitize['"]/.test(line) ||
          /require\(\s*['"]@tabtin\/env-sanitize['"]\s*\)/.test(line)
        ) {
          importHits.push({ file, lineNo: idx + 1, line: line.trim() });
        }
      });
    });

    expect(
      importHits,
      `agent-runtime 直接 import @tabtin/env-sanitize（违反单源不变量）:\n${importHits
        .map((h) => `  ${h.file}:${h.lineNo}\n    ${h.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('historical "DANGEROUS_INJECTION_ENV_KEYS" 字面在 agent-runtime/src 不作代码标识符出现', () => {
    // 历史文档 / PRD 用过这个字面但仓内从未真实存在；防止某个 Agent 误把
    // 文档字面当成"该新建的常量"加进代码。注释里的解释性引用允许，但
    // 不能作为 import / export / const 标识符出现。
    const agentRuntimeSrc = resolvePath(__dirname, '../../../');
    const usageHits: Array<{ file: string; lineNo: number; line: string }> = [];

    walkSourceFiles(agentRuntimeSrc, (file, lines) => {
      lines.forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        // 检测：作为标识符（const / import / export 后跟该名字 / 函数调用）
        if (
          /\b(const|let|var|export\s+const|import\s*\{[^}]*|export\s*\{[^}]*)\s*DANGEROUS_INJECTION_ENV_KEYS\b/.test(line) ||
          /\bDANGEROUS_INJECTION_ENV_KEYS\s*[=(\[]/.test(line)
        ) {
          usageHits.push({ file, lineNo: idx + 1, line: line.trim() });
        }
      });
    });

    expect(
      usageHits,
      `历史字面 DANGEROUS_INJECTION_ENV_KEYS 不应作代码标识符出现:\n${usageHits
        .map((h) => `  ${h.file}:${h.lineNo}\n    ${h.line}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

function walkSourceFiles(
  dir: string,
  visit: (file: string, lines: string[]) => void,
): void {
  for (const entry of readdirSync(dir)) {
    const full = joinPath(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
      walkSourceFiles(full, visit);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      const content = readFileSync(full, 'utf8');
      visit(full, content.split('\n'));
    }
  }
}
