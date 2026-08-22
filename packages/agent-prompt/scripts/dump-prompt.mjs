#!/usr/bin/env node
/**
 * dump-prompt — agent-prompt 治理阶段 1.3 dev 工具
 *
 * 用当前 host 配置 build 出完整 system prompt，按 text / json / sections
 * 0_active_renderers.yaml + builder.snapshot.test.ts 一起做离线/CI 验证。
 *
 * 设计 style 与同目录 generate-content.mjs 一致：纯 .mjs、不引入新依赖、
 * 直接 import 已 build 出的 ../dist/index.js（运行前需先跑 build）。
 *
 * 用法：
 *   node scripts/dump-prompt.mjs [options]
 *
 * 看完整 help：
 *   node scripts/dump-prompt.mjs --help
 *
 * 退出码：0 成功 / 1 参数错误 / 2 build 失败（dist 缺失或 import 失败）
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 阶段 2 收尾（2026-05-20 review）：SECTION_BUDGETS 从 REGISTRY_ENTRIES 派生，
// 避免与注册表 / 0_active_renderers.yaml 漂移（之前 tools_reference 手写表 3600
// vs 注册表 5500）。注册表是单一 SSoT，本脚本仅消费。
import { REGISTRY_ENTRIES } from '@tabtin/prompt-contract';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = resolve(__dirname, '../dist/index.js');
const PKG_ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(PKG_ROOT, 'src');
const DIST_DIR = resolve(PKG_ROOT, 'dist');
const SCRIPTS_DIR = resolve(PKG_ROOT, 'scripts');

// ─── 静态 fixtures（脱离 src/ 单独维护，dev 脚本可接受冗余）─────────────

/** 与 builder.snapshot.test.ts FIXED_RUNTIME_IDENTITY 一致。 */
const FIXED_RUNTIME_IDENTITY = {
  spaceId: 'space-dump-fixture',
  organizationId: 'organization-dump-fixture',
  sessionId: 'session-dump-fixture',
  spaceName: '示例空间',
  organizationName: '示例团队',
  workspaceRoot: '/tmp/dump-workspace',
  archiveDir: '/tmp/dump-platform-data/archive',
  toolLogsDir: '/tmp/dump-platform-data/tool-logs',
};

/** 与 builder.snapshot.test.ts FIXED_TOOLS 一致（8 个核心工具）。 */
const MINIMAL_TOOLS = [
  { name: 'run_terminal_command', description: '执行 shell 命令' },
  { name: 'read_file', description: '读文件' },
  { name: 'edit_file', description: '编辑文件' },
  { name: 'ask_user', description: '向用户提多选问题' },
  { name: 'web_search', description: '搜索网络' },
  { name: 'todo_write', description: '维护 todo 列表' },
  { name: 'skills_search', description: '搜索本地 skill' },
  { name: 'skills_read', description: '读取本地 skill' },
];

/**
 * FULL_TOOLS 直接派生自 `REGISTRY_ENTRIES`（review G2 修：去 SSoT 漂移）。
 *
 * 旧实现是手写数组，文件顶部声明"yaml 是 SSoT；本数组定期人工 sync"——
 * 实际维护时三处会漂移：(1) 注册表 + (2) 这里 + (3) audit fixture。改用派生
 * 让 dump-prompt 始终反映注册表当前状态。
 *
 * **注意**：本数组的 `description` 字段是 registry 简介（不是工具真正的 L1
 * description）。dump-prompt 渲染的是 `<tools_reference>` 段——阶段 6.2 治理
 * 后该段只列 name + 跨工具决策，不复述 description；所以这里的简介只用作
 * "fallback `<其他>` 分类的工具简介"，不污染真实工具决策。
 */
const FULL_TOOLS = REGISTRY_ENTRIES.filter((e) => e.category === 'tool_description').map(
  (e) => ({
    name: e.id.endsWith('_tool') ? e.id.slice(0, -'_tool'.length) : e.id,
    description: e.description,
  }),
);

/** 与 builder.snapshot.test.ts FIXED_APPS 一致。 */
const FIXED_APPS = [
  { key: 'tabdata', cliKey: 'table', displayName: '多维表', capability: '结构化数据表格', aliases: ['表格'] },
  { key: 'tabdoc', cliKey: 'doc', displayName: '文档', capability: '富文本协作文档' },
];

/**
 * 各段 charBudget 表 —— 从 @tabtin/prompt-contract `REGISTRY_ENTRIES` 按
 * `xmlTag` 派生，**单一 SSoT 来自注册表**。
 *
 * 阶段 2 收尾（2026-05-20）：之前是手写表，与 0_active_renderers.yaml /
 * registry-entries.generated.ts 容易漂移（review 抓到 tools_reference
 * 手写 3600 vs 注册表 5500）。改成派生消除双 SSoT。
 *
 * 派生规则：按 xmlTag group，取 max charBudget。譬如 agent_mode_plan_section /
 * agent_mode_ask_section / agent_mode_study_section / agent_mode_group_section
 * 4 个 entry 共享 xmlTag='agent_mode'，取 4 个 charBudget 的最大值——这样
 * dump 显示的 budget 反映"该 xmlTag 在所有 mode 下的最大允许值"。
 */
const SECTION_BUDGETS = (() => {
  const budgets = {};
  for (const entry of REGISTRY_ENTRIES) {
    if (!entry.xmlTag) continue;
    const current = budgets[entry.xmlTag];
    budgets[entry.xmlTag] = current
      ? Math.max(current, entry.charBudget)
      : entry.charBudget;
  }
  return budgets;
})();

// ─── CLI parser ─────────────────────────────────────────────────────────

const HELP_TEXT = `dump-prompt — agent-prompt build 后离线 dump 工具

用法：
  node scripts/dump-prompt.mjs [options]
  pnpm --filter @tabtin/agent-prompt dump -- [options]

Options:
  --mode=agent|plan|ask|study|group   agentMode（默认 agent）
  --host=electron|daemon              标注模拟哪条 host（默认 electron）。
                                       ⚠ 本 flag **只切换 meta.host 标签，不切换
                                       fixture** —— 两次 dump 输出字节级相同是
                                       "builder 对相同入参吐相同输出"（trivially
                                       true），**不是**"两 host 在生产中真传相同入
                                       参"的证明。两 host 入参/hook 是否真等价由
                                       P5 audit 静态扫 host 源校验（audit.test.ts
                                       "P5 · 双路径对称"），不由本 flag 校验。
                                       本 flag 仅用于 dump 时人眼标注当前模拟视角。
  --tools=full|minimal|<path.json>    工具集（默认 minimal=8 个；full=34 个；
                                       JSON path 时文件内容必须是
                                       [{name,description},...] 数组）
  --workspace=<path>                  workspaceRoot（默认 /tmp/dump-workspace；
                                       同时影响 archiveDir / toolLogsDir 衍生路径）
  --apps                              注入 fixture 的 2 个启用 App
  --user-portrait=<text|@path>        user portrait；@path 时读文件
  --custom-rules=<text|@path>         custom rules；@path 时读文件
  --cli-reference=<text|@path>        cli reference；@path 时读文件
  --format=text|json|sections|registry-summary
                                       输出格式（默认 sections；registry-summary
                                       = 从 registry 简介派生的工具长度报表，
                                       **不是** runtime 工厂的真实 description
                                       长度，仅作"如果工具描述写成简介长度会
                                       消耗多少"的跨工具相对比较。真实 tools[]
                                       字符合计由 agent-runtime 包的 audit P2
                                       校验）
  --output=<path>                     写入文件（默认 stdout）
  --help                              本帮助

退出码：
  0  成功
  1  参数错误
  2  build 失败（dist/index.js 缺失或 import 失败）—— 先跑
     pnpm --filter @tabtin/agent-prompt build

示例：
  node scripts/dump-prompt.mjs --mode=plan --format=sections
  node scripts/dump-prompt.mjs --tools=full --apps --format=json
  node scripts/dump-prompt.mjs --user-portrait=@./portrait.md --format=text
`;

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    // pnpm run dump -- --foo 会把裸 `--` 也传给 script，直接跳过。
    if (raw === '--') continue;
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    if (!raw.startsWith('--')) {
      throw new UsageError(`未识别参数：${raw}（参数必须以 --key= 或 --flag 形式）`);
    }
    const eq = raw.indexOf('=');
    if (eq === -1) {
      args[raw.slice(2)] = true;
    } else {
      args[raw.slice(2, eq)] = raw.slice(eq + 1);
    }
  }
  return args;
}

class UsageError extends Error {}
class BuildError extends Error {}

/**
 * 把 `<text|@path>` 形态的输入归一化为字符串。`@path` 前缀 = 读文件；
 * 否则当字面文本。
 */
function resolveTextOrFile(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`${label} 期望字符串，收到 ${typeof value}`);
  }
  if (value.startsWith('@')) {
    const path = value.slice(1);
    const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
    if (!existsSync(abs)) {
      throw new UsageError(`${label} 文件不存在：${abs}`);
    }
    return readFileSync(abs, 'utf-8');
  }
  return value;
}

/**
 * 检测 dist 是否比源码旧（stale build）—— review P1-2 加。
 *
 * 算法：
 *   1. 收集 src/ 下所有 .ts + scripts/generate-content.mjs 的 mtime 最大值。
 *   2. 对比 dist/index.js mtime —— 如果 src 比 dist 新，dist 是 stale 的。
 *   3. 返回 { stale, newestSrcRel, newestSrcMs, distMs, distRel }。
 *
 * 包内 dev 脚本，可接受 O(src 文件数) 一次性遍历开销。不递归 node_modules /
 * __tests__（这些改动不影响 build 产物）。
 */
function detectStaleDist() {
  const distMs = statSync(DIST_INDEX).mtimeMs;
  let newestSrcMs = 0;
  let newestSrcAbs = '';

  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        visit(full);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs'))) {
        const m = statSync(full).mtimeMs;
        if (m > newestSrcMs) {
          newestSrcMs = m;
          newestSrcAbs = full;
        }
      }
    }
  };
  visit(SRC_DIR);
  // scripts/generate-content.mjs 输出 generated-content.ts—— 它本身改了也要重 build
  const generateScript = resolve(SCRIPTS_DIR, 'generate-content.mjs');
  if (existsSync(generateScript)) {
    const m = statSync(generateScript).mtimeMs;
    if (m > newestSrcMs) {
      newestSrcMs = m;
      newestSrcAbs = generateScript;
    }
  }

  const stale = newestSrcMs > distMs;
  return {
    stale,
    newestSrcMs,
    distMs,
    newestSrcRel: newestSrcAbs
      ? newestSrcAbs.startsWith(PKG_ROOT)
        ? '.' + newestSrcAbs.slice(PKG_ROOT.length)
        : newestSrcAbs
      : '(none)',
    distRel: DIST_INDEX.startsWith(PKG_ROOT)
      ? '.' + DIST_INDEX.slice(PKG_ROOT.length)
      : DIST_INDEX,
  };
}

function loadTools(spec) {
  if (!spec || spec === 'minimal') return MINIMAL_TOOLS;
  if (spec === 'full') return FULL_TOOLS;
  const abs = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  if (!existsSync(abs)) {
    throw new UsageError(`--tools 文件不存在：${abs}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (err) {
    throw new UsageError(`--tools 文件不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(`--tools 文件期望数组，收到 ${typeof parsed}`);
  }
  for (const [i, t] of parsed.entries()) {
    if (!t || typeof t.name !== 'string' || typeof t.description !== 'string') {
      throw new UsageError(`--tools[${i}] 缺 name / description 字段`);
    }
  }
  return parsed;
}

function buildRuntimeIdentity(workspaceRoot) {
  const ws = workspaceRoot || '/tmp/dump-workspace';
  return {
    ...FIXED_RUNTIME_IDENTITY,
    workspaceRoot: ws,
    archiveDir: `${ws.replace(/\/+$/, '')}/.platform-data/archive`,
    toolLogsDir: `${ws.replace(/\/+$/, '')}/.platform-data/tool-logs`,
  };
}

// ─── section 切分 ───────────────────────────────────────────────────────

/**
 * 按行首闭合 XML 标签切分 buildSystemPrompt 输出。所有 section builder
 * 输出都形如 `<xxx>\n...\n</xxx>`，段间用 `\n\n` 连接，所以 multiline
 * regex 能精确切。section 内部对其他 tag 的引用都用反引号包裹（譬如
 * `` `<environment>` ``），不会出现在行首，不会误匹配。
 */
function splitSections(fullPrompt) {
  const re = /^<([a-z_][\w-]*)>\n([\s\S]*?)\n<\/\1>$/gm;
  const out = [];
  let m;
  while ((m = re.exec(fullPrompt)) !== null) {
    out.push({ tag: m[1], body: m[2], full: m[0] });
  }
  return out;
}

function formatSections(sections) {
  const totalChars = sections.reduce((sum, s) => sum + s.full.length, 0);
  const totalBudget = sections.reduce(
    (sum, s) => sum + (SECTION_BUDGETS[s.tag] ?? 0),
    0,
  );
  const lines = [];
  for (let i = 0; i < sections.length; i++) {
    const { tag, full } = sections[i];
    const budget = SECTION_BUDGETS[tag];
    const budgetText = budget
      ? `${full.length} chars / budget ${budget}`
      : `${full.length} chars / budget ?`;
    lines.push(`━━━ [${i + 1}/${sections.length}] <${tag}>  (${budgetText}) ━━━`);
    lines.push(full);
    lines.push('');
  }
  const pct = totalBudget > 0 ? Math.round((totalChars / totalBudget) * 100) : 0;
  lines.push(
    `总计：${sections.length} 段 / ${totalChars} 字符 / 占 budget ${pct}%（budget 合计 ${totalBudget}）`,
  );
  return lines.join('\n');
}

function formatJson(systemPrompt, sections, config) {
  return JSON.stringify(
    {
      system: systemPrompt,
      charCount: systemPrompt.length,
      sectionCount: sections.length,
      sectionBreakdown: sections.map((s) => ({
        tag: s.tag,
        chars: s.full.length,
        budget: SECTION_BUDGETS[s.tag] ?? null,
      })),
      // 2026-05-21 review 第三轮修：原字段名 toolsBreakdown 误导成"真实工具
      // 描述合计"——实际是 fixture 简介长度。改名 registrySummary 让消费者
      // 一眼知道这只是 fixture 派生的相对参考。真实 tools[] 合计由 audit P2 校验。
      registrySummary: buildToolsBreakdown(config.tools ?? []),
      meta: {
        mode: config.agentMode ?? 'agent',
        // Stage 4 双路径 audit：dump 同时记录"模拟的 host 装配链路"，让对比
        // ``electron`` / ``daemon`` 两次 dump 的 ``meta.host`` 差异一目了然
        // （prompt 主体应完全等价）。
        host: config._hostLabel ?? 'electron',
        tools: config.tools?.length ?? 0,
        runtimeIdentity: !!config.runtimeIdentity,
        enabledApps: config.enabledApps?.length ?? 0,
        userPortrait: !!config.userPortrait,
        customRules: !!config.customRules,
        cliReference: !!config.cliReference,
      },
    },
    null,
    2,
  );
}

/**
 * registry-summary 派生器 —— **仅基于 fixture 的简介长度**，不是真实工厂
 * description。
 *
 * 2026-05-21 review 第三轮收紧：
 *   - 不再返回 targetTotal / overTarget 字段——那容易让消费者误以为本数据
 *     就是治理目标 ≤10000 的合规依据。
 *   - 真实 tools[] description 合计的硬门槛由 agent-runtime 包的 audit P2
 *     单工具上限校验 + 后续 6.3 阶段加 aggregate 合计断言。
 */
function buildToolsBreakdown(tools) {
  // 用 tool name 反查 registry tier + charBudget
  const registryByToolName = new Map();
  for (const e of REGISTRY_ENTRIES) {
    if (e.category !== 'tool_description') continue;
    const toolName = e.id.endsWith('_tool') ? e.id.slice(0, -'_tool'.length) : e.id;
    registryByToolName.set(toolName, { tier: e.tier ?? 'unknown', budget: e.charBudget });
  }

  let totalChars = 0;
  let totalBudget = 0;
  const items = tools.map((t) => {
    const chars = (t.description ?? '').length;
    const info = registryByToolName.get(t.name) ?? { tier: 'unknown', budget: null };
    totalChars += chars;
    if (typeof info.budget === 'number') totalBudget += info.budget;
    return {
      name: t.name,
      chars,
      tier: info.tier,
      budget: info.budget,
      over: typeof info.budget === 'number' ? chars > info.budget : false,
    };
  });

  return {
    items,
    totalChars,
    totalBudget,
    // 标注数据语义，避免消费者误用
    dataSource: 'fixture (registry summary)',
    truthSourceForTotal: '@tabtin/agent-runtime tool-description-audit.test.ts P2',
  };
}

/** human-readable registry-summary 报表 —— `--format=registry-summary` 用。 */
function formatToolsBreakdown(config) {
  const b = buildToolsBreakdown(config.tools ?? []);
  // 2026-05-21 review 第三轮：标题永远明示数据来源——即使 caller 传了自己的
  // --tools=@some.json，那也是 fixture（非 runtime 工厂吐出的真 description）。
  const lines = [
    `━━━ registry-summary 报表（${b.items.length} 工具）━━━`,
    '',
    '⚠  数据来源：当前 --tools 参数指向的 fixture 数组的 description 字段长度。',
    '    **不是** runtime 工厂吐出的真实 Tool.description（譬如 read_file 真实',
    '    description ~1392 chars，而 registry 简介只 76 chars）。',
    '    真实 tools[] description 合计由 agent-runtime 的 audit P2 校验：',
    '    `pnpm --filter @tabtin/agent-runtime exec vitest run \\',
    '       src/tools/__tests__/tool-description-audit.test.ts`',
    '    本报表只反映"如果工具描述写成简介长度会消耗多少"——跨工具相对比较用途。',
    '',
  ];
  for (const it of b.items) {
    const budgetText = typeof it.budget === 'number'
      ? `/ budget ${it.budget} (${it.tier})`
      : `/ budget ? (${it.tier})`;
    const flag = it.over ? '  ✗ over (fixture 简介就超 tier budget — 不可能，应是 fixture 异常)' : '';
    lines.push(`  ${it.name.padEnd(30)} ${String(it.chars).padStart(5)} ${budgetText}${flag}`);
  }
  lines.push('');
  // 不再展示"目标 ≤10000"——那是 runtime 工厂真合计的硬目标，跟 fixture 长度比较无意义
  lines.push(`fixture 简介合计: ${b.totalChars} chars（仅作工具数 / 分布相对参考）`);
  if (b.totalBudget > 0) {
    lines.push(`(理论 budget 合计 ${b.totalBudget}，若工具 description 写满 budget 则上限合计)`);
  }
  return lines.join('\n');
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`参数错误：${err.message}\n\n`);
      process.stderr.write(HELP_TEXT);
      process.exit(1);
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  const mode = args.mode ?? 'agent';
  const validModes = new Set(['agent', 'plan', 'ask', 'study', 'group']);
  if (!validModes.has(mode)) {
    process.stderr.write(`参数错误：--mode 必须是 ${[...validModes].join(' / ')}，收到 ${mode}\n`);
    process.exit(1);
  }

  // W7c · Stage 4：``--host=electron|daemon`` 模拟两 host 装配链路。当前 Stage 4
  // 实施后两 host 入参字段集合完全等价（P5 audit 守门），所以 ``--host`` 选项
  // 当前**不改变 dump 输出**。保留 flag 让 reviewer 离线验证"diff 为零"成立，
  // 也为未来如果两 host 出现合理差异时（譬如 Electron 注入仅主进程能拿到的字段）
  // 提供切换入口。
  const host = args.host ?? 'electron';
  const validHosts = new Set(['electron', 'daemon']);
  if (!validHosts.has(host)) {
    process.stderr.write(`参数错误：--host 必须是 ${[...validHosts].join(' / ')}，收到 ${host}\n`);
    process.exit(1);
  }

  const format = args.format ?? 'sections';
  // 2026-05-21 review 第三轮修：把 `tools` 改名为 `registry-summary`，明示数据来源
  // 是 registry 简介 fixture 而非 runtime 工厂真实 description。
  // 旧 `tools` 别名仍 work 但 stderr warn——避免 PR 链接到旧文案。
  const validFormats = new Set(['text', 'json', 'sections', 'registry-summary', 'tools']);
  if (!validFormats.has(format)) {
    process.stderr.write(`参数错误：--format 必须是 ${[...validFormats].join(' / ')}，收到 ${format}\n`);
    process.exit(1);
  }
  if (format === 'tools') {
    process.stderr.write(
      `提示：--format=tools 已改名为 --format=registry-summary（数据来源是 registry 简介 fixture，` +
        `不是 runtime 工厂真实 description）。旧名仍 work，建议下次用新名。\n`,
    );
  }

  if (!existsSync(DIST_INDEX)) {
    process.stderr.write(
      `build 失败：找不到 dist/index.js（路径：${DIST_INDEX}）\n` +
        `请先跑：pnpm --filter @tabtin/agent-prompt build\n`,
    );
    process.exit(2);
  }

  // 2026-05-21 review 第四轮（P1-2）：stale dist guard。
  // 之前 dump-prompt 只检查 dist 是否存在不检查时间——src/sections.ts 改完
  // 没 build 时，dump-prompt 仍 import 旧 dist 输出**陈旧** prompt。review 复
  // 现：src/sections.ts 把 `background_task_id` 改成 `session_id` 后没 build，
  // dump-prompt --format=text 仍输出旧字符串。这把"运行 dump 前必须 build"从
  // 人肉纪律升级为脚本硬失败。
  const staleCheck = detectStaleDist();
  if (staleCheck.stale) {
    process.stderr.write(
      `dump-prompt 拒绝运行：dist 比源码旧（stale build）\n` +
        `  最新的 src/scripts 文件：${staleCheck.newestSrcRel}（mtime ${new Date(staleCheck.newestSrcMs).toISOString()}）\n` +
        `  对照的 dist 文件：${staleCheck.distRel}（mtime ${new Date(staleCheck.distMs).toISOString()}）\n` +
        `  落后：${Math.round((staleCheck.newestSrcMs - staleCheck.distMs) / 1000)}s\n` +
        `\n请先跑：pnpm --filter @tabtin/agent-prompt build\n`,
    );
    process.exit(2);
  }

  let mod;
  try {
    mod = await import(pathToFileURL(DIST_INDEX).href);
  } catch (err) {
    process.stderr.write(`build 失败：import dist/index.js 报错：${err.message}\n`);
    process.exit(2);
  }
  const { buildSystemPrompt } = mod;
  if (typeof buildSystemPrompt !== 'function') {
    process.stderr.write(`build 失败：dist/index.js 没 export buildSystemPrompt\n`);
    process.exit(2);
  }

  let tools, userPortrait, customRules, cliReference;
  try {
    tools = loadTools(args.tools);
    userPortrait = resolveTextOrFile(args['user-portrait'], '--user-portrait');
    customRules = resolveTextOrFile(args['custom-rules'], '--custom-rules');
    cliReference = resolveTextOrFile(args['cli-reference'], '--cli-reference');
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`参数错误：${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const config = {
    agentMode: mode,
    tools,
    runtimeIdentity: buildRuntimeIdentity(args.workspace),
    enabledApps: args.apps ? FIXED_APPS : undefined,
    userPortrait,
    customRules,
    cliReference,
    // ``host`` 不进 buildSystemPrompt（agent-prompt SystemPromptConfig 不识别），
    // 仅用于本脚本元信息输出 / 未来 host-specific fixture 切换。Stage 4 双路径
    // 对齐后 ``--host=electron`` 与 ``--host=daemon`` 输出预期完全等价。
    _hostLabel: host,
  };

  // 剥 ``_hostLabel`` —— ``SystemPromptConfig`` 不识别这个字段（TS 严格模式下
  // 会报错；运行时不报但属于"假冒入参"）。本脚本元信息单独透出，不污染 builder。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _hostLabel: _ignoredHostLabel, ...builderConfig } = config;
  let prompt;
  try {
    prompt = buildSystemPrompt(builderConfig);
  } catch (err) {
    process.stderr.write(`build 失败：buildSystemPrompt 抛错：${err.message}\n`);
    process.exit(2);
  }

  const sections = splitSections(prompt);

  let output;
  if (format === 'text') {
    output = prompt;
  } else if (format === 'json') {
    output = formatJson(prompt, sections, config);
  } else if (format === 'registry-summary' || format === 'tools') {
    output = formatToolsBreakdown(config);
  } else {
    output = formatSections(sections);
  }

  if (args.output) {
    const abs = isAbsolute(args.output) ? args.output : resolve(process.cwd(), args.output);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, output, 'utf-8');
    process.stderr.write(`已写入：${abs}（${output.length} chars）\n`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith('\n')) process.stdout.write('\n');
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`未预期错误：${err.stack || err.message || err}\n`);
  process.exit(2);
});
