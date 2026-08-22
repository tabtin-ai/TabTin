/**
 * Model Catalog Resolution — 子 Agent 模型自由度（Phase 3/4）的 runtime 侧 SSoT。
 *
 * 取代 agent-tool.ts 里旧的「正则替换父模型字符串」(`MODEL_TIER_RE`/
 * `resolveChildModel`) 路径。新模型：
 *
 *   平台发菜单（Django `/catalog`，已按派单成员 tier 过滤）
 *     → 宿主拉快照注入 `ModelCatalogEntry[]`
 *       → 主 Agent 照菜单点（agent 工具 `model` 自由填）
 *         → runtime 命中目录用之、命不中**确定性降级 + 中文提示**（R8）
 *           → 子 Agent 能力**按子模型从目录解析**（不继承父，Phase 3 / R5）
 *
 * **不绕过 max_model_tier（PRD §4.5.4）**：目录快照本身已是 tier 过滤后的结果，
 * runtime 只接受目录内模型，因此子 Agent 自选天然落在成员 tier 允许范围内；
 * 扣费侧 `_check_model_tier_safety_net` 仍是二次安全网。
 */

import type {
  ModelCapabilities,
  ModelCatalogEntry,
} from '../engine/contracts/model-llm.js';

/** UUID（8-4-4-4-12 hex，大小写不敏感）—— DB `LLMModel.id` 的形态。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Provider 静态声明模型的引用前缀：`declared:<provider>:<model_name>`。 */
const DECLARED_PREFIX = 'declared:';

/**
 * 校验一个模型引用是否符合 catalog → runtime → Django proxy 的契约 id 形态。
 *
 * 合法形态只有两种：
 *   1. DB `LLMModel.id` UUID —— routed 模型，proxy `_get_provider_config(model_id=...)`
 *      走 `LLMModel.objects.get(id=...)`，只认 UUID。
 *   2. `declared:<provider>:<model_name>` —— provider 静态声明模型，proxy 的
 *      model_resolver 能解析。
 *
 * **裸 model_name（如 `kimi-k2.6`）不合法**：历史上 Electron catalog 用 model_name
 * 当 entry.id，会把它透给 proxy → "declared:... 不存在或未激活" / 误触 capability gate
 * （根因见 ）。catalog 构造与磁盘缓存加载都应用本校验把非法引用挡在 runtime 外。
 */
export function isValidModelRef(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  return UUID_RE.test(trimmed) || trimmed.startsWith(DECLARED_PREFIX);
}

/**
 * 在目录里按 id / displayName / alias 查模型（大小写不敏感、trim）。
 *
 * 匹配优先级：精确 id > alias > displayName。鼓励主 Agent 填规范 id，但对历史
 * tier 词（sonnet/opus/haiku，运营可在目录里挂为 alias）与简写做软兼容。
 */
export function findCatalogEntry(
  catalog: readonly ModelCatalogEntry[] | undefined,
  idOrAlias: string | undefined,
): ModelCatalogEntry | undefined {
  if (!catalog?.length || !idOrAlias) return undefined;
  const needle = idOrAlias.trim().toLowerCase();
  if (!needle) return undefined;

  // 1) 精确 id
  for (const entry of catalog) {
    if (entry.id.trim().toLowerCase() === needle) return entry;
  }
  // 2) alias
  for (const entry of catalog) {
    if (entry.aliases?.some((a) => a.trim().toLowerCase() === needle)) return entry;
  }
  // 3) displayName
  for (const entry of catalog) {
    if (entry.displayName && entry.displayName.trim().toLowerCase() === needle) return entry;
  }
  return undefined;
}

/**
 * 按模型 id 从目录解析能力快照；命不中 / 无目录返回 `undefined`（不给 FALLBACK）。
 * 回落策略交给调用方决定——子 Agent fork 时回落父 EngineConfig 的真实 caps，而非
 * 保守 FALLBACK（否则长产出被截断 / 丢 prompt-cache / 丢视觉）。命中时取「子模型」
 * 的真实窗口 / 输出上限 / 视觉等能力（不再继承父）。
 */
export function resolveModelCapabilitiesFromCatalog(
  catalog: readonly ModelCatalogEntry[] | undefined,
  model: string | undefined,
): ModelCapabilities | undefined {
  return findCatalogEntry(catalog, model)?.capabilities;
}

export interface ResolveChildModelOptions {
  /** 宿主注入的目录快照（已 tier 过滤）。 */
  catalog?: readonly ModelCatalogEntry[];
  /** 主 Agent 在 agent 工具 `model` 参数里填的值（可空 = 缺省跟父）。 */
  requested?: string;
  /** 父 Agent 当前模型（缺省 / 降级兜底的最终落点）。 */
  parentModel: string;
  /** 用户级默认子模型（Tier 2，Phase 5 才接；本批通常 undefined）。 */
  userDefault?: string;
  /** organization 级默认子模型（Tier 3，Phase 5 才接；本批通常 undefined）。 */
  organizationDefault?: string;
}

export interface ResolveChildModelResult {
  /** 最终用于子 Agent 的模型 id。 */
  model: string;
  /**
   * 子模型对应的能力快照：
   *   - 命中目录 → 目录里的子模型 caps（Phase 3：子按子规格，不继承父）。
   *   - 缺省跟父 / 命不中降级 → undefined，由调用方（agent-tool）回落父
   *     EngineConfig 的真实 caps（`?? config.X`），兑现「无目录 / 命不中回落父值」。
   */
  capabilities: ModelCapabilities | undefined;
  /**
   * 命不中目录而发生降级时的信息；非空时调用方应在 tool_result 里中文提示主
   * Agent「请求的 X 不可用、已改用 Y」（R8）。命中或缺省时为 undefined。
   */
  downgrade?: { requested: string; resolved: string };
}

/**
 * 子 Agent 模型解析（Phase 4 核心）：
 *
 *   - 无显式 requested → 缺省跟父（不视为降级，无提示）。
 *   - requested 命中目录 → 用目录里的规范 id + 目录能力。
 *   - requested 命不中 → 确定性降级链 `userDefault → organizationDefault → parentModel`，
 *     并带 `downgrade` 让调用方提示。
 *
 * 能力快照：命中目录用目录里的子模型 caps；缺省跟父 / 命不中降级返回 undefined，
 * 由调用方回落父 EngineConfig 的真实 caps（父模型一定在 tier 允许范围内，不提权）。
 */
export function resolveChildModelFromCatalog(
  opts: ResolveChildModelOptions,
): ResolveChildModelResult {
  const { catalog, requested, parentModel, userDefault, organizationDefault } = opts;

  const trimmedRequested = requested?.trim();
  if (!trimmedRequested) {
    // 缺省 = 跟父：模型用父模型；能力回落父值——返回 undefined 让调用方用父
    // EngineConfig 的真实 caps，而非按 parentModel 精确查目录。父走前缀匹配 / 带
    // 日期后缀命中、子「缺省跟父」精确查不中时，若回 FALLBACK 会误降（长产出截断 /
    // 丢 prompt-cache / 丢视觉）。
    return {
      model: parentModel,
      capabilities: undefined,
    };
  }

  const hit = findCatalogEntry(catalog, trimmedRequested);
  if (hit) {
    return { model: hit.id, capabilities: hit.capabilities };
  }

  // 命不中：确定性降级（不静默继承、不瞎跑）。降级目标链不变（userDefault →
  // organizationDefault → parentModel）；能力回落父值——返回 undefined 让调用方用父
  // EngineConfig 的真实 caps（绝大多数情况降级落点就是 parentModel）。
  const userHit = findCatalogEntry(catalog, userDefault);
  const organizationHit = findCatalogEntry(catalog, organizationDefault);
  const resolved = userHit?.id ?? organizationHit?.id ?? parentModel;
  return {
    model: resolved,
    capabilities: undefined,
    downgrade: { requested: trimmedRequested, resolved },
  };
}

/**
 * 把目录渲染成给主 Agent 看的「可用模型清单 + 语义标签」段，拼进 agent 工具
 * description（系统 prompt 的一部分 → prompt cache 友好）。目录为空时返回 ''
 * （宿主未注入快照 → agent 工具不展示清单，沿用兼容行为）。
 *
 * 渲染形态见 §3.3：每行 `id | 用途 | ctx/上限`，外加一句「缺省 =
 * 跟父」契约。不暴露价格 / provider 细节（语义标签已含「便宜/强」口径）。
 */
export function renderModelCatalogMenu(
  catalog: readonly ModelCatalogEntry[] | undefined,
): string {
  if (!catalog?.length) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push('**可用模型清单**（派子 Agent 时 `model` 填下方某个 id；缺省 = 跟父 Agent 一样）：');
  for (const entry of catalog) {
    const name = entry.displayName && entry.displayName !== entry.id
      ? `${entry.id}（${entry.displayName}）`
      : entry.id;
    const hint = entry.usageHint ? entry.usageHint : '';
    const caps = entry.capabilities;
    const ctxK = caps.contextWindowTokens ? `${Math.round(caps.contextWindowTokens / 1000)}k` : '?';
    const outK = caps.maxOutputTokens ? `${Math.round(caps.maxOutputTokens / 1000)}k` : '?';
    const tags: string[] = [];
    if (hint) tags.push(hint);
    if (caps.supportsVision) tags.push('视觉');
    if (entry.providerScope && entry.providerScope !== 'global') tags.push('BYOK');
    const tagStr = tags.length ? `${tags.join(' / ')}` : '';
    lines.push(`- \`${name}\`${tagStr ? ` — ${tagStr}` : ''}（ctx ${ctxK} / 输出上限 ${outK}）`);
  }
  lines.push('选型直觉：调研 / 汇总 / 并行查资料选便宜快的；代码 / 文档选均衡的；复杂规划跟父或选强的；看图选带「视觉」的。');
  lines.push('填了清单外的 id 不会报错——系统会自动降级到一个可用模型，并在子 Agent 返回里说明改用了哪个。');
  return lines.join('\n');
}

/**
 * 子 Agent 目录命中后，proxy 仍可能发现该模型行已删除 / 停用 / 渠道配置不可用。
 * 这类错误适合回退父模型重试；余额、权限、上下文、内容安全等错误不应被吞掉。
 */
export function isInactiveOrMissingModelErrorType(errorType: unknown): errorType is 'model_not_found' {
  return errorType === 'model_not_found';
}
