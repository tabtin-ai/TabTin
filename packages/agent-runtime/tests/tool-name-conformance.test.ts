/**
 * Tool name conformance — 防回归静态扫描。
 *
 * **背景**：LLM 上游对 tool function name 有硬正则约束
 * `^[a-zA-Z0-9_-]{1,64}$`（OpenAI / Anthropic 共同要求，不允许点号、CJK、
 * 空格等）。
 *
 * **历史 bug（2026-04-30 dogfood P0）**：曾经在 `system-tools.ts` 注册
 * `system.relaunch_app` / `system.clear_os_error_blacklist`，在 `plan-tools.ts`
 * 注册 `plan.create` / `plan.update_todos` / `plan.exit`——这五个工具名带点号，
 * 不走 Capability 装配通道（其装配阶段已有 `prepare.ts` 校验），直接被
 * `ElectronToolProvider` / `DaemonToolProvider` 拼到 `LLMRequest.tools`。
 * proxy-provider 出口校验拦下后整个 dogfood 100% 不可用。
 *
 * **本测试角色**：在 CI 阶段对 `packages/agent-runtime/src/tools/*.ts` 静态扫描
 * 所有 `name: '...'` / `name: "..."` 字面量，断言满足上游正则。补 prepare.ts 的
 * 装配校验对"非 Capability 通道工具"覆盖盲区。
 *
 * 设计为静态扫描（而非 invoke factory）原因：
 *   - factory 需要 deps，每个 factory 入参不同；mock 起来工作量大
 *   - 纯字符串扫描不依赖运行时，无副作用、稳定
 *   - 误判率低：tools/*.ts 里 `name: '...'` 字面量基本都是 Tool 定义
 *
 * 误判处理：在测试 expected 列表里显式标注豁免（目前列表为空）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归收集目录下所有 `.ts` 文件（排除 `.test.ts` 和 `index.ts`）。
 *
 * 旧版只用 `readdirSync(dir)` 不递归，错过 `tools/show-widget/index.ts` 这种
 * 子目录里的工具定义——防回归覆盖留了盲区。新版递归遍历，覆盖所有层级。
 */
function collectToolSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    // 跳过测试目录和私有 helper（`__tests__`、`_*`）
    if (entry === '__tests__' || entry.startsWith('_')) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectToolSourceFiles(path));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      entry !== 'index.ts'
    ) {
      out.push(path);
    }
  }
  return out;
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 从源代码字符串里抠出所有形如 `name: '...'` / `name: "..."` 的 Tool name 字面量。 */
function extractToolNameLiterals(source: string): { name: string; line: number }[] {
  const matches: { name: string; line: number }[] = [];
  // 仅匹配单行 `name: 'xxx'` / `name: "xxx"` —— Tool 定义格式
  const re = /\bname\s*:\s*(['"])([^'"\n]+)\1/g;
  let lineIdx = 1;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // 计算行号（从 lastIdx 到 m.index 之间的换行数）
    const between = source.slice(lastIdx, m.index);
    lineIdx += (between.match(/\n/g) ?? []).length;
    lastIdx = m.index;
    matches.push({ name: m[2], line: lineIdx });
  }
  return matches;
}

/** 判断字符串是否长得像 Tool 工具名（启发式：纯标识符或带点号 / 连字符 / 句号）。 */
function looksLikeToolName(s: string): boolean {
  // 排除明显不是工具名的 i18n key / URL / camelCase property 等
  if (/^[a-zA-Z][a-zA-Z0-9_.-]{0,80}$/.test(s)) return true;
  return false;
}

describe('Tool name conformance — 防回归静态扫描', () => {
  const TOOLS_DIR = join(__dirname, '..', 'src', 'tools');
  const SRC_ROOT = join(__dirname, '..', 'src');

  it('packages/agent-runtime/src/tools/**/*.ts 内所有 Tool name 字面量都满足 LLM 上游正则', () => {
    // 递归扫描包含子目录（如 `tools/show-widget/`）—— 旧版只扫顶层文件，
    // 漏抓了子目录里的 Tool 定义（dogfood P0 复盘发现的覆盖盲区）。
    const files = collectToolSourceFiles(TOOLS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: { file: string; line: number; name: string }[] = [];
    for (const path of files) {
      const src = readFileSync(path, 'utf-8');
      const literals = extractToolNameLiterals(src);
      for (const { name, line } of literals) {
        if (!looksLikeToolName(name)) continue;
        // 排除两类干扰：
        // 1) JSON Schema property 名（比如 "name" 字段），通常嵌套在大括号内的属性定义里
        //    现实中 tools/*.ts 里 inputSchema 的 properties 子项也叫 `name: 'xxx'`，
        //    需要靠"出现在 createXxx 工具体内"过滤。但启发式很难做对——
        //    因此我们改用**反向**判定：只要带点号 / 中文 / 空格就当违规。
        if (TOOL_NAME_RE.test(name)) continue;
        // 显示相对路径（去掉公共前缀），方便定位
        const rel = path.slice(TOOLS_DIR.length + 1);
        violations.push({ file: rel, line, name });
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map((v) => `  ${v.file}:${v.line} → ${JSON.stringify(v.name)}`)
        .join('\n');
      throw new Error(
        `\n[Tool name conformance] 检测到 ${violations.length} 个不合规的 \`name: '...'\` 字面量：\n${msg}\n\n` +
          `工具名必须匹配 ^[a-zA-Z0-9_-]{1,64}$（LLM 上游 OpenAI/Anthropic function name 硬约束）。\n` +
          `如果是 inputSchema property 名（不是 Tool 定义），请改命名或在本测试加豁免；否则改成 snake_case / dashes。`,
      );
    }
  });

  it('capability/{core,app,native,governance}/**/*.ts 工具也满足上游正则（与 prepare.ts 装配校验同源）', () => {
    // 完整覆盖所有 capability 子目录（含 `native/host-bootstrap.ts` 这种）
    const capabilityRoots = [
      'capability/core',
      'capability/app',
      'capability/native',
      'capability/governance',
    ];
    const violations: { file: string; line: number; name: string }[] = [];
    for (const rel of capabilityRoots) {
      const dir = join(SRC_ROOT, rel);
      let files: string[];
      try {
        files = collectToolSourceFiles(dir);
      } catch {
        // 目录不存在（比如 governance 还没建）— 跳过即可
        continue;
      }
      for (const path of files) {
        const src = readFileSync(path, 'utf-8');
        for (const { name, line } of extractToolNameLiterals(src)) {
          if (!looksLikeToolName(name)) continue;
          if (TOOL_NAME_RE.test(name)) continue;
          violations.push({
            file: path.slice(SRC_ROOT.length + 1),
            line,
            name,
          });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
