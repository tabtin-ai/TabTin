/**
 * Prompt Section Descriptor —— SSoT 类型定义
 *
 * 每个 prompt 段在 `registry.ts::SECTION_REGISTRY` 里必须显式注册一条
 * `SectionDescriptor`。注册的对象 = 阶段 0 `0_active_renderers.yaml`
 * 里 A 类（active）+ B 类（code-active but production-cold）条目。
 *
 * C 类（历史观察到但代码已删 / 文档误报）**不进**注册表。
 *
 * 与阶段 0。
 */

/**
 * 注入点大类。与 0_active_renderers.yaml `category` 字段一一对应。
 */
export type SectionCategory =
  /** buildSystemPrompt 拼装的静态 system 段（identity / safety / etc.） */
  | 'base_prompt_section'
  /** 每轮 runtime hook 注入的 system / user 段（context / skills / convergence / etc.） */
  | 'hook_injection'
  /** 合成用户上下文 wrapper（<context> / @ referenced / 附件 / LSP / continuation） */
  | 'user_wrapper'
  /** Compact 路径插入的 assistant ack（譬如 UNDERSTOOD_ACK） */
  | 'assistant_ack'
  /** 每个工具的 description（在 LLM tools[] 数组里） */
  | 'tool_description'
  /** 工具结果的包装 / 截断 banner（<tool_output> fence、enforceToolOutputBudget） */
  | 'tool_result_wrap'
  /** Compact / subagent 旁路 LLM 调用使用的 prompt（COMPACT_*、JUDGE_*、fork-boilerplate） */
  | 'sideloop_llm_prompt';

/**
 * 段写作语言。治理目标全 'zh'；'en' 必须填 languageExceptionReason。
 */
export type SectionLanguage = 'zh' | 'en';

/**
 * 注入时机。每条只能选一种主导时机；多重时机的段应拆成多个条目。
 */
export type SectionInjectionTiming =
  /** runtime 创建/重建时一次（base prompt 静态段） */
  | 'runtime-create'
  /** 每轮 LLM 调用前注入（context / skills / convergence 等） */
  | 'every-turn'
  /** 按需触发（max_tokens continuation / 工具驱逐等） */
  | 'on-demand'
  /** 工具调用时（tool_use 时才出现的 description / 工具结果 wrap） */
  | 'tool-call';

/** 注入位置 / role */
export type SectionRole = 'system' | 'user' | 'assistant' | 'tools-array';

/** 在对应 role 流里的位置 */
export type SectionPosition = 'head' | 'mid' | 'tail';

/**
 * 工具风险等级（仅 category='tool_description' 用）。
 *
 * - `high-risk`：操作系统/文件/网络/外部 API（read_file / shell / mcp_* / write_file 等），description ≤ 1500 字符
 * - `medium`：业务工具（web_search / parse_document / memory_* / grep / glob / agent / plan_* 等），description ≤ 1200 字符
 * - `low-risk`：纯 UI / 元工具（ask_user / todo_write / skills_* / show_widget / relaunch_app 等），description ≤ 500 字符
 */
export type ToolRiskTier = 'high-risk' | 'medium' | 'low-risk';

/**
 * Host 覆盖率：某段在 Electron / Daemon 路径上是否真渲染。
 *
 * 用例：
 * - `<cli_capabilities>` 段：electron=true, daemon=false（Daemon 没传 cliReference）
 * - `<apps>` 段：electron=true, daemon=false（Daemon 没传 enabledApps）
 * - LSP `<system-reminder>`：electron=true, daemon=false（Daemon 没装 hook）
 * - 大多数 base prompt 段：都是 true
 */
export interface HostCoverage {
  electron: boolean;
  daemon: boolean;
}

/**
 * Mode 覆盖率：某段在哪些 agent mode 下渲染。
 *
 * 用例：
 * - `<agent_mode>` plan 段：只在 plan mode
 * - `plan_create` 工具：只在 plan/study mode
 * - `<execution>` 段：只在 agent mode（buildSystemPrompt 里硬编码 agent 才注入）
 * - 大多数段：所有 mode 都渲染（5 个 mode 全列）
 */
export type AgentMode = 'agent' | 'plan' | 'ask' | 'study' | 'group';

/**
 * 渲染条件 —— 自由文本 + 结构化条件。
 *
 * 解决"为什么某段在某条件下出现/不出现"的机器可解释性。
 * 见 review 反馈 #6：不补 renderCondition 会把复杂条件硬编码进 audit test，
 * 变成另一套隐形 SSoT。
 */
export interface RenderCondition {
  /** 该段在这些 mode 下渲染（空数组 = 所有 mode） */
  modes: AgentMode[];
  /** Host 覆盖率 */
  hosts: HostCoverage;
  /**
   * 配置开关：必须满足以下 host 配置字段才渲染。
   * 譬如 user_portrait 需要 host 传 userPortrait 非空；
   * execution_boundary 需要 host 传 executionBoundary。
   */
  requiresHostConfig?: string[];
  /**
   * 运行时条件：自由文本描述，audit 阶段可解析。
   * 譬如 convergence 是 "pressure >= 0.85"；
   * stall_detection 是 "tool failure streak >= 3"；
   * memory_search tool 是 "memory.enabled=true"。
   */
  runtimeTrigger?: string;
}

/**
 * 生产命中观测 —— 来自 0_active_renderers.yaml 的 evidence。
 * audit 阶段用来判定段属于 A 类还是 B 类。
 *
 * 语义分层（解决 review 反馈的"用负数当 sentinel 不干净"）：
 *
 *   - `observed`：是否被生产 session 真观测到过（无论命中数是否精确数过）
 *   - `hitSessions`：精确命中数。缺省 = 已知 observed 但未回填精确计数
 *
 * 不变量：
 *   - `category: 'active'` ⇒ `observed: true`
 *   - `category: 'production-cold'` ⇒ `observed: false` 且 `hitSessions: 0`
 *   - `category: 'active' && hitSessions == null` = 知道至少命中过但未数确切（阶段 0.5 的默认状态）
 *   - `category: 'active' && hitSessions: N` = 精确数据（阶段 1 可写脚本从 38 个 session 真数回填）
 *
 * audit 阶段按此语义判定：observed=true 但 hitSessions 缺省 → 标记为"待回填精确数"。
 */
export interface PresenceInProduction {
  /** 是否被生产 session 观测到过（无论命中数是否精确） */
  observed: boolean;
  /** 38 个抽样 session 中真实命中数。缺省 = 已知 observed 但未精确数 */
  hitSessions?: number;
  /** 抽样总数（当前 38，将来增长按需更新） */
  totalSessions: number;
  /** A 类 = active；B 类 = production-cold；其他 = unknown */
  category: 'active' | 'production-cold' | 'unknown';
}

export interface SectionDescriptor {
  /** 全仓唯一 id，与 0_active_renderers.yaml 里的 id 一致 */
  id: string;

  /** 大类 */
  category: SectionCategory;

  /** XML tag 名（base_prompt_section / hook_injection 通常必填） */
  xmlTag?: string;

  /** 段的物理来源包 */
  source: '@tabtin/agent-prompt' | '@tabtin/agent-runtime' | '@tabtin/agent-modes' | 'host';

  /** 段写作语言 */
  language: SectionLanguage;

  /** language='en' 时必填：模型质量证据 / 实测报告路径 */
  languageExceptionReason?: string;

  /** 字符上限（实测渲染字符数超过即 build 失败） */
  charBudget: number;

  /** 是否破坏 prompt cache */
  cacheBreak: boolean;

  /** cacheBreak=true 时必填：为什么必须每轮变 */
  cacheBreakReason?: string;

  /** 注入时机 */
  injectionTiming: SectionInjectionTiming;

  /** role */
  role: SectionRole;

  /** 位置 */
  position: SectionPosition;

  /** 工具风险等级（仅 tool_description 用） */
  tier?: ToolRiskTier;

  /**
   * 渲染条件 —— 详细说明此段在何种条件下注入。
   * 必填（即使是"所有 mode 所有 host 无条件渲染"也要明示）。
   */
  renderCondition: RenderCondition;

  /**
   * 生产命中观测。阶段 0 抽样数据。
   * 替代之前的 `productionCold: boolean`——hit 数据本身更精确。
   */
  presenceInProduction: PresenceInProduction;

  /** 一句话解释这段干什么 */
  description: string;

  /** 写入者文件:行（多个） */
  writerLocations: string[];
}
