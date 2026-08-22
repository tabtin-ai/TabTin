/**
 * SkillsCap —— Core Capability：Skill 系统的 Agent 入口。
 *
 * **W2.2.1 范围**：
 *   - 暴露 `skills_search` / `skills_read` 两个工具（复用现有
 *     `tools/skills-tools.ts` 的 `createSkillsTools` 实现，避免重写
 *     input schema + handler 双份维护）
 *   - 通过 `hooks().beforeIteration` 完全复刻
 *     `middleware/skills-and-notes.ts::createSkillsAndNotes` 的 skills
 *     部分行为：fetchSkills + truncateSkillsWithinBudget + 指纹缓存 +
 *     写 `state.__skillsHint`，让 `query.ts` 现有合并段路径
 *     （Phase 2 appendSection 'skills'）零改动消费
 *   - **不实现 notes**：`SESSION_NOTES_TEMPLATE` 归 TabMemo 后续专题
 *     （用户原话："notes 部分归 TabMemo 后续专题，不要做"）
 *   - **不实现 load_skill**：现有 `LocalSkillRegistry` 已 eager 加载
 *     `LocalSkill.content` 全文到内存，"lazy 加载 scripts/assets" 在
 *     现有产品中并不存在；强行实现等同于脑补伪需求。如未来需要分离
 *     metadata + assets，再加 tool 不迟。
 *
 * **职责边界**：
 *   - 做：包装 fetchSkills + getSkill + search 三个外部回调，提供
 *     Capability 形态的入口
 *   - 不做：扫描磁盘 / 监听文件变更 / 解析 SKILL.md / 渲染面板（这些
 *     都是 `LocalSkillRegistry` / `SkillDirWatcher` / `skill-renderer.ts`
 *     等现有 skills/ 模块的职责，SkillsCap 是消费方）
 *
 * **典型装配**（W2.3 实施会写）：
 * ```ts
 * import { initSkillsModule } from '@tabtin/agent-host/skills';
 * import { SkillsCap } from '@tabtin/agent-host/capabilities';
 *
 * const handle = await initSkillsModule({ sandboxRoot, ... });
 * await handle.ready();
 *
 * const skillsCap = new SkillsCap({
 *   contextWindowTokens: model.contextWindowTokens,
 *   getSkill: (key) => handle.registry.getByKey(key),
 *   search: (query, opts) => handle.registry.search(query, opts),
 *   // ：spaceId 由 host 装配期烘进闭包，Cap 只传 query。
 *   fetchSkills: async ({ query }) => {
 *     await handle.ensureSpaceSkills(spaceId);
 *     const skills = handle.registry.listForSpace(spaceId).map(toSkillMeta);
 *     return { formattedContent: '...', skills };
 *   },
 * });
 * await skillsCap.bind(session);
 * ```
 *
 * ：本 Cap 从 `@tabtin/agent-runtime` 的 capability/core 迁到共享宿主包
 * `@tabtin/agent-host`；依赖的 runtime 契约、skills 子系统与召回 helper 经
 * `@tabtin/agent-runtime` 跨包 import（单向、合法）。
 */

import type {
  Tool,
  EngineHooks,
  EngineState,
  RunHookContext,
} from '@tabtin/agent-runtime/engine';
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine';
import type { CapabilityCategory } from '@tabtin/agent-runtime/capability';
import {
  CapabilityBase,
  buildRecallQuery,
  collectDescribedKeys,
  blankSeenDescriptions,
} from '@tabtin/agent-runtime/capability';
import {
  createSkillsTools,
  type SkillsToolsDeps,
  type SkillsToolsCallbackContext,
} from '@tabtin/agent-runtime/tools';
// W2.2.3 解耦：从 SSoT 单源 import（旧 middleware 路径仍 re-export 透传，
// 但内部消费者直接拿单源避免循环依赖）。
import {
  truncateSkillsWithinBudget,
  type SkillListingResult,
  type SkillsTwoZoneResult,
  type SkillMeta,
  type SkillsFetchContext,
  type SkillResourceEntry,
  type SkillResourceReadResult,
} from '@tabtin/agent-runtime/skills';

/**
 * fetchSkills 回调签名 —— 与 middleware 端 `SkillsFetcher` 同形态，
 * 让宿主层（W2.3）直接复用现有的 `LocalSkillRegistry → SkillListingResult`
 * 转换函数（如 ElectronAgentHost 已有的 `buildSkillsFetcher`）。
 *
 * 返回 ``null`` 表示"本次拉取失败"——按 middleware D1 抗闪烁约定，
 * SkillsCap 仅保留当前 Run 内已经成功渲染的结果；新 Run 从空视图开始。
 */
export type SkillsCapFetcher = (
  context: SkillsFetchContext,
) => Promise<SkillsTwoZoneResult | SkillListingResult | string | null>;

export interface SkillsCapInit {
  /** 在 beforeRun 最前面冻结本 Run 的宿主 Skill 可用性快照。 */
  beginRun?: (ctx: RunHookContext) => Promise<void> | void;

  /** 在 afterRun 释放本 Run 的宿主 Skill 可用性快照。 */
  endRun?: (ctx: RunHookContext) => Promise<void> | void;

  /**
   * 拉取 Skill 列表用于装配 system prompt 中的 `<skills>` 块。
   *
   * - 必传：缺省时 SkillsCap 退化为"只暴露 search/read 工具"模式，
   *   `<skills>` 块永远不出现，LLM 只能靠 search 主动发现。
   * - 由宿主层（Electron / Daemon 启动时）注入，通常包装
   *   `LocalSkillRegistry.listForSpace(spaceId)` 转 SkillListingResult。
   */
  fetchSkills?: SkillsCapFetcher;

  /**
   * skills_read 后端 —— 按 canonical key 取完整 SKILL.md。
   *
   * 必传：缺这个 SkillsCap 不能提供 read 工具（直接抛装配错）。
   * 通常包装 `LocalSkillRegistry.getByKey(key)`。
   */
  getSkill: SkillsToolsDeps['getSkill'];

  /**
   * skills_search 后端 —— 按关键字搜索。
   *
   * 必传。通常包装 `LocalSkillRegistry.search(query, opts)`。
   */
  search: SkillsToolsDeps['search'];

  /**
   * 可选：列出 skill 的 Tier-3 附属资源（references/ + examples/），透传给
   * `skills_read`——让返回的 SKILL.md 末尾带上分层文档清单。通常包装
   * `LocalSkillRegistry.listResources(key)`。不注入则退化为「只读 SKILL.md」。
   */
  listSkillResources?: (
    key: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<SkillResourceEntry[]> | SkillResourceEntry[];

  /**
   * 可选：读取 skill 单个附属资源文件（`skills_read` 传 `path` 时用）。
   * 通常包装 `LocalSkillRegistry.readResource(key, path)`。
   */
  readSkillResource?: (
    key: string,
    relPath: string,
    ctx?: SkillsToolsCallbackContext,
  ) => Promise<SkillResourceReadResult> | SkillResourceReadResult;

  /**
   * 模型 context window 大小（tokens），用于 truncateSkillsWithinBudget
   * 的 1% 预算计算。缺省时使用 8000 字符（DEFAULT_CHAR_BUDGET）。
   *
   * 与 middleware `SkillsAndNotesOptions.contextWindowTokens` 同义。
   */
  contextWindowTokens?: number;
}

const SKILLS_TAG_OPEN = '<skills>';
const SKILLS_TAG_CLOSE = '</skills>';
const RELEVANT_TAG_OPEN = '<relevant_skills>';
const RELEVANT_TAG_CLOSE = '</relevant_skills>';

function isTwoZoneResult(raw: unknown): raw is SkillsTwoZoneResult {
  return (
    !!raw &&
    typeof raw === 'object' &&
    ('staticIndex' in raw || 'dynamicTopK' in raw)
  );
}


/**
 * 把 fetchSkills 三种返回形态归一成 SkillListingResult | null。
 *
 * 与 middleware/skills-and-notes.ts 内部 `normalizeSkillsFetcherResult`
 * 同语义，独立维护一份避免 import 该 middleware 私有函数。
 */
function normalizeSkillsFetcherResult(
  raw: SkillListingResult | string | null,
): SkillListingResult | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { formattedContent: raw, skills: [] };
  }
  return raw;
}

/**
 * Skill 列表指纹 —— 让"列表内容未变就不重新截断 + 复用上一轮渲染结果"。
 *
 * 与 middleware/skills-and-notes 用相同 hash 输入（canonicalKey +
 * description + whenToUse），保持 prompt cache 命中点对齐。
 */
function computeSkillsFingerprint(skills: SkillMeta[]): string {
  return skills
    .map((s) => `${s.canonicalKey}:${s.description ?? ''}:${s.whenToUse ?? ''}`)
    .sort()
    .join('|');
}

function renderTaggedBlock(content: string): string {
  return `${SKILLS_TAG_OPEN}\n${content}\n${SKILLS_TAG_CLOSE}`;
}

// ─── SkillsCap ───────────────────────────────────────────────────────

interface SkillsRunView {
  lastSkillsFingerprint: string;
  lastBudgetedContent: string | null;
  staticIndexBlock?: string;
  hintBlock?: string;
  relevantBlock?: string;
  lastRecallQuery?: string;
}

function createSkillsRunView(): SkillsRunView {
  return {
    lastSkillsFingerprint: '',
    lastBudgetedContent: null,
  };
}

/**
 * SkillsCap：Skill 系统 Agent 入口。
 *
 * **clone 行为**：override CapabilityBase.clone —— Run 视图对新 session
 * 无语义，clone 后必须清空，否则会复用上一 session 的渲染结果，触发
 * "两个 session 看到同一份 skills 列表但实际不同 Space"的 cross-talk。
 *
 * 三个回调函数（`_fetchSkills` / `_getSkill` / `_search`）走 structured
 * clone 失败回退路径（函数对象不能 structuredClone），保留原引用 ——
 * 这是合理的（回调本身是无状态的查询入口，多 clone 共用同一个
 * LocalSkillRegistry 实例正是宿主层期望的语义）。
 */
export class SkillsCap extends CapabilityBase {
  readonly type = 'skills';
  readonly category: CapabilityCategory = 'core';

  private readonly _fetchSkills?: SkillsCapFetcher;
  private readonly _beginRun?: SkillsCapInit['beginRun'];
  private readonly _endRun?: SkillsCapInit['endRun'];
  private readonly _getSkill: SkillsCapInit['getSkill'];
  private readonly _search: SkillsCapInit['search'];
  private readonly _listSkillResources?: SkillsCapInit['listSkillResources'];
  private readonly _readSkillResource?: SkillsCapInit['readSkillResource'];
  private readonly _contextWindowTokens?: number;

  /** 每个 EngineState 对应一个 Run 视图；父子并发不共享 Prompt 产物。 */
  private _runViews = new WeakMap<EngineState, SkillsRunView>();
  private _latestRunState: EngineState | undefined;

  /** context-injector 的 relevant 块读取口（原 `state.__skillsRelevant`）。 */
  getRelevantBlock(state?: EngineState): string | undefined {
    const target = state ?? this._latestRunState;
    return target ? this._runViews.get(target)?.relevantBlock : undefined;
  }

  constructor(init: SkillsCapInit) {
    super();
    if (typeof init.getSkill !== 'function') {
      throw new Error(
        'SkillsCap: init.getSkill is required (typically wraps LocalSkillRegistry.getByKey).',
      );
    }
    if (typeof init.search !== 'function') {
      throw new Error(
        'SkillsCap: init.search is required (typically wraps LocalSkillRegistry.search).',
      );
    }
    this._fetchSkills = init.fetchSkills;
    this._beginRun = init.beginRun;
    this._endRun = init.endRun;
    this._getSkill = init.getSkill;
    this._search = init.search;
    this._listSkillResources = init.listSkillResources;
    this._readSkillResource = init.readSkillResource;
    this._contextWindowTokens = init.contextWindowTokens;
  }

  /**
   * Tools —— 复用 `tools/skills-tools.ts::createSkillsTools` 的
   * `skills_read` / `skills_search` 实现（已有完整 input schema +
   * canonical key 校验 + ext:/tin: 前缀拦截 + 中文错误文案）。
   *
   * **不重写理由**：现有实现已经包含 review 过的边界处理（key 格式
   * 校验、unsupported prefix 中文文案、空 query 拒绝、limit 上下界），
   * 重写一份必然漏掉细节。SkillsCap 在装配链路上把这两个工具暴露给
   * Capability 体系，行为 1:1 等同于"创建 createSkillsTools(deps) 后
   * 把 Tool[] 直接挂到工具列表"——只是改个挂法（从 ToolProvider 改成
   * Capability.tools()）。
   */
  tools(): Tool[] {
    return createSkillsTools({
      getSkill: this._getSkill,
      search: this._search,
      listSkillResources: this._listSkillResources,
      readSkillResource: this._readSkillResource,
    });
  }

  /**
   * 不依赖其他 Capability —— SkillsCap 通过外部注入的 LocalSkillRegistry
   * 操作，不需要 BackendSession.read/write。
   *
   * **设计决策**：W1.1 capability.ts 的注释举例 "SkillsCap 依赖
   * `'filesystem'` 同理"。但实际上现有 `LocalSkillRegistry` 是宿主侧
   * 模块（已经直接 fs API 工作），SkillsCap 只是消费它的查询结果——
   * 不通过 BackendSession 读 SKILL.md，不需要 filesystem 依赖。
   *
   * 如未来 SkillsCap 改用 BackendSession.read 直接读 SKILL.md（脱离
   * LocalSkillRegistry 路径），再加 filesystem 依赖。
   */
  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  /**
   * Hooks —— `beforeRun` 首算 + `beforeIteration` 按需重算 + `beforeModel` 每轮注入。
   *
   * ：相关性 query = 用户原话 + 当前 in_progress todo（`buildRecallQuery`）。
   * 复合长任务里 Agent 逐条推进 todo、用户不再发新消息，query 会随 in_progress
   * 切换而变。故除 `beforeRun` 首算外，`beforeIteration` 检测 query 变化时重算召回块
   * （Run 视图的 lastRecallQuery 门控——没变就跳过，无 todo 时退化为纯用户 query）。
   *
   *  批次 10：产物存实例字段（原 `state.__skillsStaticIndex` /
   * `__skillsHint` / `__skillsRelevant` 黑板字段）：
   *   - 静态名称索引 / legacy hint → beforeModel 每轮 `ctx.appendSystemSection`
   *     （字节序由 llm-request-builder 规范序表决定，与 hook 栈位无关）；
   *   - `<relevant_skills>` → `getRelevantBlock()`，宿主装配时接给
   *     context-injector 拼进当轮 `<context>` 块。
  */
  hooks(): EngineHooks | null {
    if (!this._fetchSkills) {
      if (!this._beginRun && !this._endRun) return null;
      return {
        beforeRun: async (runCtx) => {
          await this._beginRun?.(runCtx);
        },
        afterRun: async (runCtx) => {
          await this._endRun?.(runCtx);
        },
      };
    }
    const fetchSkills = this._fetchSkills;
    const contextWindowTokens = this._contextWindowTokens;

    // ：把原 beforeRun 主体抽成可复用的 refresh —— beforeRun 首算、
    // beforeIteration 在 in_progress todo 推进（检索词变化）时重算。query 由调用方
    // 用 buildRecallQuery 计算后传入（用户原话 + 当前 in_progress todo）。
    const refresh = async (
      state: RunHookContext['state'],
      query: string,
      runId?: string,
    ): Promise<void> => {
        const view = this._runViews.get(state);
        if (!view) return;
        let raw: SkillsTwoZoneResult | SkillListingResult | string | null;
        try {
          // ：Cap 不再传业务 id，spaceId/organizationId 已由 host
          // 装配期烘进 fetchSkills 闭包。
          raw = await fetchSkills({ query, runId });
        } catch {
          // D1 抗闪烁：fetchSkills 抛错时保留当前 Run 的注入产物——HTTP 临时
          // 故障 / IPC 失败不应让同一 Run 内的 skill 块闪烁消失。
          return;
        }

        // 两区结果（live 路径：LocalSkillRegistry.render()）：
        // - staticIndex → system 静态段名称索引（query 无关、可缓存）
        // - dynamicTopK → relevant 块，由 context-injector 复用 context_injection
        //   机制拼进当轮 `<context>` 块（贴当前 user 前、fresh、缓存友好），
        //   不进 system 段。
        if (isTwoZoneResult(raw)) {
          view.staticIndexBlock = raw.staticIndex
            ? `${SKILLS_TAG_OPEN}\n${raw.staticIndex}\n${SKILLS_TAG_CLOSE}`
            : undefined;
          view.hintBlock = undefined; // 两区不走 system 动态段
          if (raw.dynamicTopK) {
            const block = `${RELEVANT_TAG_OPEN}\n${raw.dynamicTopK}\n${RELEVANT_TAG_CLOSE}`;
            // 描述已在上文（当轮 live 消息）出现过的 skill，描述列替换成「（见上文）」去重。
            const seen = collectDescribedKeys(state.messages, RELEVANT_TAG_OPEN, RELEVANT_TAG_CLOSE);
            view.relevantBlock = blankSeenDescriptions(block, seen);
          } else {
            view.relevantBlock = undefined;
          }
          return;
        }

        const listing = normalizeSkillsFetcherResult(raw);
        if (!listing) {
          // null 返回：同一 Run 内保留已经成功渲染的结果；新 Run 的视图从空开始。
          if (!view.lastBudgetedContent) {
            view.hintBlock = undefined;
          }
          return;
        }

        if (listing.skills.length > 0) {
          const fingerprint = computeSkillsFingerprint(listing.skills);
          if (
            fingerprint !== view.lastSkillsFingerprint ||
            !view.lastBudgetedContent
          ) {
            const budgeted = truncateSkillsWithinBudget(
              listing.skills,
              contextWindowTokens,
            );
            view.lastBudgetedContent = budgeted.formattedContent;
            view.lastSkillsFingerprint = fingerprint;
          }
          // 此处 `lastBudgetedContent` 必非 null —— 上方 if 分支要么命中
          // fingerprint 不变（之前已 set），要么走截断分支（刚 set）。`?? ''`
          // 是 TS narrowing 兜底（编译器无法跨 if 推断 mutation），不期望
          // 在运行时触发。
          view.hintBlock = renderTaggedBlock(view.lastBudgetedContent ?? '');
        } else {
          // 旧式 string fetcher（skills=[]）：直接用 formattedContent
          // 不走预算截断（已经是宿主拼好的字符串）。
          view.hintBlock = renderTaggedBlock(listing.formattedContent);
          // 注意：不更新 fingerprint 缓存——下次有结构化 listing 时仍能
          // 触发 truncateSkillsWithinBudget 路径。
        }
    };

    return {
      // ：与 CLI/MCP beforeRun 互不依赖，composeHooks 可并行调度。
      beforeRunParallel: true,
      beforeRun: async (runCtx: RunHookContext) => {
        const view = createSkillsRunView();
        this._runViews.set(runCtx.state, view);
        this._latestRunState = runCtx.state;
        await this._beginRun?.(runCtx);
        const query = buildRecallQuery(runCtx.state.messages);
        view.lastRecallQuery = query;
        await refresh(runCtx.state, query, runCtx.runId);
      },
      beforeIteration: async (iterCtx) => {
        // ：检索词纳入当前 in_progress todo。todo 推进 → query 变 → 重算召回块；
        // 无 todo / todo 不变 → query 与 beforeRun 一致 → 跳过（零额外开销、行为不变）。
        const view = this._runViews.get(iterCtx.state);
        if (!view) return;
        const query = buildRecallQuery(iterCtx.state.messages);
        if (query === view.lastRecallQuery) return;
        view.lastRecallQuery = query;
        await refresh(iterCtx.state, query, iterCtx.runId);
      },
      afterRun: async (runCtx: RunHookContext) => {
        try {
          await this._endRun?.(runCtx);
        } finally {
          this._runViews.delete(runCtx.state);
          if (this._latestRunState === runCtx.state) this._latestRunState = undefined;
        }
      },
      beforeModel: async (ctx) => {
        const view = this._runViews.get(ctx.state);
        if (view?.staticIndexBlock) {
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.skills_index,
            view.staticIndexBlock,
            'skills-index',
            { placement: 'static' },
          );
        }
        if (view?.hintBlock) {
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.skills_listing,
            view.hintBlock,
            'skills-and-notes',
          );
        }
      },
    };
  }

  /**
   * Override clone —— 显式重置指纹缓存。
   *
   * 默认 CapabilityBase.clone 会 structuredClone fingerprint
   * （string 能 clone 成功），但语义上 clone 通常对应**新 session**
   * （Runtime 在 prepare_agent 给每个 Run 分配独立 cap 实例）；
   * 上一 session 的指纹对新 session 无意义，反而触发"误判已渲染过"
   * 跳过新一轮 fetchSkills 的 bug。
   *
   * 显式 clone() override：先调基类拿"字段全都拷过"的克隆体，再把
   * 指纹相关字段强制清零。
   */
  clone(): SkillsCap {
    const cloned = super.clone() as SkillsCap;
    cloned._runViews = new WeakMap();
    cloned._latestRunState = undefined;
    return cloned;
  }
}
