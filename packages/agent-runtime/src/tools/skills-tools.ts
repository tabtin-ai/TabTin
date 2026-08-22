/**
 * Skills FC 工具（`skills_read` / `skills_search`）— 本地 Skill 模块 Wave B · M3
 *
 * 角色：agent-runtime 提供**工具接口**；Electron / Daemon 宿主各自持有
 * `LocalSkillRegistry`，经 host injection 提供实现回调。
 *
 * 为什么这样划分：
 * - agent-runtime 是 pure TS 库（Daemon / Electron 共用），不能直接依赖
 *   chokidar / fs.watch / Electron API；磁盘生命周期由宿主进程编排。
 * - host injection 模式对齐现有 `SkillsFetcher` / `createSkillsAndNotes`
 *   的做法：调用方负责注入运行时能力，工具只关心"拿到能力后怎么用"。
 *
 * 命名：下划线（`skills_read` / `skills_search`）而非点号——Moonshot / OpenAI /
 * Anthropic 的 function name 规范均要求 `^[a-zA-Z0-9_-]+$`，点号会被上游 400
 * 拒绝（WA-F 紧急修复 · 2026-04-19）。canonical key 里的冒号是**参数值**，
 * 不受 function name 规范约束。
 *
 * 返回 / 错误契约（PRD §5.4 + §5.X · v2.2 U-1）：
 * - **canonical key 格式**：`{source}:{slug}` 或 `{source}/{scope}:{slug}`。
 *   合法前缀是 `platform` / `app` / `user`（含 `user/agent`、`user/interop`）。
 * - **`ext:` / `tin:` 前缀**本期不支持：返回**中文错误**
 *   "此技能仅在在线模式下可用。请切换到在线 Agent 后重试。"（tool result
 *   `isError: true`；LLM 读到后应自然降级不崩溃）。
 * - **key 不存在**：tool result "未找到技能 `<key>`。可能已被删除或未安装。"
 *   （§5.X；鼓励 LLM 改用 `skills_search` 重试）。
 * - `skills_search`：第一期走 **fulltext substring**（向量搜索 L7 遗留）。
 *   返回的每条只含 `name` / `description` / canonical key —— 不含正文
 *   （LLM 想看正文应调 `skills_read`）。
 */

import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
// W2.2.3 解耦：协议类型 SSoT 在 skills/skill-listing-types.ts；旧 middleware
// 路径 re-export 透传保持向后兼容，但内部消费者直接拿单源（让 W2.3 删
// middleware 整目录时本文件零修改）。
import type {
  SkillResourceEntry,
  SkillResourceReadResult,
} from '../skills/skill-listing-types.js';
import { jsonError } from '../capability/core/_utils.js';
import {
  INTERNAL_ERROR,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  SKILL_DISABLED,
  SKILL_NOT_FOUND,
  SKILL_NOT_INSTALLED,
  SKILL_NOT_READY,
  SKILL_UNSUPPORTED_PREFIX,
  type ToolErrorKind,
} from '../engine/errors/error-kinds.js';

// ─── 宿主注入的能力接口（结构类型） ────────────────────────────────────────

/**
 * 最小 skill 记录——本文件只需这些字段完成工具职责。
 *
 * 故意**不 import** Electron 侧的 `LocalSkill`——agent-runtime 是 pure TS 库，
 * 不能依赖 Electron main 进程模块。两端通过结构类型（duck typing）对齐：
 * LocalSkillRegistry 返回的 `LocalSkill` 含本接口所需的全部字段，传入时
 * 自动兼容。
 */
export interface SkillRecord {
  canonicalKey: string;
  name: string;
  description: string;
  whenToUse?: string;
  /** SKILL.md 完整正文（含 frontmatter），skills_read 直接返回 */
  content: string;
  /** Personal Plugin 注入的 skill 所属插件；普通本地/内置 skill 为空。 */
  personalPluginId?: string;
  personalPluginDisplayName?: string;
  personalPluginRuntime?: {
    serviceId?: string;
    title?: string;
    requireMcp?: boolean;
  };
  /**
   * Wave 1.5 P0-1（质疑 4 补丁）：SKILL.md frontmatter 里的 primary_env /
   * primaryEnv / primary-env 字段（三种写法等价）的结构化值。
   *
   * 可选——宿主（LocalSkillRegistry）没 populate 也没事，`skill_invoke`
   * 工具会回退到直接解析 `content` 里的 frontmatter（`extractSkillMeta`）。
   * 把它暴露成结构化字段纯粹是**便利**：
   * - 面板 UI 展示"这个 Skill 需要什么环境变量"不用重复解析；
   * - 其他消费者（如 Skill 凭据选择器）也能 O(1) 读取。
   *
   * 不写入 `content` 本身——这是解析产物不是源数据。
   */
  primaryEnv?: string;
}

/**
 * 宿主对 Skill 可用性的结构化判定。
 *
 * `undefined` 仍按 `not_found` 解释，以兼容尚未迁移的宿主；新宿主应返回本
 * 联合类型，避免把「未启用」「注册表未就绪」「正文未物化」折叠成不存在。
 */
export type SkillUnavailableReason =
  | 'not_found'
  | 'disabled'
  | 'not_ready'
  | 'not_installed';

export type SkillResolution =
  | { status: 'available'; skill: SkillRecord }
  | {
      status: SkillUnavailableReason;
      /** 可供宿主补充诊断信息；不得包含凭据或用户隐私。 */
      detail?: string;
      retryable?: boolean;
    };

export type SkillLookupResult = SkillRecord | SkillResolution | undefined;

/**
 * 宿主注入回调传入的上下文——只含工具消费实际用到的字段。
 *
 * WA-B-fix P0-2 修法（Wave B 独立验证 P0-2）：原 `getSkill(key)` / `search(q)`
 * 签名不接收任何上下文，工具层拿到 `ToolContext.spaceId` / `organizationId` 也
 * 无处传给宿主 registry——M11 "Space 级 skills 过滤" 的投资在工具侧收益为 0。
 *
 * 契约层接通（本期）+ 行为层留 hook（L18）：
 *   - 本期：`skills_read` / `skills_search` 的 `execute` 透传 ToolContext
 *     里的 spaceId / organizationId 给宿主回调；LocalSkillRegistry 的 `getByKey`
 *     / `search` 目前**不读** 这个上下文（Space 级 enabled 过滤留给 L18）。
 *   - L18 落地时 registry 内部消费 context 即可，工具层无需再改签名。
 *
 * 兼容性：context 可选，旧宿主不传时等同全局作用域（LocalSkillRegistry 实测
 * 就是这么实现的，未来加 Space 过滤只是给已存在的 hook 注入过滤条件）。
 *
 * ****：本类型原为 `SkillsFetchContext` 的 alias，但  把 Skills
 * **清单拉取**（`SkillsFetchContext`）里的业务 id 剥离——那条链的 spaceId/
 * organizationId 改由 host 装配期烘进 fetch 闭包。而 `skills_read` /
 * `skills_search` **FC 工具**是另一条独立链路：它从 `ToolContext` 拿到本次调用
 * 的 spaceId / organizationId 透传给宿主 getSkill / search 回调（L18 的 Space 级
 * 过滤 hook）。故此处拆成独立类型，保留 `spaceId?` + `organizationId?`。
 */
export interface SkillsToolsCallbackContext {
  spaceId?: string;
  organizationId?: string;
  /** 本次工具所属 Run，用于取该 Run 冻结的 enablement 租约。 */
  agentRunId?: string;
}

/**
 * 宿主注入回调集合。
 *
 * - `getSkill(key, ctx)`：按 canonical key 查询完整 skill 记录；不存在返回 `undefined`。
 * - `search(query, options, ctx)`：按关键字做文本搜索，返回匹配的 skill 列表；
 *   空 query 应返回空数组（由宿主 registry 实现保证，本工具也会 schema 校验）。
 *
 * `ctx` 为**可选**字段——老宿主实现（只收 `key` / `query` 的 arity-1/2 闭包）
 * TypeScript 逆变兼容，仍然可以直接注入；新实现可读 `ctx.spaceId` / `organizationId`
 * 做 Space 级过滤（L18 实现时接入，本期 contract 先打通）。
 */
export interface SkillsToolsDeps {
  getSkill: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => SkillLookupResult;
  search: (
    query: string,
    options?: { limit?: number },
    ctx?: SkillsToolsCallbackContext,
  ) => SkillRecord[] | { status: 'not_ready'; retryable?: boolean };
  /**
   * 可选：列出某 skill 的 Tier-3 附属资源（references/ + examples/）。
   *
   * 注入后，`skills_read`（不传 path）会把清单附到 SKILL.md 正文末尾，让 Agent
   * 知道有哪些分层文档、可用 `skills_read` 传 `path` 读全文。宿主（LocalSkillRegistry）
   * 不注入时退化为「只读 SKILL.md 正文」的旧行为（无回归）。
   */
  listSkillResources?: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<SkillResourceEntry[]> | SkillResourceEntry[];
  /**
   * 可选：读取某 skill 的单个附属资源文件（`skills_read` 传 `path` 时走这里）。
   *
   * 未注入时，`skills_read` 收到 `path` 参数会返回「当前运行时不支持」错误。
   */
  readSkillResource?: (
    key: string,
    relPath: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<SkillResourceReadResult> | SkillResourceReadResult;
  /**
   * ** RB1**：host 在装配 ToolProvider 时烘进的 per-runtime 业务身份。
   *
   * 业务工具是业务耦合的，其 spaceId/organizationId 由 host 在装配期烘进 deps
   * （host 装配期已手握这两个 id；切 Space 会重建 runtime，故是 per-runtime 常量，
   * 可安全烘焙）。工具**不再**从运行时 `ToolContext` 读业务 id，改用这里的烘焙值
   * 构造回调上下文（L18 Space 级过滤 hook）。
   */
  spaceId?: string;
  organizationId?: string;
}

function isSkillResolution(value: SkillLookupResult): value is SkillResolution {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'status' in value &&
      ['available', 'not_found', 'disabled', 'not_ready', 'not_installed'].includes(
        value.status as string,
      ),
  );
}

/** 把旧 `SkillRecord | undefined` 与新结构化结果收口成单一内部契约。 */
export function normalizeSkillResolution(value: SkillLookupResult): SkillResolution {
  if (isSkillResolution(value)) return value;
  if (value) return { status: 'available', skill: value };
  return { status: 'not_found' };
}

/**
 * 用 host 装配期烘进 deps 的 spaceId/organizationId 构造回调上下文。
 *  RB1：替代原先从 `ToolContext` 读业务 id 的做法。
 */
function bakedCallbackContext(
  deps: SkillsToolsDeps,
  context?: ToolContext,
): SkillsToolsCallbackContext {
  return {
    spaceId: deps.spaceId,
    organizationId: deps.organizationId,
    agentRunId: context?.agentRunId,
  };
}

export function skillAvailabilityErrorKind(
  reason: SkillUnavailableReason,
): ToolErrorKind {
  switch (reason) {
    case 'disabled':
      return SKILL_DISABLED;
    case 'not_ready':
      return SKILL_NOT_READY;
    case 'not_installed':
      return SKILL_NOT_INSTALLED;
    case 'not_found':
      return SKILL_NOT_FOUND;
  }
}

export function skillUnavailableMessage(
  key: string,
  reason: SkillUnavailableReason,
  action: 'read' | 'invoke' = 'read',
): string {
  const verb = action === 'invoke' ? '调用' : '读取';
  switch (reason) {
    case 'disabled':
      return `技能 \`${key}\` 存在，但当前 Agent 未启用。请在 Agent 技能设置中启用后再试。`;
    case 'not_ready':
      return `技能注册表尚未就绪，暂时无法${verb} \`${key}\`。请稍后重试。`;
    case 'not_installed':
      return `技能 \`${key}\` 已登记，但本机尚未安装或物化 SKILL.md。请安装或重新同步后再试。`;
    case 'not_found':
      return `未找到技能 \`${key}\`。可能已被删除。可以用 skills_search 搜索相关技能。`;
  }
}

export function skillUnavailableHint(reason: SkillUnavailableReason): string {
  switch (reason) {
    case 'disabled':
      return 'Ask the user to enable this skill for the current Agent before retrying.';
    case 'not_ready':
      return 'Retry once after the skill registry becomes ready; do not treat this skill as missing.';
    case 'not_installed':
      return 'The skill is known but its local instructions are unavailable. Install or synchronize it before retrying.';
    case 'not_found':
      return 'Run skills_search with keywords from the user request, then pass one returned canonical key to skills_read.';
  }
}

export function buildSkillAvailabilityError(
  key: string,
  resolution: Extract<SkillResolution, { status: SkillUnavailableReason }>,
  action: 'read' | 'invoke' = 'read',
): ToolResult {
  return jsonError(skillUnavailableMessage(key, resolution.status, action), {
    error_kind: skillAvailabilityErrorKind(resolution.status),
    reason: resolution.status,
    retryable: resolution.retryable ?? resolution.status === 'not_ready',
    ...(resolution.detail ? { detail: resolution.detail } : {}),
    key,
    hint: skillUnavailableHint(resolution.status),
  });
}

/**
 * 把附属资源清单渲染成一段中文 Markdown，附到 `skills_read` / `skill_invoke` 的
 * 返回末尾。空清单返回空串（调用方据此决定是否拼接）。
 */
export function renderSkillResourceManifest(
  key: string,
  resources: SkillResourceEntry[],
): string {
  if (!resources || resources.length === 0) return '';
  const lines = resources.map(
    (r) => `- \`${r.path}\`${r.summary ? ` — ${r.summary}` : ''}`,
  );
  const example = resources[0]?.path ?? 'references/xxx.md';
  return [
    '',
    '',
    '---',
    '',
    '## 附属文档（按需读取）',
    '',
    `本 skill 还有以下附属文档。命中对应场景时，用 \`skills_read\` 传 \`path\` 参数读取全文，例如 \`skills_read(key="${key}", path="${example}")\`：`,
    '',
    ...lines,
  ].join('\n');
}

// ─── 常量 ──────────────────────────────────────────────────────────────

/** `skills_search` 第一期默认 limit —— 对齐 PRD §五.2 M1 要点 ④ 的 search API。 */
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/** §5.X UX-1 / v2.2 U-1：`ext:` / `tin:` 前缀统一错误文案（全中文，MVP 约束）。 */
const UNSUPPORTED_PREFIX_MESSAGE =
  '此技能仅在在线模式下可用。请切换到在线 Agent 后重试。';

/**
 * canonical key 正则：`{source}[/{scope}]:{slug}`。source/scope/slug 使用
 * `[a-z0-9-]` 字符集（对齐 agentskills.io 规范 kebab-case）+ 一层可选斜杠。
 *
 * 注意：app 类型 key 形如 `app:<appId>/<slug>`，`<appId>/<slug>` 段作为整体
 * 出现在冒号后——本正则宽松允许冒号后有 `/`，由宿主的 `getSkill` 做精确匹配。
 */
const CANONICAL_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)?:[a-z0-9-][a-z0-9-\\/]*$/i;

// ─── 输入 schema ───────────────────────────────────────────────────────

// 阶段 6.6 议题 3 翻译 + 瘦身：示例 key 精简成两个，详细 prefix 列表在
// 工具 description 里描述。
const readInputSchema = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description:
        '单个 skill 的完整规范 key（譬如 `user:code-style-check` 或 `app:tabcode/code-review`）。',
    },
    path: {
      type: 'string',
      description:
        '可选，仅配合单个 `key`。留空 → 读 skill 正文（有附属文档时末尾会列出清单）。' +
        '传清单里给出的相对路径 → 读该附属文档全文。',
    },
  },
  required: ['key'],
  additionalProperties: false,
} as unknown as Tool['inputSchema'];

const searchInputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        '关键字，在 skill 的 `name` / `description` / `slug` / `when_to_use` 上做大小写不敏感全文子串匹配。',
    },
    limit: {
      type: 'number',
      description: `返回匹配项的最大数量（默认 ${DEFAULT_SEARCH_LIMIT}，上限 ${MAX_SEARCH_LIMIT}）。`,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as unknown as Tool['inputSchema'];

// ─── 辅助 ──────────────────────────────────────────────────────────────

function hasUnsupportedPrefix(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('ext:') || lower.startsWith('tin:');
}

function formatSkillMatch(skill: SkillRecord): {
  key: string;
  name: string;
  description: string;
  when_to_use?: string;
} {
  const entry: ReturnType<typeof formatSkillMatch> = {
    key: skill.canonicalKey,
    name: skill.name,
    description: skill.description,
  };
  if (skill.whenToUse) entry.when_to_use = skill.whenToUse;
  return entry;
}

function validateSingleSkillReadKey(key: string): ToolResult | null {
  if (!key) {
    return jsonError(
      '缺少参数 key。请传入 <skills> 段展示的完整 canonical key，例如 "user:code-style-check"。',
      {
        error_kind: MISSING_REQUIRED_PARAM,
        field: 'key',
        hint: 'Pass the exact canonical skill key from the <skills> list, or run skills_search to find one first.',
      },
    );
  }
  if (hasUnsupportedPrefix(key)) {
    return jsonError(UNSUPPORTED_PREFIX_MESSAGE, {
      error_kind: SKILL_UNSUPPORTED_PREFIX,
      key,
      hint: 'Use a local user: or app: skill key. For external or online-only skills, ask the user to switch to an online agent.',
    });
  }
  if (!CANONICAL_KEY_PATTERN.test(key)) {
    return jsonError(
      `技能 key 格式不合法："${key}"。请使用 <skills> 段展示的完整 canonical key，` +
        `例如 "user:code-style-check" 或 "app:tabcode/code-review"。`,
      {
        error_kind: INVALID_PARAM_FORMAT,
        field: 'key',
        value: key,
        hint: 'Use a canonical skill key in the form user:<slug> or app:<app>/<slug>.',
      },
    );
  }
  return null;
}

function readSkillRecord(
  deps: SkillsToolsDeps,
  key: string,
  cbCtx: SkillsToolsCallbackContext,
): { ok: true; skill: SkillRecord } | { ok: false; result: ToolResult } {
  try {
    const resolution = normalizeSkillResolution(deps.getSkill(key, cbCtx));
    if (resolution.status === 'available') {
      return { ok: true, skill: resolution.skill };
    }
    return {
      ok: false,
      result: buildSkillAvailabilityError(key, resolution),
    };
  } catch (err) {
    return {
      ok: false,
      result: jsonError(
        `读取技能 "${key}" 时发生内部错误。`,
        {
          error_kind: INTERNAL_ERROR,
          key,
          hint: 'Stop reading this skill in the current run and ask the user to try again after the skill registry is available.',
        },
      ),
    };
  }
}

async function readSkillResourceContent(
  deps: SkillsToolsDeps,
  key: string,
  resourcePath: string,
  cbCtx: SkillsToolsCallbackContext,
): Promise<ToolResult> {
  if (!deps.readSkillResource) {
    return jsonError(
      '当前运行时不支持按 path 读取 skill 附属文档。',
      {
        error_kind: INTERNAL_ERROR,
        key,
        hint: 'Read the skill body via skills_read without a path; reference files are unavailable in this runtime.',
      },
    );
  }
  let res: SkillResourceReadResult;
  try {
    res = await deps.readSkillResource(key, resourcePath, cbCtx);
  } catch {
    return jsonError(
      `读取 skill 附属文件 "${resourcePath}" 时发生内部错误。`,
      {
        error_kind: INTERNAL_ERROR,
        key,
        hint: 'Retry once; if it keeps failing read the skill body (skills_read without path).',
      },
    );
  }
  if (res.ok) return { content: res.content };
  return skillResourceNotFoundResult(deps, key, resourcePath, cbCtx, res);
}

async function skillResourceNotFoundResult(
  deps: SkillsToolsDeps,
  key: string,
  resourcePath: string,
  cbCtx: SkillsToolsCallbackContext,
  res: Exclude<SkillResourceReadResult, { ok: true }>,
): Promise<ToolResult> {
  let available: SkillResourceEntry[] = [];
  if (deps.listSkillResources) {
    try {
      available = await deps.listSkillResources(key, cbCtx);
    } catch {
      available = [];
    }
  }
  const availableHint =
    available.length > 0
      ? `本 skill 可用的附属文档：${available
          .map((r) => r.path)
          .join('、')}。只读清单里列出的 path，不要猜测。`
      : '本 skill 没有附属文档，不要猜测路径。';
  return jsonError(res.error, {
    error_kind: SKILL_NOT_FOUND,
    key,
    path: resourcePath,
    available_paths: available.map((r) => r.path),
    hint: res.hint ? `${availableHint} ${res.hint}` : availableHint,
  });
}

async function renderSkillBodyWithManifest(
  deps: SkillsToolsDeps,
  key: string,
  skill: SkillRecord,
  cbCtx: SkillsToolsCallbackContext,
): Promise<ToolResult> {
  let manifest = '';
  if (deps.listSkillResources) {
    try {
      const resources = await deps.listSkillResources(key, cbCtx);
      manifest = renderSkillResourceManifest(key, resources);
    } catch {
      manifest = '';
    }
  }
  return { content: manifest ? `${skill.content}${manifest}` : skill.content };
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * 创建 `skills_read` / `skills_search` 两件套工具。
 *
 * 宿主典型用法（Wave B · M6 对接点）：
 * ```ts
 * import { createSkillsTools } from '@tabtin/agent-runtime/tools';
 *
 * const registry = new LocalSkillRegistry({
 *   skillRecall: createLexicalSkillRecall(),
 *   ...
 * });
 * await registry.ready();
 *
 * const skillsTools = createSkillsTools({
 *   getSkill: (key) => registry.getByKey(key),
 *   search: (query, opts) => registry.search(query, opts),
 * });
 * // 把 skillsTools 加入 ElectronToolProvider.getTools() 返回列表
 * ```
 */
export function createSkillsTools(deps: SkillsToolsDeps): Tool[] {
  return [createSkillsReadTool(deps), createSkillsSearchTool(deps)];
}

// ─── skills_read ───────────────────────────────────────────────────────

function createSkillsReadTool(deps: SkillsToolsDeps): Tool {
  return {
    name: 'skills_read',
    policyActionKind: 'object_read',
    // 阶段 6.7 议题 1 治理（2026-05-21）：原 <skills_usage> 段（3110 字）已删，
    // 工具用法（前缀含义 / 先读再行动）从段吸收到本工具说明书。
    // 英文术语用反引号包围让 detectLanguage 剥离正确（避免 P3 mixed 判定）。
    description:
      '按 `canonical key` 读本地 skill 的正文；若该 skill 有附属文档，返回末尾会附上清单。' +
      'key 形如 `user:code-style-check`、`app:tabcode/code-review`，来自 `<skills>` 段或搜索结果。\n\n' +
      '**读附属文档**：清单或正文指向某个附属文档时，再调本工具、把清单里给出的路径原样填进 `path` 读全文——别用 `read_file`（读不到 skill 目录）。\n' +
      '不支持 `section` 参数。`ext:` / `tin:` 前缀只在线模式可用。\n\n' +
      '**用途**：查阅 skill 的完整指令与附属文档、核对其是否存在或查看写法。' +
      '用户通过 `/skill` 选定的 Skill 由 runtime 在模型调用前自动激活。',
    inputSchema: readInputSchema,
    isReadOnly: true,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (input ?? {}) as { key?: unknown; path?: unknown };

      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      const resourcePath =
        typeof raw.path === 'string' ? raw.path.trim() : '';

      const keyError = validateSingleSkillReadKey(key);
      if (keyError) return keyError;

      const cbCtx = bakedCallbackContext(deps, context);

      const skillResult = readSkillRecord(deps, key, cbCtx);
      if (!skillResult.ok) return skillResult.result;

      // 传了 path → 读附属资源文件（references/ examples/）而非 SKILL.md 正文。
      if (resourcePath) {
        return readSkillResourceContent(deps, key, resourcePath, cbCtx);
      }

      // 无 path → SKILL.md 正文 + 附属资源清单（若宿主注入了 listSkillResources）。
      return renderSkillBodyWithManifest(deps, key, skillResult.skill, cbCtx);
    },
  };
}

// ─── skills_search ─────────────────────────────────────────────────────

function createSkillsSearchTool(deps: SkillsToolsDeps): Tool {
  return {
    name: 'skills_search',
    policyActionKind: 'object_read',
    // 阶段 6.7 议题 1 治理（2026-05-21）：原 <skills_usage> 段（3110 字）已删，
    // "什么时候用 skills_search vs 看 <skills> 段" 决策从段吸收到本工具说明书。
    description:
      '按关键词搜本地 skill（在 `name` / `description` / `slug` / `when_to_use` 上做全文子串匹配）。' +
      '返回匹配的 skill 及其 `canonical key`（不含正文）。\n\n' +
      '**用途**：`<skills>` 段没出现的 skill、创建前查重、需要 skill 显示名。\n' +
      '**不是**：列出全部 skill（看 `<skills>` 段）；读取或执行 skill 正文。',
    inputSchema: searchInputSchema,
    isReadOnly: true,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (input ?? {}) as { query?: unknown; limit?: unknown };
      const query = typeof raw.query === 'string' ? raw.query.trim() : '';

      if (!query) {
        return jsonError(
          '缺少参数 query。请传入非空的搜索关键字（会匹配技能的 name / description / slug / when_to_use）。',
          {
            error_kind: MISSING_REQUIRED_PARAM,
            field: 'query',
            hint: 'Provide keywords from the user request before calling skills_search.',
          },
        );
      }

      let limit = DEFAULT_SEARCH_LIMIT;
      if (typeof raw.limit === 'number' && Number.isFinite(raw.limit)) {
        limit = Math.min(Math.max(1, Math.floor(raw.limit)), MAX_SEARCH_LIMIT);
      }

      const cbCtx = bakedCallbackContext(deps, context);

      let matches: SkillRecord[];
      try {
        const searched = deps.search(query, { limit }, cbCtx);
        if (!Array.isArray(searched)) {
          return jsonError('技能注册表尚未就绪，暂时无法搜索。请稍后重试。', {
            error_kind: SKILL_NOT_READY,
            reason: 'not_ready',
            retryable: searched.retryable ?? true,
            query,
            hint: skillUnavailableHint('not_ready'),
          });
        }
        matches = searched;
      } catch (err) {
        return jsonError(
          '搜索技能时发生内部错误。',
          {
            error_kind: INTERNAL_ERROR,
            query,
            hint: 'Stop retrying skills_search with the same query and ask the user to try again after the skill registry is available.',
          },
        );
      }

      const results = matches.slice(0, limit).map(formatSkillMatch);

      return {
        content: JSON.stringify({
          success: true,
          query,
          count: results.length,
          results,
          hints:
            results.length > 0
              ? '使用 skills_read(key) 读取完整说明。'
              : '未匹配到技能。可以换个关键词，或查看 <skills> 段了解已有技能。',
        }),
      };
    },
  };
}

// ─── 便于宿主单独 import 使用的命名导出（可选） ────────────────────────

export { UNSUPPORTED_PREFIX_MESSAGE as SKILLS_UNSUPPORTED_PREFIX_MESSAGE };
