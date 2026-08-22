/**
 * Skill 清单 / Listing 协议类型 —— SSoT 单源。
 *
 * **历史背景（W2.2.3）**：这些接口最初定义在
 * `packages/agent-runtime/src/middleware/skills-and-notes.ts`，与
 * `createSkillsAndNotes` 工厂耦合在一个文件里。W2.2.3 把"中间件工厂行为"
 * 与"清单协议契约"解耦——契约迁到本文件成为单源；`middleware/skills-and-notes.ts`
 * 仅 re-export 保持向后兼容（W2.3 删 middleware 整目录时一并清空）。
 *
 * **职责边界**：
 *   - 做：定义 Skills 拉取 / 渲染的协议数据形状（输入 context、单条
 *     metadata、批量结果、fetcher 函数签名）
 *   - 不做：实际拉取实现 / 列表渲染 / token 预算截断（这些分别归宿主
 *     注入的 fetcher、`skill-renderer.ts`、`skill-budget.ts`）
 *
 * **下游消费方**：
 *   - `capability/core/skills.ts` —— SkillsCap 通过 SkillsCapFetcher 消费
 *     SkillListingResult，调用 truncateSkillsWithinBudget 做预算截断
 *   - `tools/skills-tools.ts` —— skills_read / skills_search 工具的
 *     ToolContext.spaceId/organizationId 透传给宿主回调时构造此 context
 *   - `middleware/skills-and-notes.ts` + `middleware/skills-fetcher-http.ts`
 *     —— 旧路径继续 import（含 re-export 链）
 *
 * **W2.3 收尾**：删 middleware/ 整目录时本文件保留，所有消费者已直接 import
 * 自此处。
 */

// ─── 拉取上下文 ─────────────────────────────────────────────────────

/**
 * Skills 拉取调用上下文。
 *
 * 由 `query.ts` 主循环 / Capability hook 在每轮 LLM 前调 fetcher 时传入。
 *
 * ****：不再携带 `spaceId` / `organizationId`——这两个业务 id 是
 * per-runtime 常量（切 Space 会重建 runtime），已由 host 在装配期烘进 fetch
 * 闭包，Cap 不再感知。此 context 只保留非业务字段（`query` / `focusedApp`）。
 */
export interface SkillsFetchContext {
  /**
   * 最近一条真实 user 消息，用于 skill listing 的相关性排序（by SkillsCap）。
   * host 侧 fetcher 应把它透传给 `LocalSkillRegistry.render()`，让
   * `skill-renderer.ts` 组内按相关性排序。缺省 / 空则回退字母序（无回归）。
   */
  query?: string;
  /** 当前 Run 的 hostRunId，用于取该 Run 冻结的 enablement 租约。 */
  runId?: string;
  /**
   * 当前 focused App 的 app key（如 `tabdoc` / `tabdata`）。
   *
   * host 侧 fetcher 可从同一份 AppContext 提取并透传给
   * `LocalSkillRegistry.render()`；renderer 仅把它作为弱排序 / 无词法命中
   * fallback 信号，明确 query BM25 仍能覆盖跨 App 意图。
   */
  focusedApp?: string | null;
}

// ─── Skill 元数据 ───────────────────────────────────────────────────

/**
 * 单条 Skill 的结构化元数据。
 *
 * 用途（按调用频次）：
 *   1. token 预算截断（`skill-budget.ts::truncateSkillsWithinBudget`）按
 *      1% context window + 250 字符 cap 做三层截断
 *   2. delta 注入（指纹 hash 比对让 prompt cache 最大化命中）
 *   3. SkillTool name 校验（`skill_invoke` 的 skill 名是否在合法列表内）
 *
 * 按约定实现 `formatCommandsWithinBudget` + `sentSkillNames` Set。
 */
export interface SkillMeta {
  canonicalKey: string;
  name: string;
  description: string;
  whenToUse?: string;
  source?: string;
  contentLength?: number;
  /** platform/bundled skill 不参与截断（按约定实现）。 */
  isPlatform?: boolean;
}

// ─── Skill 列表渲染结果 ──────────────────────────────────────────────

/**
 * fetchSkills 的结构化返回值。
 *
 * 相比早期"`string | null`"形态，新增 `skills` 元数据数组用于：
 *   - Token 预算截断（按 1% context window + 250 字符 cap 三层截断）
 *   - Delta 注入（只重算变化的 skill，不每轮重发全量）
 *   - SkillTool name 校验（skill_invoke 的 skill 名是否合法）
 *
 * `formattedContent`：宿主渲染好的人类可读 listing 字符串（兼容旧 API
 * 路径，可填空串走 truncateSkillsWithinBudget 重新生成）。
 */
export interface SkillListingResult {
  formattedContent: string;
  skills: SkillMeta[];
}

/**
 * 两区渲染结果（prompt cache 友好）。
 *
 * - `staticIndex`：全部 skill 的**名称索引**（query 无关、跨轮稳定）→ 注入 system
 *   **静态段**（boundary 之前），可被 prompt cache（BP2）覆盖。
 * - `dynamicTopK`：与当前 query 最相关的 **Top-N 带描述**（每轮变）→ 注入 system
 *   **动态段**（boundary 之后）。无词法命中时为 `null`（本轮不注入动态段）。
 *
 * 两者均为「内容体」，不含外层 XML tag——`SkillsCap` 负责包 tag。
 */
export interface SkillsTwoZoneResult {
  staticIndex: string | null;
  dynamicTopK: string | null;
}

// ─── Tier-3 附属资源（references / examples） ────────────────────────

/**
 * skill 目录下一个附属资源文件（references/ 或 examples/ 内）的清单条目。
 *
 * 背景：skill 系统只把 `SKILL.md` 正文索引进上下文（Tier-2）；`references/`
 * `examples/` 里的分层文档（Tier-3）预装到磁盘但此前没有任何通道让 Agent 读到
 * （`read_file` 受 workspace 边界隔离、`skills_read` 只返回 SKILL.md）。本类型是
 * 把这些附属文件「可见化」的清单项：`skills_read` / `skill_invoke` 返回里带上它，
 * Agent 就知道有哪些文件、可用 `skills_read` 传 `path` 读全文。
 */
export interface SkillResourceEntry {
  /** 相对 skill 目录的 POSIX 路径，如 `references/cli-reference.md`。 */
  path: string;
  /** 一句话摘要（取文件首个标题 / 首行），用于清单展示；无法提取时省略。 */
  summary?: string;
}

/** 读取单个附属资源文件的结果（成功带全文；失败带中文原因 + 可选 hint）。 */
export type SkillResourceReadResult =
  | { ok: true; path: string; content: string }
  | { ok: false; error: string; hint?: string };

// ─── Fetcher 函数签名 ───────────────────────────────────────────────

/**
 * Skills 拉取回调类型。
 *
 * **返回语义**：
 *   - `SkillListingResult` —— 拉取成功，含结构化 metadata 数组。
 *   - `string` —— 旧式纯文本格式化结果（无结构化 metadata，跳过预算截断）。
 *   - `null` —— 拉取失败（HTTP 临时故障 / IPC 失败）。消费方按 D1 抗闪烁
 *     约定保留上一轮渲染结果，不清空。
 *
 * 实现侧（宿主）：
 *   - Electron / Daemon 通过本地 `LocalSkillRegistry.render()` 渲染
 *   - `createHttpSkillsFetcher` 仅保留给 legacy / non-local host 兼容测试
 *   - Node CLI / 测试通过本地 `LocalSkillRegistry.listForSpace(spaceId)` 转
 */
export type SkillsFetcher = (
  context: SkillsFetchContext,
) => Promise<SkillsTwoZoneResult | SkillListingResult | string | null>;
