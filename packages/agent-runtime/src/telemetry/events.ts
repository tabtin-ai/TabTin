/**
 * 事件名常量表——Runtime 和宿主唯一真相源。
 *
 * 命名规则：`namespace.action[.qualifier]`，全小写 + 下划线连字符：
 *   - namespace（必选）：persona / api / doom_loop / compact / message / docparse / mttr / sync / runtime
 *   - action（必选）：applied / changed / triggered / recovered / end / truncated / local_success 等
 *   - qualifier（可选）：error.400 / error.4xx / local_failed 这种带具体子类的
 *
 * 指标前缀规范：
 *   - `event.*`  —— 离散事件（单次发生，可计数/配对分析），不带此前缀，直接事件名
 *   - `metric.*` —— 数值采集（可聚合：p50/p95/sum/avg），事件名以 `metric.` 开头
 *
 * 新增事件必须：
 *   1. 添加常量到此表
 *   2. 在 `TELEMETRY.md` 附录"事件清单"中登记 payload 字段
 *   3. 若包含潜在敏感信息，先走 `redact.ts` 脱敏
 */

export const TelemetryEvents = {
  /**
   * Runtime 创建 / 重建时发送一次，记录本 session 生效的 custom_rules 指纹。
   * **不是**每轮对话发——因为 custom_rules 在 `createRuntimeForSession` 里被
   * 烘焙进 system prompt，Runtime 缓存命中时完全不变，无需重复上报。
   *
   * 事件名保留 `persona.applied`（历史命名，作为稳定埋点标识符）；「角色设定」
   * persona 已下线后，本事件只承载 custom_rules 指纹。
   */
  PERSONA_APPLIED: 'persona.applied',
  /**
   * 会话中用户改了 custom_rules，Runtime 缓存因此 invalidate 并重建时发送。
   * 区别于 `persona.applied`：此事件一定带 `previous_custom_rules_hash`，
   * 可用于排查"规则来回变"问题。事件名保留为稳定埋点标识符。
   */
  PERSONA_CHANGED: 'persona.changed',

  /**
   * W1-A：用户在 ChatInput 切换了 AgentMode (ask/agent/plan/study/group)，触发
   * Runtime 重建。payload：`from`（旧 mode）/ `to`（新 mode）/ `reason`（'user_switch'）。
   * 用于产品健康度分析：mode 切换频次、各 mode 平均会话时长、plan→agent 的转化率等。
   */
  AGENT_MODE_CHANGED: 'agent_mode.changed',
  /**
   * W1-A：Runtime 创建（首次 / 重建）时记录最终生效的 AgentMode。每个 runtime
   * 生命周期内只发一次。payload：`mode` / `reason`（'created' | 'rebuilt'）。
   */
  AGENT_MODE_APPLIED: 'agent_mode.applied',

  /**
   * W2-B：Plan 模式 guard 触发的拒绝决策（写权限硬兜底）。
   *
   * 用途：观察 LLM 在 plan / study / ask 模式下是否真的尝试调用过被禁工具，
   * 以及违规模式（mode_disallowed_tool / no_active_plan / wrong_target_document）
   * 的分布。dashboard 上若某 deny_code 持续上升，说明 prompt 段需要加强或
   * 工具策略需要调整。
   *
   * payload：`outcome`（`'deny' | 'allow_unknown_mode'`）/ `deny_code` /
   * `agent_mode` / `tool_name` / `session_id` / 以及 guard.details 里的结构化字段
   * （`active_plan_document_id` / `provided_document_id` / `tool_target_field` 等）。
   *
   * 不上报工具的真实 input —— 只记录字段名 + 命中字段值 / active plan id。
   */
  PLAN_GUARD_DENIED: 'plan_guard.denied',

  /** FR-03 配套：LLM Proxy 返回 400（API 参数错误），带 error_body_sample。 */
  API_ERROR_400: 'api.error.400',
  /** FR-03 配套：其他 4xx 错误（403/404 等）。独立于 400 以便 A/B 观察。 */
  API_ERROR_4XX: 'api.error.4xx',

  /** FR-01：DoomLoop 进入 warn / pause / terminate 状态。 */
  DOOM_LOOP_TRIGGERED: 'doom_loop.triggered',
  /** FR-01：DoomLoop 从 warn/pause 状态恢复正常（streak 归零）。 */
  DOOM_LOOP_RECOVERED: 'doom_loop.recovered',

  /** FR-04：单条消息超 MAX_MESSAGE_CHARS 被硬截断。 */
  MESSAGE_TRUNCATED: 'message.truncated',

  /**
   * FR-15：IterationBudget 双通路升级到 warn 阶段。
   *
   * **触发点**：`query.ts` 主循环顶部预算评估段。每次 stage 升级到 warn
   * 发一次（同 stage 重复评估不重复发——靠 iteration-budget-policy 闭包内的 stage 档位
   * 去重）。
   *
   * payload 字段（详见 TELEMETRY.md §6.X）：
   *   `trigger` ('iteration' | 'token') / `current` / `threshold` / `percent` /
   *   `max` / `iteration_index` / `iteration_max` / `total_tokens` / `max_total_tokens`。
   *
   * 北极星指标关联：作为长任务"自然结束 vs 硬断"的上游解释变量——
   * `iteration_budget.warn` 上涨说明长会话频次提升，可指导是否需要默认值调整。
   */
  ITERATION_BUDGET_WARN: 'iteration_budget.warn',
  /**
   * FR-15：IterationBudget 进入 grace 阶段——LLM 即将做最后总结，工具已被禁用。
   *
   * **触发点**：同 warn；当评估结果 stage='grace' 且首次超越已通知阶段时发。
   *
   * payload 多一个 `tools_disabled: true`（D3 决策硬约束的可观测标记，便于
   * AdminDash 区分"正常 grace"和"未禁用工具的异常分支"）。
   */
  ITERATION_BUDGET_GRACE: 'iteration_budget.grace',
  /**
   * FR-15：IterationBudget 进入 terminate 阶段——强制 DONE 退出。
   *
   * **触发点**：评估 stage='terminate' 时；可能在两种语境下发：
   *   1. **grace 完成路径**（最常见）：上一轮 grace 完成后本轮顶部再评估
   *      已 ≥ terminate，直接 DONE。`final_message_present=true` 表示
   *      grace 期 LLM 已输出最终回复（前端有内容可展示）。
   *   2. **跳过 grace 路径**：BudgetTracker 在轮内突变把 token 推到 100%，
   *      stage 直接从 normal → terminate（极端边缘情形）。
   *      `final_message_present=false`，前端展示"达上限但无最终回复"。
   *
   * payload 多 `tools_disabled: true` + `final_message_present: boolean`。
   */
  ITERATION_BUDGET_TERMINATE: 'iteration_budget.terminate',
  /**
   * FR-15：grace 期 LLM 仍尝试调用工具（弱模型 hallucination 场景）。
   *
   * **触发点**：grace 完成路径中，`toolUseBlocks.length > 0` 时（在 query.ts
   * 强制 final 之前）。
   *
   * **频率**：理论上 0（D3 决策硬约束 — `llmRequest.tools=undefined` 时模型不应
   * 看到任何工具）。实际可能出现在：弱模型对 system prompt 中"do NOT call tools"
   * 的指令遵从度差时仍尝试 hallucinate tool_use。
   *
   * **运维价值**：观察哪些模型 / Skill 在 grace 期不守规矩，作为：
   * 1. 模型质量评估（哪些模型 grace 期表现好）
   * 2. system injection 文案优化触发条件（频次高时考虑增强 "FINAL turn / do NOT" 措辞）
   * 3. 用户反馈"总结不完整"投诉的根因定位
   *
   * payload：`trigger`（继承 grace 阶段的通路）/ `tool_count`（被丢弃的 tool_use 数）/
   * `iteration_index`。**不**载具体 tool_name（tool_use input 可能含敏感数据，
   * 与 doom_loop tool_hash 走脱敏指纹同模式即可——本期 P3 跟进）。
   */
  ITERATION_BUDGET_GRACE_TOOL_BLOCKED: 'iteration_budget.grace_tool_blocked',

  /**
   * W3：tool-failure stall detector 升级到 notice 阶段——LLM 已连续 N 次同
   * tool + 同 error_kind 失败，runtime 给用户发了一条中文 SYSTEM_NOTICE，
   * **未**注入 LLM context（hint 已在 tool_result 里）。
   *
   * **触发点**：`query.ts` 主循环工具执行后评估 tracker，stage 升级到 notice。
   *
   * payload：
   *   - `tool: string` — 反复失败的工具名
   *   - `error_kind: string` — W2 语义化 error_kind（如 `network_failed`）
   *   - `streak: number` — 当前连续次数（≥ notice 阈值）
   *   - `notice_threshold: number` — 触发阈值（便于 telemetry 识别 env override）
   *   - `iteration_index: number`
   *
   * **运维价值**：哪些 (tool, error_kind) 组合最常触发 notice → 指导 W2 hint
   * 文案优化优先级；阈值 false-positive 率（notice 后立即换思路成功 vs 仍升 nudge）
   * 反映 "3 次提醒是否过于激进"。
   */
  TOOL_FAILURE_NOTICE: 'tool_failure.notice',
  /**
   * W3：tool-failure stall detector 升级到 nudge 阶段——LLM 撞 N 次墙仍未
   * 收敛，runtime 把英文 system reminder 注入下一轮 LLM context。
   *
   * **触发点**：同 notice，但 stage 升级到 nudge。
   *
   * payload：notice 字段全有 + `nudge_threshold` + `injection_pending: true`
   * （表示注入会在下一轮顶部生效）。
   *
   * **运维价值**：nudge 触发率是 stall detector 真正"挽救"的次数；nudge
   * 后下一轮是否 (a) 主动调 ask_question (b) 换工具 (c) 退出本轮 — 这三类
   * 比例反映文案动作化是否有效。
   */
  TOOL_FAILURE_NUDGE: 'tool_failure.nudge',

  /**
   * ：tool-failure tracker 升级到 terminate 阶段——同一工具在本轮失败
   * 计数达 terminate 阈值（默认 8，**不要求连续同 kind**）。Runtime **硬停本轮**
   * （emit 用户 SYSTEM_NOTICE + DONE + break），不再调用 LLM。
   *
   * **触发点**：`query.ts` 主循环工具执行后评估 stall tracker，stage 升级到
   * terminate；tool_result 入队后统一消费该 flag 收尾。
   *
   * payload：`tool` / `error_kind`（最近一次）/ `streak`（同 tool 失败总数）/
   * `terminate_threshold` / `iteration_index`。
   *
   * **运维价值**：terminate 触发率 = nudge 软提示后弱模型仍闷头烧 token 被
   * runtime 硬熔断的次数，是"防 token 烧穿"安全网真正生效的次数。
   */
  TOOL_FAILURE_TERMINATE: 'tool_failure.terminate',

  /**
   * Wave 6：tool-repetition tracker 升级到 notice 阶段——LLM 在 30s 窗口内
   * 用同 (tool, inputDigest) 成功 emit 已达 notice 阈值（默认 2 次）。
   * Runtime 给用户发了一条中文 SYSTEM_NOTICE，**未**注入 LLM context
   * （那是 nudge 阶段的事）。
   *
   * **触发点**：`query.ts` 主循环工具执行后评估 repetition tracker，
   * stage 升级到 notice。
   *
   * payload：
   *   - `tool: string` — 反复成功调用的工具名
   *   - `count: number` — 当前窗口内同 (tool, digest) 总计数
   *   - `notice_threshold: number` — 触发阈值
   *   - `window_ms: number` — 窗口大小（便于 dashboard 区分 env override）
   *   - `iteration_index: number`
   *
   * **运维价值**：哪些工具最常触发成功复读 notice → 指导工具回灌文案优化
   * （raw JSON → 自然语言断言）的优先级；阈值 false-positive 率反映 2/3
   * 是否过于敏感。
   *
   * **隐私**：不携带 `inputDigest`（虽然是 hash，但仍是间接指纹）—— 与
   * `doom_loop` tool_hash 走脱敏指纹同模式。
   */
  TOOL_REPETITION_NOTICE: 'tool_repetition.notice',
  /**
   * Wave 6：tool-repetition tracker 升级到 nudge 阶段——LLM 在 30s 窗口内
   * 同 (tool, inputDigest) 成功 emit 已达 nudge 阈值（默认 3 次）。Runtime
   * 把英文 `[System / Repetition Detection]` system reminder 注入到下一轮
   * LLM context。
   *
   * **触发点**：同 notice，但 stage 升级到 nudge。
   *
   * payload：notice 字段全有 + `nudge_threshold` + `injection_pending: true`
   * （表示注入会在下一轮顶部生效）。
   *
   * **运维价值**：nudge 触发率是 repetition detector 真正"挽救"的次数；
   * nudge 后下一轮 LLM 是否 (a) 停止重发 (b) 换不同 input (c) 退出本轮 —
   * 反映 prompt 文案 + runtime detection 双层防御的有效性。
   */
  TOOL_REPETITION_NUDGE: 'tool_repetition.nudge',

  /**
   * ：tool-repetition tracker 升级到 terminate 阶段——窗口内同
   * (tool, inputDigest) 成功复读计数达 terminate 阈值（默认 6）。Runtime
   * **硬停本轮**（emit 用户 SYSTEM_NOTICE + DONE + break），不再调用 LLM。
   *
   * **触发点**：同 nudge，但 stage 升级到 terminate；tool_result 入队后统一
   * 消费 flag 收尾。
   *
   * payload：`tool` / `count` / `terminate_threshold` / `window_ms` /
   * `iteration_index`。**不**携带 inputDigest（间接指纹，隐私）。
   *
   * **运维价值**：覆盖"工具真成功 / dedup 命中后模型仍 byte-identical 重发"的
   * token 烧穿场景被硬熔断的次数。
   */
  TOOL_REPETITION_TERMINATE: 'tool_repetition.terminate',

  /**
   * Access Barrier HITL：`presentAccessBarrier` 在能力出口发起专用 HITL kind 前发一条。
   * 接替已拆除的 login/captcha wall-gate engage 遥测。
   *
   * payload：`kind`（AccessBarrierKind）/ `domain` / `source_tool`。
   */
  ACCESS_BARRIER_PRESENTED: 'access_barrier.presented',
  /**
   * 用户在卡片上选完三选一之一（`resume_same_tab` / `alternate_source` /
   * `abort_this_target`）。payload：`kind` / `domain` / `action` / `duration_ms`
   * （挂起到用户答复的耗时）。
   */
  ACCESS_BARRIER_RESOLVED: 'access_barrier.resolved',
  /**
   * 挂起超时未获答复（`InterruptOutcome.status==='timeout'`）。
   * payload：`kind` / `domain` / `duration_ms`。
   */
  ACCESS_BARRIER_TIMEOUT: 'access_barrier.timeout',
  /**
   * 无人值守（scheduled/batch）或宿主未注入 HITL 通道（`isAvailable()===false`）
   * 时的诚实失败结局。payload：`kind` / `domain` / `runtime_mode` /
   * `reason`（`'scheduled_or_batch' | 'host_unavailable'`）。
   */
  ACCESS_BARRIER_HOST_UNAVAILABLE: 'access_barrier.host_unavailable',

  /**
   * ：流式 assistant 文本复读硬停——单轮 LLM 流内检测到完全相同
   * 文字周期连续反复输出，runtime 主动 abort 上游并 DONE。
   *
   * payload：`reason`（phrase_period）/ `evidence` /
   * `window_chars` / `text_chars` / `iteration` / `model`。
   */
  TEXT_REPETITION_TERMINATE: 'text_repetition.terminate',

  /**
   * FR-03：消息规范化实际产生修改（合并/修复 orphan/过滤 thinking/丢弃
   * 空 content 等任一类改动命中）。**仅在有实际变更时发送**——
   * `changes` 全 0 或 `level='off'` 时不发，避免对健康会话造成 noise。
   */
  MESSAGE_NORMALIZED: 'message.normalized',

  /** FR-05/FR-11：一次 Compaction 阶段结束（reactive / auto / emergency_blocking / recovery_413 / hard_trim）。 */
  COMPACT_END: 'compact.end',

  /**
   * ：幻影压力告警——裁剪后锚坐标系失效时，纯字符估算比实报上界
   * （anchorInputSide）虚高超过 2×。压力判定已被钳制到实报上界（不会误触发
   * emergency），本事件仅曝光「估算器对当前内容失真」的事实，供估算系数
   * 校调与回归监控（live 取证：中文重内容实报 30k 被估成 115k）。
   */
  COMPACT_PHANTOM_PRESSURE: 'compact.phantom_pressure',

  /**
   * FR-16 H3-B：一次 `compactConversation` 真正走了"基于前次 summary 的增量摘要"
   * 路径（`reused=true`）。每次 reuse 命中发一条；`reused=false` 不发本事件，由
   * `compact.fallback_full` 上报具体降级原因。
   *
   * Payload：
   * - `previous_summary_age_ms`：本次 reuse 时距上次 summary 写入的时差。
   * - `msgs_added`：相比上次 `msgsCovered`，本次 reuse 增量覆盖了多少条原始消息。
   * - `tokens_saved`：与"理论上走全量 compact 的输入 token"对比节省值（≥ 0）。
   * - `covered_msgs_before` / `covered_msgs_after`：上次/本次覆盖的消息数；
   *   两值差即 `msgs_added`，两个字段独立保留是为了 dashboard 过滤"覆盖范围
   *   一直没增长"的可疑会话。
   * - `iteration`：当前主循环迭代号，便于关联其他 compact.* / message.* 事件。
   *
   * 北极星指标：Compact 成本相对基线（PRD §3.1 O6 ≥ 30% 节省）。
   * 监控时聚合 `tokens_saved / (tokens_saved + tokens_after_reuse_input)` 即"节省比"。
   */
  COMPACT_SUMMARY_REUSED: 'compact.summary_reused',
  /**
   * FR-16 H3-B：reuse 命中后采样到的 LLM judge 评分。每次采样发一条；
   * `summaryReuseJudgeSampleRate=0` 时永不发。
   *
   * Payload：
   * - `score`：0-1 分；越大越好。`null`（judge 调用失败）由调用方过滤掉**不发本事件**，
   *   单独走 `compact.fallback_full` 的 `reason='judge_failed'` 路径。
   * - `sample_id`：每次采样的本地 UUID，便于跨 session 关联同一次 reuse + judge 对子。
   * - `fallback_triggered`：本次评分写入后窗口是否触发了 fallback（即下次 compact
   *   会强制走全量）。便于 dashboard 直接 group by 这个 bool 看降级密度。
   * - `window_size` / `threshold`：当时生效的配置值，便于回溯当时的"判定标准"。
   * - `iteration`：当前主循环迭代号。
   *
   * 监控建议：滑动一周看 score p50 / p95；若 p95 < 0.85 持续 3 天，考虑停用 reuse。
   */
  COMPACT_JUDGE_SCORE: 'compact.judge_score',
  /**
   * FR-16 H3-B：本次 compact 因为某个原因**不**走 reuse、或者走了但被强制回退到
   * 全量 summary 路径。
   *
   * Payload：
   * - `reason`：与 `SummaryReuseFallbackReason` 联合类型同集合。
   *   - `disabled`：`enableSummaryReuse=false`。
   *   - `no_previous_summary`：首次 compact 或缓存不存在。
   *   - `no_new_messages`：splitIdx 没扩展，跳过 reuse。
   *   - `judge_window_fallback`：判分窗口平均分 < 阈值（关键告警源）。
   *   - `summary_too_old`：缓存超过 `summaryReuseMaxAgeMs`。
   *   - `incremental_call_failed`：reuse LLM 调用本身抛错或 summary 为空。
   * - `iteration`：当前主循环迭代号。
   *
   * 设计理由：把 reuse "未启用 / 主动回退" 和 "尝试失败" 的所有路径统一到
   * 一个事件名，dashboard 直接 group by `reason` 区分根因，避免事件种类爆炸。
   */
  COMPACT_FALLBACK_FULL: 'compact.fallback_full',
  /**
   * FR-16 H3-B Review fix：judge LLM 调用失败时发一条事件，让运维 dashboard 能感知
   * "judge 通道挂了"——否则 reuse 一直跑、`compact.judge_score` 永远不发，运维
   * 无法判断"采样率为 0 还是 judge 全失败"。
   *
   * Payload：
   * - `consecutive_failures`：截止本次失败的累计次数（同 CompactionOrchestratorState.reuseStats）。
   * - `iteration`：当前主循环迭代号。
   *
   * 监控建议：失败率 = `judge_failed / (judge_failed + judge_score)` 持续 > 30%
   * 触发告警；连续失败大于阈值时考虑暂时关掉 reuse（`TABTIN_SUMMARY_REUSE=off`）。
   */
  COMPACT_JUDGE_FAILED: 'compact.judge_failed',

  /** FR-18：本地解析（pdfjs/xlsx/mammoth）成功。 */
  DOCPARSE_LOCAL_SUCCESS: 'docparse.local_success',
  /** FR-18：本地解析失败（超时/崩溃/未识别）。 */
  DOCPARSE_LOCAL_FAILED: 'docparse.local_failed',
  /** FR-18：切云端兜底（含 reason: scanned / oversize / timeout / unsupported / unknown）。 */
  DOCPARSE_CLOUD_FALLBACK: 'docparse.cloud_fallback',
  /** FR-18：本地禁止解析（超 50MB 上限 / 类型黑名单等），未产生失败但未进入本地路径。 */
  DOCPARSE_FORBIDDEN_LOCAL: 'docparse.forbidden_local',
  /** FR-18：本地解析耗时（ms），按文件类型/页数可分桶聚合。 */
  DOCPARSE_LOCAL_DURATION: 'metric.docparse.local_duration_ms',

  /** O3：MTTR 标记——人工报告事故开始。 */
  MTTR_START: 'mttr.start',
  /** O3：MTTR 标记——人工报告根因定位完成。 */
  MTTR_RESOLVED: 'mttr.resolved',

  /**
   * FR-14：SyncQueue 入队成功（每条 TranscriptEntry 进入内存批次）。
   *
   * **量级提示**：每次 transcript 写入都会发——长对话 + 高频 tool_use
   * 场景下可能秒级数十条。本期 sink 仅本地落盘，无外部上报压力；未来
   * 若开启远端 telemetry 转发需评估采样率。
   *
   * payload：`pending`（入队后内存待 flush 数量）+ `entry_type`
   * （TranscriptEntryType：user/assistant/tool_use/tool_result/compact/error）。
   */
  SYNC_QUEUED: 'sync.queued',
  /**
   * FR-14：一次 batch 上传失败（`uploadFn` reject）。
   *
   * payload：`attempt`（累计已尝试次数，含本次）/ `max_attempts_in_run`
   * （本次 flush 周期总尝试位数）/ `entry_count` / `error_message`
   * （uploadFn 抛错的 message 一行；不含 stack 也不含原 batch 内容）。
   */
  SYNC_FAILED: 'sync.failed',
  /**
   * FR-14：达到 maxAttempts 后 batch 写入持久化队列。
   *
   * payload：`id`（PersistedEntry id）/ `entry_count` / `attempts`。
   */
  SYNC_PERSISTED: 'sync.persisted',
  /**
   * FR-14：startup 时 `recover()` 从持久化队列恢复 + 重试上传成功。
   *
   * payload：`id` / `age_ms`（创建到恢复时长）/ `previous_attempts`
   * （recover 之前累计的尝试次数）/ `entry_count`。
   */
  SYNC_RECOVERED: 'sync.recovered',
  /**
   * FR-14：persisted 条目超过 TTL（默认 7 天）后归档。
   *
   * payload：`id` / `reason`（`'ttl' | 'max_attempts'`）/
   * `age_ms` / `attempts` / `entry_count`。归档不是删除——条目仍在
   * archive 子库 / 子文件可审计。
   */
  SYNC_ARCHIVED: 'sync.archived',
  /**
   * FR-14：`persistBatch` 写入持久化层失败（fs 满 / 权限改 / 杀毒锁等）。
   *
   * 这是与 `sync.failed`（上传失败）**不同**的运维信号——`sync.failed`
   * 通常意味着网络问题，`sync.persist_failed` 意味着本机 fs 出问题。
   * 区分事件名让 dashboard / 告警规则可以独立配置。
   *
   * payload：`id` / `entry_count` / `error_message`。当前 batch 数据**丢失**
   * （append 失败时不回灌内存——见 `sync.ts.persistBatch` 注释）。
   */
  SYNC_PERSIST_FAILED: 'sync.persist_failed',

  // ── relay 持久化重试（RelayRetryQueue）：relay_events 内存重试耗尽 / out-of-query
  //    失败 → 落 PersistentQueue，启动/重连 recover 重投。与 SYNC_* 同构但独立事件名，
  //    便于 dashboard 区分"transcript 上云"与"relay 落库"两类信号。 ──
  /** relay batch 内存重试耗尽 / out-of-query 一次失败 → 落盘等重投。payload：id / session_id / event_count。 */
  RELAY_PERSISTED: 'relay.persisted',
  /** relay batch 落盘失败（fs 故障）——本批 relay 丢失。payload：session_id / event_count / error_message。 */
  RELAY_PERSIST_FAILED: 'relay.persist_failed',
  /**
   * relay batch 落盘前剔除了纯转发的 6 件套流式事件（message_* 与 content_block_*）
   * 后整批为空 → 不落盘（这些事件后端本就不落库，重投也只给 observer 转发陈旧
   * delta；单条 delta 可达上百 MB，落盘会把队列文件撑到 GB 级导致 recover 失效 +
   * 主进程 OOM）。payload：session_id / dropped_transient。
   */
  RELAY_PERSIST_SKIPPED_TRANSIENT: 'relay.persist_skipped_transient',
  /**
   * recover 读到修复前落盘的纯 transient 批次 → 直接 remove 清盘（不重投）。
   * payload：id / session_id / dropped_transient。
   */
  RELAY_RECOVER_PURGED_TRANSIENT: 'relay.recover_purged_transient',
  /** recover 从持久化队列重投 relay batch 成功。payload：id / session_id / age_ms / previous_attempts / event_count。 */
  RELAY_RECOVERED: 'relay.recovered',
  /** relay batch 超 TTL 归档（知情放弃，可审计）。payload：id / reason / age_ms / attempts。 */
  RELAY_ARCHIVED: 'relay.archived',
  /**
   * FR-14：宿主 `start()` 期间的 bootstrap recover 失败信号。每个失败的
   * 子阶段独立发一条事件——`phase` 字段区分 `'recover' | 'archive'
   * | 'persist' | 'flush' | 'thrown'`。recover 失败被宿主吞掉**不阻塞启动**
   * ——但运维需要从 dashboard 看到「长期 recover 失败」的机器，否则永远
   * 没机会修。
   *
   * 与 `sync.failed`（上传一次失败）/ `sync.persist_failed`（一次落盘失败）
   * 都不同——本事件代表"启动恢复阶段的整体可观测信号"，颗粒度是宿主进程级。
   *
   * 触发路径（H2-D Review #2 修复）：
   * - `recover()` 内部对 `loadAll` / `archive` / `update` / `remove` 的失败
   *   统一通过 `onError(err, ctx)` 上报、**不抛错**（保宿主 startup 不被
   *   fs 故障阻塞）。宿主在 bootstrap SyncQueue 上注入 `onError` 把每次
   *   子阶段失败转成本事件。
   * - 防御性 `try { recover() } catch`：若未来契约改变 recover() 真的抛
   *   错，宿主 catch 后发 `phase: 'thrown'` 的本事件保留兜底信号。
   *
   * payload：`host` (`'electron' | 'daemon'`) / `phase`（恢复子阶段标签
   * `'recover' | 'archive' | 'persist' | 'flush' | 'thrown'`）/
   * `error_message`。
   *
   * 真实用户视角 Review 修复：旧实现仅 `log.warn` + 仅 catch 路径触发，
   * 运维不查日志即不知；现在每次子阶段失败都发一条 telemetry。
   */
  SYNC_BOOTSTRAP_RECOVER_FAILED: 'sync.bootstrap_recover_failed',

  /**
   * FR-17.1（H3-C）：子 Agent fork 被 per-parent 并发上限拒绝。
   *
   * payload：
   *   - `reason`：实际发的是 BudgetTracker.trySubmit 的拒绝原因——
   *     `'queue_full'`（active+queue 都满）或 `'budget_exhausted'`（token/credits
   *     耗尽）。见 `agent-tool.ts` 拒绝分支（`SUBAGENT_SPAWN_BLOCKED` emit 处）
   *     透传 `submitResult.reason`。
   *     （历史注释曾写死 `'concurrency_limit'`，与实现漂移，2026-05-30 W-H④ 订正。）
   *   - `current_children`：拒绝时父 BudgetTracker 已占用的 active children 数。
   *   - `max`：生效上限（通常等于 `EngineConfig.maxConcurrentChildren ?? 5`）。
   *
   * 用途：观察"子 Agent 拒绝率"——如果某 Agent 频繁被拒绝（每天 N 次以上），
   * 说明用户/Agent 行为模式与默认 5 的上限不匹配；运维可调高
   * `TABTIN_MAX_CONCURRENT_CHILDREN` 或 PRD 决策上调默认值。
   *
   * Dashboard：按 `agent_id` / `session_id` 聚合，与 `subagent_started` 总数对比
   * 算"拒绝率 = blocked / (blocked + started)"。
   */
  SUBAGENT_SPAWN_BLOCKED: 'subagent.spawn_blocked',
  /**
   * ：子 Agent 每次 spawn 时上报一次，用于观测「模板驱动 spawn」的采用率。
   *
   * payload：
   *   - `source`：`'template'`（命中 Space 模板）/ `'inherit'`（ad-hoc 继承派发）。
   *   - `resolved`：template_id 是否成功解析到启用模板（true 才套用模板策略）。
   *   - `template_id` / `template_version`：命中模板时填；未命中 undefined。
   *   - `space_id`：当前 Space。
   *   - `child_speaker_id`：子 Agent id（= subagent_run_id）。
   *
   * **不上报 persona / task 原文**（隐私）。Dashboard 可按 `resolved` 算模板采用率、
   * 按 `template_id` 看热门角色。
   */
  SUBAGENT_SPAWN: 'subagent.spawn',
  /**
   * FR-17.2（H3-C）：子 Agent 完成时对 summary 做了 microCompact。
   *
   * payload：
   *   - `msgs_before` / `msgs_after`：固定 `1`（子 Agent summary 是单条字符串，
   *     不是 messages 数组；保留这两个键名只为与 `compact.end` payload shape
   *     对齐，方便 dashboard 复用聚合查询）。
   *   - `tokens_before` / `tokens_after`：用 `chars / 4` 估算（与 `estimateTokens`
   *     的 1.3-4.0 混合估算同一数量级），便于和 `compact.end.tokens_freed`
   *     口径对齐做"总节省 token"看板。
   *   - `chars_before` / `chars_after`：原始字符数与压缩后字符数（精确数据）。
   *   - `truncated`：是否真做了截断（`<= maxChars` 时为 false 且 chars_after =
   *     chars_before；事件仍发以便统计"开启了 microCompact 的子 Agent 总数"）。
   *   - `subagent_run_id`：与 SUBAGENT_STARTED.payload.subagent_run_id 同源，
   *     便于跨 event 关联。
   *
   * **不上报 summary 原文**——内容可能包含用户隐私 / 内部数据。压缩前后只看
   * 数值统计。
   */
  SUBAGENT_COMPACT: 'subagent.compact',
  /**
   * LH2-A1 / FR-10 配套（H3-C）：子 Agent 主线 ReAct events 通过独立 trace
   * 通道经 DeliveryBatchBuffer 上报到 Django，让 AdminDash trace-detail 可嵌套展示。
   *
   * 单 event 维度上报开销过高（一个子 Agent 跑 10 轮可能上百条 stream event），
   * 因此本事件 **每个子 Agent 完成时聚合发 1 次**，记录该子 Agent 一共转发了多少
   * 条事件。
   *
   * payload：
   *   - `event_count`：本子 Agent 期间通过 subagentTraceEmitter 转发的事件总数。
   *   - `parent_trace_id`：父 Agent 的 trace_id。
   *   - `child_trace_id`：子 Agent 的 trace_id（通常 = `subagent_run_id`，但
   *     不强制；fork-query 内部生成 child runId 等于子 traceId）。
   *   - `subagent_run_id`：与 SUBAGENT_STARTED.payload.subagent_run_id 一致。
   *
   * Dashboard：按 `parent_trace_id` 聚合 `sum(event_count)` 看"父 Agent 这次
   * query 总共在子 Agent 上花了多少 trace event 吞吐"，对照 DeliveryBatchBuffer 上报
   * 压力做容量规划。
   */
  SUBAGENT_TRACE_EMITTED: 'subagent.trace_emitted',

  /**
   * L34 (H2-B): disablePreStart readonly 工具本来符合 pre-start 快路径条件
   * （isReadOnly=true），但因 disablePreStart=true 被拦住，强制走 runTools +
   * permissionHandler 路径。
   *
   * payload：
   *   - `tool_name`：被拦住的工具名（公开元数据，不含用户隐私）。
   *
   * 用途：量化 disablePreStart 分层策略对 pre-start 命中率的影响。宿主侧
   * sink 可自行补充 permission_mode 等上下文字段。
   */
  TOOL_PRESTART_BLOCKED_HIGH_RISK: 'tool.prestart_blocked_high_risk',

  /**
   * G5.3：prompt cache 命中率 session 级汇总。每轮 LLM 调用结束后发射。
   *
   * payload：
   *   - `cached_tokens`：本 session 累计被 cache 命中的 input token 数。
   *   - `total_input_tokens`：本 session 累计 input token 数。
   *   - `hit_rate`：`cached_tokens / total_input_tokens`（session 级）。
   *   - `model`：当前模型 id。
   */
  PROMPT_CACHE_STATS: 'prompt_cache.stats',

  /**
   * LLM 调用链路阶段耗时。payload 只允许阶段名、毫秒值、模型、消息/工具计数、
   * request_id 等低敏字段；禁止上报 prompt/completion 原文、API key、上游 URL。
   */
  LLM_TIMING: 'metric.llm.timing_ms',

  // ─── Error handling / retry / fallback (PRD 03 §5.9) ─────────────

  /**
   * Provider 重试一次 LLM 调用。每次 sleep 前发送。
   * payload: `attempt` / `max_retries` / `delay_ms` / `status_code` / `error_message` / `is_stall_retry`
   */
  ERROR_RETRY_ATTEMPT: 'error.retry_attempt',
  /**
   * 所有重试耗尽仍失败。触发条件：Provider 内部 loop 结束、未恢复。
   * payload: `attempts` / `final_status_code` / `error_message` / `query_source`
   */
  ERROR_RETRY_EXHAUSTED: 'error.retry_exhausted',
  /**
   * 529 触发模型降级，切到 fallbackChain 中下一个可用模型。
   * payload: `from_model` / `to_model` / `chain_index` / `reason`
   */
  ERROR_MODEL_FALLBACK: 'error.model_fallback',
  /**
   * 当前模型在 fallbackChain 中未匹配到任何降级链。
   * payload: `model` / `normalized` / `chain_length`
   */
  ERROR_FALLBACK_CHAIN_MISMATCH: 'error.fallback_chain_mismatch',
  /**
   * 413 prompt-too-long 触发自动压缩恢复（compact → 重试）。
   * payload: `token_gap` / `messages_before` / `messages_after` / `tokens_freed`
   */
  ERROR_PTL_RECOVERY: 'error.ptl_recovery',
  /**
   * 413 恢复中，autoCompact 后仍超限，走 truncateHead 裁剪头部轮次。
   * payload: `token_gap` / `rounds_removed` / `messages_after`
   */
  ERROR_PTL_TRUNCATE_HEAD: 'error.ptl_truncate_head',
  /**
   * truncateHead 后仍超限或 compact 本身失败，走 hardTrim 最终兜底。
   * payload: `messages_before` / `messages_after` / `target_tokens`
   */
  ERROR_PTL_HARD_TRIM: 'error.ptl_hard_trim',
  /**
   * 后台任务（title_generation / memory_extraction 等）遇到 529 立即放弃，不消耗重试预算。
   * payload: `query_source` / `model` / `status_code`
   */
  ERROR_529_BACKGROUND_BAIL: 'error.529_background_bail',
  /**
   * Provider 检测到流式响应停滞（stall），即将发起 stall retry。
   * payload: `stall_duration_ms` / `bytes_received` / `attempt`
   */
  ERROR_STALL_DETECTED: 'error.stall_detected',

  // ─── Proactive Report (PRD 06 §5.5) ─────────────────────────────────

  /**
   * PRD 06 §5.5.2：主 Agent 消费 pending SubtaskRun 并生成 push 汇报消息。
   *
   * **@reserved（ Wave3）**：常量存在，生产路径**不 emit**本 telemetry。
   * 活链路是 Electron Main IPC `agent-engine:proactive-report-ready` → Renderer
   * 注入文案；stream 侧对应幽灵事件 `SPEAKER_PUSH_MESSAGE`（亦零 emit）。
   * 统一观测另开 issue。
   *
   * 预留 payload（接线时沿用）：
   *   - `turn_type`：`'push_report'` | `'push_report_cold'`
   *   - `pending_count` / `tool_use_count` / `tool_names` / `text_length` / `speaker_id`
   */
  PROACTIVE_REPORT: 'proactive_report.consumed',
} as const;

export type TelemetryEventName =
  (typeof TelemetryEvents)[keyof typeof TelemetryEvents];
