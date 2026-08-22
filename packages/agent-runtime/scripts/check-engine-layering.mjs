#!/usr/bin/env node
/**
 * Engine 分层守卫 —— 断言「执行微内核」(`src/engine/**`) 不 import 任何
 * 高级能力 / 会与主循环成环的兄弟目录。
 *
 * 背景：engine 曾把子 Agent 编排、HITL 审批、终端可靠投递、上下文注入器等
 * 高级能力与微内核混在一层；#4007 分层后  又完成控制反转——compact /
 * telemetry / agent-modes / HITL 全部经 `QueryDeps` 端口（createContextManager /
 * observe / toolGate / interrupt）由组装根 `src/runtime-assembly.ts` 注入。
 * 本守卫在控制反转后**收紧为零目录白名单**（仅 prompts 纯文本资源例外），
 * 防止跨层直连回潮。
 *
 * 规则（仅约束 `src/engine/**`，排除 barrel `engine/index.ts` 与测试）：
 *   - `import type` / `export type`（类型擦除，运行时零依赖）—— 一律放行。
 *   - `@tabtin/*` 等外部包 —— 放行（基础层依赖，方向正确）。
 *   - 引擎内部相对 import（仍在 `engine/**`）—— 放行。
 *   - **动态 import**（`import('...')`）与静态 import 同规则扫描——历史上
 *     `restorePendingApprovalsPrelude` 曾用动态 import permissions 绕过守卫。
 *   - 跨顶层目录的**运行时** import —— 仅放行：
 *       prompts（纯文本提示词资源）、runtime-defaults（常量）、
 *       telemetry/events.ts（纯事件名常量，emit 本体经 deps.observe 注入）、
 *       permissions/os-error-blacklist.ts（纯常量叶子）。
 *   - `src/runtime-assembly.ts`（组装根）—— 组装根单向依赖内核，内核
 *     import 组装根即成环，违规。
 *   - 其余跨目录运行时 import（compact / history / telemetry emitter /
 *     subagent / capability / session / tools / host / providers / skills /
 *     state / permissions 策略实现 / agent-modes 兄弟目录）—— 分层违规。
 *     修复：经 QueryDeps 端口注入，或从 @tabtin/* 包引入，或改 import type。
 *
 *  批次 14 新增三条规则：
 *   1. **contracts 分层顺序**：`engine/contracts/**` 内部 import（含
 *      import type）必须遵守 7 层顺序（wire-protocol ← conversation ←
 *      model-llm ← tools ← hitl ← context-capability ← kernel），禁止反向。
 *      裸 `import('x').Foo` 内联类型引用是类型擦除的允许逃生口（与既有
 *      守卫对 guards 类型的口径一致）。
 *   2. **EngineState 黑板回归守卫**：`contracts/kernel.ts` 的
 *      `interface EngineState` 体内禁止新增 `_` / `__` 前缀字段——白名单
 *      钉死当前残留集。新信号走 hook outcome / RunContext / QueryDeps
 *      端口，不回黑板。
 *   3. **策略 knobs 内核零直读**：EngineConfig「策略 knobs」分节字段在
 *      `engine/**` 出现 `config.<knob>` / `ctx.config.<knob>` 直读即违规；
 *      豁免装配层 `core/default-policy-hooks.ts`，另钉死 loop.ts 构造期
 *      三处一次性解析（contextBudget / toolSchemaValidation /
 *      toolOutputScan → RunContext， 批次 12 口径）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PKG, 'src');
const ENGINE = path.join(SRC, 'engine');

// 纯资源目录（提示词文本，方向无害）。
const ALLOWED_LEAF_DIRS = new Set(['prompts']);
const ALLOWED_LEAF_FILES = new Set([
  path.join(SRC, 'runtime-defaults.ts'),
  path.join(SRC, 'permissions', 'os-error-blacklist.ts'),
  // 纯事件名常量（namespace.action 字符串表）；emitter 本体已从 engine 消失
  // （ 批次 2，遥测经 deps.observe 注入）。
  path.join(SRC, 'telemetry', 'events.ts'),
]);

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      walk(p, acc);
    } else if (e.name.endsWith('.ts')) {
      acc.push(p);
    }
  }
}

function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const noJs = base.endsWith('.js') ? base.slice(0, -3) : base;
  for (const c of [noJs + '.ts', path.join(noJs, 'index.ts')]) {
    if (fs.existsSync(c)) return c;
  }
  return noJs + '.ts';
}

const IMPORT_RE =
  /(?:^|\n)[ \t]*(import|export)([ \t]+type)?\b([^;]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g;
// 动态 import 补扫：只匹配 `await import('...')`（真实运行时加载——历史违规
// 的形态）。裸 `import('x').Foo` 是 TS 类型位置引用（类型擦除，运行时零依赖），
// 与 `import type` 同等放行。
const DYNAMIC_IMPORT_RE = /\bawait\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const files = [];
walk(ENGINE, files);

const violations = [];

function checkSpecifier(file, spec, kind) {
  if (!spec.startsWith('.')) return; // 外部包
  const target = resolveSpecifier(file, spec);
  if (target.startsWith(ENGINE + path.sep)) return; // 引擎内部
  if (!target.startsWith(SRC + path.sep)) return; // 包外（不太可能）
  if (ALLOWED_LEAF_FILES.has(target)) return;
  const rel = path.relative(SRC, target);
  if (rel === 'runtime-assembly.ts') {
    violations.push({ file: path.relative(PKG, file), spec, target: rel, kind: `${kind}（组装根反向依赖，成环）` });
    return;
  }
  const topDir = rel.split(path.sep)[0];
  if (ALLOWED_LEAF_DIRS.has(topDir)) return;
  violations.push({ file: path.relative(PKG, file), spec, target: rel, kind });
}

for (const file of files) {
  if (file === path.join(ENGINE, 'index.ts')) continue; // barrel 门面豁免
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const isType = Boolean(m[2]);
    if (isType) continue;
    checkSpecifier(file, m[4], 'static import');
  }
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) {
    checkSpecifier(file, m[1], 'dynamic import');
  }
}

// ─── 规则 1（ 批次 14）：contracts 7 层顺序 ───────────────────────
// 层序表：后层只能 import 前层；同层 / 反向都算违规（同层前向引用应并入
// 同一文件解决）。inline `import('x').Foo` 类型引用不在此列（类型擦除）。
const CONTRACT_LAYERS = [
  'wire-protocol',
  'conversation',
  'model-llm',
  'tools',
  'hitl',
  'context-capability',
  'kernel',
];
const CONTRACTS_DIR = path.join(ENGINE, 'contracts');

function contractLayerOf(file) {
  if (!file.startsWith(CONTRACTS_DIR + path.sep)) return -1;
  const name = path.basename(file, '.ts');
  return CONTRACT_LAYERS.indexOf(name);
}

for (const file of files) {
  const fromLayer = contractLayerOf(file);
  if (fromLayer === -1) continue;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[4];
    if (!spec.startsWith('.')) continue;
    const target = resolveSpecifier(file, spec);
    const toLayer = contractLayerOf(target);
    if (toLayer === -1) continue; // 非 contracts 目标由既有规则约束
    if (toLayer >= fromLayer) {
      violations.push({
        file: path.relative(PKG, file),
        spec,
        target: path.relative(SRC, target),
        kind: `contracts 层序违规（第 ${fromLayer + 1} 层不得 import 第 ${toLayer + 1} 层，含 import type）`,
      });
    }
  }
}

// ─── 规则 2（ 批次 14）：EngineState 黑板回归守卫 ─────────────────
// 白名单钉死当前残留集；新增 `_` / `__` 前缀字段即违规。
// 新信号走 hook outcome（如 setBudgetEvaluation）/ RunContext accessor /
// QueryDeps 端口，不回 EngineState 黑板。
const ENGINE_STATE_FIELD_WHITELIST = new Set([
  // 单下划线残留（计费 / 预算基线， / PRD-04）
  '_cachedInputTokens',
  '_lastChargeStatus',
  '_budgetRunBaseline',
  '_budgetRunBaselineByModel',
  // 双下划线残留（retry notice 通道）——#6009 Phase 2 已移除 force-final
  // 黑板字段（`__force_final__` / `__budgetExceeded`），改走 RunContext
  // forceFinalRef 显式通道，故白名单同步删除这两项。
  '__pendingNotices',
]);

{
  const kernelFile = path.join(CONTRACTS_DIR, 'kernel.ts');
  const src = fs.readFileSync(kernelFile, 'utf8');
  const start = src.indexOf('export interface EngineState {');
  if (start === -1) {
    violations.push({
      file: path.relative(PKG, kernelFile),
      spec: 'interface EngineState',
      target: 'contracts/kernel.ts',
      kind: 'EngineState 守卫失效（未找到 interface 定义，请更新守卫脚本）',
    });
  } else {
    // 按花括号配对截取 interface 体
    let depth = 0;
    let end = start;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = src.slice(start, end);
    for (const m of body.matchAll(/^\s*(_\w+)\??\s*:/gm)) {
      const field = m[1];
      if (!ENGINE_STATE_FIELD_WHITELIST.has(field)) {
        violations.push({
          file: path.relative(PKG, kernelFile),
          spec: field,
          target: 'interface EngineState',
          kind: 'EngineState 黑板回归（新增下划线前缀字段）——新信号走 hook outcome / RunContext / QueryDeps 端口，不回黑板',
        });
      }
    }
  }
}

// ─── 规则 3（ 批次 14）：策略 knobs 内核零直读 ────────────────────
// EngineConfig「策略 knobs」分节字段（contracts/kernel.ts 分节注释为准）。
// 解析与兜底收敛到装配层：default-policy-hooks 两个 builder / runtime-assembly /
// loop 构造期一次性解析进 RunContext。内核其余位置 `config.<knob>` /
// `ctx.config.<knob>` 直读即违规。
const POLICY_KNOBS = [
  'contextBudget',
  'doomLoopPolicy',
  'maxMessageChars',
  'normalizationLevel',
  'toolSchemaValidation',
  'toolOutputScan',
  'attachmentStrategy',
  'syncPersistence',
  'enableSummaryReuse',
  'summaryReuseJudgeSampleRate',
  'summaryReuseJudgeWindowSize',
  'summaryReuseJudgeThreshold',
  'summaryReuseMaxAgeMs',
  'summaryReuseMinAddedMessages',
  'summaryReuseJudgeFn',
  'iterationBudget',
  'toolFailureTracker',
  'toolRepetitionTracker',
  'maxConcurrentChildren',
  'maxSubagentQueue',
  'timeBasedMicroCompact',
  'pressureThresholds',
  'subagentResultCompact',
  'postCompactAttachmentBudget',
  'fallbackModel',
  'fallbackChain',
];
// 装配层豁免：policy hook builder 全文件豁免。
const KNOB_EXEMPT_FILES = new Set([
  path.join(ENGINE, 'core', 'default-policy-hooks.ts'),
]);
// 钉死的既有事实：loop.ts 构造期一次性解析进 RunContext（ 批次 12）。
// 只允许这三个 (file, knob) 组合，新增组合仍违规。
const KNOB_PINNED_READS = new Set([
  `core/loop.ts::contextBudget`,
  `core/loop.ts::toolSchemaValidation`,
  `core/loop.ts::toolOutputScan`,
]);
const KNOB_RE = new RegExp(`\\bconfig\\.(${POLICY_KNOBS.join('|')})\\b`, 'g');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

for (const file of files) {
  if (KNOB_EXEMPT_FILES.has(file)) continue;
  if (contractLayerOf(file) !== -1) continue; // 契约定义自身不算消费
  const relToEngine = path.relative(ENGINE, file);
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  for (const m of code.matchAll(KNOB_RE)) {
    const knob = m[1];
    if (KNOB_PINNED_READS.has(`${relToEngine}::${knob}`)) continue;
    violations.push({
      file: path.relative(PKG, file),
      spec: `config.${knob}`,
      target: 'EngineConfig 策略 knobs',
      kind: '策略 knob 内核直读——解析与兜底应收敛到装配层（default-policy-hooks / runtime-assembly / loop 构造期 RunContext），经闭包 / RunContext 注入消费',
    });
  }
}

if (violations.length > 0) {
  console.error('engine 分层守卫失败——微内核出现禁止的跨层运行时 import：\n');
  for (const v of violations) {
    console.error(`  ${v.file}\n    → ${v.kind} '${v.spec}'  (${v.target})`);
  }
  console.error(
    '\n修复：把该依赖经 QueryDeps 端口（createContextManager / observe / toolGate / interrupt）' +
    '或 EngineConfig 注入，或从 @tabtin/* 包引入，或改为 import type。',
  );
  process.exit(1);
}

console.log(
  `engine 分层守卫通过：扫描 ${files.length} 个微内核文件——` +
  `跨层运行时 import 零违规；contracts 7 层顺序合规；` +
  `EngineState 黑板字段钉死 ${ENGINE_STATE_FIELD_WHITELIST.size} 个残留；` +
  `策略 knobs（${POLICY_KNOBS.length} 个）内核零直读。`,
);
